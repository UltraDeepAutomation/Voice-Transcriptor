const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, systemPreferences, dialog, clipboard, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const MIRROR_RENDERER_TRACE_LOGS =
  process.env.TRANSCRIPTOR_RENDERER_TRACE_LOGS === "1" ||
  process.env.NODE_ENV === "development";

const BACKEND_RUNTIME_IMPORTS = Object.freeze([
  "fastapi",
  "uvicorn",
  "multipart",
  "cryptography",
  "faster_whisper",
  "soundfile",
  "numpy",
  "requests",
  "websockets",
]);
const BACKEND_RUNTIME_IMPORT_CHECK = `import ${BACKEND_RUNTIME_IMPORTS.join(", ")}`;
const PYTHON_ENV_SCRUB_KEYS = Object.freeze([
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "PYTHONUSERBASE",
]);
const RUN_COMMAND_OUTPUT_MAX_CHARS = 1024 * 1024;

// Register process-level crash handlers IMMEDIATELY — the previous
// registration happened inside app.whenReady().then(...), meaning any
// module-load-time crash (in requestSingleInstanceLock or other
// top-level fs/path calls) terminated the process with no log trace
// because appendMainLog requires app.getPath('userData') which isn't
// ready yet. Fall back to console.error for the pre-ready window.
let fatalMainExitScheduled = false;
function exitAfterFatalMainProcessError(reason) {
  if (fatalMainExitScheduled) return;
  fatalMainExitScheduled = true;
  try { isQuitting = true; } catch { }
  try {
    if (typeof killBackendHard === "function") {
      killBackendHard(reason || "fatal main-process exception");
    }
  } catch { }
  const exitNow = () => {
    try { app.exit(1); } catch { process.exit(1); }
  };
  try { setImmediate(exitNow); } catch { exitNow(); }
  try {
    const timer = setTimeout(() => process.exit(1), 1500);
    timer.unref?.();
  } catch { }
}
process.on("uncaughtException", (err) => {
  try {
    if (typeof appendMainLog === "function") {
      appendMainLog(`[uncaughtException] ${err?.stack || err?.message || String(err)}`);
    }
  } catch { /* appendMainLog may not be defined yet during early boot */ }
  try { console.error("[uncaughtException]", err); } catch { }
  exitAfterFatalMainProcessError("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  try {
    if (typeof appendMainLog === "function") {
      appendMainLog(`[unhandledRejection] ${String(reason)}`);
    }
  } catch { }
  try { console.error("[unhandledRejection]", reason); } catch { }
});

// Windows: detect OneDrive-managed %APPDATA% and re-home userData to
// %LOCALAPPDATA%\Transcriptor (which is NEVER synced by OneDrive,
// regardless of Known-Folder-Move policy). When a corporate Group
// Policy enables KFM Roaming → OneDrive, our config.json writes get
// sync-conflicted across devices and ``writeFile(tmp) + rename``
// fails with EPERM while OneDrive holds the file handle during
// upload — symptom: users periodically lose their API keys +
// presets + archive-dir preferences. Also: encrypted API keys wind
// up syncing to OneDrive cloud (privacy leak).
//
// Must run BEFORE any `app.getPath('userData')` call (line 227
// `mainLogFilePath`), BEFORE `requestSingleInstanceLock` (line 154),
// and BEFORE we spawn the backend (TRANSCRIPTOR_DATA_DIR env flows
// through to backend/config.py `_default_data_dir`).
function _relocateUserDataOffOneDrive() {
  if (process.platform !== "win32") return;
  const roaming = process.env.APPDATA;
  const local = process.env.LOCALAPPDATA;
  if (!roaming || !local) return;
  // Resolve OneDrive root candidates. `OneDriveCommercial` is
  // corporate M365; `OneDriveConsumer` / `OneDrive` are personal.
  const oneDriveRoots = [
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.OneDrive,
  ].filter((p) => p && typeof p === "string").map((p) => path.resolve(p));
  if (oneDriveRoots.length === 0) return;
  const roamingResolved = path.resolve(roaming);
  const insideOneDrive = oneDriveRoots.some((od) => {
    const rel = path.relative(od, roamingResolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!insideOneDrive) return;
  // Target: non-synced Local AppData.
  const newDir = path.join(local, "Transcriptor");
  const oldDir = path.join(roaming, "Transcriptor");
  try { fs.mkdirSync(newDir, { recursive: true }); } catch { /* EEXIST or broken FS — fall through; setPath will still try */ }
  // One-time migration: if the user had a prior OneDrive'd install,
  // copy their data from the old location to the new location once.
  // Marker file prevents re-copying on every launch, which would
  // silently overwrite their new-location edits with old data.
  const marker = path.join(newDir, ".migrated-from-onedrive");
  try {
    if (!fs.existsSync(marker) && fs.existsSync(oldDir)) {
      // `cpSync` landed in Node 16.7 / Electron 30 ships Node 20.x.
      // Copy only the user-facing subset — skip bundled-runtime caches,
      // .venv, anything else that is safe to regenerate.
      let allCopied = true;
      const copyChild = (name) => {
        const src = path.join(oldDir, name);
        const dst = path.join(newDir, name);
        try {
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.cpSync(src, dst, { recursive: true, errorOnExist: false });
          }
        } catch (e) {
          // 1.1.25 fix: previously silently swallowed per-child errors
          // AND wrote the migration marker unconditionally. If a single
          // child copy failed (disk full, AV blocking, antivirus quarantine
          // mid-rename), the marker pinned the migration as "done" forever
          // and the user's recordings stayed stranded in the OneDrive path
          // — silent data loss. Now we track success and write the marker
          // only when EVERY child landed.
          allCopied = false;
        }
      };
      for (const child of [
        "config.json",
        ".encryption_key",
        "api_token.txt",
        "known_archive_dirs.json",
        "upscale_presets",
        "recordings",
      ]) copyChild(child);
      if (allCopied) {
        try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* non-fatal */ }
      }
      // If !allCopied, intentionally do NOT write the marker — next boot
      // will retry the failed child(ren). The user only sees a "did all
      // copies succeed" delta on retry, never silent loss.
    }
  } catch { /* migration best-effort */ }
  // Override BOTH Electron's userData AND the backend's DATA_DIR so
  // they stay in lockstep. The child-spawn code at line ~5085 reads
  // `TRANSCRIPTOR_DATA_DIR` from process.env — setting it here means
  // backend/config.py `_default_data_dir` picks up the override even
  // though it never sees Electron's `app.setPath` call.
  try { app.setPath("userData", newDir); } catch { /* path must be absolute on Win; already is */ }
  process.env.TRANSCRIPTOR_DATA_DIR = newDir;
  // Cache note: main.log path switches to the new dir automatically
  // on the next appendMainLog call (mainLogFilePath at line 227 is
  // computed lazily from app.getPath). Old log in OneDrive'd path
  // stays as an artefact — harmless.
}
_relocateUserDataOffOneDrive();

let backend = null;
let win = null;
let mainWindowInitialLoadPromise = null;
let recordingStateMonitor = null;
let tray = null;
let backendBootError = "";
// Cache the last shortcut-registration status so we can replay it to
// any renderer window created AFTER the registration happened.
// `registerGlobalShortcuts` runs during app startup before createWindow,
// so the very first window misses the live injection and would render
// with no awareness that its F9 hotkey is unclaimed. Cached here,
// replayed from `did-finish-load`.
let lastShortcutStatus = null;
// Cached macOS Accessibility-trust state. Updated by the
// `checkAccessibility` poll inside app.whenReady; replayed to every
// renderer load via did-finish-load so a closed-and-reopened window
// (tray click after `win.close` on darwin) doesn't have to wait the
// full 30 s poll cycle to learn the current trust state.
let lastAccessibilityTrusted = null;
// Accessibility-poll timer handle — see `app.whenReady` for setup.
// Stored module-scope so `before-quit` can clear it cleanly.
let accessibilityPollTimer = null;
// Ring buffer of the last ~4 KB of backend stderr. When the fallback
// HTML fires "Backend did not start in time" / "exited with code N
// after 8 restart attempts", we include the tail of stderr so the user
// and support can SEE what actually failed — ImportError, missing
// module, module-level crash, port collision, etc. Without this the
// error page is actionable only by a developer with log-file access.
let backendStderrTail = "";
const BACKEND_STDERR_TAIL_MAX = 4096;
let isQuitting = false;
let shortcutToggleInFlight = false;
let recordingStopInFlight = false;
let pasteShortcutInFlight = false;
let lastTranscriptText = "";
let mainLogFilePath = "";
let traceCounter = 0;
const DEFAULT_RECORDING_AUTO_STOP_CONFIG = Object.freeze({ enabled: false, seconds: 2, thresholdDb: -42 });
let recordingSilenceStartedAt = 0;
let recordingAutoStopConfig = DEFAULT_RECORDING_AUTO_STOP_CONFIG;
let recordingAutoStopConfigRefreshAt = 0;
// Generation counter for recordingAutoStopConfig async refreshes. Each
// scheduled refresh captures this value; when the Promise resolves it
// checks that the generation still matches before writing — so a
// resolve from a PREVIOUS session (after the recording status state was reset and a
// new recording started) cannot clobber the new session's config.
let recordingAutoStopConfigGen = 0;
let recordingStartedAt = 0;
let recordingSeenAudioFrames = false;
let postStopQueue = [];
let postStopWorkerRunning = false;
let pendingTranscriptionCount = 0;
let backendRestartTimer = null;
// Render-process-gone recovery timer. Schedules a loadURL to recreate
// the renderer 500 ms after a crash. Tracked at module scope so
// before-quit can clear it — if the user quits during the recovery
// window the loadURL would otherwise fire against a teardown-in-progress
// webContents and produce shutdown-log noise.
let renderRecoveryTimer = null;
let backendRestartAttempts = 0;
// Set at app.whenReady, cleared on before-quit so shutdown doesn't
// produce unhandledRejection noise from executeJavaScript against a
// destroyed webContents.
let shortcutPollTimer = null;
let shortcutBridgeHandler = null;
let pendingShortcutBridgeMessages = [];
// Single-flight promise for ``startBackend``. Concurrent callers
// (window creation, restart timer, tray re-open) all await the same
// in-flight start instead of racing to spawn duplicate Python
// subprocesses that leak PIDs when ``backend`` is overwritten.
let backendStartInFlight = null;
let micPermissionChecked = false;
let loadedFrontendBuildSignature = "";
let pasteTarget = emptyCapturedPasteTarget();
const HOST = "127.0.0.1";
// Backend port default. pickBackendPort iterates up if occupied, so
// collisions with other local services on 8321 are non-fatal — the
// actual port the backend bound is stored in mutable ``PORT`` below.
// All four previous hardcoded 8321 literals now reference this constant
// so a future port change is a one-line edit.
const DEFAULT_BACKEND_PORT = 8321;
let PORT = DEFAULT_BACKEND_PORT;
let BASE_URL = `http://${HOST}:${PORT}`;
let BACKEND_BOOT_NONCE = "";
const LAST_TRANSCRIPT_FILE = "last_transcript.json";
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  // app.quit() is async and allows module-level code to keep running
  // (startBackend, BrowserWindow creation, globalShortcut registration),
  // so the duplicate instance briefly races the primary for port 8321
  // and the F9/F10 hotkeys before finally exiting. app.exit(0) is
  // synchronous — nothing after this line runs.
  app.exit(0);
}

app.on("second-instance", () => {
  ensureWindowVisible({ manual: true, force: true });
});

// Rotate main.log when it exceeds this size. Prior code appended
// forever — a heavy trace-log session (hotkey fires ~200 events per
// recording start/stop cycle) grew the file to 35+ MB over a few
// days, making the log unusable for support triage and unnecessarily
// consuming userData disk.
const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;
let mainLogSizeCached = -1;
let mainLogCheckCounter = 0;

function mainLogArchivePath(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${mainLogFilePath}.${kind}-${stamp}`;
  let candidate = base;
  for (let i = 1; fs.existsSync(candidate); i += 1) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

function rotateMainLogIfNeeded() {
  if (!mainLogFilePath) return;
  try {
    const st = fs.statSync(mainLogFilePath);
    mainLogSizeCached = st.size;
    if (st.size < MAIN_LOG_MAX_BYTES) return;
    const legacyPending = mainLogFilePath + ".rotating";
    if (fs.existsSync(legacyPending)) {
      try { fs.renameSync(legacyPending, mainLogArchivePath("recovered")); } catch { /* keep orphan in place */ }
    }
    const pending = mainLogArchivePath("rotating");
    const archived = mainLogArchivePath("archive");
    // Never delete support logs during rotation. Move current log to a
    // unique pending name, then promote that pending file to a unique
    // timestamped archive. If any step fails, preserve the best available
    // file instead of unlinking it.
    try {
      fs.renameSync(mainLogFilePath, pending);
    } catch {
      // Current log is locked — skip rotation this cycle. Next
      // amortised-counter tick will retry. main.log keeps growing
      // past 5 MB until the lock is released.
      return;
    }
    try {
      fs.renameSync(pending, archived);
      mainLogSizeCached = 0;
    } catch {
      // Promotion failed. Restore the log to its original name so
      // appendFile keeps working. If THAT also fails, preserve the
      // pending file as a recovered archive.
      try { fs.renameSync(pending, mainLogFilePath); } catch {
        try { fs.renameSync(pending, mainLogArchivePath("recovered")); } catch { /* keep pending in place */ }
      }
    }
  } catch { /* stat failed — nothing to rotate */ }
}

function appendMainLog(message) {
  try {
    if (!mainLogFilePath) {
      mainLogFilePath = path.join(app.getPath("userData"), "main.log");
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    // Amortised rotation check — stat every 256 appends (& 0xff).
    // Must come BEFORE the append so we rotate the CURRENT main.log
    // and the just-generated line lands in the fresh file rather
    // than getting buffered into the about-to-be-renamed inode.
    if ((++mainLogCheckCounter & 0xff) === 0) {
      rotateMainLogIfNeeded();
    }
    // appendFileSync (not appendFile): the async form buffers the
    // write and can race with a synchronous renameSync inside
    // rotateMainLogIfNeeded — on POSIX the pending write lands in
    // the NOW-RENAMED inode (the .rotating / .1 file), then the
    // next rotation cycle unlinks it, losing data. Synchronous
    // appends cost ~0.5-1ms per line on local SSD; trace logging
    // peaks at ~20 lines/second which is still well under 2% of
    // main-process time. Acceptable cost for log durability.
    fs.appendFileSync(mainLogFilePath, line, "utf8");
  } catch (e) {
    // Last-resort: the logger itself failed. Fall back to stderr so
    // we never silently lose signal.
    // eslint-disable-next-line no-console
    console.error("appendMainLog failed", e);
  }
}

function logPasteTrace(step, details = {}) {
  try {
    appendMainLog(`[paste-trace] ${JSON.stringify({ step, ...details })}`);
  } catch (e) {
    // JSON.stringify cycles or unrepresentable values — fall back to
    // a single-line dump. Do NOT recurse via appendMainLog with
    // objects that just threw.
    try {
      appendMainLog(`[paste-trace-error] step=${step} error=${e?.message || e}`);
    } catch (inner) {
      // eslint-disable-next-line no-console
      console.error("logPasteTrace catastrophic failure", inner);
    }
  }
}

/**
 * Best-effort execution helper with observability.
 *
 * Use for "might legitimately fail during teardown" calls — executing JS
 * in the renderer after it's been destroyed, resizing a hidden window,
 * or clipboard ops on platforms where the caller might not have focus.
 * Failures are logged to main.log (``safe-exec`` tag) and ``null`` is
 * returned so the caller can continue.
 *
 * Do NOT call inside ``appendMainLog`` / ``logPasteTrace``.
 */
async function safeExec(context, fn) {
  try {
    return await fn();
  } catch (error) {
    appendMainLog(`[safe-exec] ${context}: ${error?.message || error}`);
    return null;
  }
}

function safeExecSync(context, fn) {
  try {
    return fn();
  } catch (error) {
    appendMainLog(`[safe-exec-sync] ${context}: ${error?.message || error}`);
    return null;
  }
}

function compactLogText(value, max = 180) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function normalizeTranscriptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function textDigest(input) {
  const str = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function isMeaningfulTranscriptText(value) {
  const txt = normalizeTranscriptText(value);
  if (!txt) return false;
  const lower = txt.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (lower === "error" || lower === "[websocket error]" || compact === "[silence]") return false;
  if (lower.startsWith("http ") || lower.startsWith("network error")) return false;
  return true;
}

function createTrace(scope, seed = {}) {
  const id = `${scope}-${Date.now()}-${(++traceCounter % 100000).toString().padStart(5, "0")}`;
  const ctx = { id, scope, startedAt: Date.now(), step: 0 };
  appendMainLog(`[trace-start] ${JSON.stringify({ id, scope, ...seed })}`);
  return ctx;
}

function traceStep(ctx, stage, details = {}) {
  if (!ctx) return;
  ctx.step += 1;
  appendMainLog(
    `[trace] ${JSON.stringify({
      id: ctx.id,
      scope: ctx.scope,
      step: ctx.step,
      ms: Date.now() - ctx.startedAt,
      stage,
      ...details,
    })}`
  );
}

function traceEnd(ctx, status = "done", details = {}) {
  if (!ctx) return;
  appendMainLog(
    `[trace-end] ${JSON.stringify({
      id: ctx.id,
      scope: ctx.scope,
      status,
      totalMs: Date.now() - ctx.startedAt,
      steps: ctx.step,
      ...details,
    })}`
  );
}

async function ensureWindowVisible(options = {}) {
  const force = !!options.force;
  if (!force && recordingStopInFlight) return;
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.show(); } catch { }
  }
  if (!win || win.isDestroyed()) {
    await createWindow();
    return;
  }
  if (backend === null) {
    await startBackend();
  }
  await refreshWindowForFrontendBuild(false);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function getRepoRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "..");
}

function getFrontendBuildRoot() {
  const repoRoot = getRepoRoot();
  const devDistDir = path.join(repoRoot, "frontend", "dist");
  const packagedFrontendDir = path.join(repoRoot, "frontend");
  if (fs.existsSync(path.join(devDistDir, "index.html"))) return devDistDir;
  if (fs.existsSync(path.join(packagedFrontendDir, "index.html"))) return packagedFrontendDir;
  return devDistDir;
}

// Signature cache: stat the frontend entry file at most once per TTL
// window. Since Vite emits hashed asset filenames, index.html is the
// SSOT for the build — any asset change implies index.html references
// a different hash and therefore a different on-disk content. Stat'ing
// 10+ asset files on every window show was a main-thread stall.
const FRONTEND_SIGNATURE_TTL_MS = 1500;
let cachedFrontendSignature = "";
let cachedFrontendSignatureAt = 0;

async function getFrontendBuildSignature() {
  const now = Date.now();
  if (cachedFrontendSignature && now - cachedFrontendSignatureAt < FRONTEND_SIGNATURE_TTL_MS) {
    return cachedFrontendSignature;
  }
  try {
    const indexPath = path.join(getFrontendBuildRoot(), "index.html");
    const stat = await fs.promises.stat(indexPath);
    cachedFrontendSignature = `index:${stat.size}:${stat.mtimeMs}`;
    cachedFrontendSignatureAt = now;
    return cachedFrontendSignature;
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      appendMainLog(`[frontend-signature-error] ${error?.message || error}`);
    }
    cachedFrontendSignature = "";
    cachedFrontendSignatureAt = now;
    return "";
  }
}

function invalidateFrontendSignatureCache() {
  cachedFrontendSignature = "";
  cachedFrontendSignatureAt = 0;
}

async function refreshWindowForFrontendBuild(force = false) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  if (force) {
    invalidateFrontendSignatureCache();
  }
  const nextSignature = await getFrontendBuildSignature();
  if (!nextSignature) return;

  // First-launch case: the renderer hasn't reported its loaded
  // signature yet (``did-finish-load`` hasn't fired). Doing clearCache
  // + reload here would be a spurious white flash on every app startup.
  if (!loadedFrontendBuildSignature) return;

  if (!force && loadedFrontendBuildSignature === nextSignature) return;

  appendMainLog(
    `[frontend-refresh] force=${force} from=${loadedFrontendBuildSignature || "none"} to=${nextSignature}`
  );
  await safeExec("refreshWindowForFrontendBuild:clearCache", () =>
    win.webContents.session.clearCache()
  );
  await safeExec("refreshWindowForFrontendBuild:clearStorageData", () =>
    win.webContents.session.clearStorageData({
      origin: BASE_URL,
      storages: ["serviceworkers", "cachestorage"],
    })
  );
  loadedFrontendBuildSignature = nextSignature;
  if (!win.webContents.isLoading()) {
    await safeExec("refreshWindowForFrontendBuild:reload", () =>
      win.webContents.reloadIgnoringCache()
    );
  }
}

function normalizeProviderChoice(value) {
  const v = String(value || "").trim();
  if (v === "local" || v === "openrouter" || v === "deepgram" || v === "") return v;
  return "local";
}

function normalizeLocalModelChoice(value) {
  const v = String(value || "").trim();
  return v || "small";
}

/**
 * Race win.webContents.executeJavaScript(code) against a timeout.
 *
 * Every hotkey-lifecycle renderer probe (`getRendererProviderChoice`,
 * `getRendererLocalModelChoice`, auto-stop config reads, etc.) previously awaited the
 * executeJavaScript Promise unconditionally. If the renderer was
 * stuck (long synchronous work, layout lock, extension interaction),
 * the main process would hang in the recording startup path forever —
 * `shortcutToggleInFlight` stayed true and the user could not re-fire
 * the hotkey until process restart. This wrapper guarantees a
 * bounded wait per probe.
 *
 * Returns ``fallback`` if:
 *   - win is destroyed / webContents is gone
 *   - executeJavaScript rejects
 *   - the timeout (default 2000ms) elapses before the Promise settles
 */
async function execRendererJsWithTimeout(code, fallback, timeoutMs = 2000) {
  if (!win || win.isDestroyed() || !win.webContents) return fallback;
  let timer = null;
  try {
    const result = await Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`renderer probe timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return result;
  } catch (e) {
    try { appendMainLog(`[renderer-probe] fallback: ${e?.message || e}`); } catch { }
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getRendererProviderChoice() {
  const v = await execRendererJsWithTimeout(
    `(() => {
      const el = document.getElementById('providerSelect');
      return String(el ? el.value : 'local').trim();
    })();`,
    "local",
  );
  return normalizeProviderChoice(v);
}

async function getRendererLocalModelChoice() {
  const v = await execRendererJsWithTimeout(
    `(() => String((document.getElementById('model')?.value || 'small')).trim())();`,
    "small",
  );
  return normalizeLocalModelChoice(v);
}

async function getRendererAutoSendEnterEnabled() {
  const out = await execRendererJsWithTimeout(
    `
    (() => {
      const btn = document.getElementById('autoSendEnterToggle');
      return !!(btn && btn.classList.contains('active'));
    })();
    `,
    false,
  );
  return !!out;
}

async function getRendererAutoStopSilenceConfig() {
  const fallback = DEFAULT_RECORDING_AUTO_STOP_CONFIG;
  const out = await execRendererJsWithTimeout(
    `
    (() => {
      const fallback = ${JSON.stringify(fallback)};
      const enabledEl = document.getElementById('autoStopSilenceEnabled');
      const secEl = document.getElementById('autoStopSilenceSeconds');
      const dbEl = document.getElementById('autoStopSilenceDb');
      const enabled = !!(enabledEl && enabledEl.checked);
      const secRaw = Number(secEl ? secEl.value : fallback.seconds);
      const dbRaw = Number(dbEl ? dbEl.value : fallback.thresholdDb);
      const seconds = Math.min(120, Math.max(1, Number.isFinite(secRaw) ? Math.round(secRaw) : fallback.seconds));
      const thresholdDb = Math.min(-10, Math.max(-80, Number.isFinite(dbRaw) ? Math.round(dbRaw) : fallback.thresholdDb));
      return { enabled, seconds, thresholdDb };
    })();
    `,
    null,
  );
  if (!out) return fallback;
  return {
    enabled: !!out.enabled,
    seconds: Number.isFinite(Number(out.seconds)) ? Number(out.seconds) : fallback.seconds,
    thresholdDb: Number.isFinite(Number(out.thresholdDb)) ? Number(out.thresholdDb) : fallback.thresholdDb,
  };
}

function hasActivePostStopWork() {
  return pendingTranscriptionCount > 0 || postStopWorkerRunning || postStopQueue.length > 0;
}

function stopRecordingStateMonitor() {
  if (recordingStateMonitor) {
    clearInterval(recordingStateMonitor);
    recordingStateMonitor = null;
  }
}

function startRecordingStateMonitor() {
  stopRecordingStateMonitor();
  recordingStateMonitor = setInterval(() => {
    if (!win || win.isDestroyed() || !win.webContents) return;
    win.webContents
      .executeJavaScript(
        `(() => {
          const vu = Number(window.__transcriptorVuLevel || 0);
          const rms = Number(window.__transcriptorRmsLevel || 0);
          const lastFrameAt = Number(window.__transcriptorLastFrameAt || 0);
          const isRec = !!window.__transcriptorIsRecording;
          return {
            vu: Number.isFinite(vu) ? vu : 0,
            rms: Number.isFinite(rms) ? rms : 0,
            lastFrameAt: Number.isFinite(lastFrameAt) ? lastFrameAt : 0,
            isRec
          };
        })();`,
        true
      )
      .then((state) => {
        const safeLevel = Math.max(0, Math.min(1, Number(state?.vu) || 0));
        const safeRms = Math.max(0, Number(state?.rms) || 0);
        const safeLastFrameAt = Math.max(0, Number(state?.lastFrameAt) || 0);
        const isRec = !!state?.isRec;
        const cfg = recordingAutoStopConfig || DEFAULT_RECORDING_AUTO_STOP_CONFIG;
        const now = Date.now();
        if (safeLastFrameAt > 0) recordingSeenAudioFrames = true;
        if (now - recordingAutoStopConfigRefreshAt > 1200) {
          recordingAutoStopConfigRefreshAt = now;
          const gen = ++recordingAutoStopConfigGen;
          getRendererAutoStopSilenceConfig().then((nextCfg) => {
            // Drop the result if a new recording session bumped the
            // generation while we were awaiting — the old config would
            // otherwise overwrite freshly set values from the new
            // session's recording status state.
            if (gen === recordingAutoStopConfigGen) {
              recordingAutoStopConfig = nextCfg;
            }
          }).catch(() => { });
        }
        if (!isRec || !cfg.enabled || recordingStopInFlight) {
          recordingSilenceStartedAt = 0;
        } else {
          const thresholdRms = Math.pow(10, Number(cfg.thresholdDb) / 20);
          const warmupMs = 1500;
          if (recordingStartedAt && (now - recordingStartedAt) < warmupMs) {
            recordingSilenceStartedAt = 0;
            return;
          }
          // Only use dB-based silence detection — no staleAudioFrames shortcut.
          // staleAudioFrames was causing false stops during active speech when
          // the audio pipeline had minor hiccups.
          const consideredSilent = safeRms <= thresholdRms;
          if (consideredSilent) {
            if (!recordingSilenceStartedAt) {
              recordingSilenceStartedAt = now;
            }
            const silentElapsed = now - recordingSilenceStartedAt;
            if (silentElapsed >= Number(cfg.seconds) * 1000) {
              recordingSilenceStartedAt = 0;
              recordingStopInFlight = true;
              stopRecordingStateMonitor();
              appendMainLog(`[recording-autostop] trigger level=${safeLevel.toFixed(4)} rms=${safeRms.toFixed(6)} lastFrameAge=${safeLastFrameAt ? (now - safeLastFrameAt) : -1} cfgSec=${Number(cfg.seconds)} cfgDb=${Number(cfg.thresholdDb)}`);
              guardedStopFromRecordingStatus("autostop");
            }
          } else {
            recordingSilenceStartedAt = 0;
          }
          // Separate fail-safe: if audio pipeline is truly dead (no frames for 8 seconds),
          // force stop to avoid infinite hang. This is NOT silence detection.
          const staleAudioFrames = recordingSeenAudioFrames && safeLastFrameAt > 0 && (now - safeLastFrameAt) > 8000;
          if (staleAudioFrames && !recordingStopInFlight) {
            recordingStopInFlight = true;
            stopRecordingStateMonitor();
            appendMainLog(`[recording-autostop-stale] audio pipeline dead for 8s, forcing stop`);
            guardedStopFromRecordingStatus("autostop-stale");
          }
        }
      })
      .catch(() => { });
  }, 120);
  try { recordingStateMonitor.unref?.(); } catch { }
}

async function beginRecordingStatusSession() {
  recordingSilenceStartedAt = 0;
  recordingAutoStopConfigRefreshAt = 0;
  recordingStartedAt = Date.now();
  recordingSeenAudioFrames = false;
  recordingAutoStopConfig = await getRendererAutoStopSilenceConfig();
  startRecordingStateMonitor();
}

async function publishRecordingStatus(status) {
  const text = String(status || "").trim();
  if (!text) return;
  await setRecordingStatus(text);
}

function resetRecordingStatusState() {
  recordingStopInFlight = false;
  recordingSilenceStartedAt = 0;
  recordingAutoStopConfigRefreshAt = 0;
  recordingAutoStopConfigGen++;
  recordingStartedAt = 0;
  recordingSeenAudioFrames = false;
  stopRecordingStateMonitor();
  if (!postStopWorkerRunning && postStopQueue.length === 0 && pendingTranscriptionCount !== 0) {
    appendMainLog(`[recording-status] reset-stale-pending=${pendingTranscriptionCount}`);
    pendingTranscriptionCount = 0;
  }
}

async function setRecordingStatus(text) {
  const status = String(text || "").trim();
  if (!status) return;
  await execRendererJsWithTimeout(
    `(() => {
      const fn = window.__transcriptorSetMainStatus;
      if (typeof fn !== 'function') return false;
      return !!fn(${JSON.stringify(status)});
    })();`,
    false,
    500,
  );
}

async function isRendererRecording() {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  const recording = await safeExec("isRendererRecording", () =>
    win.webContents.executeJavaScript(
      `(() => { return !!(window.__transcriptorIsRecording); })();`,
      true
    )
  );
  return !!recording;
}

async function ensureBackgroundWindow() {
  if (win && !win.isDestroyed() && win.webContents) return;
  await createWindow({ showWindow: false });
}

async function waitForRendererUiReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!win || win.isDestroyed() || !win.webContents) return false;
    try {
      const remainingMs = Math.max(100, timeoutMs - (Date.now() - started));
      const ready = await execRendererJsWithTimeout(
        `(() => typeof window.__transcriptorLiveStatusSnapshot === 'function')();`,
        false,
        Math.min(500, remainingMs)
      );
      if (ready) return true;
    } catch { }
    await sleep(120);
  }
  return false;
}

async function toggleRecordingFromShortcut() {
  if (shortcutToggleInFlight) return;
  const trace = createTrace("toggle_hotkey", {});
  shortcutToggleInFlight = true;
  let keepCapturedTarget = false;
  try {
    const front = await getFrontmostAppInfo();
    traceStep(trace, "front_before", {
      name: front.name || "",
      pid: front.pid || 0,
      windowTitle: compactLogText(front.windowTitle || "", 80),
    });
    await publishRecordingStatus(hasActivePostStopWork() ? "" : "Starting");
    traceStep(trace, "recording_status_ready", { status: hasActivePostStopWork() ? "active-post-stop" : "Starting" });
    await ensureBackgroundWindow();
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "app_not_ready", {});
      await setRecordingStatus("App Not Ready");
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "window-not-ready" });
      return;
    }

    const ready = await waitForRendererUiReady();
    traceStep(trace, "renderer_ready_check", { ready: !!ready });
    if (!ready) {
      await setRecordingStatus("App Loading");
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "renderer-not-ready" });
      return;
    }

    const beforeToggleState = await queryRendererRecordingState().catch(() => ({ recording: false, recordingId: 0 }));
    if (!beforeToggleState.recording && hasActivePostStopWork()) {
      appendMainLog(
        `[shortcut] start blocked by single-capsule post-stop work ` +
        `pending=${pendingTranscriptionCount} queue=${postStopQueue.length} worker=${postStopWorkerRunning ? 1 : 0}`,
      );
      await publishRecordingStatus("Transcribing");
      traceStep(trace, "single_capsule_busy", {
        pending: pendingTranscriptionCount,
        queue: postStopQueue.length,
        worker: !!postStopWorkerRunning,
      });
      traceEnd(trace, "blocked", { reason: "single-capsule-post-stop-active" });
      return;
    }

    const micGranted = await requestMacMicrophonePermissionOnce();
    if (!micGranted) {
      traceStep(trace, "mic_permission_denied", {});
      await setRecordingStatus("Grant Access");
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "mic-permission-denied" });
      return;
    }

    // 1.1.25 fix: previously called ``executeJavaScript`` directly with
    // no timeout, while this function holds ``shortcutToggleInFlight =
    // true``. A stuck renderer (long synchronous work, blocked event
    // loop, frozen DOM) made the hotkey a permanent no-op until process
    // restart — the exact failure mode the dedicated
    // ``execRendererJsWithTimeout`` helper exists to prevent. 2 s
    // budget mirrors the helper's default; if the renderer can't
    // respond in 2 s the recording probably wasn't going to work
    // anyway, and the hotkey resets cleanly via the inflight finally.
    const result = await execRendererJsWithTimeout(
      `
      (() => {
        const isRec = !!(window.__transcriptorIsRecording);
        const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
        const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
        const autoSendEnter = !!(document.getElementById('autoSendEnterToggle') && document.getElementById('autoSendEnterToggle').classList.contains('active'));
        const liveSnapshot = typeof window.__transcriptorLiveStatusSnapshot === 'function'
          ? window.__transcriptorLiveStatusSnapshot()
          : null;
        const timerText = String(liveSnapshot?.timerText || '00:00').trim();
        window.dispatchEvent(new Event('transcriptor-hotkey-toggle'));
        return { ok: true, recording: !isRec, auto, autoSendEnter, timerText, recordingId };
      })();
      `,
      null,
      2000,
    );
    if (result === null) {
      // Renderer didn't respond inside the budget — log, release the
      // inflight guard via the outer finally, and let the user retry.
      appendMainLog("[shortcut] toggle aborted: renderer probe timed out (2s)");
      shortcutToggleInFlight = false;
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "renderer-probe-timeout" });
      return;
    }

    if (!result?.ok) {
      traceStep(trace, "renderer_toggle_failed", { result: result || null });
      await setRecordingStatus("App Loading");
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "renderer-toggle-failed" });
      return;
    }

    if (result.recording) {
      setCapturedPasteTarget(capturePasteTargetFromFrontInfo(front));
      keepCapturedTarget = true;
      traceStep(trace, "target_captured", {
        target: pasteTargetSummary(pasteTarget),
      });
      traceStep(trace, "recording_started", { auto: !!result.auto, timerText: result.timerText || "" });
      await beginRecordingStatusSession();
      traceEnd(trace, "recording-started", {});
      return;
    }

    if (result.auto) {
      traceStep(trace, "recording_stopped", { autoTranscribe: true, timerText: result.timerText || "" });
      enqueuePostStopTask({
        autoTranscribe: true,
        autoSendEnter: !!result.autoSendEnter,
        stopRequestedAt: Date.now(),
        recordingId: Number(result.recordingId || 0),
        target: pasteTarget,
      });
      stopRecordingStateMonitor();
    } else {
      traceStep(trace, "recording_stopped", { autoTranscribe: false, timerText: result.timerText || "" });
      // Kill recording monitor immediately — recording is done.
      stopRecordingStateMonitor();
      await setRecordingStatus("Saved To App");
      resetRecordingStatusState();
    }
    traceEnd(trace, "done", {});
  } finally {
    shortcutToggleInFlight = false;
    if (!keepCapturedTarget) {
      clearCapturedPasteTarget();
    }
  }
}

/**
 * Fire-and-forget wrapper for ``stopRecordingFromMainProcess`` with a
 * hard deadline. If the stop call hangs (e.g., renderer is
 * unresponsive), the recording state machine would be stuck with
 * ``recordingStopInFlight = true`` forever, permanently blocking new
 * recordings. This wrapper clears the flag on EVERY exit path —
 * resolve, reject, OR timeout — and resets recording status state if the stop
 * never completed.
 */
function guardedStopFromRecordingStatus(reason) {
  const deadlineMs = 12000;
  let settled = false;
  const finish = (why, err) => {
    if (settled) return;
    settled = true;
    recordingStopInFlight = false;
    if (err) {
      appendMainLog(`[recording-${reason}-error] ${compactLogText(err?.message || err)}`);
    } else if (why === "timeout") {
      appendMainLog(`[recording-${reason}-timeout] stopRecordingFromMainProcess exceeded ${deadlineMs}ms deadline`);
    }
    if (why !== "resolve") {
      resetRecordingStatusState();
    }
  };
  const timer = setTimeout(() => finish("timeout"), deadlineMs);
  stopRecordingFromMainProcess().then(
    () => {
      clearTimeout(timer);
      finish("resolve");
    },
    (err) => {
      clearTimeout(timer);
      finish("reject", err);
    }
  );
}

async function stopRecordingFromMainProcess() {
  await ensureBackgroundWindow();
  if (!win || win.isDestroyed() || !win.webContents) return;
  if (win.isVisible()) win.hide();

  try {
    const snapshot = await queryRendererRecordingState().catch(() => ({ recording: false, recordingId: 0 }));
    const expectedRecordingId = Number(snapshot?.recordingId || 0);
    const result = snapshot?.recording
      ? await execRendererJsWithTimeout(
        `
        (() => {
          const expectedRecordingId = ${JSON.stringify(expectedRecordingId)};
          const isRec = !!(window.__transcriptorIsRecording);
          const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
          const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
          const liveSnapshot = typeof window.__transcriptorLiveStatusSnapshot === 'function'
            ? window.__transcriptorLiveStatusSnapshot()
            : null;
          const timerText = String(liveSnapshot?.timerText || '00:00').trim();
          const autoSendEnter = !!(document.getElementById('autoSendEnterToggle') && document.getElementById('autoSendEnterToggle').classList.contains('active'));
          if (!isRec) return { ok: false, recording: false, timerText, recordingId, auto, autoSendEnter };
          if (expectedRecordingId > 0 && recordingId !== expectedRecordingId) {
            return { ok: false, recording: true, stale: true, timerText, recordingId, expectedRecordingId, auto, autoSendEnter };
          }
          // Use a dedicated stop event so main-process stops have one renderer entrypoint.
          window.dispatchEvent(new CustomEvent('transcriptor-hotkey-stop', { detail: { recordingId } }));
          return { ok: true, recording: false, timerText, recordingId, auto, autoSendEnter };
        })();
        `,
        null,
        2000,
      )
      : {
        ok: false,
        recording: false,
        timerText: "",
        recordingId: expectedRecordingId,
        auto: false,
        autoSendEnter: false,
      };

    if (!result) {
      appendMainLog("[recording-stop] renderer stop request timed out");
      await setRecordingStatus("App Loading");
      resetRecordingStatusState();
    } else if (result?.stale) {
      appendMainLog(
        `[recording-stop] stale stop ignored current=${Number(result.recordingId || 0)} expected=${Number(result.expectedRecordingId || 0)}`
      );
      await setRecordingStatus("Recording");
    } else if (result?.ok) {
      if (result.auto) {
        enqueuePostStopTask({
          autoTranscribe: true,
          autoSendEnter: !!result.autoSendEnter,
          stopRequestedAt: Date.now(),
          recordingId: Number(result.recordingId || 0),
          target: pasteTarget,
        });
        stopRecordingStateMonitor();
      } else {
        await setRecordingStatus("Saved To App");
        resetRecordingStatusState();
      }
    } else {
      await setRecordingStatus("Saved To App");
      resetRecordingStatusState();
    }
  } finally {
    clearCapturedPasteTarget();
  }
}

// Maximum time we wait on the renderer for a state snapshot. If the
// renderer is stuck (infinite loop, ongoing synchronous work, blocked
// on a pending IPC), ``executeJavaScript`` never resolves — and the
// recording stop path sits forever waiting for getLatestTranscriptText.
// 2 s is long enough for a healthy renderer under load but short
// enough that a stuck renderer still lets the user stop cleanly.
const RENDERER_STATE_QUERY_TIMEOUT_MS = 2000;

async function queryRendererState() {
  if (!win || win.isDestroyed() || !win.webContents) return null;
  // Attach a no-op ``.catch`` to the executeJavaScript promise up-front so
  // a late rejection (renderer crashes AFTER our Promise.race timeout
  // already gave up waiting) doesn't surface as an unhandledRejection in
  // the main process. We still return null via the timeoutPromise path —
  // the queryPromise's eventual settlement is intentionally discarded.
  const queryPromise = win.webContents.executeJavaScript(
    `
    (() => {
      const finishedAt = Number(window.__transcriptorLastFinishedAt || 0);
      const finishedRecordingId = Number(window.__transcriptorLastFinishedRecordingId || 0);
      const finishedText = String(window.__transcriptorLastFinishedText || '').trim();
      const uiFinalAt = Number(window.__transcriptorLastUiFinalAt || 0);
      const uiFinalRecordingId = Number(window.__transcriptorLastUiFinalRecordingId || 0);
      const uiFinalText = String(window.__transcriptorLastUiFinalText || '').trim();
      const uiFinalKind = String(window.__transcriptorLastUiFinalKind || '').trim();
      const finishedRecords = Array.isArray(window.__transcriptorFinishedRecords)
        ? window.__transcriptorFinishedRecords
          .map((x) => ({
            recordingId: Number((x && x.recordingId) || 0),
            finishedAt: Number((x && x.finishedAt) || 0),
            text: String((x && x.text) || '').trim(),
          }))
          .filter((x) => x.recordingId > 0 && x.finishedAt > 0 && x.text.length > 0)
          .slice(-30)
        : [];
      const isRec = !!(window.__transcriptorIsRecording);
      const liveSnapshot = typeof window.__transcriptorLiveStatusSnapshot === 'function'
        ? window.__transcriptorLiveStatusSnapshot()
        : null;
      const status = String(liveSnapshot?.status || '').trim();
      const finalText = (document.getElementById('finalOutput')?.textContent || '').trim();
      const liveText = (document.getElementById('liveOutput')?.textContent || '').trim();
      const busy = !!liveSnapshot?.busy;
      const progressVisible = document.getElementById('progressRow') ? !document.getElementById('progressRow').hidden : false;
      return {
        finishedAt,
        finishedRecordingId,
        finishedText,
        uiFinalAt,
        uiFinalRecordingId,
        uiFinalText,
        uiFinalKind,
        finishedRecords,
        isRec,
        status,
        finalText,
        liveText,
        busy,
        progressVisible,
      };
    })();
    `,
    true
  ).catch(() => null);
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      appendMainLog(
        `[renderer-state-query-timeout] ms=${RENDERER_STATE_QUERY_TIMEOUT_MS}`,
      );
      resolve(null);
    }, RENDERER_STATE_QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([queryPromise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function queryRendererRecordingState() {
  const state = await execRendererJsWithTimeout(
    `(() => ({ recording: !!window.__transcriptorIsRecording, recordingId: Number(window.__transcriptorCurrentRecordingId || 0) }))();`,
    { recording: false, recordingId: 0 },
    1000,
  );
  return state && typeof state === "object"
    ? state
    : { recording: false, recordingId: 0 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyCapturedPasteTarget() {
  return {
    appName: "",
    pid: 0,
    windowTitle: "",
    windowId: "",
    hwnd: "",
    className: "",
    instanceName: "",
  };
}

function normalizeCapturedPasteTarget(target) {
  const src = target && typeof target === "object" ? target : {};
  return {
    appName: String(src.appName ?? src.name ?? src.targetName ?? "").trim(),
    pid: Number.parseInt(String(src.pid ?? src.targetPid ?? 0), 10) || 0,
    windowTitle: String(src.windowTitle || "").trim(),
    windowId: normalizeLinuxWindowId(src.windowId || ""),
    hwnd: normalizeWindowsHwnd(src.hwnd || ""),
    className: String(src.className || "").trim(),
    instanceName: String(src.instanceName || "").trim(),
  };
}

function cloneCapturedPasteTarget(target) {
  return normalizeCapturedPasteTarget(target);
}

function hasCapturedPasteTarget(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  return (
    normalized.pid > 0 ||
    !!normalized.appName ||
    !!normalized.windowId ||
    !!normalized.hwnd
  );
}

function setCapturedPasteTarget(target) {
  pasteTarget = cloneCapturedPasteTarget(target);
}

function clearCapturedPasteTarget() {
  pasteTarget = emptyCapturedPasteTarget();
}

function capturePasteTargetFromFrontInfo(front) {
  if (!shouldUsePasteTarget(front)) return emptyCapturedPasteTarget();
  return normalizeCapturedPasteTarget({
    appName: front?.name,
    pid: front?.pid,
    windowTitle: front?.windowTitle,
    windowId: front?.windowId,
    hwnd: front?.hwnd,
    className: front?.className,
    instanceName: front?.instanceName,
  });
}

function pasteTargetSummary(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  return `app="${normalized.appName}" pid=${normalized.pid} windowTitle="${compactLogText(normalized.windowTitle, 80)}" windowId="${normalized.windowId}" hwnd="${normalized.hwnd}" class="${normalized.className}" instance="${normalized.instanceName}"`;
}

function getLastTranscriptPath() {
  try {
    return path.join(app.getPath("userData"), LAST_TRANSCRIPT_FILE);
  } catch {
    return "";
  }
}

/**
 * Sweep stale `last_transcript.json.tmp-*` files from userData on boot.
 * saveLastTranscriptToDisk writes via tmp+rename for atomicity; if
 * Electron crashes between write and rename, the tmp file lingers.
 * Over many crashes these accumulate. Called once at app.whenReady.
 *
 * Files modified within the last 60 s are preserved: the single-instance
 * lock prevents two Electron Transcriptor processes from running
 * concurrently, but a second-instance launch that loses the lock may
 * still have fired whenReady before app.quit() took effect. An mtime
 * floor ensures we never delete an in-flight tmp from the primary.
 */
function cleanupStaleTranscriptTmpFiles() {
  const p = getLastTranscriptPath();
  if (!p) return;
  const dir = path.dirname(p);
  const prefix = `${LAST_TRANSCRIPT_FILE}.tmp-`;
  const cutoff = Date.now() - 60_000;
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
      } catch { }
    }
  } catch { }
}

// Cache for the last-transcript file. Paste-last is triggered by a
// global hotkey and can fire rapidly; without a cache every press
// performed a synchronous stat + readFile + JSON.parse on the main
// process, blocking the Electron event loop. We key on the file's
// mtime so any external change (another process, manual edit,
// saveLastTranscriptToDisk) invalidates the cache automatically.
let _lastTranscriptCacheText = "";
let _lastTranscriptCacheMtimeMs = -1;

function loadLastTranscriptFromDisk() {
  const p = getLastTranscriptPath();
  if (!p) return "";
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    // File does not exist or stat failed — invalidate cache and return "".
    _lastTranscriptCacheText = "";
    _lastTranscriptCacheMtimeMs = -1;
    return "";
  }
  const mtimeMs = stat.mtimeMs;
  if (mtimeMs === _lastTranscriptCacheMtimeMs && _lastTranscriptCacheText) {
    return _lastTranscriptCacheText;
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const text = String(parsed?.text || "").trim();
    _lastTranscriptCacheText = text;
    _lastTranscriptCacheMtimeMs = mtimeMs;
    return text;
  } catch {
    _lastTranscriptCacheText = "";
    _lastTranscriptCacheMtimeMs = -1;
    return "";
  }
}

function saveLastTranscriptToDisk(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  const p = getLastTranscriptPath();
  if (!p) return;
  const payload = JSON.stringify({ text: cleaned, updated_at: new Date().toISOString() }, null, 2);
  // Atomic write: temp file in the SAME directory (same filesystem,
  // avoiding EXDEV on cross-volume rename), then fs.renameSync which is
  // atomic on POSIX and Windows. A crash mid-write leaves the tmp file
  // behind as garbage but the real file stays consistent.
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, p);
    _lastTranscriptCacheText = cleaned;
    try {
      _lastTranscriptCacheMtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      _lastTranscriptCacheMtimeMs = -1;
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    appendMainLog(`[save-last-transcript-error] ${compactLogText(e?.message || e)}`);
  }
}

function escapeAppleScriptString(s) {
  // AppleScript string literals terminate at CR/LF. A bare newline in a
  // target app name would break out of the quoted string and inject
  // arbitrary AppleScript. Strip all control characters AND escape
  // backslashes + quotes. Backslash must be replaced FIRST so the
  // subsequent ``"`` replacement doesn't double-escape its own slash.
  return String(s || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function isBadActivationTarget(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return true;
  // Exact matches only for our own process family. Previous substring
  // check on "transcriptor" would exclude third-party apps whose name
  // or window title contains the word (e.g. "Audio Transcriptor Pro",
  // a browser tab titled "Transcriptor tutorial", another voice tool).
  // Electron helpers have deterministic suffixes that substring match
  // is correct for.
  if (n === "electron" || n === "transcriptor" || n === "transcriptor helper") return true;
  if (n.includes("helper (renderer)") ||
      n.includes("helper (gpu)") ||
      n.includes("helper (plugin)") ||
      n.includes("electron helper")) return true;
  return false;
}

function shouldUsePasteTarget(front) {
  const pid = Number(front?.pid || 0);
  const name = String(front?.name || "").trim().toLowerCase();
  if (pid > 0 && pid === process.pid) return false;
  // Exact match for our own app; substring would block legitimate
  // third-party apps with "transcriptor" in their window title.
  if (name === "transcriptor" || name === "transcriptor helper") return false;
  if (!name && pid <= 0) return false;
  return true;
}

function looksLikeAutomationPermissionError(reason) {
  const r = String(reason || "").toLowerCase();
  return (
    r.includes("not authorized") ||
    r.includes("not permitted") ||
    r.includes("system events got an error") ||
    r.includes("-1743")
  );
}

function recordingStatusForPasteFailure(reason) {
  const r = String(reason || "").toLowerCase();
  // The transcript is ALWAYS written to the system clipboard before
  // the paste attempt (see ``clipboard.writeText(transcript)`` in
  // processPostStopTask), so every failure mode below still leaves
  // the text available via Cmd+V. We prefer a status that tells the
  // user their text is safe rather than one that just says
  // "failed" — "In Clipboard" is the clearest signal that recovery
  // is one keypress away. The explicit permission flows
  // (no-accessibility, automation) still open System Settings via
  // the separate callback path, so the user can grant access AND
  // knows the text survived.
  if (r.includes("no-accessibility")) return "In Clipboard · Grant Access";
  if (r.includes("secure-field")) return "In Clipboard · Secure Field";
  if (r.includes("no-focus") || r.includes("not-editable") || r.includes("ax-failed")) return "In Clipboard · No Focus";
  if (r.includes("clipboard")) return "Clipboard Error";
  if (looksLikeAutomationPermissionError(r)) return "In Clipboard · Grant Access";
  return "In Clipboard";
}

function openPrivacyAccessibilitySettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
    timeoutMs: 5000
  }).catch(() => { });
}

function openPrivacyAutomationSettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], {
    timeoutMs: 5000
  }).catch(() => { });
}

function isLinuxWaylandSession() {
  return process.platform === "linux" && !!process.env.WAYLAND_DISPLAY;
}

function hasLinuxX11Session() {
  return process.platform === "linux" && !!process.env.DISPLAY;
}

function normalizeWindowsHwnd(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-f]+$/i.test(hex)) return "";
  return `0x${hex.replace(/^0+/, "") || "0"}`;
}

function normalizeLinuxWindowId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const parsed = raw.startsWith("0x")
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  return `0x${parsed.toString(16)}`;
}

function linuxWindowIdToDecimal(value) {
  const normalized = normalizeLinuxWindowId(value);
  if (!normalized) return "";
  const parsed = Number.parseInt(normalized.slice(2), 16);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  return String(parsed);
}

function parseLinuxWmClass(value) {
  const raw = String(value || "").trim();
  const [instanceName = "", className = ""] = raw.split(".", 2);
  return {
    wmClass: raw,
    instanceName: instanceName.trim(),
    className: className.trim(),
  };
}

function normalizeLinuxMatchValue(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreLinuxTargetCandidate(candidate, target) {
  const c = normalizeLinuxMatchValue(candidate);
  const t = normalizeLinuxMatchValue(target);
  if (!c || !t) return 0;
  if (c === t) return 40;
  if (c.startsWith(`${t}.`) || c.endsWith(`.${t}`)) return 32;
  if (c.includes(t)) return 24;
  if (t.includes(c) && c.length >= 4) return 12;
  return 0;
}

async function getLinuxProcessName(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const res = await runCommand("ps", ["-p", String(Math.trunc(n)), "-o", "comm="], {
    timeoutMs: 1500
  });
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

async function listLinuxWindows() {
  if (!hasLinuxX11Session()) return [];
  const res = await runCommand("wmctrl", ["-lpGx"], { timeoutMs: 2000 });
  if (!res.ok) return [];
  const windows = [];
  const lines = String(res.stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const wmClassInfo = parseLinuxWmClass(m[9]);
    windows.push({
      windowId: normalizeLinuxWindowId(m[1]),
      desktop: Number.parseInt(m[2], 10) || 0,
      pid: Number.parseInt(m[3], 10) || 0,
      host: String(m[8] || "").trim(),
      wmClass: wmClassInfo.wmClass,
      instanceName: wmClassInfo.instanceName,
      className: wmClassInfo.className,
      title: String(m[10] || "").trim(),
    });
  }
  return windows;
}

function pickLinuxTargetName(windowInfo, processName = "") {
  const className = String(windowInfo?.className || "").trim();
  if (className) return className;
  const instanceName = String(windowInfo?.instanceName || "").trim();
  if (instanceName) return instanceName;
  const proc = String(processName || "").trim();
  if (proc) return proc;
  return String(windowInfo?.title || "").trim();
}

function scoreLinuxWindowMatch(windowInfo, targetName) {
  const weightedFields = [
    { value: windowInfo?.className, weight: 400 },
    { value: windowInfo?.instanceName, weight: 340 },
    { value: windowInfo?.wmClass, weight: 280 },
    { value: windowInfo?.title, weight: 180 },
  ];
  let best = 0;
  for (const field of weightedFields) {
    const score = scoreLinuxTargetCandidate(field.value, targetName);
    if (score > 0) {
      best = Math.max(best, field.weight + score);
    }
  }
  return best;
}

async function findLinuxWindowByPid(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  const windows = await listLinuxWindows();
  const matches = windows.filter((w) => Number(w.pid || 0) === Math.trunc(n));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => {
    const aScore = (a.title ? 10 : 0) + (a.className ? 5 : 0);
    const bScore = (b.title ? 10 : 0) + (b.className ? 5 : 0);
    return bScore - aScore;
  })[0] || null;
}

async function findLinuxWindowByName(name) {
  const targetName = String(name || "").trim();
  if (!targetName) return null;
  const windows = await listLinuxWindows();
  let bestWindow = null;
  let bestScore = 0;
  for (const winInfo of windows) {
    const score = scoreLinuxWindowMatch(winInfo, targetName);
    if (score > bestScore) {
      bestScore = score;
      bestWindow = winInfo;
    }
  }
  return bestWindow;
}

async function activateLinuxWindowById(windowId) {
  const normalizedId = normalizeLinuxWindowId(windowId);
  if (!normalizedId || !hasLinuxX11Session()) return false;
  const wmctrlRes = await runCommand("wmctrl", ["-ia", normalizedId], { timeoutMs: 1500 });
  if (wmctrlRes.ok) {
    await sleep(180);
    return true;
  }
  const decimalId = linuxWindowIdToDecimal(normalizedId);
  if (!decimalId) return false;
  const xdotoolRes = await runCommand("xdotool", ["windowactivate", "--sync", decimalId], {
    timeoutMs: 1500
  });
  if (!xdotoolRes.ok) return false;
  await sleep(180);
  return true;
}

async function getLinuxFrontmostAppInfo() {
  if (!hasLinuxX11Session()) return { name: "", pid: 0 };
  const activeRes = await runCommand("xdotool", ["getactivewindow"], { timeoutMs: 1500 });
  if (!activeRes.ok) return { name: "", pid: 0 };
  const activeWindowId = normalizeLinuxWindowId(activeRes.stdout || "");
  if (!activeWindowId) return { name: "", pid: 0 };
  const windows = await listLinuxWindows();
  const winInfo = windows.find((w) => w.windowId === activeWindowId) || null;
  const activeWindowDec = linuxWindowIdToDecimal(activeWindowId);
  let pid = Number(winInfo?.pid || 0);
  if (pid <= 0 && activeWindowDec) {
    const pidRes = await runCommand("xdotool", ["getwindowpid", activeWindowDec], { timeoutMs: 1500 });
    if (pidRes.ok) {
      pid = Number.parseInt(String(pidRes.stdout || "").trim(), 10) || 0;
    }
  }
  let title = String(winInfo?.title || "").trim();
  if (!title && activeWindowDec) {
    const titleRes = await runCommand("xdotool", ["getwindowname", activeWindowDec], { timeoutMs: 1500 });
    if (titleRes.ok) {
      title = String(titleRes.stdout || "").trim();
    }
  }
  const processName = pid > 0 ? await getLinuxProcessName(pid) : "";
  const name = pickLinuxTargetName({ ...winInfo, title }, processName);
  return {
    name,
    pid,
    windowId: activeWindowId,
    windowTitle: title,
    className: String(winInfo?.className || "").trim(),
    instanceName: String(winInfo?.instanceName || "").trim(),
  };
}

async function getFrontmostAppInfo() {
  if (process.platform === "win32") {
    const pwsh = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class Window {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
          [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
          [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
        }
"@
      $hwnd = [Window]::GetForegroundWindow()
      $pid = 0
      [Window]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      $titleSb = New-Object System.Text.StringBuilder 4096
      [Window]::GetWindowText($hwnd, $titleSb, $titleSb.Capacity) | Out-Null
      $classSb = New-Object System.Text.StringBuilder 512
      [Window]::GetClassName($hwnd, $classSb, $classSb.Capacity) | Out-Null
      $result = @{
        name = if ($proc) { $proc.Name } else { "" }
        pid = if ($proc) { $pid } else { 0 }
        hwnd = if ($hwnd -ne [IntPtr]::Zero) { ('0x{0:X}' -f ([Int64]$hwnd)) } else { "" }
        windowTitle = $titleSb.ToString()
        className = $classSb.ToString()
      }
      $result | ConvertTo-Json -Compress
    `;
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
    if (!res.ok) return { name: "", pid: 0 };
    try {
      const parsed = JSON.parse(String(res.stdout || "").trim() || "{}");
      return {
        name: String(parsed?.name || "").trim(),
        pid: Number.parseInt(String(parsed?.pid || "0").trim(), 10) || 0,
        hwnd: normalizeWindowsHwnd(parsed?.hwnd || ""),
        windowTitle: String(parsed?.windowTitle || "").trim(),
        className: String(parsed?.className || "").trim(),
      };
    } catch {
      return { name: "", pid: 0 };
    }
  }
  if (process.platform === "linux") {
    return getLinuxFrontmostAppInfo();
  }
  const script = `
    tell application "System Events"
      set p to first process whose frontmost is true
      set n to name of p
      set u to unix id of p
      set d to ASCII character 30
      set w to ""
      try
        set w to name of front window of p
      end try
      return (n as text) & d & (u as text) & d & (w as text)
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: 5000 });
  if (!res.ok) return { name: "", pid: 0 };
  const raw = String(res.stdout || "").trim();
  const [name, pidText, windowTitle] = raw.split(String.fromCharCode(30));
  return {
    name: String(name || "").trim(),
    pid: Number.parseInt(String(pidText || "0").trim(), 10) || 0,
    windowTitle: String(windowTitle || "").trim(),
  };
}

async function activateAppByName(name) {
  const appName = String(name || "").trim();
  if (!appName || isBadActivationTarget(appName)) return false;
  if (process.platform === "win32") {
    // PowerShell single-quoted strings do NOT interpolate: ``$var``,
    // ``$(expr)``, and backticks are all literal. Using single quotes
    // plus the canonical single-quote doubling escape ('') is the only
    // injection-safe way to embed untrusted data — here, an app name
    // that could (in principle) come from a process named something
    // like ``evil$(Invoke-Mimikatz)``. The previous double-quoted form
    // only escaped ``"`` and left ``$(...)`` subexpression evaluation
    // wide open.
    const escapedName = appName.replace(/'/g, "''");
    const pwsh = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Window {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      $proc = Get-Process -Name '${escapedName}' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($proc -and $proc.MainWindowHandle) {
        [Window]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Write-Output "1"
      } else { Write-Output "0" }
    `;
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
    if (!res.ok) return false;
    await sleep(350);
    return true;
  }
  if (process.platform === "linux") {
    const winInfo = await findLinuxWindowByName(appName);
    if (!winInfo) return false;
    return activateLinuxWindowById(winInfo.windowId);
  }
  const escaped = escapeAppleScriptString(appName);
  const res = await runCommand("osascript", ["-e", `tell application "${escaped}" to activate`], {
    timeoutMs: 5000
  });
  if (!res.ok) return false;
  await sleep(350);
  return true;
}

async function activateAppByPid(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (process.platform === "win32") {
    const pwsh = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Window {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      $proc = Get-Process -Id ${Math.trunc(n)} -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle) {
        [Window]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Write-Output "1"
      } else { Write-Output "0" }
    `;
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
    if (!res.ok) return false;
    return String(res.stdout || "").trim() === "1";
  }
  if (process.platform === "linux") {
    const winInfo = await findLinuxWindowByPid(n);
    if (!winInfo) return false;
    return activateLinuxWindowById(winInfo.windowId);
  }
  const script = `
    tell application "System Events"
      if exists (first process whose unix id is ${Math.trunc(n)}) then
        set frontmost of first process whose unix id is ${Math.trunc(n)} to true
        return "1"
      end if
      return "0"
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: 5000 });
  if (!res.ok) return false;
  return String(res.stdout || "").trim() === "1";
}

async function activateWindowsWindowByHwnd(hwnd) {
  const normalized = normalizeWindowsHwnd(hwnd);
  if (!normalized) return false;
  const hex = normalized.slice(2);
  const pwsh = `
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class Window {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
      }
"@
    $hwnd = [IntPtr]::new([Int64]::Parse('${hex}', [System.Globalization.NumberStyles]::AllowHexSpecifier))
    if ([Window]::IsWindow($hwnd)) {
      [Window]::ShowWindowAsync($hwnd, 5) | Out-Null
      [Window]::SetForegroundWindow($hwnd) | Out-Null
      Write-Output "1"
    } else {
      Write-Output "0"
    }
  `;
  const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
  if (!res.ok) return false;
  await sleep(180);
  return String(res.stdout || "").trim() === "1";
}

async function activateMacCapturedWindow(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  const escapedApp = escapeAppleScriptString(normalized.appName);
  const escapedTitle = escapeAppleScriptString(normalized.windowTitle);
  const pid = Number(normalized.pid || 0);
  const script = `
    set targetApp to "${escapedApp}"
    set targetPid to ${pid > 0 ? Math.trunc(pid) : 0}
    set targetWindowTitle to "${escapedTitle}"
    tell application "System Events"
      set p to missing value
      if targetPid > 0 then
        try
          if exists (first process whose unix id is targetPid) then
            set p to first process whose unix id is targetPid
          end if
        end try
      end if
      if p is missing value and targetApp is not "" then
        try
          if exists process targetApp then
            set p to process targetApp
          end if
        end try
      end if
      if p is missing value then return "0"
      set frontmost of p to true
      delay 0.08
      if targetWindowTitle is not "" then
        try
          if exists (first window of p whose name is targetWindowTitle) then
            set w to first window of p whose name is targetWindowTitle
            try
              perform action "AXRaise" of w
            end try
            try
              set value of attribute "AXMain" of w to true
            end try
            delay 0.08
          end if
        end try
      end if
      return "1"
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: 5000 });
  if (!res.ok) return false;
  return String(res.stdout || "").trim() === "1";
}

async function activateCapturedPasteTarget(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  if (!hasCapturedPasteTarget(normalized)) return false;
  if (process.platform === "win32") {
    if (normalized.hwnd) {
      const byHwnd = await activateWindowsWindowByHwnd(normalized.hwnd);
      if (byHwnd) return true;
    }
    if (normalized.pid > 0) {
      const byPid = await activateAppByPid(normalized.pid);
      if (byPid) return true;
    }
    if (normalized.appName) {
      return activateAppByName(normalized.appName);
    }
    return false;
  }
  if (process.platform === "linux") {
    if (normalized.windowId) {
      const byWindow = await activateLinuxWindowById(normalized.windowId);
      if (byWindow) return true;
    }
    if (normalized.pid > 0) {
      const byPid = await activateAppByPid(normalized.pid);
      if (byPid) return true;
    }
    if (normalized.appName) {
      return activateAppByName(normalized.appName);
    }
    return false;
  }
  return activateMacCapturedWindow(normalized);
}

async function requestMacPastePermissionsOnce() {
  if (process.platform !== "darwin") return;

  // Accessibility prompt (native macOS prompt).
  let trusted = false;
  try {
    trusted = !!systemPreferences.isTrustedAccessibilityClient(false);
  } catch { }
  if (!trusted) {
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch { }
  }

  // Automation prompt for System Events (Apple Events permission).
  const probe = await runCommand(
    "osascript",
    ["-e", 'tell application "System Events" to keystroke ""'],
    { timeoutMs: 7000 }
  );
  if (probe.ok) return;

  const reason = (probe.stderr || probe.stdout || "").trim();
  const message =
    "To auto-paste transcript into any app, allow Transcriptor in Accessibility and Automation (System Events).";
  const detail = reason ? `${message}\n\nmacOS response:\n${reason}` : message;
  const res = await dialog.showMessageBox({
    type: "info",
    buttons: ["Open Privacy Settings", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Grant macOS Permissions",
    message: "Enable permissions for auto-paste",
    detail
  });
  if (res.response === 0) {
    openPrivacyAccessibilitySettings();
    setTimeout(() => openPrivacyAutomationSettings(), 350);
  }
}

async function requestMacMicrophonePermissionOnce() {
  if (process.platform !== "darwin") return true;
  if (micPermissionChecked) {
    try {
      return systemPreferences.getMediaAccessStatus("microphone") === "granted";
    } catch {
      return true;
    }
  }
  micPermissionChecked = true;
  let status = "unknown";
  try {
    status = String(systemPreferences.getMediaAccessStatus("microphone") || "unknown");
  } catch { }
  if (status === "granted") return true;
  try {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    if (granted) return true;
  } catch { }
  const res = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Open Microphone Settings", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Microphone Access Required",
    message: "Transcriptor needs microphone permission to record audio.",
    detail: "Enable Transcriptor in System Settings -> Privacy & Security -> Microphone.",
  });
  if (res.response === 0) {
    runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"], {
      timeoutMs: 5000
    }).catch(() => { });
  }
  return false;
}

/**
 * Snapshot every clipboard format that Electron exposes so we can restore
 * the ORIGINAL clipboard after a paste — even when it held an image, RTF,
 * or a browser bookmark rather than plain text.
 *
 * If the original clipboard was completely empty the snapshot records
 * { formats: [] } and restoreClipboard will call clipboard.clear() instead
 * of leaving the transcript pinned on the clipboard permanently.
 */
function snapshotClipboard() {
  try {
    const formats = clipboard.availableFormats();
    const snap = { formats: formats || [] };
    if (!formats || formats.length === 0) return snap;
    snap.text = clipboard.readText();
    if (formats.some(f => /html/i.test(f))) { try { snap.html = clipboard.readHTML(); } catch { } }
    if (formats.some(f => /rtf/i.test(f))) { try { snap.rtf = clipboard.readRTF(); } catch { } }
    if (formats.some(f => /image|png|bitmap|tiff/i.test(f))) {
      try {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) { snap.image = img; snap.hasImage = true; }
      } catch { }
    }
    // macOS bookmark (URL + display title) — clipboard.readBookmark is macOS-only.
    if (formats.some(f => /url|bookmark/i.test(f))) {
      try { snap.bookmark = clipboard.readBookmark(); } catch { }
    }
    return snap;
  } catch {
    return { formats: [] };
  }
}

// Reference-counted snapshot of the user's REAL clipboard, captured
// at the FIRST paste of any chained-paste sequence. Without this,
// rapid F9-stop → F9-stop within the 1500 ms restore window has
// paste-2's `snapshotClipboard` capture paste-1's transcript as the
// "original" — paste-2's eventual restore then writes paste-1's
// transcript back onto the clipboard, permanently pinning it
// (the user's real clipboard is gone forever).
//
// acquireClipboardSnapshot:
//   - First paste: snapshots the clipboard (user's real content)
//     and stores it module-wide.
//   - Subsequent pastes during the restore window: return the SAME
//     snapshot. Increment depth.
//
// releaseClipboardSnapshot:
//   - Decrement depth. When the LAST outstanding paste finishes
//     (depth=0), clear the cached snapshot so the next paste-cycle
//     starts fresh.
//
// Both atomic under V8's single-threaded event loop — no extra lock
// needed, the increment/decrement pair runs synchronously between
// awaits.
let _clipboardSnapshotDepth = 0;
let _clipboardSnapshotCache = null;
function acquireClipboardSnapshot() {
  _clipboardSnapshotDepth += 1;
  if (_clipboardSnapshotCache === null) {
    _clipboardSnapshotCache = snapshotClipboard();
  }
  return _clipboardSnapshotCache;
}
function releaseClipboardSnapshot() {
  _clipboardSnapshotDepth = Math.max(0, _clipboardSnapshotDepth - 1);
  if (_clipboardSnapshotDepth === 0) {
    _clipboardSnapshotCache = null;
  }
}

/**
 * Smart clipboard restore.
 *
 * Waits for the paste to settle, then restores the user's original
 * clipboard — but ABORTS the restore if the clipboard contents
 * changed before we got there, which means the user intentionally
 * copied something new (Cmd+C on a different selection) during the
 * window. Without this guard the prior fixed-1200 ms setTimeout
 * could clobber the user's new copy, or could steal a second paste
 * (Cmd+V → gets transcript again) if the target app handled the
 * synthesised paste faster than 1200 ms.
 *
 * Algorithm:
 *   1. Wait INITIAL_DELAY_MS (400) so the target process reads the
 *      clipboard via the synthesised Cmd+V / Ctrl+V.
 *   2. Poll ``clipboard.readText()`` every POLL_INTERVAL_MS (200)
 *      up to MAX_WAIT_MS (1500) total.
 *      - If text still equals what WE wrote → keep waiting.
 *      - If text differs → user copied something else; ABORT restore
 *        (don't clobber).
 *   3. At MAX_WAIT_MS → restore snapshot.
 *
 * Note on rich clipboards: ``readText`` returns "" for image-only
 * clipboards, so Cmd+C on an image during the window → "" !==
 * writtenText → correctly aborts restore (user's image survives).
 */
function scheduleSmartClipboardRestore(snap, writtenText, logCtx = "paste:clipboardRestore") {
  const INITIAL_DELAY_MS = 400;
  const POLL_INTERVAL_MS = 200;
  const MAX_WAIT_MS = 1500;
  const expected = String(writtenText == null ? "" : writtenText);
  const startedAt = Date.now();

  const tryPollOrRestore = () => {
    const elapsed = Date.now() - startedAt;
    let current = "";
    try { current = String(clipboard.readText() || ""); } catch { current = ""; }
    if (current !== expected) {
      // User copied something new during the window. Abort the restore
      // so we don't clobber their new clipboard content. The original
      // snapshot is forever sacrificed here — acceptable trade-off,
      // otherwise we silently overwrite user intent.
      appendMainLog(`[${logCtx}] user copied new content during paste window; skipping restore`);
      releaseClipboardSnapshot();
      return;
    }
    if (elapsed >= MAX_WAIT_MS) {
      // Paste is settled, clipboard still has our text, no new user
      // copy arrived — safe to restore the original snapshot.
      safeExecSync(logCtx, () => restoreClipboard(snap));
      releaseClipboardSnapshot();
      return;
    }
    setTimeout(tryPollOrRestore, POLL_INTERVAL_MS);
  };
  setTimeout(tryPollOrRestore, INITIAL_DELAY_MS);
}

/** Restore a clipboard snapshot produced by snapshotClipboard(). */
function restoreClipboard(snap) {
  try {
    if (!snap || !snap.formats || snap.formats.length === 0) {
      // Original clipboard was genuinely empty — clear so we don't
      // leave the transcript pinned.
      clipboard.clear();
      return;
    }
    const writeObj = {};
    if (snap.text) writeObj.text = snap.text;
    if (snap.html) writeObj.html = snap.html;
    if (snap.rtf) writeObj.rtf = snap.rtf;
    if (snap.hasImage && snap.image) writeObj.image = snap.image;
    if (snap.bookmark && (snap.bookmark.title || snap.bookmark.url)) writeObj.bookmark = snap.bookmark;
    if (Object.keys(writeObj).length > 0) {
      clipboard.write(writeObj);
      return;
    }
    // Original clipboard held formats we can't read back (file URLs,
    // CF_HDROP, custom MIME types). Calling clipboard.clear() here
    // would destroy the user's file/URL reference — worse than
    // leaving our transcript pinned. Log and leave the clipboard as is.
    appendMainLog(
      `[clipboard-restore] unrecognised formats=${snap.formats.join(",")}; keeping transcript`
    );
  } catch {
    // Swallow any unexpected write/clear errors — we cannot recover.
  }
}

async function tryPasteToFocusedField(text, target = emptyCapturedPasteTarget()) {
  const originalTarget = normalizeCapturedPasteTarget(target);
  let effectiveTarget = cloneCapturedPasteTarget(originalTarget);
  const trace = createTrace("paste", {
    target: pasteTargetSummary(originalTarget),
    textLen: String(text || "").length,
    textDigest: textDigest(text),
    textPreview: compactLogText(text, 120),
  });
  if (!text || !text.trim()) {
    traceStep(trace, "input_rejected", { reason: "empty-text" });
    logPasteTrace("start_skip", { reason: "empty-text" });
    traceEnd(trace, "failed", { reason: "empty-text" });
    return { ok: false, reason: "empty-text", method: "none", verified: false };
  }
  let frontBefore = { name: "", pid: 0 };
  try {
    frontBefore = await getFrontmostAppInfo();
  } catch { }
  traceStep(trace, "front_before", {
    frontBeforeName: frontBefore.name || "",
    frontBeforePid: frontBefore.pid || 0,
    frontBeforeWindowTitle: compactLogText(frontBefore.windowTitle || "", 80),
  });
  const targetLooksGenericElectron = /^electron$/i.test(effectiveTarget.appName);
  if (targetLooksGenericElectron && shouldUsePasteTarget(frontBefore)) {
    effectiveTarget = capturePasteTargetFromFrontInfo(frontBefore);
    traceStep(trace, "target_normalized_from_front", {
      from: pasteTargetSummary(originalTarget),
      to: pasteTargetSummary(effectiveTarget),
      reason: "generic-electron-target",
    });
  } else if (targetLooksGenericElectron) {
    // Avoid routing by generic app name when we don't have a safe concrete pid.
    effectiveTarget.appName = "";
    traceStep(trace, "target_name_cleared", {
      from: pasteTargetSummary(originalTarget),
      reason: "generic-electron-without-safe-front",
    });
  }
  const targetHint = `${effectiveTarget.appName} ${effectiveTarget.windowTitle} ${String(frontBefore.name || "")}`.toLowerCase();
  const genericElectronTarget = /^electron$/i.test(effectiveTarget.appName);
  if (genericElectronTarget) {
    // For Electron-based third-party apps, process-level targeting can hit the shell process
    // instead of the real focused webview/editor. Force global frontmost route.
    traceStep(trace, "target_route_override", {
      from: pasteTargetSummary(effectiveTarget),
      reason: "generic-electron-use-frontmost-global",
    });
    effectiveTarget = emptyCapturedPasteTarget();
  }
  const preferTypedFirst = false;
  traceStep(trace, "paste_strategy", { preferTypedFirst, targetHint: compactLogText(targetHint, 80) });
  logPasteTrace("start", {
    target: pasteTargetSummary(effectiveTarget),
    frontBeforeName: frontBefore.name || "",
    frontBeforePid: frontBefore.pid || 0,
    textLen: String(text).length,
  });
  // Acquire the depth-counted shared snapshot. First paste captures
  // the user's REAL clipboard; subsequent pastes during the
  // 1500 ms restore window reuse the same snapshot so a chained
  // paste can never accidentally capture our own transcript as
  // the "original" content. Every code path below MUST eventually
  // call releaseClipboardSnapshot() so the cache clears when the
  // last outstanding paste resolves.
  const savedClipboard = acquireClipboardSnapshot();
  try {
    clipboard.writeText(String(text));
  } catch {
    traceStep(trace, "clipboard_write_failed", {});
    logPasteTrace("clipboard_write_failed", {});
    traceEnd(trace, "failed", { reason: "clipboard-write-failed" });
    // Restore original clipboard.
    safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
    releaseClipboardSnapshot();
    return { ok: false, reason: "clipboard-write-failed", method: "clipboard", verified: false };
  }
  traceStep(trace, "clipboard_write_ok", {});
  logPasteTrace("clipboard_write_ok", {});
  if (hasCapturedPasteTarget(effectiveTarget)) {
    try {
      const restored = await activateCapturedPasteTarget(effectiveTarget);
      traceStep(trace, restored ? "target_activated" : "target_activation_failed", {
        target: pasteTargetSummary(effectiveTarget),
      });
      await sleep(80);
    } catch { }
  }
  const escapedApp = escapeAppleScriptString(effectiveTarget.appName);
  const escapedWindowTitle = escapeAppleScriptString(effectiveTarget.windowTitle);
  const rawPid = Number.parseInt(String(effectiveTarget.pid || 0), 10) || 0;
  // Defense-in-depth: reject any value that is not a safe non-negative integer
  // before interpolating it into the AppleScript source string.
  const pid = (Number.isFinite(rawPid) && rawPid >= 0 && rawPid < 2 ** 31) ? Math.trunc(rawPid) : 0;
  const robustPasteScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${pid}
    set targetWindowTitle to "${escapedWindowTitle}"
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set p to missing value
      
      -- Priority 1: Target by exact Unix PID
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      end if
      
      -- Priority 2: Target by exact App Name
      if p is missing value and targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if
      
      -- Priority 3: Target whatever is frontmost right now
      if p is missing value then
        set p to first process whose frontmost is true
      end if
      
      if p is missing value then return "ERR:no-process"
      
      -- Fast path: bring target to front and send physical Cmd+V keycode.
      -- Avoid AXFocusedUIElement probing here because some apps block this call
      -- for several seconds and makes the recording status look stuck on transcribing.
      set frontmost of p to true
      delay 0.08
      if targetWindowTitle is not "" then
        try
          if exists (first window of p whose name is targetWindowTitle) then
            set w to first window of p whose name is targetWindowTitle
            try
              perform action "AXRaise" of w
            end try
            try
              set value of attribute "AXMain" of w to true
            end try
            delay 0.05
          end if
        end try
      end if
      
      -- Perform physical V key press (key code 9) + Cmd
      -- This bypasses keyboard layout issues (like Russian "м") where keystroke "v" fails
      tell p
        key code 9 using {command down}
      end tell
      
      delay 0.10
      return "OK:robust-paste"
    end tell
  `;

  const textLen = String(text || "").length;

  let lastReason = "paste-no-attempt";

  // ── Enterprise Paste Logic ──
  // Clipboard is already populated synchronously via Electron before we get here.
  
  if (process.platform === "win32") {
    // Windows paste strategy:
    //
    // Method 1 (fast): Write a temporary .vbs script that calls
    // WScript.Shell.SendKeys "^v" (Ctrl+V). This is instantaneous
    // compared to the old PowerShell path which compiled C# inline
    // on every attempt (~2-3 seconds per try, often timing out).
    //
    // Method 2 (fallback): PowerShell with SendKeys as a last resort
    // if VBS is blocked by group policy.
    //
    // Both methods require the clipboard to be populated BEFORE the
    // keypress fires, which we do via Electron's clipboard.writeText
    // synchronously.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { clipboard.writeText(String(text)); } catch { }
      await sleep(30 + attempt * 30);
      if (hasCapturedPasteTarget(effectiveTarget)) {
        await activateCapturedPasteTarget(effectiveTarget).catch(() => false);
        await sleep(70);
      }

      logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "win_paste" });
      traceStep(trace, "method_begin", { method: "win_paste", attempt: attempt + 1 });

      const cmdStarted = Date.now();

      // Fast path: VBS SendKeys — no compilation, no .NET assembly
      // loading, executes in <100 ms on all Windows versions.
      // Use a per-invocation UUID rather than Date.now() — two paste
      // operations in the same millisecond (chained autosend, dual
      // hotkey press) collided on the same temp filename, and the
      // first's `unlinkSync` could delete the second's script
      // mid-execution. crypto.randomUUID is in Node 14.17+ so it's
      // safe in our Electron 30 build.
      const vbsPath = path.join(
        app.getPath("temp"),
        `transcriptor_paste_${require("crypto").randomUUID()}.vbs`,
      );
      try {
        const vbsLines = [
          'Set WshShell = CreateObject("WScript.Shell")',
        ];
        // Activate target window by PID/name only when we do not have an
        // exact HWND-level restore already performed above.
        if (!effectiveTarget.hwnd && effectiveTarget.pid > 0) {
          vbsLines.push(`WshShell.AppActivate ${Math.trunc(effectiveTarget.pid)}`);
          vbsLines.push('WScript.Sleep 80');
        } else if (!effectiveTarget.hwnd && effectiveTarget.appName) {
          // VBS string literals are terminated by CR/LF — a target name
          // that contains a newline would break out of the quoted string
          // and inject arbitrary VBS into the script. Doubling the ``"``
          // is the standard VBS escape; stripping CR/LF + NUL + all other
          // control characters prevents any line-break-based escape.
          // effectiveTarget.appName comes from the Windows process table, so
          // the attack surface is small (a process would have to register
          // with a pathological name), but the one-line fix is free.
          const sanitizedName = effectiveTarget.appName
            .replace(/[\x00-\x1f\x7f]/g, "")
            .replace(/"/g, '""');
          vbsLines.push(`WshShell.AppActivate "${sanitizedName}"`);
          vbsLines.push('WScript.Sleep 80');
        }
        vbsLines.push('WScript.Sleep 30');
        vbsLines.push('WshShell.SendKeys "^v"');
        vbsLines.push('WScript.Echo "OK:vbs-paste"');

        // Write as UTF-16 LE with BOM. Windows cscript/wscript decode
        // .vbs files using the system's ANSI code page (CP-1251 / CP-932
        // / Windows-1252) unless the file starts with a UTF-16 LE BOM.
        // A Russian user targeting a window titled "Телеграм" would
        // otherwise see UTF-8 bytes interpreted as CP-1251 gibberish,
        // AppActivate fails silently, and SendKeys hits whichever
        // process is foreground — usually Transcriptor itself.
        const vbsSource = vbsLines.join("\r\n");
        const vbsBuf = Buffer.concat([
          Buffer.from([0xFF, 0xFE]),           // UTF-16 LE BOM
          Buffer.from(vbsSource, "utf16le"),
        ]);
        fs.writeFileSync(vbsPath, vbsBuf);
        // 5000 ms (was 2500): on Windows 11 with Defender real-time
        // scanning, cscript launch can spend 1–3 s in AV scan before
        // the script body executes. The previous 2.5 s budget made
        // VBS paste fail on these machines and fall through to the
        // slower PowerShell path with no functional benefit.
        const check = await runCommand("cscript", ["//Nologo", "//B", "//U", vbsPath], { timeoutMs: 5000 });

        // Clean up temp file
        try { fs.unlinkSync(vbsPath); } catch { }

        if (check.ok) {
          traceEnd(trace, "success", { method: "vbs_paste", attempt: attempt + 1, reason: "vbs_success", verified: false });
          scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:vbs");
          return { ok: true, reason: "OK:vbs_paste", method: "vbs_paste", verified: false };
        }
        lastReason = (check.stderr || check.stdout || "vbs-failed").trim();
      } catch (e) {
        try { fs.unlinkSync(vbsPath); } catch { }
        lastReason = `vbs-error: ${e?.message || e}`;
      }

      // Fallback: lightweight PowerShell (no C# compilation).
      // Activate the captured target PID FIRST via SetForegroundWindow
      // — otherwise SendKeys fires at whatever has focus when the
      // hotkey was pressed (often Transcriptor itself), and the
      // text lands in the wrong window.
      if (attempt === 2) {
        const pidNum = Number.parseInt(String(effectiveTarget.pid || 0), 10) || 0;
        const safePid = (Number.isFinite(pidNum) && pidNum > 0 && pidNum < 2 ** 31) ? Math.trunc(pidNum) : 0;
        const safeHwnd = normalizeWindowsHwnd(effectiveTarget.hwnd || "");
        const hwndHex = safeHwnd ? safeHwnd.slice(2) : "";
        // Inside a JS template literal (backtick-delimited), `"` is not
        // a special character and MUST NOT be escaped. The over-escaped
        // `\\"user32.dll\\"` version produced literal `\"user32.dll\"`
        // in the PowerShell source, which was then invalid C# inside
        // Add-Type (CS1056: unexpected character '\'). See the sibling
        // PowerShell blocks in getFrontmostAppInfo / getFrontmostAppName
        // for the correct unescaped form.
        const activateBlock = safeHwnd ? (
          `Add-Type @"\n` +
          `using System;\n` +
          `using System.Runtime.InteropServices;\n` +
          `public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd); }\n` +
          `"@;\n` +
          `try { $h = [IntPtr]::new([Int64]::Parse('${hwndHex}', [System.Globalization.NumberStyles]::AllowHexSpecifier)); [W]::ShowWindowAsync($h, 5) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 120 } catch {};`
        ) : safePid > 0 ? (
          `Add-Type @"\n` +
          `using System;\n` +
          `using System.Runtime.InteropServices;\n` +
          `public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }\n` +
          `"@;\n` +
          `try { $p = Get-Process -Id ${safePid} -ErrorAction Stop; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 120 } catch {};`
        ) : "";
        const pwshSimple = `${activateBlock}Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^{v}"); Write-Output "OK:pwsh-paste"`;
        const fallback = await runCommand("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", pwshSimple], { timeoutMs: 3000 });
        if (fallback.ok && (fallback.stdout || "").includes("OK:")) {
          traceEnd(trace, "success", { method: "pwsh_paste_fallback", attempt: attempt + 1 });
          scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:pwsh_fallback");
          return { ok: true, reason: "OK:pwsh_paste_fallback", method: "pwsh_paste_fallback", verified: false };
        }
        lastReason = (fallback.stderr || fallback.stdout || "pwsh-fallback-failed").trim();
      }
    }
  } else if (process.platform === "linux") {
    // ─ Linux paste cascade ─────────────────────────────────────────
    //
    // Linux has no single canonical paste API — the active display
    // server dictates which tool can send synthesised keystrokes:
    //
    //   * X11: xdotool (well-established, installed by setup.sh).
    //   * Wayland (GNOME/KDE/Sway/wlroots): wtype — stateless Wayland
    //     virtual-keyboard injector. Works on most compositors that
    //     expose the virtual-keyboard-v1 protocol.
    //   * Wayland fallback when wtype is blocked: ydotool — userland
    //     uinput driver; requires the user to be in the ``input``
    //     group but bypasses the compositor protocol entirely.
    //
    // The cascade: wtype → xdotool → ydotool. Each tool's exit code
    // tells us truthfully whether the keystroke landed; we don't
    // second-guess via focus polling (Linux has no stable per-window
    // "activate and paste" API like AppleScript's ``tell process``).
    //
      // Window activation: for captured X11 targets we restore the
      // exact window id first; on Wayland there is no standard cross-
      // compositor restore API, so we rely on the compositor's current
      // focus and then send the paste keystroke.
    // $WAYLAND_DISPLAY is set on any Wayland session (pure Wayland or
    // XWayland hybrid). GNOME and KDE on Wayland set BOTH WAYLAND_DISPLAY
    // and DISPLAY — the old check (&&!DISPLAY) incorrectly treated them
    // as X11-only and never tried wtype. Correct check: Wayland whenever
    // WAYLAND_DISPLAY is present, X11-only when only DISPLAY is set.
    const isWayland = !!process.env.WAYLAND_DISPLAY;
    const hasX11 = !!process.env.DISPLAY;

    for (let attempt = 0; attempt < 3; attempt++) {
      try { clipboard.writeText(String(text)); } catch { }
      await sleep(30 + attempt * 30);

      logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "linux_paste" });
      traceStep(trace, "method_begin", { method: "linux_paste", attempt: attempt + 1, wayland: isWayland });

      if (hasCapturedPasteTarget(effectiveTarget)) {
        await activateCapturedPasteTarget(effectiveTarget).catch(() => false);
        await sleep(60);
      }

      // Build ordered cascade for the detected session type.
      // Wayland (pure or hybrid): wtype → ydotool → xdotool (for XWayland apps).
      // X11 only: xdotool → ydotool (fallback).
      const attempts = [];
      if (isWayland) {
        attempts.push({
          method: "wtype",
          cmd: "wtype",
          args: ["-M", "ctrl", "v", "-m", "ctrl"],
          timeoutMs: 2000,
        });
        attempts.push({
          method: "ydotool",
          cmd: "ydotool",
          args: ["key", "29:1", "47:1", "47:0", "29:0"],
          timeoutMs: 2000,
        });
        // On XWayland hybrid sessions the target may be an X11 app —
        // xdotool works for those even inside a Wayland compositor.
        if (hasX11) {
          attempts.push({
            method: "xdotool",
            cmd: "xdotool",
            args: ["key", "--clearmodifiers", "ctrl+v"],
            timeoutMs: 2000,
          });
        }
      } else {
        // Pure X11 session.
        attempts.push({
          method: "xdotool",
          cmd: "xdotool",
          args: ["key", "--clearmodifiers", "ctrl+v"],
          timeoutMs: 2000,
        });
        attempts.push({
          method: "ydotool",
          cmd: "ydotool",
          args: ["key", "29:1", "47:1", "47:0", "29:0"],
          timeoutMs: 2000,
        });
      }

      let methodOk = false;
      let lastPasteErr = "";
      for (const a of attempts) {
        const cmdStarted = Date.now();
        const res = await runCommand(a.cmd, a.args, { timeoutMs: a.timeoutMs });
        traceStep(trace, "method_result", {
          method: a.method,
          attempt: attempt + 1,
          ms: Date.now() - cmdStarted,
          ok: !!res.ok,
          code: res.code,
          stderr: compactLogText(res.stderr),
        });
        if (res.ok) {
          methodOk = true;
          traceEnd(trace, "success", { method: a.method, attempt: attempt + 1, reason: `${a.method}_ok`, verified: false });
          scheduleSmartClipboardRestore(savedClipboard, text, `paste:clipboardRestore:${a.method}`);
          return { ok: true, reason: `OK:${a.method}`, method: a.method, verified: false };
        }
        lastPasteErr = (res.stderr || res.stdout || `${a.method}-failed`).trim();
      }
      if (!methodOk) {
        lastReason = lastPasteErr || "linux-paste-failed";
      }
    }
  } else {
    // macOS AppleScript 'key code 9'
    for (let attempt = 0; attempt < 3; attempt++) {
    // Refresh clipboard just in case OS flushed it
    try { clipboard.writeText(String(text)); } catch { }
    await sleep(45 + attempt * 40);

    logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "robust_paste" });
    traceStep(trace, "method_begin", { method: "robust_paste", attempt: attempt + 1 });

    const cmdStarted = Date.now();
    const check = await runCommand("osascript", ["-e", robustPasteScript], { timeoutMs: 3200 });

    traceStep(trace, "method_result", {
      method: "robust_paste",
      attempt: attempt + 1,
      ms: Date.now() - cmdStarted,
      ok: !!check.ok,
      code: check.code,
      stdout: compactLogText(check.stdout),
      stderr: compactLogText(check.stderr),
    });
    logPasteTrace("robust_paste_result", {
      attempt: attempt + 1,
      ok: !!check.ok,
      code: check.code,
      stdout: compactLogText(check.stdout),
      stderr: compactLogText(check.stderr),
    });

    if (check.ok) {
      const out = (check.stdout || "").trim();
      if (out.startsWith("OK:")) {
        logPasteTrace("success", { method: "robust_paste", attempt: attempt + 1, reason: out });
        traceEnd(trace, "success", { method: "robust_paste", attempt: attempt + 1, reason: out, verified: false });
        // Restore previous clipboard cleanly since paste was successful
        scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:robust_paste");
        return { ok: true, reason: out, method: "robust_paste", verified: false };
      }
      if (out === "ERR:secure-field") {
        traceEnd(trace, "failed", { reason: "secure-field" });
        safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
        releaseClipboardSnapshot();
        return { ok: false, reason: "secure-field", method: "robust_paste", verified: false };
      }
      if (out === "ERR:no-accessibility") {
        lastReason = "no-accessibility";
      } else {
        lastReason = out || "paste-return-unknown";
      }
    } else {
      lastReason = (check.stderr || check.stdout || "osascript-failed").trim();
    }
  }
  } // end macOS block

  // Secondary fallback: trigger Edit -> Paste menu item in target process.
  // macOS-only — uses AppleScript ``System Events`` which doesn't exist
  // on Win/Linux. Without this guard, the post-Win/Linux fallthrough
  // ran the osascript spawn anyway, hit ENOENT (no osascript binary),
  // overwrote ``lastReason`` with the bogus spawn-error string, and
  // surfaced a useless "spawn osascript ENOENT" status to the user
  // instead of the real Win/Linux paste-failure cause. Skip directly
  // to the consolidated failure path which restores the clipboard +
  // releases the snapshot symmetrically with the success branches.
  if (process.platform !== "darwin") {
    try { restoreClipboard(savedClipboard); } catch { }
    releaseClipboardSnapshot();
    traceEnd(trace, "failed", { reason: lastReason || "paste-no-attempt", method: "exhausted" });
    logPasteTrace("failed", { reason: compactLogText(lastReason || "paste-no-attempt") });
    return {
      ok: false,
      reason: lastReason || "paste-no-attempt",
      method: "exhausted",
      verified: false,
    };
  }
  const menuPasteScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set p to missing value
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      end if
      if p is missing value and targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if
      if p is missing value then
        set p to first process whose frontmost is true
      end if
      if p is missing value then return "ERR:no-process"
      set frontmost of p to true
      delay 0.32
      try
        click menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1 of p
        delay 0.16
        return "OK:menu-paste"
      on error errMsg
        return "ERR:menu-paste:" & errMsg
      end try
    end tell
  `;
  const menuRes = await runCommand("osascript", ["-e", menuPasteScript], { timeoutMs: 4500 });
  traceStep(trace, "menu_paste_result", {
    ok: !!menuRes.ok,
    code: menuRes.code,
    stdout: compactLogText(menuRes.stdout),
    stderr: compactLogText(menuRes.stderr),
  });
  if (menuRes.ok) {
    const out = String(menuRes.stdout || "").trim();
    if (out.startsWith("OK:")) {
      scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:menu");
      traceEnd(trace, "success", { method: "menu-paste", reason: out, verified: false });
      return { ok: true, reason: out, method: "menu-paste", verified: false };
    }
    lastReason = out || lastReason;
  } else {
    lastReason = String(menuRes.stderr || menuRes.stdout || lastReason || "menu-paste-failed").trim();
  }

  // Exhausted all robust attempts
  let frontAfter = { name: "", pid: 0 };
  try {
    frontAfter = await getFrontmostAppInfo();
  } catch { }
  traceStep(trace, "front_after", {
    frontAfterName: frontAfter.name || "",
    frontAfterPid: frontAfter.pid || 0,
  });
  logPasteTrace("failed", {
    reason: compactLogText(lastReason),
    frontAfterName: frontAfter.name || "",
    frontAfterPid: frontAfter.pid || 0,
  });
  traceEnd(trace, "failed", {
    reason: compactLogText(lastReason),
    finalMethod: "failed",
  });
  // Restore original clipboard whether paste succeeded or all methods failed.
  try { restoreClipboard(savedClipboard); } catch { }
  releaseClipboardSnapshot();
  return { ok: false, reason: lastReason, method: "failed", verified: false };
}

async function sendCommandEnterToFocusedApp(target = emptyCapturedPasteTarget()) {
  const normalized = normalizeCapturedPasteTarget(target);
  if (hasCapturedPasteTarget(normalized)) {
    await activateCapturedPasteTarget(normalized);
    await sleep(110);
  }
  
  if (process.platform === "win32") {
      const pwsh = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("^{ENTER}")
      `;
      const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 3200 });
      if (res.ok) {
        return { ok: true, reason: "powershell-ctrl-enter-sent" };
      }
      return { ok: false, reason: String(res.stderr || res.stdout || "powershell-ctrl-enter-failed") };
  }

  if (process.platform === "linux") {
    const attempts = [];
    if (isLinuxWaylandSession()) {
      attempts.push({
        method: "wtype-ctrl-enter",
        cmd: "wtype",
        args: ["-M", "ctrl", "-P", "Return", "-p", "Return", "-m", "ctrl"],
        timeoutMs: 2000,
      });
      attempts.push({
        method: "ydotool-ctrl-enter",
        cmd: "ydotool",
        args: ["key", "29:1", "28:1", "28:0", "29:0"],
        timeoutMs: 2000,
      });
      if (hasLinuxX11Session()) {
        attempts.push({
          method: "xdotool-ctrl-enter",
          cmd: "xdotool",
          args: ["key", "--clearmodifiers", "ctrl+Return"],
          timeoutMs: 2000,
        });
      }
    } else {
      attempts.push({
        method: "xdotool-ctrl-enter",
        cmd: "xdotool",
        args: ["key", "--clearmodifiers", "ctrl+Return"],
        timeoutMs: 2000,
      });
      attempts.push({
        method: "ydotool-ctrl-enter",
        cmd: "ydotool",
        args: ["key", "29:1", "28:1", "28:0", "29:0"],
        timeoutMs: 2000,
      });
    }

    let lastReason = "linux-ctrl-enter-no-attempt";
    for (const attempt of attempts) {
      const res = await runCommand(attempt.cmd, attempt.args, { timeoutMs: attempt.timeoutMs });
      if (res.ok) {
        return { ok: true, reason: attempt.method };
      }
      lastReason = String(res.stderr || res.stdout || `${attempt.method}-failed`).trim();
    }
    return { ok: false, reason: lastReason };
  }

  const primary = `
    tell application "System Events"
      keystroke return using command down
    end tell
  `;
  const res1 = await runCommand("osascript", ["-e", primary], { timeoutMs: 5000 });
  if (res1.ok) {
    return { ok: true, reason: "cmd-return-sent" };
  }
  const fallback = `
    tell application "System Events"
      key code 36 using command down
    end tell
  `;
  const res2 = await runCommand("osascript", ["-e", fallback], { timeoutMs: 5000 });
  if (res2.ok) {
    return { ok: true, reason: "cmd-enter-keycode-sent" };
  }
  const reason = String(res2.stderr || res2.stdout || res1.stderr || res1.stdout || "cmd-enter-failed").trim();
  return { ok: false, reason };
}

// Tracks recordingIds that have already been enqueued or processed
// in this app session. enqueuePostStopTask dedupes against this set
// so a single recording can never produce two paste events.
//
// User report (1 May 2026, Telegram screenshot showed duplicated text):
//   "Сергей, привет... Просто расскажу,"           ← interim-final paste
//   "Сергей, привет... Просто расскажу кратко..."  ← later final paste
// The two halves both started with the exact same opening sentence —
// classic two-paste-of-same-recording symptom. Two entry points feed
// enqueuePostStopTask:
//   * toggleRecordingFromShortcut() — fired by Alt+Left hotkey
//   * stopRecordingFromMainProcess()    — fired by main-process auto-stop,
//                                     wrapped in guardedStopFromRecordingStatus
// They use SEPARATE in-flight flags (shortcutToggleInFlight vs
// recordingStopInFlight). A press-and-click sequence within ~50 ms can
// invoke both before either flag has been observed, producing TWO
// enqueuePostStopTask calls for the SAME recordingId — two
// transcript polls, two clipboard writes, two AppleScript Cmd+V's.
// Dedup at the enqueue gate is the simplest enterprise-correct fix:
// recordingId is monotonic (++liveRecordingSeq in startLive), unique
// per recording, and already on the task. We track up to 4096
// recordingIds (~weeks of normal usage) and roll the oldest out.
const _enqueuedRecordingIds = new Set();
const _ENQUEUED_RECORDING_IDS_CAP = 4096;
function enqueuePostStopTask(options = {}) {
  const task = {
    autoTranscribe: !!options.autoTranscribe,
    autoSendEnter: !!options.autoSendEnter,
    stopRequestedAt: Number(options.stopRequestedAt || Date.now()),
    recordingId: Number(options.recordingId || 0),
    target: normalizeCapturedPasteTarget(options.target),
  };
  if (!task.autoTranscribe) return;
  // Dedup by recordingId. recordingId === 0 is the legacy fallback
  // (renderer didn't supply one, very old build); skip dedup for
  // those so the legacy path still works at least once. Modern
  // renderers always send a positive monotonic id.
  if (task.recordingId > 0) {
    if (_enqueuedRecordingIds.has(task.recordingId)) {
      appendMainLog(
        `[post-stop-queue] dedup-skipped rec=${task.recordingId} ` +
        `(already enqueued; preventing double-paste)`
      );
      return;
    }
    _enqueuedRecordingIds.add(task.recordingId);
    // Roll the oldest entry out when the cap is reached.
    if (_enqueuedRecordingIds.size > _ENQUEUED_RECORDING_IDS_CAP) {
      const iter = _enqueuedRecordingIds.values();
      const oldest = iter.next().value;
      if (oldest !== undefined) _enqueuedRecordingIds.delete(oldest);
    }
  }
  postStopQueue.push(task);
  pendingTranscriptionCount += 1;
  appendMainLog(`[post-stop-queue] enqueue pending=${pendingTranscriptionCount} rec=${task.recordingId} ${pasteTargetSummary(task.target)}`);
  void runPostStopQueue();
}

async function runPostStopQueue() {
  if (postStopWorkerRunning) return;
  postStopWorkerRunning = true;
  try {
    while (postStopQueue.length > 0) {
      const task = postStopQueue.shift();
      if (!task) continue;
      // One accounting block per task: the decrement is guaranteed
      // to happen exactly once even if any step below throws, so the
      // counter can never drift above the real number of pending
      // tasks. The outer try/finally (at the function bottom) drains
      // any remaining queue entries on catastrophic failure.
      try {
        try {
          await processPostStopTask(task);
        } catch (e) {
          appendMainLog(`[post-stop-queue] task-error rec=${task.recordingId} err="${compactLogText(e?.message || e)}"`);
          await setRecordingStatus("Saved To App").catch(() => { });
        }
      } finally {
        pendingTranscriptionCount = Math.max(0, pendingTranscriptionCount - 1);
      }
      if (pendingTranscriptionCount > 0) {
        await setRecordingStatus("Transcribing").catch(() => { });
      } else {
        resetRecordingStatusState();
      }
    }
  } finally {
    // Catastrophic exit — drop any tasks the loop could not reach so
    // the counter can never outlive the queue and produce a phantom
    // "N queued" indicator the user cannot clear.
    if (postStopQueue.length > 0) {
      const dropped = postStopQueue.length;
      postStopQueue = [];
      pendingTranscriptionCount = Math.max(0, pendingTranscriptionCount - dropped);
      appendMainLog(`[post-stop-queue] drained dropped=${dropped}`);
    }
    postStopWorkerRunning = false;
  }
}

// Second-line dedup: tracks recordingIds that have ACTUALLY been pasted.
// Even if ``_enqueuedRecordingIds`` somehow lets a duplicate through
// (future bug, edge race, recordingId==0 legacy path), this gate
// blocks the second paste before it reaches the AppleScript / VBS /
// xdotool key-injection. Belt-and-braces over the enqueue dedup.
const _pastedRecordingIds = new Set();
const _PASTED_RECORDING_IDS_CAP = 4096;
function _markRecordingPasted(recordingId) {
  if (!recordingId || recordingId <= 0) return;
  _pastedRecordingIds.add(recordingId);
  if (_pastedRecordingIds.size > _PASTED_RECORDING_IDS_CAP) {
    const oldest = _pastedRecordingIds.values().next().value;
    if (oldest !== undefined) _pastedRecordingIds.delete(oldest);
  }
}

async function processPostStopTask(task) {
  const trace = createTrace("post_stop", { autoTranscribe: !!task.autoTranscribe, queuePending: pendingTranscriptionCount });
  // SECOND-LINE DEDUP — even if the same recordingId reaches this
  // function through some path that bypassed _enqueuedRecordingIds
  // (defensive against future regressions, the legacy recordingId==0
  // exemption path, or any race that pushes directly into postStop
  // Queue), refuse to paste a recording that already produced one.
  if (task.recordingId > 0 && _pastedRecordingIds.has(task.recordingId)) {
    appendMainLog(
      `[post-stop-paste] dedup-skipped rec=${task.recordingId} ` +
      `(already pasted; second-line guard fired)`,
    );
    traceEnd(trace, "skipped", { reason: "already-pasted" });
    return;
  }
  // Bound post-stop wait to the renderer's live-recovery SLA. Fast paths
  // exit immediately on paste-ready; this ceiling only protects the
  // rare "stream dropped, REST/local recovery is still running" case.
  // Mirrors the renderer's slow-path SLA: Deepgram final envelope
  // (up to ~4s) + REST/local recovery hard cap (20s) + bounded live
  // paste-upscale wait (3s) + disk/IPC headroom. Fast paths exit on
  // the first paste-ready signal, so increasing this ceiling does not
  // add latency to healthy recordings; it only prevents legitimate
  // slow recovery from degrading into "Saved To App" with no paste.
  const POST_STOP_TRANSCRIPT_TIMEOUT_MS = 32000;
  const deadline = Date.now() + POST_STOP_TRANSCRIPT_TIMEOUT_MS;
  let transcript = "";
  let pollCount = 0;
  const stopRequestedAt = Number(task.stopRequestedAt || Date.now());
  let recordingStatusPhase = "";
  let doneStatusTranscriptSince = 0;

  while (Date.now() < deadline) {
    pollCount += 1;
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "poll_window_lost", { pollCount });
      await sleep(70);
      continue;
    }
    const state = await queryRendererState();
    if (!state) {
      traceStep(trace, "poll_js_error", { pollCount });
      await sleep(70);
      continue;
    }
    const statusLower = String(state.status || "").trim().toLowerCase();
    if (!state.isRec) {
      if (statusLower === "upscaling" && recordingStatusPhase !== "upscaling") {
        await setRecordingStatus("Upscaling");
        recordingStatusPhase = "upscaling";
      } else if ((statusLower === "processing" || statusLower === "transcribing") && recordingStatusPhase !== "transcribing") {
        await setRecordingStatus("Transcribing");
        recordingStatusPhase = "transcribing";
      }
    }
    const finishedRecords = Array.isArray(state.finishedRecords) ? state.finishedRecords : [];
    const byRecording = task.recordingId > 0
      ? finishedRecords.find((x) => Number(x?.recordingId || 0) === task.recordingId)
      : null;
    const byTime = task.recordingId <= 0
      ? [...finishedRecords]
        .filter((x) => Number(x?.finishedAt || 0) > stopRequestedAt)
        .sort((a, b) => Number(b?.finishedAt || 0) - Number(a?.finishedAt || 0))[0]
      : null;
    const uiFinalKind = String(state.uiFinalKind || "").trim().toLowerCase();
    const uiFinalText = normalizeTranscriptText(state.uiFinalText || "");
    const uiFinalBelongsToTask =
      task.recordingId > 0
        ? Number(state.uiFinalRecordingId || 0) === task.recordingId
        : Number(state.uiFinalAt || 0) > stopRequestedAt;
    const uiFinalStatusHasTranscript =
      uiFinalKind === "status" &&
      uiFinalBelongsToTask &&
      isMeaningfulTranscriptText(uiFinalText);
    const uiFinalReadyByRecording =
      uiFinalKind === "transcript" &&
      isMeaningfulTranscriptText(uiFinalText) &&
      task.recordingId > 0 &&
      Number(state.uiFinalRecordingId || 0) === task.recordingId;
    const uiFinalReadyByTime =
      uiFinalKind === "transcript" &&
      isMeaningfulTranscriptText(uiFinalText) &&
      task.recordingId <= 0 &&
      Number(state.uiFinalAt || 0) > stopRequestedAt;
    const readyByRecording = !!byRecording || (task.recordingId > 0 && Number(state.finishedRecordingId || 0) === task.recordingId);
    const readyByTime = !!byTime || (task.recordingId <= 0 && state.finishedAt > stopRequestedAt);
    if (readyByRecording || readyByTime || uiFinalReadyByRecording || uiFinalReadyByTime) {
      transcript = normalizeTranscriptText(
        byRecording?.text || byTime?.text || state.finishedText || uiFinalText || ""
      );
      if (!isMeaningfulTranscriptText(transcript)) {
        traceStep(trace, "signal_ready_ignored_non_transcript", {
          pollCount,
          textLen: transcript.length,
          preview: compactLogText(transcript, 80),
        });
        transcript = "";
        await sleep(30);
        continue;
      }
      traceStep(trace, "signal_ready", {
        pollCount,
        finishedAt: Number(byRecording?.finishedAt || byTime?.finishedAt || state.finishedAt || 0),
        finishedRecordingId: Number(byRecording?.recordingId || state.finishedRecordingId || state.uiFinalRecordingId || 0),
        expectedRecordingId: task.recordingId || 0,
        delay: Number(byRecording?.finishedAt || byTime?.finishedAt || state.finishedAt || state.uiFinalAt || 0) - stopRequestedAt,
        source: byRecording ? "finished_record" : byTime ? "finished_record_by_time" : state.finishedText ? "finished_text" : "ui_final",
        textLen: transcript.length,
      });
      break;
    }
    const doneLike = !state.busy && !state.progressVisible && !state.isRec &&
      (state.status === "Done" || state.status === "Error" || state.status === "Idle");
    if (doneLike && state.status === "Done" && uiFinalStatusHasTranscript) {
      if (!doneStatusTranscriptSince) doneStatusTranscriptSince = Date.now();
      if (Date.now() - doneStatusTranscriptSince >= 600) {
        transcript = uiFinalText;
        traceStep(trace, "done_status_transcript_fallback", {
          pollCount,
          expectedRecordingId: task.recordingId || 0,
          uiFinalRecordingId: Number(state.uiFinalRecordingId || 0),
          textLen: transcript.length,
        });
        break;
      }
      traceStep(trace, "done_waiting_for_paste_ready", {
        pollCount,
        expectedRecordingId: task.recordingId || 0,
        uiFinalRecordingId: Number(state.uiFinalRecordingId || 0),
        textLen: uiFinalText.length,
      });
      await sleep(30);
      continue;
    }
    doneStatusTranscriptSince = 0;
    if (doneLike) break;
    await sleep(30);
  }

  let recordingStatusText = "Saved To App";
  if (transcript) {
    traceStep(trace, "transcript_ready", {
      len: transcript.length,
      digest: textDigest(transcript),
      preview: compactLogText(transcript, 140),
    });
    lastTranscriptText = transcript;
    saveLastTranscriptToDisk(transcript);
    try {
      clipboard.writeText(transcript);
    } catch { }

    // Paste target resolution is start-target-first. We preserve the
    // window/app snapshot captured when recording began and only fall
    // back to the current frontmost target when no valid start target
    // exists. That matches the product contract: paste back into the
    // place where recording started, not wherever focus happens to be
    // when the transcript finishes.
    let effectiveTarget = normalizeCapturedPasteTarget(task.target);
    if (!hasCapturedPasteTarget(effectiveTarget)) {
      try {
        effectiveTarget = capturePasteTargetFromFrontInfo(await getFrontmostAppInfo());
        traceStep(trace, "target_fallback_current_front", {
          target: pasteTargetSummary(effectiveTarget),
        });
      } catch { }
    } else {
      try {
        const restored = await activateCapturedPasteTarget(effectiveTarget);
        traceStep(trace, restored ? "target_restored" : "target_restore_failed", {
          target: pasteTargetSummary(effectiveTarget),
        });
        if (!restored) {
          effectiveTarget = emptyCapturedPasteTarget();
        }
      } catch {
        effectiveTarget = emptyCapturedPasteTarget();
      }
    }

    const pasted = await tryPasteToFocusedField(transcript, effectiveTarget);
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-auto] ${pasteTargetSummary(effectiveTarget)} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${transcript.length}`
    );
    if (pasted.ok) {
      // Mark this recordingId as pasted BEFORE returning so any
      // second-arrival task for the same id (defensive against races
      // that bypass the enqueue dedup) is rejected by the second-line
      // guard at the top of processPostStopTask.
      _markRecordingPasted(task.recordingId);
      // Show success immediately once the paste actually happened.
      await setRecordingStatus("Pasted");
    }
    if (pasted.ok && task.autoSendEnter) {
      await sleep(220);
      const sent = await sendCommandEnterToFocusedApp(effectiveTarget);
      traceStep(trace, "cmd_enter_result", {
        ok: !!sent.ok,
        reason: compactLogText(sent.reason || ""),
      });
      appendMainLog(
        `[cmd-enter] ${pasteTargetSummary(effectiveTarget)} ok=${sent.ok ? "1" : "0"} reason="${sent.reason || ""}"`
      );
      if (sent.ok) {
        await setRecordingStatus("Sent");
      }
      if (!sent.ok && looksLikeAutomationPermissionError(sent.reason)) {
        openPrivacyAccessibilitySettings();
      }
    }
    if (!pasted.ok && (looksLikeAutomationPermissionError(pasted.reason) || String(pasted.reason || "").includes("no-accessibility"))) {
      openPrivacyAccessibilitySettings();
    }
    recordingStatusText = pasted.ok ? "Paste Sent" : recordingStatusForPasteFailure(pasted.reason);
  } else {
    traceStep(trace, "transcript_missing", { reason: "no-final-or-live-text-before-deadline" });
  }

  const isRecNow = await isRendererRecording();
  if (!isRecNow) {
    await setRecordingStatus(recordingStatusText);
  }
  traceEnd(trace, "done", { transcriptFound: !!transcript, pollCount });
}

async function getLatestTranscriptText() {
  const s = await queryRendererState();
  const finished = normalizeTranscriptText(s?.finishedText || "");
  if (isMeaningfulTranscriptText(finished)) {
    lastTranscriptText = finished;
    saveLastTranscriptToDisk(finished);
    return finished;
  }
  const uiFinalKind = String(s?.uiFinalKind || "").trim().toLowerCase();
  const uiFinalText = normalizeTranscriptText(s?.uiFinalText || "");
  if (uiFinalKind === "transcript" && isMeaningfulTranscriptText(uiFinalText)) {
    lastTranscriptText = uiFinalText;
    saveLastTranscriptToDisk(uiFinalText);
    return uiFinalText;
  }
  if (lastTranscriptText) return lastTranscriptText;
  const disk = loadLastTranscriptFromDisk();
  if (disk) {
    lastTranscriptText = disk;
    return disk;
  }
  return "";
}

async function pasteLatestTranscriptFromShortcut() {
  if (pasteShortcutInFlight) return;
  const trace = createTrace("paste_last", {});
  pasteShortcutInFlight = true;
  try {
    clearCapturedPasteTarget();
    const front = await getFrontmostAppInfo();
    traceStep(trace, "front_before", {
      name: front.name || "",
      pid: front.pid || 0,
      windowTitle: compactLogText(front.windowTitle || "", 80),
    });
    setCapturedPasteTarget(capturePasteTargetFromFrontInfo(front));
    await publishRecordingStatus("Pasting");

    const text = await getLatestTranscriptText();
    if (!text) {
      traceStep(trace, "no_text_available", {});
      await setRecordingStatus("No Text");
      resetRecordingStatusState();
      clearCapturedPasteTarget();
      return;
    }
    traceStep(trace, "text_ready", {
      len: text.length,
      digest: textDigest(text),
      preview: compactLogText(text, 140),
    });
    try {
      clipboard.writeText(text);
    } catch { }

    const pasted = await tryPasteToFocusedField(text, pasteTarget);
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-last] ${pasteTargetSummary(pasteTarget)} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${text.length}`
    );
    await setRecordingStatus(pasted.ok ? "Paste Sent" : recordingStatusForPasteFailure(pasted.reason));
    if (!pasted.ok) {
      if (String(pasted.reason || "").includes("no-accessibility")) {
        openPrivacyAccessibilitySettings();
      }
      appendMainLog(`[paste-last] failed: ${pasted.reason || "unknown"}`);
    }
    clearCapturedPasteTarget();
    resetRecordingStatusState();
  } finally {
    clearCapturedPasteTarget();
    pasteShortcutInFlight = false;
    traceEnd(trace, "done", {});
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fileExists(p) {
  // Accept BOTH POSIX absolute paths ("/…") AND Windows drive paths
  // ("C:\…"). The original "/"-prefix gate was a defence against bare
  // PATH names slipping through into fs.existsSync — preserve that
  // intent via path.isAbsolute which handles both conventions.
  // Without this, every bundled-runtime discovery on Windows returned
  // false because paths start with a drive letter, and 1.1.0's
  // "zero user setup" promise was silently inverted into a guaranteed
  // "Python not found" boot failure.
  if (!p) return false;
  if (!path.isAbsolute(p)) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

function runCommand(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  // On Windows, PowerShell emits stdout in the system OEM code page
  // (CP866/CP1251/CP932/…) by default. When we read it as UTF-8 the
  // non-ASCII bytes become mojibake, breaking app-name detection for
  // users whose window titles contain Cyrillic/CJK characters. Inject
  // a prelude that forces [Console]::OutputEncoding to UTF-8 so the
  // bytes we read back are decoded correctly.
  let effectiveArgs = args;
  const cmdLc = String(cmd || "").toLowerCase();
  if (cmdLc === "powershell" || cmdLc === "pwsh") {
    const cmdIdx = args.findIndex((a) => String(a || "").toLowerCase() === "-command");
    if (cmdIdx >= 0 && cmdIdx + 1 < args.length) {
      const script = args[cmdIdx + 1];
      const prelude = "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
      if (typeof script === "string" && !script.startsWith(prelude)) {
        effectiveArgs = args.slice();
        effectiveArgs[cmdIdx + 1] = prelude + script;
      }
    }
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const appendBoundedOutput = (current, chunk, streamName) => {
      const next = current + String(chunk || "");
      if (next.length <= RUN_COMMAND_OUTPUT_MAX_CHARS) return next;
      if (streamName === "stdout") stdoutTruncated = true;
      if (streamName === "stderr") stderrTruncated = true;
      return next.slice(-RUN_COMMAND_OUTPUT_MAX_CHARS);
    };
    const finalStdout = () => (
      stdoutTruncated
        ? `[stdout truncated to last ${RUN_COMMAND_OUTPUT_MAX_CHARS} chars]\n${stdout}`
        : stdout
    );
    const finalStderr = () => (
      stderrTruncated
        ? `[stderr truncated to last ${RUN_COMMAND_OUTPUT_MAX_CHARS} chars]\n${stderr}`
        : stderr
    );
    // Three independent code paths (timeout, child error, child close)
    // can all reach ``resolve``; the first wins, the rest are no-ops.
    // Without this guard, an error fired BETWEEN the timeout's
    // SIGKILL and the kernel reaping the process triggered TWO
    // resolves on the same Promise — the second is a Promise no-op
    // but the work allocated by the second (e.g. extra stderr
    // concatenation) is wasted and the trace path fires twice.
    let settled = false;
    const settleOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(cmd, effectiveArgs, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    // Force UTF-8 decoding on the streams. This is the default on macOS
    // and Linux, but explicit here so a platform quirk cannot silently
    // switch the encoding.
    try { child.stdout.setEncoding("utf8"); } catch { }
    try { child.stderr.setEncoding("utf8"); } catch { }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { }
      settleOnce({ ok: false, code: -1, stdout: finalStdout(), stderr: `${finalStderr()}\nTimed out` });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout = appendBoundedOutput(stdout, d.toString(), "stdout");
    });

    child.stderr.on("data", (d) => {
      stderr = appendBoundedOutput(stderr, d.toString(), "stderr");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settleOnce({ ok: false, code: -1, stdout: finalStdout(), stderr: `${finalStderr()}\n${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      settleOnce({ ok: code === 0, code: code ?? -1, stdout: finalStdout(), stderr: finalStderr() });
    });
  });
}

function isBundledPythonRuntime(python) {
  const bundled = getBundledPythonPath();
  return !!bundled && path.resolve(python) === path.resolve(bundled);
}

function buildPythonEnv(python, overrides = {}) {
  const env = { ...process.env };
  if (isBundledPythonRuntime(python)) {
    for (const key of PYTHON_ENV_SCRUB_KEYS) {
      delete env[key];
    }
    env.PYTHONNOUSERSITE = "1";
  }
  return {
    ...env,
    ...overrides,
  };
}

function canBindPort(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const done = (ok) => {
      try {
        srv.close();
      } catch { }
      resolve(ok);
    };
    srv.once("error", () => done(false));
    srv.once("listening", () => done(true));
    try {
      srv.listen(port, host);
    } catch {
      done(false);
    }
  });
}

async function pickBackendPort(host, preferred = DEFAULT_BACKEND_PORT) {
  const start = Number(preferred || DEFAULT_BACKEND_PORT);
  for (let p = start; p < start + 24; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(host, p)) return p;
  }
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? Number(addr.port || 0) : 0;
      try {
        srv.close();
      } catch { }
      resolve(port || start);
    });
    srv.once("error", () => resolve(start));
  });
}

// ── App-scoped venv (persists across app updates) ──
function getAppVenvDir() {
  return path.join(app.getPath("userData"), ".venv");
}

/**
 * One-shot cleanup of the legacy 1.0.x app-venv.
 *
 * 1.0.x created a Python venv at ``userData/.venv`` (~300–500 MB
 * after `pip install -r requirements.txt`). 1.1.0 ships a fully
 * self-contained bundled Python under ``resourcesPath/runtime/``
 * and never touches the legacy venv — it just sits on the user's
 * disk forever, wasting space, showing up in backup/sync tooling
 * for no reason.
 *
 * Only deletes if:
 *   1. We successfully booted with the bundled runtime this session
 *      (caller guarantees this via call site in resolvePython).
 *   2. The path really is ``userData/.venv`` — not some other `.venv`
 *      the user symlinked in via TRANSCRIPTOR_DATA_DIR shenanigans.
 *   3. We haven't already cleaned it in a prior session
 *      (idempotency marker).
 *
 * Non-fatal on every failure — wasting 500 MB is better than
 * deleting the wrong directory.
 */
function _cleanupOrphanedLegacyVenv() {
  try {
    const userData = path.resolve(app.getPath("userData"));
    const marker = path.join(userData, ".legacy-venv-cleaned");
    if (fs.existsSync(marker)) return;
    const venvDir = getAppVenvDir();
    const target = path.resolve(venvDir);
    // Safety: path must be EXACTLY `<userData>/.venv` — no subpath,
    // no symlink chain. Prevents a misconfigured userData from
    // causing us to delete something unexpected.
    if (path.dirname(target) !== userData || path.basename(target) !== ".venv") {
      appendMainLog(`[legacy-venv-cleanup] refusing to delete unexpected path: ${target}`);
      return;
    }
    if (!fs.existsSync(target)) {
      // No legacy venv to clean. Still write the marker so we skip
      // the directory-exists probe on every subsequent launch.
      try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* non-fatal */ }
      return;
    }
    // Additional safety: confirm it LOOKS like a Python venv before
    // deleting (has pyvenv.cfg or bin/python* / Scripts/python.exe).
    // A user's arbitrary .venv folder without these markers gets
    // skipped — better cautious than sorry.
    const looksLikeVenv = (
      fs.existsSync(path.join(target, "pyvenv.cfg"))
      || fs.existsSync(path.join(target, "bin", "python"))
      || fs.existsSync(path.join(target, "bin", "python3"))
      || fs.existsSync(path.join(target, "Scripts", "python.exe"))
    );
    if (!looksLikeVenv) {
      appendMainLog(`[legacy-venv-cleanup] ${target} does not look like a Python venv; skipping`);
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* non-fatal */ }
    appendMainLog(`[legacy-venv-cleanup] removed legacy venv at ${target}`);
  } catch (e) {
    appendMainLog(`[legacy-venv-cleanup] non-fatal: ${e?.message || e}`);
  }
}

async function findSystemPython(repoRoot) {
  // Find any working Python 3 on the system (for venv creation)
  const sysCandidates = process.platform === "win32" ? [
    (process.env.PYTHON || "").trim(),
    "python"
  ].filter(Boolean) : [
    (process.env.PYTHON || "").trim(),
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const py of sysCandidates) {
    // path.isAbsolute matches both POSIX "/…" and Windows "C:\…".
    // Previous startsWith("/") let non-existent Windows paths slip
    // through to spawn() with ENOENT.
    if (path.isAbsolute(py) && !fileExists(py)) continue;
    const check = await runCommand(py, ["-c", "import sys; print(sys.version_info.major)"], {
      cwd: repoRoot, timeoutMs: 8000
    });
    if (check.ok && (check.stdout || "").trim() === "3") return py;
  }
  return null;
}

async function ensureAppVenv(repoRoot) {
  const venvDir = getAppVenvDir();
  const venvPy = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python3");

  // If venv already exists and works, return it
  if (fileExists(venvPy)) {
    const check = await runCommand(venvPy, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000
    });
    if (check.ok) return venvPy;
    // Venv is broken — delete and recreate
    appendMainLog(`[venv] existing venv broken, recreating`);
    try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch { }
  }

  // Find a system Python to create the venv with
  const sysPy = await findSystemPython(repoRoot);
  if (!sysPy) return null;

  appendMainLog(`[venv] creating app venv at "${venvDir}" using "${sysPy}"`);
  const create = await runCommand(sysPy, ["-m", "venv", venvDir], {
    cwd: repoRoot, timeoutMs: 60000
  });

  if (!create.ok) {
    appendMainLog(`[venv] creation failed: ${(create.stderr || "").trim()}`);
    return null;
  }

  if (fileExists(venvPy)) return venvPy;
  return null;
}

/**
 * Absolute path to the bundled Python interpreter that ships with the
 * installer, or null if not present (dev checkout or prior releases).
 *
 * When the app is packaged by electron-builder with the bundled runtime,
 * extraResources places the Python install at
 * `process.resourcesPath/runtime/python/`. Windows layout:
 *   runtime/python/python.exe
 * Unix layout:
 *   runtime/python/bin/python3
 *
 * The bundled runtime contains Python 3.12 + all requirements.txt deps
 * pre-installed into site-packages + a static ffmpeg binary. Using it
 * means zero user setup — no winget install, no pip, no internet.
 */
function getBundledPythonPath() {
  // Only a packaged app ships the bundled runtime. In dev mode
  // process.resourcesPath points at Electron's OWN Resources dir
  // (node_modules/electron/.../Resources); a stray runtime/ folder
  // there would be picked up by accident.
  if (!app.isPackaged) return null;
  const resDir = process.resourcesPath || "";
  if (!resDir) return null;
  const candidate = process.platform === "win32"
    ? path.join(resDir, "runtime", "python", "python.exe")
    : path.join(resDir, "runtime", "python", "bin", "python3");
  return fileExists(candidate) ? candidate : null;
}

/**
 * Absolute path to the bundled ffmpeg binary, or null if not bundled.
 * Appended to PATH when the backend is spawned so audio conversion
 * works offline without a system ffmpeg install.
 */
function getBundledFfmpegDir() {
  if (!app.isPackaged) return null;
  const resDir = process.resourcesPath || "";
  if (!resDir) return null;
  const dir = path.join(resDir, "runtime", "ffmpeg", "bin");
  const ffmpeg = process.platform === "win32"
    ? path.join(dir, "ffmpeg.exe")
    : path.join(dir, "ffmpeg");
  return fileExists(ffmpeg) ? dir : null;
}

async function resolvePython(repoRoot) {
  // 0) Bundled runtime (ships with release installer). Preferred over
  // everything else because it is known-good + fully self-contained —
  // the user doesn't need a system Python, a venv, pip, or network
  // access to first-launch the app.
  const bundled = getBundledPythonPath();
  if (bundled) {
    const check = await runCommand(bundled, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000, env: buildPythonEnv(bundled)
    });
    if (check.ok) {
      appendMainLog(`[resolvePython] using bundled runtime: ${bundled}`);
      _cleanupOrphanedLegacyVenv();
      return bundled;
    }
    appendMainLog(`[resolvePython] bundled runtime failed probe: ${(check.stderr || "").trim()}`);
  }

  // 1) Try app venv (used by legacy source installers and older
  // Windows installs prior to 1.1.0).
  const appVenvPy = process.platform === "win32"
    ? path.join(getAppVenvDir(), "Scripts", "python.exe")
    : path.join(getAppVenvDir(), "bin", "python3");
  if (fileExists(appVenvPy)) {
    const check = await runCommand(appVenvPy, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000
    });
    if (check.ok) return (check.stdout || "").trim() || appVenvPy;
  }

  // 2) Try dev venv (for development)
  const devVenvPy = process.platform === "win32"
    ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
    : path.join(repoRoot, ".venv", "bin", "python3");
  if (fileExists(devVenvPy)) {
    const check = await runCommand(devVenvPy, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000
    });
    if (check.ok) return (check.stdout || "").trim() || devVenvPy;
  }

  // 3) Create app venv from system Python (legacy fallback for
  // installs without a bundled runtime).
  setBackendBootStatus("Setting up Python environment…");
  const created = await ensureAppVenv(repoRoot);
  if (created) return created;

  // 4) Fallback to any system Python (will need --user pip later)
  return await findSystemPython(repoRoot);
}

let backendBootStatus = "";
function setBackendBootStatus(msg) {
  backendBootStatus = msg || "";
  appendMainLog(`[backend-boot-status] ${msg}`);
  // Broadcast to renderer if window exists
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.executeJavaScript(
      `window.__setBackendBootStatus && window.__setBackendBootStatus(${JSON.stringify(msg)});`,
      true
    ).catch(() => { });
  }
}

function broadcastBackendBootError() {
  if (!backendBootError || !win || win.isDestroyed() || !win.webContents) return;
  win.webContents.executeJavaScript(
    `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
    true
  ).catch((e) => {
    appendMainLog(`[backend-boot-error-broadcast] failed: ${e?.message || e}`);
  });
}

async function ensureBackendRuntime(python, repoRoot) {
  const importCheck = await runCommand(
    python,
    ["-c", BACKEND_RUNTIME_IMPORT_CHECK],
    { cwd: repoRoot, timeoutMs: 12000, env: buildPythonEnv(python) }
  );

  if (importCheck.ok) return { ok: true };

  // If the selected Python IS the bundled runtime, deps are pre-installed
  // into its site-packages at release build time. An import failure here
  // means the bundle is corrupted (AV quarantined a .pyd / .so, user
  // deleted a file, disk error). `pip install --user` would write to a
  // dir OUTSIDE the app bundle (~/Library/Python/3.12/ or
  // %APPDATA%\Python\Python312\), persist across uninstalls, and shadow
  // the pinned versions on every future launch — a worse state than
  // the failure itself. Surface the error with the stderr so the user
  // can report it.
  const bundled = getBundledPythonPath();
  if (bundled && path.resolve(python) === path.resolve(bundled)) {
    return {
      ok: false,
      details: [
        "Bundled Python runtime is missing one or more pre-installed dependencies.",
        "This usually means an antivirus quarantined a file inside the app bundle.",
        `python: ${python}`,
        (importCheck.stderr || importCheck.stdout || "").trim(),
      ].filter(Boolean).join("\n"),
    };
  }

  const requirementsPath = path.join(repoRoot, "requirements.txt");
  if (!fs.existsSync(requirementsPath)) {
    return { ok: false, details: "requirements.txt not found in app resources" };
  }

  setBackendBootStatus("Installing dependencies (first launch)…");

  // If Python is inside the app venv, install directly (no --user needed).
  // Compare normalized absolute paths with a separator-boundary check
  // so we can't (a) match a sibling directory by raw prefix
  // ("/…/.venvold" matching "/…/.venv"), or (b) miss due to mixed
  // separators after Python normalizes its own `sys.executable`.
  // On case-insensitive filesystems (macOS APFS default, Windows NTFS)
  // also compare case-insensitively so a user dir recorded in
  // different case by the OS doesn't produce a false negative that
  // scatters pip packages outside the app sandbox.
  const venvDirNormalized = path.resolve(getAppVenvDir());
  const pythonResolved = path.resolve(python);
  const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";
  const pathEq = (a, b) => caseInsensitiveFs
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
  const pathStartsWith = (a, prefix) => caseInsensitiveFs
    ? a.toLowerCase().startsWith(prefix.toLowerCase())
    : a.startsWith(prefix);
  const isAppVenv =
    pathEq(pythonResolved, venvDirNormalized) ||
    pathStartsWith(pythonResolved, venvDirNormalized + path.sep);
  const pipArgs = ["-m", "pip", "install", "-r", requirementsPath];
  if (!isAppVenv) {
    pipArgs.splice(3, 0, "--user");
  }

  const install = await runCommand(python, pipArgs, {
    cwd: repoRoot, timeoutMs: 300000
  });

  if (!install.ok && !isAppVenv) {
    // Retry with --break-system-packages for macOS 14+ managed Python
    appendMainLog("[backend-runtime] retrying pip with --break-system-packages");
    const retry = await runCommand(
      python,
      ["-m", "pip", "install", "--user", "--break-system-packages", "-r", requirementsPath],
      { cwd: repoRoot, timeoutMs: 300000 }
    );
    if (!retry.ok) {
      return {
        ok: false,
        details: [
          "Python dependencies are missing and auto-install failed.",
          `python: ${python}`,
          (retry.stderr || retry.stdout || "").trim()
        ].join("\n")
      };
    }
  } else if (!install.ok) {
    return {
      ok: false,
      details: [
        "Python dependencies are missing and auto-install failed.",
        `python: ${python}`,
        (install.stderr || install.stdout || "").trim()
      ].join("\n")
    };
  }

  setBackendBootStatus("Verifying dependencies…");

  const recheck = await runCommand(
    python,
    ["-c", BACKEND_RUNTIME_IMPORT_CHECK],
    { cwd: repoRoot, timeoutMs: 12000, env: buildPythonEnv(python) }
  );

  if (!recheck.ok) {
    return {
      ok: false,
      details: [
        "Python dependencies were installed but still cannot be imported.",
        `python: ${python}`,
        (recheck.stderr || recheck.stdout || "").trim()
      ].join("\n")
    };
  }

  return { ok: true };
}

async function startBackend() {
  // ORDER MATTERS: check inflight FIRST. Otherwise a concurrent
  // caller arriving during the spawn-then-instant-crash window can
  // see `backend` momentarily set, take the early-return, and
  // proceed to loadURL against a backend that's about to die.
  // Returning the inflight promise keeps every concurrent caller
  // synchronised on the same outcome.
  if (backendStartInFlight) return backendStartInFlight;
  if (backend) return;

  // Absorb any queued crash-restart BEFORE we set inflight, so a
  // concurrent caller that arrives while the timer is firing can't
  // race us into double-spawn. The timer clear must happen on the
  // SAME synchronous branch as the inflight check above.
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }

  backendStartInFlight = (async () => {
  const repoRoot = getRepoRoot();
  setBackendBootStatus("Locating Python…");
  const python = await resolvePython(repoRoot);

  if (!python) {
    backendBootError = "Python 3 interpreter was not found. Please install Python 3 from python.org.";
    setBackendBootStatus("");
    broadcastBackendBootError();
    throw new Error(backendBootError);
  }

  const runtime = await ensureBackendRuntime(python, repoRoot);
  if (!runtime.ok) {
    backendBootError = runtime.details || "Backend runtime is unavailable.";
    setBackendBootStatus("");
    broadcastBackendBootError();
    throw new Error(backendBootError);
  }

  setBackendBootStatus("Starting backend…");

  // Validate TRANSCRIPTOR_PORT: must be a user-space TCP port
  // (1024-65535). A bogus value (0, negative, non-integer, >65535)
  // silently fell through pickBackendPort's iteration and produced an
  // OS-assigned random port — deviation from the user's configured
  // port with no log trace.
  let preferredPort = Number(process.env.TRANSCRIPTOR_PORT);
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    if (process.env.TRANSCRIPTOR_PORT) {
      appendMainLog(`[backend-start] invalid TRANSCRIPTOR_PORT=${process.env.TRANSCRIPTOR_PORT}; using default ${DEFAULT_BACKEND_PORT}`);
    }
    preferredPort = DEFAULT_BACKEND_PORT;
  }
  PORT = await pickBackendPort(HOST, preferredPort);
  BASE_URL = `http://${HOST}:${PORT}`;
  BACKEND_BOOT_NONCE = crypto.randomBytes(32).toString("hex");
  appendMainLog(`[backend-start] python="${python}" host=${HOST} port=${PORT} repo="${repoRoot}"`);

  // --app-dir tells uvicorn where to find the "backend.main" module
  // WITHOUT polluting PYTHONPATH globally. The previous PYTHONPATH=
  // repoRoot approach made the bundled standalone Python willing to
  // import any top-level name from resources/ (including `runtime`
  // and `frontend`) which invites silent import shadowing on any
  // refactor.
  const args = [
    "-B",
    "-m", "uvicorn",
    "backend.main:app",
    "--app-dir", repoRoot,
    "--host", HOST,
    "--port", String(PORT),
    "--log-level", "info"
  ];

  // stdin is a ``pipe`` (not ``ignore``) so the backend's parent-death
  // watchdog can detect EOF when this Electron process dies. Without
  // this, a SIGKILL / crash of Electron leaves the Python backend
  // running as an orphan: still bound to the TCP port, still holding
  // whisper models in RAM, visible only via ``ps``. With the pipe open,
  // the kernel closes our write-end when we exit (for ANY reason,
  // including SIGKILL), the backend's watchdog thread sees EOF on its
  // stdin, and calls ``os._exit(0)`` — guaranteed cleanup.
  //
  // We explicitly NEVER write to backend.stdin; the pipe's sole purpose
  // is liveness signalling via close-on-exit.
  // Prepend the bundled ffmpeg directory to PATH so backend/audio.py
  // finds `ffmpeg` for format conversion even on a user system that
  // has no ffmpeg installed. On dev / non-release runs the bundled
  // path doesn't exist and we fall through to the existing PATH.
  const ffmpegDir = getBundledFfmpegDir();
  const envPath = ffmpegDir
    ? `${ffmpegDir}${path.delimiter}${process.env.PATH || ""}`
    : (process.env.PATH || "");
  const pythonCacheDir = path.join(app.getPath("userData"), "python-cache");
  try {
    fs.mkdirSync(pythonCacheDir, { recursive: true });
  } catch (e) {
    appendMainLog(`[backend-start] python cache dir unavailable: ${e?.message || e}`);
  }
  // Child env. `--app-dir repoRoot` (above, in args) already inserts
  // repoRoot into sys.path for uvicorn's module resolution, so
  // exporting PYTHONPATH=repoRoot would double-inject the same dir
  // AND expose every sibling top-level dir (runtime/, frontend/) as
  // importable. buildPythonEnv scrubs Python-specific parent env when
  // using the bundled runtime so packaged launches stay hermetic.
  const childEnv = buildPythonEnv(python, {
    PATH: envPath,
    PYTHONUNBUFFERED: "1",
    // CRITICAL on macOS: prevent Python from writing .pyc bytecode
    // cache files into the signed .app bundle at runtime. Python
    // eagerly caches compiled bytecode next to .py source files on
    // every import; those writes invalidate the bundle's Resources
    // envelope (codesign --verify --deep reports them as "file
    // added") and amfi on every subsequent backend spawn re-checks
    // the envelope — eventually breaking launch after enough
    // imports accumulated. Setting this env var makes Python run
    // entirely from source; PYTHONPYCACHEPREFIX is an additional
    // hard guard for any Python subprocess/import path that ignores
    // -B or PYTHONDONTWRITEBYTECODE. Any bytecode cache that still
    // gets written lands in userData/python-cache, never in the
    // signed Resources envelope.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: pythonCacheDir,
    TRANSCRIPTOR_DATA_DIR: process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData"),
    TRANSCRIPTOR_BOOT_NONCE: BACKEND_BOOT_NONCE,
    TRANSCRIPTOR_PARENT_WATCHDOG: "1",
  });
  backend = spawn(python, args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  // Ignore any stdin errors — the pipe is only used for EOF-on-parent-
  // exit detection. If the write end gets EPIPE for some reason (backend
  // crashed, fd was closed), Node would otherwise emit an unhandled
  // 'error' event and crash the main process.
  if (backend.stdin) {
    backend.stdin.on("error", () => { /* intentional no-op */ });
  }

  backend.stdout.on("data", (d) => {
    const msg = d.toString();
    appendMainLog(`[backend-stdout] ${compactLogText(msg, 1400)}`);
  });
  backend.stderr.on("data", (d) => {
    const msg = d.toString();
    appendMainLog(`[backend-stderr] ${compactLogText(msg, 1400)}`);
    // Keep the last ~4 KB of stderr so the fallback error page can
    // show the actual failure reason instead of a generic "did not
    // start in time" message.
    backendStderrTail = (backendStderrTail + msg).slice(-BACKEND_STDERR_TAIL_MAX);
  });

  backend.on("exit", (code, signal) => {
    appendMainLog(`[backend-exit] code=${code} signal=${signal || ""}`);
    backend = null;
    // Restart on either:
    //   (a) non-zero exit (Python crash, sys.exit(1), broken venv, ...)
    //   (b) signal exit (segfault, oom-kill, manual SIGKILL outside our
    //       quit path) — code is null in that case so the old check
    //       ``Number(code || 0) !== 0`` was 0 !== 0 → false → silently
    //       skipped restart. A backend killed by SIGSEGV would not
    //       come back without a manual app relaunch.
    const abnormalExit = Number(code || 0) !== 0 || (signal != null && signal !== "");
    if (!isQuitting && abnormalExit) {
      if (backendRestartTimer) {
        clearTimeout(backendRestartTimer);
        backendRestartTimer = null;
      }
      const attempt = backendRestartAttempts + 1;
      backendRestartAttempts = attempt;
      // Hard cap: after 8 attempts, stop scheduling. A deterministically
      // broken backend (corrupt config, missing dep, port conflict we
      // can't escape) would otherwise restart every 5s forever, growing
      // the log file unboundedly and masking the real failure. The user
      // sees a permanent backend error in the renderer instead.
      if (attempt > 8) {
        backendBootError = `Backend exited with code ${code} after ${attempt - 1} restart attempts — giving up.`;
        setBackendBootStatus("");
        appendMainLog(`[backend-restart-giving-up] ${backendBootError}`);
        broadcastBackendBootError();
        return;
      }
      const delay = Math.min(800 * attempt, 5000);
      appendMainLog(`[backend-restart-scheduled] attempt=${attempt} delayMs=${delay}`);
      backendRestartTimer = setTimeout(() => {
        // 1.1.25 fix: previously nulled ``backendRestartTimer`` BEFORE
        // calling startBackend(). A concurrent caller (window-create,
        // tray click) entering startBackend between the null and the
        // inflight assignment passed the ``if (backendRestartTimer)
        // clearTimeout(...)`` guard on a now-null timer, then proceeded
        // independently — both spawned ``python -m uvicorn`` and the
        // loser hit "Address already in use", triggering yet another
        // restart cycle and leaking PIDs.
        //
        // New ordering: keep backendRestartTimer set until startBackend
        // takes the inflight lock; null it from .finally so a concurrent
        // clearTimeout above is a no-op only AFTER the inflight promise
        // is in place.
        startBackend()
          .then(() => appendMainLog("[backend-restart] attempted"))
          .catch((e) => appendMainLog(`[backend-restart-error] ${e?.message || e}`))
          .finally(() => { backendRestartTimer = null; });
      }, delay);
    } else if (Number(code || 0) === 0) {
      backendRestartAttempts = 0;
    }
  });

  backend.on("error", (err) => {
    backendBootError = err.message;
    appendMainLog(`[backend-error] ${err.message}`);
  });
  })();

  try {
    await backendStartInFlight;
  } finally {
    backendStartInFlight = null;
  }
}

function waitForBackendHealth(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOk = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const scheduleRetry = () => {
      if (settled) return;
      setTimeout(tick, 250);
    };
    const tick = () => {
      if (settled) return;
      if (Date.now() - started > timeoutMs) {
        settleErr(new Error("Backend did not start in time"));
        return;
      }
      const req = http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16 * 1024) {
            try { req.destroy(new Error("health response too large")); } catch { }
          }
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
            const payload = JSON.parse(body || "{}");
            if (payload?.boot_nonce !== BACKEND_BOOT_NONCE) {
              throw new Error("backend boot nonce mismatch");
            }
            settleOk();
          } catch {
            scheduleRetry();
          }
        });
      });
      // Per-request timeout so a hanging connection (backend mid-boot,
      // accept queue full, kernel pause) doesn't sit on a half-open
      // socket for the full outer ``timeoutMs``. Without this, a 60 s
      // outer timeout with 250 ms retry interval can pile up ~240
      // dangling sockets against the loopback backend before the outer
      // reject fires. ``req.destroy()`` cancels the in-flight TCP
      // connection cleanly so the next tick reuses fresh sockets.
      req.setTimeout(2000, () => {
        try { req.destroy(); } catch { }
      });
      req.on("error", scheduleRetry);
    };
    tick();
  });
}

function trackMainWindowInitialLoad(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    mainWindowInitialLoadPromise = null;
    return null;
  }
  let timeoutHandle = null;
  let resolvePromise = null;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const settle = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    try { browserWindow.webContents.off("did-finish-load", settle); } catch { }
    try { browserWindow.webContents.off("did-fail-load", settle); } catch { }
    try { browserWindow.off("closed", settle); } catch { }
    if (mainWindowInitialLoadPromise === promise) {
      mainWindowInitialLoadPromise = null;
    }
    resolvePromise?.();
  };
  browserWindow.webContents.once("did-finish-load", settle);
  browserWindow.webContents.once("did-fail-load", settle);
  browserWindow.once("closed", settle);
  timeoutHandle = setTimeout(settle, 15000);
  timeoutHandle.unref?.();
  mainWindowInitialLoadPromise = promise;
  return promise;
}

async function createWindow(options = {}) {
  const showWindow = options.showWindow !== false;

  // Idempotency guard: if we already own a live BrowserWindow, reuse
  // it instead of spawning a second one. Creating a second window
  // would leak the first's webContents listeners (render-process-gone,
  // did-fail-load, did-finish-load) because nothing ever destroys the
  // orphaned BrowserWindow. Every caller today already checks
  // ``win && !win.isDestroyed()`` — this is a defense-in-depth guard
  // so a future caller cannot silently trip the leak.
  if (win && !win.isDestroyed()) {
    if (mainWindowInitialLoadPromise) {
      try { await mainWindowInitialLoadPromise; } catch { }
    }
    if (showWindow && !win.isVisible()) {
      win.show();
      win.focus();
    }
    return;
  }

  // Window icon for Windows taskbar + Linux panel. On macOS the dock
  // icon comes from the .app bundle's Info.plist (set by electron-builder
  // via mac.icon), so no runtime assignment is needed there. On Windows
  // the BrowserWindow takes an .ico (multi-resolution); the .png is
  // used on Linux.
  const appIconPath = process.platform === "win32"
    ? path.join(__dirname, "icon.ico")
    : path.join(__dirname, "icon.png");
  win = new BrowserWindow({
    width: 1420,
    height: 780,
    minWidth: 1140,
    minHeight: 700,
    backgroundColor: "#1a1a1a",
    title: "Transcriptor",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    icon: process.platform !== "darwin" ? appIconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      webSecurity: true,
      // Sandbox: renderer has no Node.js access even in worst case
      // (a preload script exploit would not break out of sandbox).
      sandbox: true,
      // ROOT CAUSE for Windows-only "transcription is slow / doesn't
      // appear when the app window is not focused":
      //
      // Chromium aggressively throttles background renderers to save
      // CPU on Windows. When this BrowserWindow loses focus (user
      // alt-tabs to a browser to paste into a Meet chat / Slack /
      // editor — the EXACT workflow this app is built for):
      //   * setInterval / setTimeout clamp to 1 Hz
      //   * AudioContext + AudioWorklet get demoted CPU priority,
      //     so the PCM-capture worklet skips frames and the mic
      //     stream goes patchy
      //   * WebSocket frames sit on the Chromium event loop
      //     without being processed for hundreds of ms
      //   * MediaRecorder ondataavailable callbacks stall
      //
      // Result on Windows: "I started recording, switched to my
      // browser to paste, came back — no transcription appeared
      // and the bar at the bottom shows 'no speech detected'".
      // On macOS Chromium throttles less aggressively so the same
      // workflow worked fine. This single flag disables the
      // throttle for our renderer so background recording behaves
      // identically across platforms.
      backgroundThrottling: false,
    }
  });
  trackMainWindowInitialLoad(win);

  // Refuse navigation to any origin other than the backend. A
  // transcript containing an <a href="https://evil..."> that's clicked
  // must NOT navigate the renderer to an attacker-controlled origin —
  // hand it off to the OS default browser via shell.openExternal.
  //
  // Use proper URL origin parsing rather than string prefix-match.
  // Prefix-match is vulnerable to suffix injection: BASE_URL =
  // "http://127.0.0.1:8321" prefix-matches "http://127.0.0.1:8321evil.com"
  // because the dot/slash boundary is not enforced. URL.parse strips
  // ambiguity — same protocol + host + port = same origin. We also
  // match the backend's host:port exactly instead of any-port loopback.
  const _isBackendOrigin = (rawUrl) => {
    if (typeof rawUrl !== "string") return false;
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }
    let backend;
    try { backend = new URL(BASE_URL); } catch { return false; }
    return parsed.protocol === backend.protocol
        && parsed.hostname === backend.hostname
        && parsed.port === backend.port;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (_isBackendOrigin(url)) return { action: "allow" };
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      try { shell.openExternal(url); } catch { }
    }
    return { action: "deny" };
  });
  // Renderer → main IPC over the document-title channel. The renderer
  // (sandbox: true, contextIsolation: true) cannot use ipcRenderer;
  // the canonical workaround used elsewhere in this file
  // is to set ``document.title = "__app_<verb>__<payload>"`` and have
  // the main process intercept the page-title-updated event. We
  // restrict accepted verbs to a closed list and decode the payload
  // back to a known recordings dir + filename, so a malicious
  // transcript cannot smuggle arbitrary paths into shell.showItemInFolder.
  win.webContents.on("page-title-updated", (event, title) => {
    const raw = String(title || "");
    if (!raw.startsWith("__app_")) return;
    event.preventDefault();
    if (raw.startsWith("__app_shortcuts__")) {
      let payload;
      try {
        payload = JSON.parse(decodeURIComponent(raw.slice("__app_shortcuts__".length)));
      } catch (e) {
        appendMainLog(`[shortcuts-bridge] bad payload: ${e?.message || e}`);
        return;
      }
      const action = String(payload?.action || "").trim();
      if (!["capture-start", "capture-cancel", "update"].includes(action)) {
        appendMainLog(`[shortcuts-bridge] rejected action=${compactLogText(action, 40)}`);
        return;
      }
      const message = {
        action,
        record: String(payload?.record || "").trim().slice(0, 96),
        paste: String(payload?.paste || "").trim().slice(0, 96),
      };
      if (shortcutBridgeHandler) {
        shortcutBridgeHandler(message);
      } else {
        pendingShortcutBridgeMessages.push(message);
        pendingShortcutBridgeMessages = pendingShortcutBridgeMessages.slice(-8);
      }
      return;
    }
    if (raw.startsWith("__app_reveal_recording__")) {
      let payload;
      try {
        payload = JSON.parse(decodeURIComponent(raw.slice("__app_reveal_recording__".length)));
      } catch (e) {
        appendMainLog(`[reveal-recording] bad payload: ${e?.message || e}`);
        return;
      }
      // 1.1.25: path-traversal defense. Previous form stripped only
      // path separators, leaving ``..`` intact. Combined with
      // shell.showItemInFolder, a renderer compromise could enumerate
      // the user's home parent (e.g. /Users) by repeatedly revealing
      // dotted names. Reject any name containing ``..`` OR a path
      // separator outright — recording filenames produced by the
      // backend never need either character.
      const rawName = String(payload?.name || "");
      if (!rawName || rawName.includes("..") || /[\\/]/.test(rawName)) return;
      const safeName = rawName;
      if (!safeName.toLowerCase().endsWith(".txt")) {
        appendMainLog(`[reveal-recording] rejected non-transcript name: ${safeName}`);
        return;
      }
      const archiveDirRaw = String(payload?.archiveDir || "").trim();
      // Resolve the transcript path under the SAME archive dir we wrote to.
      // archiveDir comes back from saveRecordingText which already
      // sanitises it via _resolve_recordings_target_dir on the backend
      // side, but defence-in-depth: only accept absolute paths under
      // the userData root or under TRANSCRIPTOR_DATA_DIR / recordings.
      const pathContains = (root, candidate) => {
        const rel = path.relative(root, candidate);
        return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
      };
      const dataDir = process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData");
      const recordingsRoot = path.resolve(dataDir, "recordings");
      const allowedRecordingRoots = [recordingsRoot];
      try {
        const cfgPath = path.join(dataDir, "config.json");
        if (fs.existsSync(cfgPath)) {
          const rawCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          const configuredRoot = String(rawCfg?.preferences?.recordings_dir || "").trim();
          if (configuredRoot) {
            allowedRecordingRoots.push(
              path.isAbsolute(configuredRoot)
                ? path.resolve(configuredRoot)
                : path.resolve(dataDir, configuredRoot)
            );
          }
        }
      } catch (e) {
        appendMainLog(`[reveal-recording] config allowlist read failed: ${e?.message || e}`);
      }
      const archiveDir = archiveDirRaw && path.isAbsolute(archiveDirRaw)
        ? path.resolve(archiveDirRaw)
        : recordingsRoot;
      // Walk up to make sure the resolved path is still under the
      // user's home — block any symlink-shenanigans that would point
      // at /etc/shadow or similar.
      //
      // Plain ``startsWith(home)`` has the classic prefix-bypass bug:
      // when home = "/Users/foo", any sibling like "/Users/foobar/x"
      // also matches because "/Users/foobar" starts with "/Users/foo".
      // A compromised renderer could pass an archive_dir like
      // "<home>~unrelated/whatever" and reveal arbitrary files via
      // shell.showItemInFolder. Anchor the check on a path-separator
      // boundary (or exact equality) so only descendants of home pass.
      const home = path.resolve(app.getPath("home"));
      const isInsideHome =
        archiveDir === home || archiveDir.startsWith(home + path.sep);
      if (!isInsideHome) {
        appendMainLog(`[reveal-recording] archive_dir outside home: ${archiveDir}`);
        return;
      }
      // Reveal means "show the transcript file". Never substitute the
      // adjacent audio/video recording: the History and Upload panes
      // already have dedicated playback, and selecting the media file
      // made the user think the transcription had been saved under the
      // wrong name.
      const target = path.resolve(archiveDir, safeName);
      const isAllowedRecordingPath = allowedRecordingRoots.some((root) =>
        pathContains(root, archiveDir) && pathContains(root, target)
      );
      if (!isAllowedRecordingPath) {
        appendMainLog(`[reveal-recording] archive_dir outside recording roots: ${archiveDir}`);
        return;
      }
      try {
        shell.showItemInFolder(target);
      } catch (e) {
        appendMainLog(`[reveal-recording] shell.showItemInFolder failed: ${e?.message || e}`);
      }
      return;
    }
  });

  win.webContents.on("will-navigate", (e, url) => {
    if (_isBackendOrigin(url)) return;
    e.preventDefault();
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      try { shell.openExternal(url); } catch { }
    }
  });

  const audioPermissions = new Set(["microphone", "audioCapture"]);
  const clipboardWritePermissions = new Set([
    "clipboard-write",
    "clipboard-sanitized-write",
  ]);
  const permissionLogUrl = (url) => {
    const raw = String(url || "");
    if (!raw) return "";
    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      const mime = raw.slice(5, comma >= 0 ? comma : Math.min(raw.length, 80)).split(";")[0] || "inline";
      return `data:${mime};bytes=${Buffer.byteLength(raw, "utf8")}`;
    }
    return compactLogText(raw, 240);
  };
  // Origin gate: only the backend's own origin is allowed to request
  // media permissions and clipboard-write. Clipboard-read stays
  // denied; copy buttons only need writeText. Without this check, a
  // navigation race or a
  // shared-session future (Electron 30+ shares the default session
  // across BrowserWindow instances) could let any other origin
  // inherit our microphone / clipboard grants. Tightened to ``_isBackendOrigin``
  // so the renderer must be on http://127.0.0.1:<our-port> to be
  // allowed.
  const mediaTypesAreAudioOnly = (details) => {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes.map(String) : [];
    return mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
  };
  const permissionDecision = (permission, details = {}) => {
    const perm = String(permission || "");
    const audioOnlyMedia = perm === "media" && mediaTypesAreAudioOnly(details);
    const allowedCapability =
      audioPermissions.has(perm) ||
      audioOnlyMedia ||
      clipboardWritePermissions.has(perm);
    const known =
      allowedCapability ||
      perm === "media" ||
      perm === "videoCapture";
    return { perm, known, allowedCapability };
  };
  const permissionOriginCandidates = (wc, details = {}, requestingOrigin = "") => {
    const values = [
      details?.securityOrigin,
      details?.requestingOrigin,
      details?.requestingUrl,
      requestingOrigin,
      details?.embeddingOrigin,
      details?.frameOrigin,
      wc?.getURL?.(),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  };
  const permissionFromBackendOrigin = (wc, details = {}, requestingOrigin = "") => {
    const origins = permissionOriginCandidates(wc, details, requestingOrigin);
    return origins.length > 0 && origins.every((origin) => _isBackendOrigin(origin));
  };
  const permissionOriginsLog = (wc, details = {}, requestingOrigin = "") =>
    permissionOriginCandidates(wc, details, requestingOrigin)
      .map(permissionLogUrl)
      .filter(Boolean)
      .join(" | ");
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb, details = {}) => {
    const { perm, known, allowedCapability } = permissionDecision(permission, details);
    const fromBackend = permissionFromBackendOrigin(wc, details);
    const allow = allowedCapability && fromBackend;
    const logUrl = permissionOriginsLog(wc, details);
    if (known && !fromBackend) {
      appendMainLog(`[perm-request] DENY non-backend origin: perm=${perm} origins=${logUrl}`);
    } else {
      appendMainLog(`[perm-request] perm=${perm} allow=${allow} origins=${logUrl}`);
    }
    cb(allow);
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
    const { perm, known, allowedCapability } = permissionDecision(permission, details);
    const fromBackend = permissionFromBackendOrigin(wc, details, requestingOrigin);
    const allow = allowedCapability && fromBackend;
    const logUrl = permissionOriginsLog(wc, details, requestingOrigin);
    if (known && !fromBackend) {
      appendMainLog(`[perm-check] DENY non-backend origin: perm=${perm} origins=${logUrl}`);
    } else {
      appendMainLog(`[perm-check] perm=${perm} allow=${allow} origins=${logUrl}`);
    }
    return allow;
  });
  // Mirror renderer-side trace logs to main.log only when explicitly
  // enabled. The renderer emits high-volume ``[trace ...]`` lines on
  // live stop/recovery paths; mirroring them synchronously in release
  // builds creates avoidable I/O during the exact latency-sensitive
  // path users are timing. Keep crash/backend/permission logs always
  // on, and enable renderer trace capture with
  // TRANSCRIPTOR_RENDERER_TRACE_LOGS=1 when diagnosing a packaged app.
  //
  // Args: (event, level, message, line, sourceId)
  //   level: 0=verbose, 1=info, 2=warning, 3=error
  win.webContents.on("console-message", (_event, level, message) => {
    if (!MIRROR_RENDERER_TRACE_LOGS) return;
    const text = String(message || "");
    if (!text.startsWith("[trace")) return;
    const levelTag = level === 3 ? "ERROR" : level === 2 ? "WARN" : "INFO";
    appendMainLog(`[renderer ${levelTag}] ${text}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    const reason = String(details?.reason || "unknown");
    const exitCode = details?.exitCode ?? "";
    appendMainLog(`[render-process-gone] reason=${reason} exitCode=${exitCode}`);
    // ``clean-exit`` happens on normal window close and does NOT
    // require recovery. Every other reason (crashed, killed,
    // oom, etc.) leaves the Electron main process holding stale
    // references — the recording state machine, any in-flight
    // ``recordingStopInFlight`` flag, the ``pendingTranscriptionCount``
    // counter, and the ``shortcutToggleInFlight`` guard — that
    // would otherwise block every future hotkey press.
    if (reason === "clean-exit") return;
    // Reset the state machine so the NEXT hotkey press starts
    // cleanly instead of short-circuiting on a stale flag.
    recordingStopInFlight = false;
    shortcutToggleInFlight = false;
    pasteShortcutInFlight = false;
    if (pendingTranscriptionCount > 0) {
      appendMainLog(`[render-process-gone] dropping pendingTranscriptionCount=${pendingTranscriptionCount}`);
      pendingTranscriptionCount = 0;
    }
    // Drain any queued post-stop tasks — their renderer state is
    // dead, polling them would just spin processPostStopTask for
    // 15 s per task hitting executeJavaScript failures, then time
    // out. Faster + cleaner to drop them now.
    if (postStopQueue.length > 0) {
      const dropped = postStopQueue.length;
      postStopQueue = [];
      appendMainLog(`[render-process-gone] dropped postStopQueue=${dropped}`);
    }
    // Clear dedup Sets — the post-crash renderer's ``liveRecordingSeq``
    // resets to 0 on reload, so the new recordings will reuse ids 1, 2,
    // 3, ... that the pre-crash session already added to these Sets.
    // Without this clear, the next recording's recordingId=1 silently
    // collides with the dead-session entry and the dedup gate falsely
    // skips the post-stop paste task — user records, stops, and sees
    // NO paste happen until ids climb past the highest pre-crash id.
    if (_enqueuedRecordingIds.size > 0 || _pastedRecordingIds.size > 0) {
      appendMainLog(
        `[render-process-gone] clearing dedup sets ` +
        `enqueued=${_enqueuedRecordingIds.size} pasted=${_pastedRecordingIds.size}`,
      );
      _enqueuedRecordingIds.clear();
      _pastedRecordingIds.clear();
    }
    // Tear down recording status state: it may be waiting on a transcript
    // that will never arrive.
    try {
      resetRecordingStatusState();
    } catch (e) {
      appendMainLog(`[render-process-gone] resetRecordingStatusState failed: ${e?.message || e}`);
    }
    // The renderer is dead; ``reload()`` on a crashed webContents
    // throws. Schedule a fresh load so the user sees a working UI
    // on the next Spotlight/Dock click. Track the handle so the
    // app-quit path can clear it — if the user quits within the
    // 500 ms window after a crash, the timer would otherwise fire
    // against a webContents that's already going through teardown
    // and produce an unhandled rejection in the shutdown log.
    if (renderRecoveryTimer) clearTimeout(renderRecoveryTimer);
    renderRecoveryTimer = setTimeout(() => {
      renderRecoveryTimer = null;
      if (isQuitting) return;
      if (!win || win.isDestroyed() || !win.webContents) return;
      const baseUrl = `${BASE_URL}/`;
      win.loadURL(baseUrl).catch((e) => {
        appendMainLog(`[render-process-gone] reload failed: ${e?.message || e}`);
      });
    }, 500);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    appendMainLog(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
    // -3 = ERR_ABORTED (internal, usually benign — new nav cancelled old).
    // Everything else is a real load failure that leaves the renderer
    // blank, so surface a native diagnostic dialog with the log path.
    // Users on Windows most commonly see this when the backend hasn't
    // finished bootstrapping but the window was shown via a second
    // instance / tray click before loadURL completed.
    if (Number(code) === -3) return;
    if (String(url || "").startsWith("data:")) return;
    const logPath = path.join(app.getPath("userData"), "main.log");
    const msg =
      "Transcriptor could not load the app window.\n\n" +
      `Error: ${desc} (${code})\n\n` +
      `Log file: ${logPath}\n\n` +
      "This is usually a one-time startup hiccup. Try closing and " +
      "reopening Transcriptor. If it keeps happening, send the log " +
      "file to support.";
    try {
      dialog.showMessageBox({
        type: "error",
        title: "Transcriptor — startup error",
        message: "The app window failed to load",
        detail: msg,
        buttons: ["Copy log path", "OK"],
        defaultId: 1,
        cancelId: 1,
      }).then((res) => {
        if (res.response === 0) {
          try { clipboard.writeText(logPath); } catch { }
        }
      }).catch(() => { });
    } catch { }
  });
  win.webContents.on("did-finish-load", async () => {
    loadedFrontendBuildSignature = (await getFrontendBuildSignature()) || "";
    appendMainLog(`[did-finish-load] frontendSignature=${loadedFrontendBuildSignature || "none"}`);
    // Clear paste-dedup Sets on every renderer (re)load — but ONLY
    // when no in-flight recording or queued post-stop work exists.
    //
    // ``liveRecordingSeq`` (the renderer-side monotonic counter that
    // produces ``recordingId`` values) resets to 0 in every new
    // renderer instance — initial window load AND after a user-
    // initiated ``location.reload()`` (recoverFromBackendBoot,
    // DevTools refresh, F5). Without a clear at that boundary, ids
    // 1, 2, 3 from the new renderer collide with stale Set entries
    // from the previous renderer — ``handleRecordingPostStop`` then
    // falsely flags the next recording as a duplicate and silently
    // drops the paste task.
    //
    // BUT: a careless unconditional clear is itself a regression
    // surface. ``did-finish-load`` also fires when DevTools refreshes
    // mid-recording (Cmd-R / F5 while a recording is active). At that
    // moment ``pendingTranscriptionCount > 0`` (the in-flight stop is
    // queued) and ``postStopQueue`` is non-empty — clearing the Sets
    // there drops the active recording's id, then the post-stop
    // signal arrives and bypasses dedup, allowing the SAME content
    // to be pasted twice (once by the queued task, once by the
    // post-reload retry). That is the exact paste-duplication
    // regression the 1b05c52 / 1.1.10 hardening fixed.
    //
    // Idle-gate: clear only when both signals say "no work in
    // flight". On a normal cold load both are zero / empty — clear
    // runs as before. On a mid-recording reload the clear is
    // skipped, the in-flight id stays in the Set, and the queued
    // task's eventual paste is correctly deduped.
    const idle = pendingTranscriptionCount === 0 && postStopQueue.length === 0;
    if (!idle) {
      appendMainLog(
        `[did-finish-load] dedup clear SKIPPED ` +
        `(pending=${pendingTranscriptionCount} queue=${postStopQueue.length}) — ` +
        `mid-recording reload protected from paste-dup regression`,
      );
    } else if (_enqueuedRecordingIds.size > 0 || _pastedRecordingIds.size > 0) {
      appendMainLog(
        `[did-finish-load] clearing dedup sets ` +
        `enqueued=${_enqueuedRecordingIds.size} pasted=${_pastedRecordingIds.size}`,
      );
      _enqueuedRecordingIds.clear();
      _pastedRecordingIds.clear();
    }
    // Replay the cached shortcut status. If the initial
    // registerGlobalShortcuts() call happened before this window
    // existed (the usual case — shortcuts register during app.whenReady
    // before createWindow), the renderer would otherwise render with
    // its "hotkey" Settings panel showing the configured accelerator
    // as healthy when in fact registration silently failed.
    if (lastShortcutStatus && win && !win.isDestroyed() && win.webContents) {
      try {
        await win.webContents.executeJavaScript(
          `window.__transcriptorShortcutStatus = ${JSON.stringify(lastShortcutStatus)};`,
          true,
        );
      } catch (e) {
        appendMainLog(`[did-finish-load] shortcut replay failed: ${e?.message || e}`);
      }
    }
    // Replay cached accessibility-trust state. A window closed
    // (tray) and reopened would otherwise wait up to 30 s (the
    // poll interval) before the renderer learns whether
    // accessibility is granted, leaving the F9-collision badge
    // and other dependent UI in a stale state.
    if (lastAccessibilityTrusted !== null && win && !win.isDestroyed() && win.webContents) {
      try {
        await win.webContents.executeJavaScript(
          `window.__transcriptorAccessibilityStatus = ${JSON.stringify({ trusted: lastAccessibilityTrusted })};`,
          true,
        );
      } catch (e) {
        appendMainLog(`[did-finish-load] accessibility replay failed: ${e?.message || e}`);
      }
    }
    // Replay backendBootError if set — a window that was closed-
    // and-reopened after a failed boot attempt would otherwise
    // render its boot overlay in a "no error" state, hiding the
    // diagnostic the user needs.
    if (backendBootError && win && !win.isDestroyed() && win.webContents) {
      try {
        await win.webContents.executeJavaScript(
          `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
          true,
        );
      } catch (e) {
        appendMainLog(`[did-finish-load] backendBootError replay failed: ${e?.message || e}`);
      }
    }
  });

  win.on("close", (event) => {
    // Keep renderer warm on macOS so global-hotkey actions are instant and
    // don't steal focus by re-creating window each time.
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      win.hide();
      return;
    }
  });
  win.on("show", () => {
    if (process.platform === "darwin" && app.dock) app.dock.show();
  });

  win.on("closed", () => {
    // Drop webContents listeners explicitly before releasing the ref
    // so nothing can re-bind them through a stale closure. Electron
    // GCs the BrowserWindow's native resources on its own, but
    // JavaScript closures that captured ``win.webContents`` would
    // still hold references to the old listener set.
    try {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.removeAllListeners("render-process-gone");
        win.webContents.removeAllListeners("did-fail-load");
        win.webContents.removeAllListeners("did-finish-load");
      }
    } catch (e) {
      appendMainLog(`[win-closed-listener-cleanup] ${e?.message || e}`);
    }
    win = null;
  });

  // ``url`` is captured AFTER startBackend so it reflects whatever
  // port pickBackendPort actually bound. Previously captured at this
  // point (before the conditional startBackend call), the URL would
  // freeze at the OLD ``BASE_URL`` and a port shift inside
  // pickBackendPort (preferred 8321 occupied → fallback 8322) made
  // win.loadURL hit ERR_CONNECTION_REFUSED on the stale port. The
  // healthcheck below already used template re-evaluation against
  // fresh BASE_URL, so the inconsistency was easy to miss until a
  // backend-restart-after-crash path triggered the port shift.
  try {
    if (!backend) {
      await startBackend();
    }
    const url = `${BASE_URL}/`;
    // Per-user-decision (pass 28): NO BOOT LOADER. The window stays
    // hidden during the cold-start window; once /api/health responds
    // OK we load the real URL and reveal the window. This avoids
    // the "Starting Transcriptor…" pulse screen the user finds
    // distracting, while ALSO avoiding the alternative regression
    // (blank window for 5–60 s) — by staying hidden we show
    // nothing at all until the app is genuinely ready.
    //
    // 60 s ceiling: cold-start on a fresh install with bundled
    // runtime is typically <5 s; the budget just bounds the wait
    // before the catch branch surfaces a real error to the user.
    await waitForBackendHealth(`${BASE_URL}/api/health`, 60_000);
    // Backend is healthy — treat this as a successful recovery signal
    // and clear the restart-attempt counter. Without this reset the
    // counter only decayed on a clean `exit code 0`, which never fires
    // outside shutdown, so the exponential backoff compounded across
    // sessions making the log delay misleading.
    if (backendRestartAttempts !== 0) {
      appendMainLog(`[backend-recovery] healthy after ${backendRestartAttempts} attempt(s); resetting counter`);
      backendRestartAttempts = 0;
    }
    // CLEAR `backendBootError` once /api/health responds OK. Pass-24c
    // added a `did-finish-load` replay of this string so a closed-
    // and-reopened window can re-deliver the diagnostic — but if the
    // user successfully RECOVERED from the error (transient port
    // collision, fixed permissions, etc.), the stale message would
    // re-render on every subsequent window load, looking like the
    // app failed when it actually succeeded. Clearing on health-OK
    // closes that regression window.
    if (backendBootError) {
      appendMainLog(`[backend-recovery] clearing prior backendBootError (was: ${backendBootError.slice(0, 80)}...)`);
      backendBootError = "";
    }
    await refreshWindowForFrontendBuild(true);
    await win.loadURL(url);
    // Reveal NOW that the real frontend is loaded and the backend is
    // healthy. Skipping the loader page (pass 28) means this is the
    // very first time the user sees a window — no transition flash,
    // no "starting up" UI, just the ready app.
    if (showWindow && !win.isVisible()) {
      win.show();
      win.focus();
    }
  } catch (err) {
    const stderrTail = (backendStderrTail || "").trim();
    const details = [
      err.message,
      backendBootError,
      stderrTail ? `— Backend stderr (last ${stderrTail.length} chars) —\n${stderrTail}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Platform-specific recovery instructions. Keep these tied to the
    // current root entrypoints instead of deleted legacy install scripts.
    const logPath = path.join(app.getPath("userData"), "main.log");
    let recoveryHtml;
    if (app.isPackaged) {
      recoveryHtml = (
        `<p style="color:#bbb;margin-bottom:6px">Troubleshooting:</p>` +
        `<ol style="color:#ddd;margin:8px 0 14px 18px;padding:0;line-height:1.8">` +
        `<li>Close Transcriptor fully and reopen it once.</li>` +
        `<li>Reinstall the current release if the bundled runtime was quarantined or removed.</li>` +
        `<li>If the problem persists, send the log file shown below.</li>` +
        `</ol>` +
        `<p style="color:#888;font-size:12px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    } else if (process.platform === "win32") {
      recoveryHtml = (
        `<p style="color:#bbb;margin-bottom:6px">Troubleshooting:</p>` +
        `<ol style="color:#ddd;margin:8px 0 14px 18px;padding:0;line-height:1.8">` +
        `<li>Close Transcriptor fully and reopen it.</li>` +
        `<li>Make sure Python 3.12 is installed: <code style="background:#333;padding:2px 6px;border-radius:4px">winget install Python.Python.3.12</code></li>` +
        `<li>If the problem persists, rebuild from the source checkout.</li>` +
        `</ol>` +
        `<p style="color:#888;font-size:12px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    } else if (process.platform === "linux") {
      recoveryHtml = (
        `<p style="color:#bbb;margin-bottom:6px">Troubleshooting:</p>` +
        `<ol style="color:#ddd;margin:8px 0 14px 18px;padding:0;line-height:1.8">` +
        `<li>Install missing system deps: <code style="background:#333;padding:2px 6px;border-radius:4px">sudo apt install python3 python3-venv python3-pip ffmpeg xdotool zenity</code></li>` +
        `<li>Close and relaunch the AppImage.</li>` +
        `</ol>` +
        `<p style="color:#888;font-size:12px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    } else {
      recoveryHtml = (
        `<h3 style="margin:0 0 10px 0;color:#e0e0e0">If it doesn't recover automatically</h3>` +
        `<p style="color:#bbb;margin-bottom:6px">Find the <b>Voice Transcriptor</b> folder you downloaded:</p>` +
        `<p style="color:#ddd;margin:8px 0">Quit and reopen Transcriptor. For a source checkout, run the current root installer:</p>` +
        `<pre style="background:#111;padding:10px 14px;border-radius:8px;border:1px solid #444;color:#7defa0;font-size:12px;user-select:all;cursor:text">cd ~/Downloads/Voice\\\\ Transcriptor && ./INSTALL.command</pre>` +
        `<p style="color:#888;font-size:12px;margin-top:14px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    }
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
      <html>
        <head><meta charset="utf-8"></head>
        <body style="background:#1a1a1a;color:#cfcfcf;font-family:-apple-system,Segoe UI,Arial;padding:28px;line-height:1.6">
          <h2 style="margin:0 0 16px 0">Transcriptor — Backend startup failed</h2>
          <pre style="white-space:pre-wrap;background:#111;padding:14px;border-radius:8px;border:1px solid #333;margin-bottom:20px">${escapeHtml(details)}</pre>
          <div id="status" style="padding:10px 14px;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:8px;margin-bottom:16px;color:#7defa0;font-size:13px">⏳ Checking if backend is starting...</div>
          ${recoveryHtml}
        </body>
      </html>
    `)}`
    );
    if (showWindow && win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    let recoveryAttempt = 0;
    const updateRecoveryStatus = async (text, healthy = false) => {
      if (!win || win.isDestroyed()) return;
      const js = `
        (() => {
          const s = document.getElementById('status');
          if (!s) return;
          s.textContent = ${JSON.stringify(text)};
          if (${healthy ? "true" : "false"}) {
            s.style.background = '#1a3a1a';
            s.style.borderColor = '#2a6a2a';
          }
        })();
      `;
      try { await win.webContents.executeJavaScript(js, true); } catch { /* page may have navigated */ }
    };
    const pollRecovery = async () => {
      while (win && !win.isDestroyed()) {
        recoveryAttempt += 1;
        await updateRecoveryStatus(`⏳ Waiting for backend... (attempt ${recoveryAttempt})`);
        try {
          await waitForBackendHealth(`${BASE_URL}/api/health`, 3000);
          await updateRecoveryStatus("✅ Backend is up! Loading app...", true);
          if (win && !win.isDestroyed()) {
            await win.loadURL(`${BASE_URL}/`);
          }
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    };
    void pollRecovery();
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  ensureWindowVisible({ manual: true, force: true });
});

/**
 * Robust backend termination — used from every exit path so the
 * Python subprocess is never orphaned.
 *
 * Previously only ``before-quit`` called ``backend.kill()``. If the
 * app crashed (``uncaughtException``), received a POSIX signal, or
 * went through any exit path that doesn't fire ``before-quit``, the
 * backend would keep running and hold on to its listening port.
 *
 * This helper sends SIGTERM first (graceful shutdown), then escalates
 * to SIGKILL after 1500 ms if the process is still alive. It also
 * tries to reap a stale PID via ``process.kill`` even after our local
 * ``backend`` reference has been cleared.
 */
let backendTerminationInProgress = false;
function killBackendHard(reason) {
  if (backendTerminationInProgress) return;
  backendTerminationInProgress = true;
  const proc = backend;
  backend = null;
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  if (!proc) {
    backendTerminationInProgress = false;
    return;
  }
  appendMainLog(`[backend-kill] reason=${reason} pid=${proc.pid}`);
  let pidForFallback = proc.pid;

  // On Windows, Node's ``proc.kill("SIGTERM")`` maps to TerminateProcess
  // on the IMMEDIATE child only — uvicorn workers, ffmpeg subprocesses,
  // and any Python-spawned helpers survive as orphans holding port 8321
  // and whisper models in RAM. The kernel's ``taskkill /T /F`` tree-
  // kill primitive walks the PID tree and is the correct fix. We still
  // rely on the parent-death stdin watchdog (backend/main.py) as a
  // belt-and-braces backup for crash-exit paths where we don't get to
  // run this function.
  if (process.platform === "win32") {
    const tryProcKill = () => {
      // Final fallback — the original TerminateProcess path. Better
      // than nothing when taskkill fails / times out / the PID is
      // garbage. ``proc`` may be a stale reference at this point, so
      // swallow its own failure — we already logged one above.
      try {
        if (proc && typeof proc.kill === "function") {
          proc.kill("SIGKILL");
          appendMainLog(`[backend-kill] fallback proc.kill(SIGKILL) executed`);
        } else if (pidForFallback) {
          process.kill(pidForFallback, "SIGKILL");
          appendMainLog(`[backend-kill] fallback process.kill(${pidForFallback}, SIGKILL) executed`);
        }
      } catch { }
    };
    // Guard: the subprocess can have spawned but crashed before we got
    // here, making `proc.pid` either `undefined` or a stale value that
    // taskkill will reject with "ERROR: Invalid argument". Without the
    // guard `String(undefined) === "undefined"` becomes a literal
    // taskkill arg, the call fails nonzero, and we used to `return`
    // with no fallback kill.
    if (!pidForFallback || typeof pidForFallback !== "number") {
      appendMainLog(`[backend-kill] no valid pid to tree-kill; trying direct proc.kill fallback`);
      tryProcKill();
      pidForFallback = null;
      backendTerminationInProgress = false;
      return;
    }
    let taskkillOk = false;
    try {
      const r = spawnSync("taskkill", ["/pid", String(pidForFallback), "/t", "/f"], {
        windowsHide: true,
        timeout: 5000,
      });
      if (r.status === 0) {
        taskkillOk = true;
        appendMainLog(`[backend-kill] taskkill tree-killed pid=${pidForFallback}`);
      } else {
        appendMainLog(
          `[backend-kill] taskkill exit=${r.status} signal=${r.signal || ""} ` +
          `stderr=${(r.stderr || "").toString().trim().slice(0, 200)}`
        );
      }
    } catch (e) {
      appendMainLog(`[backend-kill] taskkill threw: ${e?.message || e}`);
    }
    // If taskkill didn't report success (non-zero exit, SIGTERM'd by
    // our 5 s timeout, or threw), run the direct-kill fallback.
    // Without this a wedged taskkill (corp AV, elevated shell
    // blocking) leaves the backend tree orphaned and the next app
    // launch fails with "port 8321 already in use" for 120 s.
    if (!taskkillOk) tryProcKill();
    pidForFallback = null;
    backendTerminationInProgress = false;
    return;
  }

  try {
    proc.kill("SIGTERM");
  } catch (e) {
    appendMainLog(`[backend-kill] SIGTERM failed: ${e?.message || e}`);
  }
  // Hard-kill timeout — if the process ignores SIGTERM (e.g., blocked
  // in a native call), SIGKILL it so we don't orphan it.
  setTimeout(() => {
    if (!pidForFallback) return;
    try {
      process.kill(pidForFallback, 0);
      // Still alive — escalate to SIGKILL.
      try {
        process.kill(pidForFallback, "SIGKILL");
        appendMainLog(`[backend-kill] escalated to SIGKILL pid=${pidForFallback}`);
      } catch (e) {
        appendMainLog(`[backend-kill] SIGKILL failed: ${e?.message || e}`);
      }
    } catch {
      // ESRCH — process is already gone, nothing to do.
    }
    pidForFallback = null;
    backendTerminationInProgress = false;
  }, 1500);
}

app.on("before-quit", () => {
  isQuitting = true;
  // Clear the auto-restart timer FIRST, before any other cleanup.
  // killBackendHard at the bottom of this handler also clears it, but
  // by then we've already spent ~tens of milliseconds tearing down
  // shortcuts, timers, recording monitors, and the tray. If the timer fires
  // during that window it spawns a NEW backend that the now-cleared
  // ``backend`` reference can't kill — a guaranteed orphan. Yanking
  // the timer first closes that race window.
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  // Same reasoning for the render-process-gone recovery timer:
  // if the user quits during the 500 ms window after a renderer
  // crash, the scheduled loadURL must NOT fire against a webContents
  // that's already going through teardown.
  if (renderRecoveryTimer) {
    clearTimeout(renderRecoveryTimer);
    renderRecoveryTimer = null;
  }
  globalShortcut.unregisterAll();
  shortcutBridgeHandler = null;
  pendingShortcutBridgeMessages = [];
  if (shortcutPollTimer) {
    clearInterval(shortcutPollTimer);
    shortcutPollTimer = null;
  }
  if (accessibilityPollTimer) {
    clearInterval(accessibilityPollTimer);
    accessibilityPollTimer = null;
  }
  stopRecordingStateMonitor();
  if (tray) {
    try {
      tray.destroy();
    } catch (e) {
      appendMainLog(`[before-quit] tray destroy failed: ${e?.message || e}`);
    }
    tray = null;
  }
  killBackendHard("before-quit");
});

// Hook the raw node process exit events too — covers crashes and
// external signals that bypass Electron's ``before-quit`` handler.
process.on("exit", () => {
  isQuitting = true;
  killBackendHard("process-exit");
});
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    appendMainLog(`[signal] ${sig}`);
    isQuitting = true;
    killBackendHard(`signal-${sig}`);
    try {
      app.quit();
    } catch {
      try { app.exit(SIGNAL_EXIT_CODES[sig] || 0); } catch { process.exit(SIGNAL_EXIT_CODES[sig] || 0); }
    }
    const exitTimer = setTimeout(() => {
      try { app.exit(SIGNAL_EXIT_CODES[sig] || 0); } catch { process.exit(SIGNAL_EXIT_CODES[sig] || 0); }
    }, 1500);
    if (typeof exitTimer.unref === "function") exitTimer.unref();
  });
}

app.whenReady().then(async () => {
  // Process-level uncaughtException / unhandledRejection handlers are
  // already registered at module top-level so pre-whenReady crashes are
  // captured. No duplicate registration needed here.
  cleanupStaleTranscriptTmpFiles();
  lastTranscriptText = loadLastTranscriptFromDisk();
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
  }
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
  }
  // macOS-only: poll Accessibility permission. Users who recorded
  // successfully once, then revoked the permission via System Settings
  // would otherwise see their F9 become a silent no-op on the next
  // session. `globalShortcut.register` returns true even when the
  // handler has been made non-functional by revocation — there is no
  // event to listen for, so we poll at 30 s intervals and surface the
  // state to the renderer. Non-Darwin platforms no-op.
  if (process.platform === "darwin") {
    const checkAccessibility = () => {
      try {
        const trusted = !!systemPreferences.isTrustedAccessibilityClient(false);
        if (trusted !== lastAccessibilityTrusted) {
          lastAccessibilityTrusted = trusted;
          appendMainLog(`[accessibility] trusted=${trusted}`);
          if (win && !win.isDestroyed() && win.webContents) {
            win.webContents
              .executeJavaScript(
                `window.__transcriptorAccessibilityStatus = ${JSON.stringify({ trusted })};`,
                true,
              )
              .catch(() => { });
          }
        }
      } catch { }
    };
    checkAccessibility();
    // Capture the handle so we can clear it on before-quit (otherwise
    // repeated dev-reload leaks intervals, and on production the
    // refed timer can delay clean shutdown by up to 30 s). `.unref`
    // also lets the event loop exit naturally if this were the last
    // pending handle.
    accessibilityPollTimer = setInterval(checkAccessibility, 30000);
    try { accessibilityPollTimer.unref?.(); } catch { }
  }
  // Create a 5-bar sound wave tray icon matching the app icon (icon.png).
  // 32×32 @2x retina, template image auto-adapts to light/dark menu bar.
  const trayCanvas = (() => {
    const s = 32;
    const buf = Buffer.alloc(s * s * 4, 0);
    const barW = 3;
    const gap = 2;
    const totalW = 5 * barW + 4 * gap;
    const startX = Math.round((s - totalW) / 2);
    const heights = [14, 19, 24, 18, 12];

    const setPixel = (x, y, alpha) => {
      if (x < 0 || x >= s || y < 0 || y >= s) return;
      const i = (y * s + x) * 4;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = alpha;
    };

    for (let b = 0; b < 5; b++) {
      const bx = startX + b * (barW + gap);
      const h = heights[b];
      const top = Math.round((s - h) / 2);
      const bot = top + h;
      for (let y = top; y < bot; y++) {
        for (let x = bx; x < bx + barW; x++) {
          // Round the top and bottom corners
          const isTopEdge = y === top;
          const isBotEdge = y === bot - 1;
          const isLeftEdge = x === bx;
          const isRightEdge = x === bx + barW - 1;
          if ((isTopEdge || isBotEdge) && (isLeftEdge || isRightEdge)) {
            setPixel(x, y, 140); // soften corners
          } else {
            setPixel(x, y, 255);
          }
        }
      }
    }
    return nativeImage.createFromBuffer(buf, { width: s, height: s, scaleFactor: 2.0 });
  })();
  trayCanvas.setTemplateImage(true);
  tray = new Tray(trayCanvas);
  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Open Transcriptor",
      click: () => {
        ensureWindowVisible({ manual: true, force: true });
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  ]);
  tray.on("click", () => {
    ensureWindowVisible({ manual: true, force: true });
  });
  tray.on("right-click", () => {
    tray?.popUpContextMenu(trayMenu);
  });
  // Linux GTK status icons don't emit ``right-click`` on most desktop
  // environments — only macOS and Windows do. Without setContextMenu,
  // Linux users have no way to reach Quit / Open from the tray icon.
  // Calling setContextMenu installs a native context menu hook that
  // works on every platform; macOS and Windows still benefit from the
  // explicit right-click handler above for double-coverage.
  try {
    tray.setContextMenu(trayMenu);
  } catch (e) {
    appendMainLog(`[tray] setContextMenu failed: ${e?.message || e}`);
  }
  if (!app.isPackaged) {
    const devKey = process.platform === "darwin" ? "Command+Shift+D" : "Control+Shift+D";
    const ok = globalShortcut.register(devKey, () => {
      if (!win?.webContents) return;
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools();
    });
    if (!ok) {
      appendMainLog("[app] failed to register devtools shortcut");
    }
  }

  // ── Global Shortcuts (config-driven with live reload) ─────────────────────
  let registeredRecordHotkey = "";
  let registeredPasteHotkey = "";
  let shortcutsSuspendedForCapture = false;

  function readShortcutsFromConfig() {
    // Must match DEFAULT_SHORTCUTS in frontend/src/main.tsx.
    //
    // Platform-specific defaults — F-keys on Mac fight the OS:
    // F9 = Mission Control / F10 = Notification Center under the
    // default "media keys" mode, so users had to either hold Fn or
    // toggle the OS setting before our hotkey did anything. On
    // Win/Linux F-keys are clean — no built-in app binding.
    //
    // Mac: Option+Left for record (Option = "Alt" in Electron's
    //      accelerator vocabulary; both left and right Option work),
    //      Option+Shift+V for paste-last (avoids the Shift+7=`&`
    //      quirk on US/UK layouts that broke Alt+Shift+7).
    // Win/Linux: F9 / F10 (clean function keys).
    const defaults = process.platform === "darwin"
      ? { record: "Alt+Left", paste: "Alt+Shift+V" }
      : { record: "F9", paste: "F10" };
    try {
      const dataDir = process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData");
      const cfgPath = path.join(dataDir, "config.json");
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const ui = raw?.preferences?.ui || {};
        let record = String(ui.shortcut_record || defaults.record).trim() || defaults.record;
        let paste = String(ui.shortcut_paste || defaults.paste).trim() || defaults.paste;
        // Mirror the renderer's loadCfg one-time migration:
        // a Mac user's config still carries pass-15's stale F9/F10
        // cross-platform default. F9 = Mission Control on macOS, so
        // registering it here means the OS hijacks every press and
        // the user reports "shortcut doesn't work". The renderer
        // ALSO migrates and queues a pending re-register on its 2 s
        // poll, but the main process registers FIRST at startup —
        // for those 2+ seconds (and any earlier F9 press), the
        // shortcut is a black hole. Mirror the migration here so
        // the FIRST register call uses the correct platform default.
        if (process.platform === "darwin" && record === "F9" && paste === "F10") {
          record = defaults.record;
          paste = defaults.paste;
          appendMainLog("[shortcuts] migrated stale F9/F10 → Alt+Left/Alt+Shift+V on Mac");
        }
        // Migration 2: legacy `Alt+Shift+7` was unpressable on
        // US/UK layouts (Shift+7 = `&`). Always rewrite to the
        // platform default's paste accelerator.
        if (paste === "Alt+Shift+7") {
          paste = defaults.paste;
          appendMainLog(`[shortcuts] migrated stale Alt+Shift+7 → ${paste}`);
        }
        return { record, paste };
      }
    } catch (e) {
      appendMainLog(`[shortcuts] config read error: ${e?.message || e}`);
    }
    return defaults;
  }

  // Attempt to register an accelerator and return a normalized result.
  // ``globalShortcut.register`` can return ``false`` (accelerator in
  // use by another app) OR throw (malformed accelerator string from
  // an edited config). Both paths become a non-fatal ``ok=false`` so
  // the caller can log + surface the failure without crashing the
  // Electron main process.
  function safeRegisterShortcut(accelerator, handler) {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      return { ok: !!ok, error: ok ? "" : "already in use" };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  function unregisterRegisteredShortcuts(reason = "") {
    const previousRecord = registeredRecordHotkey;
    const previousPaste = registeredPasteHotkey;
    if (registeredRecordHotkey) {
      try { globalShortcut.unregister(registeredRecordHotkey); } catch { }
    }
    if (registeredPasteHotkey) {
      try { globalShortcut.unregister(registeredPasteHotkey); } catch { }
    }
    registeredRecordHotkey = "";
    registeredPasteHotkey = "";
    if (reason && (previousRecord || previousPaste)) {
      appendMainLog(
        `[shortcuts] unregistered (${reason}): record=${previousRecord || "-"} paste=${previousPaste || "-"}`,
      );
    }
  }

  function registerGlobalShortcuts(override = null) {
    if (shortcutsSuspendedForCapture && !override) {
      appendMainLog("[shortcuts] register skipped while Settings capture is active");
      return;
    }
    // SSOT for the accelerators we actually bind:
    //   - At startup → readShortcutsFromConfig() (disk-backed, pre-renderer).
    //   - After a Settings-UI capture → renderer pushes pending values
    //     via `__transcriptorPendingShortcuts`. Pass them in here as
    //     `override` so the registration uses the IN-MEMORY values the
    //     user just typed, NOT the disk config.
    //
    // Why the override exists (root cause of "не ставятся новые при
    // нажатии клавиш"): the renderer queues a debounced (600 ms) save
    // to /api/config which the backend writes to disk asynchronously,
    // while ALSO setting the pending window flag immediately. The main
    // process polls every 2 s. If the poll fires before the disk write
    // completes (debounce + apiPost RTT + fs flush often >2 s under
    // any load), readShortcutsFromConfig returns the OLD shortcut and
    // we re-register the very accelerator the user just changed away
    // from. The pending flag is consumed but its payload is discarded.
    // Result: the displayed shortcut updates in the UI but the actual
    // global hotkey remains the previous binding. Routing the pending
    // payload through `override` removes the disk-write dependency
    // entirely — registration uses exactly what the user pressed.
    //
    // Defensive fallback: if `override` is partial (only `record` or
    // only `paste`) we fill the missing half from disk so we never
    // unregister an accelerator without re-registering its replacement.
    let shortcuts;
    if (override && (override.record || override.paste)) {
      const fromDisk = (override.record && override.paste) ? null : readShortcutsFromConfig();
      shortcuts = {
        record: String(override.record || (fromDisk && fromDisk.record) || "").trim(),
        paste: String(override.paste || (fromDisk && fromDisk.paste) || "").trim(),
      };
    } else {
      shortcuts = readShortcutsFromConfig();
    }
    // Unregister old shortcuts (keep devtools). Clear stored values
    // up-front — only set them back after a
    // successful registration, so a failed accelerator is never
    // tracked as "active" (which would cause the next reload to
    // unregister something that was never registered).
    unregisterRegisteredShortcuts();

    const recordResult = safeRegisterShortcut(shortcuts.record, () => {
      toggleRecordingFromShortcut().catch((e) => {
        appendMainLog(`[shortcut] toggle failed: ${e?.message || e}`);
        resetRecordingStatusState();
      });
    });
    if (recordResult.ok) {
      registeredRecordHotkey = shortcuts.record;
    } else {
      appendMainLog(
        `[app] failed to register recording shortcut: ${shortcuts.record} (${recordResult.error})`,
      );
    }

    const pasteResult = safeRegisterShortcut(shortcuts.paste, () => {
      pasteLatestTranscriptFromShortcut().catch((e) => {
        appendMainLog(`[shortcut] paste-last failed: ${e?.message || e}`);
        resetRecordingStatusState();
      });
    });
    if (pasteResult.ok) {
      registeredPasteHotkey = shortcuts.paste;
    } else {
      appendMainLog(
        `[app] failed to register paste-last shortcut: ${shortcuts.paste} (${pasteResult.error})`,
      );
    }

    // Surface registration status to the renderer so the Settings
    // panel can show a red indicator next to any shortcut that the
    // main process could not claim. Failures are common: stale
    // accelerators from another running copy, malformed user input,
    // OS-level reservations (e.g. Alt+Space on some locales).
    //
    // IMPORTANT: `registerGlobalShortcuts` is invoked DURING app startup
    // (see the bottom of this file, before createWindow). At that
    // moment `win` is null and the injection below no-ops, so the
    // renderer never learns that its hotkey is unclaimed — the most
    // common real-world failure mode (corp user, F9 owned by another
    // app) becomes silent. We cache the latest status in a module var
    // and replay it from `did-finish-load` so every window creation
    // sees the current state, including the very first window ever
    // created.
    // On macOS, check whether the OS is intercepting F1–F12 as media
    // keys (default on Apple keyboards: "Use F1, F2, etc. keys as
    // standard function keys" OFF → F9 = Mission Control, F10 =
    // Notification Center, F11 = Show Desktop). In that mode
    // `globalShortcut.register("F9")` returns true but the user's
    // actual F9 press fires the OS function, never reaches us — the
    // single most common "hotkey does not work" report from Mac users.
    // We surface the state to the renderer so Settings can badge the
    // F9 / F10 rows with a "macOS is intercepting this key — hold Fn,
    // or switch the OS setting, or pick a different hotkey" hint.
    // No forced dialog on launch — that would annoy users who
    // deliberately picked a non-F-key accelerator.
    let macFnState = null;  // null = unknown / non-darwin / probe failed
    if (process.platform === "darwin") {
      try {
        const raw = systemPreferences.getUserDefault("com.apple.keyboard.fnState", "boolean");
        macFnState = (raw === true);
      } catch {
        macFnState = null;
      }
    }
    const status = {
      record: {
        desired: shortcuts.record,
        active: recordResult.ok ? shortcuts.record : "",
        error: recordResult.ok ? "" : recordResult.error,
      },
      paste: {
        desired: shortcuts.paste,
        active: pasteResult.ok ? shortcuts.paste : "",
        error: pasteResult.ok ? "" : pasteResult.error,
      },
      // Renderer uses this to decide whether to show the "macOS is
      // intercepting F9/F10" hint. Only relevant on darwin and only
      // when the configured accelerator is an F-key.
      macFnState,
      platform: process.platform,
    };
    lastShortcutStatus = status;
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents
        .executeJavaScript(
          `window.__transcriptorShortcutStatus = ${JSON.stringify(status)};`,
          true,
        )
        .catch(() => { });
    }

    appendMainLog(
      `[shortcuts] registered: record=${registeredRecordHotkey || "FAILED"} ` +
      `paste=${registeredPasteHotkey || "FAILED"}`,
    );
  }

  function handleShortcutBridgeMessage(message) {
    const action = String(message?.action || "").trim();
    if (action === "capture-start") {
      if (!shortcutsSuspendedForCapture) {
        shortcutsSuspendedForCapture = true;
        unregisterRegisteredShortcuts("settings-capture");
      }
      return;
    }
    if (action === "capture-cancel") {
      if (shortcutsSuspendedForCapture) {
        shortcutsSuspendedForCapture = false;
        appendMainLog("[shortcuts] settings capture cancelled; restoring registered shortcuts");
        registerGlobalShortcuts();
      }
      return;
    }
    if (action === "update") {
      const record = String(message?.record || "").trim();
      const paste = String(message?.paste || "").trim();
      if (!record || !paste) {
        appendMainLog(`[shortcuts] bridge update rejected: record=${record || "-"} paste=${paste || "-"}`);
        return;
      }
      shortcutsSuspendedForCapture = false;
      appendMainLog(`[shortcuts] bridge live reload: record=${record} paste=${paste}`);
      registerGlobalShortcuts({ record, paste });
    }
  }

  registerGlobalShortcuts();

  shortcutBridgeHandler = handleShortcutBridgeMessage;
  if (pendingShortcutBridgeMessages.length > 0) {
    const queuedMessages = pendingShortcutBridgeMessages.splice(0);
    for (const message of queuedMessages) {
      handleShortcutBridgeMessage(message);
    }
  }

  // Poll for live shortcut changes from the renderer settings UI.
  // Skip when the window is hidden — users edit shortcuts only with
  // the Settings pane visible. Handle is cleared in before-quit so a
  // late tick can never executeJavaScript against a torn-down
  // webContents (which otherwise produces [unhandledRejection] noise
  // in the shutdown log).
  shortcutPollTimer = setInterval(async () => {
    if (!win || win.isDestroyed() || !win.webContents || !win.isVisible()) return;
    try {
      const pending = await win.webContents.executeJavaScript(
        `(() => { const p = window.__transcriptorPendingShortcuts; if (p) { delete window.__transcriptorPendingShortcuts; return p; } return null; })()`,
        true
      );
      if (pending && (pending.record || pending.paste)) {
        appendMainLog(`[shortcuts] live reload: record=${pending.record} paste=${pending.paste}`);
        // Pass the in-memory payload directly. registerGlobalShortcuts
        // will NOT re-read disk for these values, eliminating the
        // pending-vs-disk-write race that silently rebound users to
        // the OLD accelerator after Settings → Shortcuts capture.
        shortcutsSuspendedForCapture = false;
        registerGlobalShortcuts({ record: pending.record, paste: pending.paste });
      }
    } catch { }
  // Match accessibilityPollTimer: `.unref` so this refed timer
  // doesn't block clean event-loop shutdown by up to 2 s. Cleared
  // explicitly in `before-quit` (line ~5491) for the same reason.
  }, 2000);
  try { shortcutPollTimer.unref?.(); } catch { }

  // 1.1.25 fix: previously awaited the permission prompts before
  // starting the backend. The permission dialog is modal and can
  // sit there for minutes if the user is AFK — backend never
  // booted, renderer's preload waited, user thought the app was
  // broken. Kick the prompt off in PARALLEL with backend boot
  // (they are orthogonal — perms gate paste at runtime, not boot).
  const macPermPromise = requestMacPastePermissionsOnce();
  await startBackend();
  await ensureWindowVisible();
  await requestMacMicrophonePermissionOnce();
  // Drain the permission prompt promise — by now boot is complete,
  // the user has the window in front of them, and any modal dialog
  // is contextual rather than blocking the launch.
  try { await macPermPromise; } catch { /* best-effort permission */ }
}).catch((err) => {
  // The whenReady chain has many awaits — startBackend, permission
  // probes, accessibility checks, and any one of
  // them rejecting becomes an unhandled promise rejection that the
  // top-level ``unhandledRejection`` handler logs but cannot recover
  // from. The app then sits in an inconsistent state (no shortcuts,
  // no tray, no backend) with the user staring at a hidden window.
  // Catching here gives us one place to surface the failure both to
  // the log AND to the renderer / boot overlay so the user can
  // either retry or quit instead of force-killing.
  const msg = err && err.message ? err.message : String(err);
  try { appendMainLog(`[whenReady-fatal] ${msg}`); } catch { }
  backendBootError = `App startup failed: ${msg}`;
  setBackendBootStatus("");
  // Surface to whichever surface is alive: an existing window's
  // boot-overlay first (renderer is up but backend died), tray
  // notification second, dialog last (final fallback when the
  // window never made it).
  if (win && !win.isDestroyed() && win.webContents) {
    try {
      win.webContents.executeJavaScript(
        `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
        true,
      ).catch(() => { });
    } catch { }
  } else {
    try {
      dialog.showErrorBox("Transcriptor — startup failed", msg);
    } catch { }
  }
});
