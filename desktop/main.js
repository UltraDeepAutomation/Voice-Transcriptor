const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage, systemPreferences, dialog, clipboard } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

let backend = null;
let win = null;
let overlayWin = null;
let overlayMonitor = null;
let overlayWaveMonitor = null;
let overlayLoaded = false;
let tray = null;
let backendBootError = "";
let isQuitting = false;
let shortcutToggleInFlight = false;
let pasteTargetAppName = "";
let pasteTargetAppPid = 0;
let overlayStopInFlight = false;
let pasteShortcutInFlight = false;
let lastTranscriptText = "";
let mainLogFilePath = "";
let traceCounter = 0;
let overlayQuickSettingsOpen = false;
let overlayQuickProvider = "local";
let overlayQuickModel = "small";
let overlayQuickUpscalePreset = "builtin_clean";
let overlayQuickUpscaleEnabled = false;
let overlayQuickAutoSend = false;
let overlayQuickAutoSendInitialized = false;
let overlayQuickSettingsInitialized = false;
let overlaySilenceStartedAt = 0;
let overlayAutoStopConfig = { enabled: false, seconds: 2, thresholdDb: -42 };
let overlayAutoStopUiActive = false;
let overlayAutoStopConfigRefreshAt = 0;
let overlayRecordingStartedAt = 0;
let overlaySeenAudioFrames = false;
let overlaySpeechRecoveryStartedAt = 0;
let overlayAutoStopTriggerTimer = null;
let overlayTranscribingStatusTimer = null;
let overlayHideTimer = null;
let lastOverlayUiInteractionAt = 0;
let postStopQueue = [];
let postStopWorkerRunning = false;
let pendingTranscriptionCount = 0;
let backendRestartTimer = null;
let backendRestartAttempts = 0;
// Single-flight promise for ``startBackend``. Concurrent callers
// (window creation, restart timer, tray re-open) all await the same
// in-flight start instead of racing to spawn duplicate Python
// subprocesses that leak PIDs when ``backend`` is overwritten.
let backendStartInFlight = null;
let micPermissionChecked = false;
let loadedFrontendBuildSignature = "";
const OVERLAY_FIXED_HEIGHT = 150;

const HOST = "127.0.0.1";
// Backend port default. pickBackendPort iterates up if occupied, so
// collisions with other local services on 8321 are non-fatal — the
// actual port the backend bound is stored in mutable ``PORT`` below.
// All four previous hardcoded 8321 literals now reference this constant
// so a future port change is a one-line edit.
const DEFAULT_BACKEND_PORT = 8321;
let PORT = DEFAULT_BACKEND_PORT;
let BASE_URL = `http://${HOST}:${PORT}`;
const LAST_TRANSCRIPT_FILE = "last_transcript.json";
const LOCAL_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const OVERLAY_TOKENS = Object.freeze({
  window: Object.freeze({
    collapsedWidth: 320,
    expandedWidth: 320,
    height: 47,
    bottomOffset: 10,
  }),
  pill: Object.freeze({
    marginTop: 6,
    gap: 9,
    padY: 7,
    padX: 10,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.18)",
    background: "linear-gradient(180deg,rgba(40,40,40,.97),rgba(24,24,24,.97))",
    backdrop: "blur(8px) saturate(100%)",
  }),
  wave: Object.freeze({
    width: 54,
    height: 16,
    barWidth: 1.4,
    barGap: 1.0,
    idleTickMs: 120,
    activeStaleMs: 220,
  }),
  timer: Object.freeze({
    tickMs: 200,
  }),
  sounds: Object.freeze({
    start: Object.freeze({ durationSec: 0.075, baseHz: 760, endHz: 980, gainPeak: 0.04 }),
    stop: Object.freeze({ durationSec: 0.09, baseHz: 560, endHz: 420, gainPeak: 0.055 }),
  }),
  stateIcon: Object.freeze({
    size: 14,
    dotSize: 8,
  }),
});

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  ensureWindowVisible({ manual: true });
});

function appendMainLog(message) {
  try {
    if (!mainLogFilePath) {
      mainLogFilePath = path.join(app.getPath("userData"), "main.log");
    }
    fs.appendFile(mainLogFilePath, `[${new Date().toISOString()}] ${message}\n`, "utf8", () => { });
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
  if (!force && overlayStopInFlight) return;
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
  const allowed = new Set(LOCAL_MODELS);
  return allowed.has(v) ? v : "small";
}

async function getRendererProviderChoice() {
  if (!win || win.isDestroyed() || !win.webContents) return "local";
  try {
    const v = await win.webContents.executeJavaScript(
      `(() => String((document.getElementById('providerSelect')?.value || 'local')).trim())();`,
      true
    );
    return normalizeProviderChoice(v);
  } catch {
    return "local";
  }
}

async function getRendererLocalModelChoice() {
  if (!win || win.isDestroyed() || !win.webContents) return "small";
  try {
    const v = await win.webContents.executeJavaScript(
      `(() => String((document.getElementById('model')?.value || 'small')).trim())();`,
      true
    );
    return normalizeLocalModelChoice(v);
  } catch {
    return "small";
  }
}

async function getRendererModelContext() {
  if (!win || win.isDestroyed() || !win.webContents) {
    return { provider: "local", model: "small", models: [...LOCAL_MODELS] };
  }
  try {
    const state = await win.webContents.executeJavaScript(
      `
      (() => {
        const provider = String((document.getElementById('providerSelect')?.value || 'local')).trim();
        const modelSel = document.getElementById('model');
        const remoteSel = document.getElementById('remoteModelSelect');
        const orModel = document.getElementById('orModel');
        const localModel = String(modelSel?.value || 'small').trim();
        const remoteModel = String(remoteSel?.value || orModel?.value || '').trim();
        const localOptions = Array.from(modelSel?.options || []).map((o) => String(o.value || '').trim()).filter(Boolean);
        const remoteOptions = Array.from(remoteSel?.options || []).map((o) => String(o.value || '').trim()).filter(Boolean);
        const models = provider === 'local'
          ? (localOptions.length ? localOptions : ${JSON.stringify(LOCAL_MODELS)})
          : (remoteOptions.length ? remoteOptions : (remoteModel ? [remoteModel] : []));
        const model = provider === 'local' ? localModel : remoteModel;
        return { provider, model, models };
      })();
      `,
      true
    );
    return {
      provider: normalizeProviderChoice(state?.provider),
      model: String(state?.model || "").trim() || "small",
      models: Array.isArray(state?.models) ? state.models.map((x) => String(x || "").trim()).filter(Boolean) : [...LOCAL_MODELS],
    };
  } catch {
    return { provider: "local", model: "small", models: [...LOCAL_MODELS] };
  }
}

async function getRendererQuickSettingsOpen() {
  if (!win || win.isDestroyed() || !win.webContents) return null;
  try {
    const open = await win.webContents.executeJavaScript(
      // Use getComputedStyle instead of .hidden: the panel is hidden via
      // CSS display:none (not via the HTML hidden attribute), so p.hidden
      // is always false even when the element is invisible, causing the
      // overlay to always think quick-settings is open.
      `(() => { const p = document.getElementById('quickSettingsPanel'); if (!p) return false; return getComputedStyle(p).display !== 'none'; })();`,
      true
    );
    return !!open;
  } catch {
    return null;
  }
}

async function getRendererUpscalePresetContext() {
  if (!win || win.isDestroyed() || !win.webContents) {
    return { selected: "builtin_clean", enabled: false, presets: [{ id: "builtin_clean", name: "Clean" }] };
  }
  try {
    const out = await win.webContents.executeJavaScript(
      `
      (() => {
        const sel = document.getElementById('upscalePresetSelect');
        const en = document.getElementById('upscaleToggle');
        const selected = String(sel?.value || 'builtin_clean').trim();
        const enabled = !!(en && en.checked);
        const presets = Array.from(sel?.options || []).map((o) => ({
          id: String(o.value || '').trim(),
          name: String(o.textContent || o.value || '').trim(),
        })).filter((x) => x.id);
        return { selected, enabled, presets };
      })();
      `,
      true
    );
    const presets = Array.isArray(out?.presets) ? out.presets : [];
    const selected = String(out?.selected || "builtin_clean").trim() || "builtin_clean";
    const enabled = !!out?.enabled;
    return { selected, enabled, presets: presets.length ? presets : [{ id: "builtin_clean", name: "Clean" }] };
  } catch {
    return { selected: "builtin_clean", enabled: false, presets: [{ id: "builtin_clean", name: "Clean" }] };
  }
}

async function getRendererAutoSendEnterEnabled() {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  try {
    const out = await win.webContents.executeJavaScript(
      `
      (() => {
        const btn = document.getElementById('autoSendEnterToggle');
        return !!(btn && btn.classList.contains('active'));
      })();
      `,
      true
    );
    return !!out;
  } catch {
    return false;
  }
}

async function getRendererAutoStopSilenceConfig() {
  if (!win || win.isDestroyed() || !win.webContents) {
    return { enabled: false, seconds: 2, thresholdDb: -42 };
  }
  try {
    const out = await win.webContents.executeJavaScript(
      `
      (() => {
        const enabledEl = document.getElementById('autoStopSilenceEnabled');
        const secEl = document.getElementById('autoStopSilenceSeconds');
        const dbEl = document.getElementById('autoStopSilenceDb');
        const enabled = !!(enabledEl && enabledEl.checked);
        const secRaw = Number(secEl ? secEl.value : 2);
        const dbRaw = Number(dbEl ? dbEl.value : -42);
        const seconds = Math.min(120, Math.max(1, Number.isFinite(secRaw) ? Math.round(secRaw) : 2));
        const thresholdDb = Math.min(-10, Math.max(-80, Number.isFinite(dbRaw) ? Math.round(dbRaw) : -42));
        return { enabled, seconds, thresholdDb };
      })();
      `,
      true
    );
    return {
      enabled: !!out?.enabled,
      seconds: Number.isFinite(Number(out?.seconds)) ? Number(out.seconds) : 2,
      thresholdDb: Number.isFinite(Number(out?.thresholdDb)) ? Number(out.thresholdDb) : -42,
    };
  } catch {
    return { enabled: false, seconds: 2, thresholdDb: -42 };
  }
}

async function setRendererUpscalePresetChoice(presetId) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = String(presetId || "").trim();
  if (!target) return;
  await safeExec("setRendererUpscalePresetChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const target = ${JSON.stringify(target)};
        const sel = document.getElementById('upscalePresetSelect');
        if (!sel) return false;
        if (!Array.from(sel.options || []).some((o) => String(o.value || '') === target)) return false;
        if (sel.value !== target) {
          sel.value = target;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })();
      `,
      true
    )
  );
}

async function setRendererUpscaleEnabledChoice(enabled) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = !!enabled;
  await safeExec("setRendererUpscaleEnabledChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const target = ${target ? "true" : "false"};
        const el = document.getElementById('upscaleToggle');
        if (!el) return false;
        if (!!el.checked !== target) {
          el.checked = target;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })();
      `,
      true
    )
  );
}

async function setRendererQuickSettingsOpenChoice(open) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = !!open;
  await safeExec("setRendererQuickSettingsOpenChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const target = ${target ? "true" : "false"};
        if (typeof window.__transcriptorSetQuickSettingsOpen === 'function') {
          return !!window.__transcriptorSetQuickSettingsOpen(target);
        }
        const panel = document.getElementById('quickSettingsPanel');
        const btn = document.getElementById('quickSettingsToggle');
        if (!panel || !btn) return false;
        const isOpen = !panel.hidden;
        if (isOpen !== target) btn.click();
        return true;
      })();
      `,
      true
    )
  );
}

async function setRendererAutoSendEnterChoice(enabled) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = !!enabled;
  await safeExec("setRendererAutoSendEnterChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const btn = document.getElementById('autoSendEnterToggle');
        if (!btn) return false;
        const isOn = btn.classList.contains('active');
        if (isOn !== ${target ? "true" : "false"}) btn.click();
        return true;
      })();
      `,
      true
    )
  );
}

async function setRendererProviderChoice(provider) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const normalized = normalizeProviderChoice(provider);
  await safeExec("setRendererProviderChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const target = ${JSON.stringify(normalized)};
        const main = document.getElementById('providerSelect');
        const quick = document.getElementById('quickProviderSelect');
        if (main && main.value !== target) {
          main.value = target;
          main.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (quick && quick.value !== target) {
          quick.value = target;
          quick.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })();
      `,
      true
    )
  );
}

async function setRendererLocalModelChoice(model) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const normalized = normalizeLocalModelChoice(model);
  await safeExec("setRendererLocalModelChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const target = ${JSON.stringify(normalized)};
        const sel = document.getElementById('model');
        if (sel && sel.value !== target) {
          sel.value = target;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })();
      `,
      true
    )
  );
}

async function setRendererModelChoice(provider, model) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const p = normalizeProviderChoice(provider);
  const target = String(model || "").trim();
  await safeExec("setRendererModelChoice", () =>
    win.webContents.executeJavaScript(
      `
      (() => {
        const provider = ${JSON.stringify(p)};
        const model = ${JSON.stringify(target)};
        const localSel = document.getElementById('model');
        const remoteSel = document.getElementById('remoteModelSelect');
        const orModel = document.getElementById('orModel');
        const hasOpt = (sel, val) => Array.from(sel?.options || []).some((o) => String(o.value || '') === val);
        if (provider === 'local') {
          if (localSel && model && hasOpt(localSel, model) && localSel.value !== model) {
            localSel.value = model;
            localSel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        }
        if (remoteSel && model) {
          if (!hasOpt(remoteSel, model)) {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            remoteSel.appendChild(opt);
          }
          if (remoteSel.value !== model) {
            remoteSel.value = model;
            remoteSel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        if (orModel && model && orModel.value !== model) {
          orModel.value = model;
          orModel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })();
      `,
      true
    )
  );
}

function createOverlayHtml() {
  const t = OVERLAY_TOKENS;
  return `
  <html>
    <body style="margin:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;display:flex;justify-content:center;">
      <div id="stack">
      <div id="queuePill">
        <canvas id="queueWave" width="${t.wave.width}" height="12"></canvas>
        <span id="queueTimer">00:00</span>
      </div>
      <div id="settingsSlot">
        <div id="settingsPill">
          <div id="quickPanel">
            <div id="quickAutoStopCapsule" title="Auto stop on silence">
              <input id="quickAutoStopToggle" type="checkbox" />
              <span class="capsuleLabel">Stop</span>
              <label id="quickAutoStopSecsLabel">
                <input id="quickAutoStopSecs" type="text" inputmode="numeric" pattern="[0-9]*" value="2" style="ime-mode:disabled" />
              </label>
            </div>
            <div id="quickUpscaleCapsule" title="Upscale settings">
              <input id="quickUpscaleToggle" type="checkbox" />
              <span id="quickUpscaleOffLabel">Upscale</span>
              <div id="quickUpscaleDrop">
                <button id="quickUpscaleBtn" type="button" aria-label="Upscale preset">
                  <span id="quickUpscaleBtnText">Clean</span>
                </button>
                <div id="quickUpscaleMenu"></div>
              </div>
            </div>
            <div id="quickAutoSendCapsule" title="Auto send after paste">
              <input id="quickAutoSendToggle" type="checkbox" />
              <span class="capsuleLabel">Send</span>
            </div>
          </div>
        </div>
      </div>
      <div id="pill">
        <div id="core">
          <button id="gearBtn" aria-label="Quick settings" title="Quick settings"></button>
          <canvas id="wave" width="${t.wave.width}" height="${t.wave.height}"></canvas>
          <span id="timer">00:00</span>
          <span id="stateIcon" aria-hidden="true"></span>
        </div>
      </div>
      </div>
      <style>
        #stack{
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:4px;
          margin:2px auto 0;
        }
        #pill{
          width: fit-content;
          margin: 0;
          display:flex;
          align-items:center;
          justify-content:flex-start;
          gap:6px;
          padding:${t.pill.padY}px 7px ${t.pill.padY}px 5px;
          border-radius:${t.pill.borderRadius}px;
          border:1px solid #333;
          background:#161616;
          box-shadow:none;
          overflow:hidden;
          isolation:isolate;
        }
        #core{
          display:flex;
          align-items:center;
          justify-content:center;
          gap:9px;
        }
        #queuePill{
          width:132px;
          height:18px;
          padding:2px 8px;
          border-radius:999px;
          border:1px solid #2e2e2e;
          background:#141414;
          display:flex;
          align-items:center;
          justify-content:space-between;
          opacity:0;
          pointer-events:none;
        }
        #queuePill.on{
          opacity:1;
        }
        #settingsSlot{
          width:100%;
          height:auto;
          min-height:34px;
          display:flex;
          align-items:center;
          justify-content:center;
          margin-bottom:16px;
        }
        #settingsPill{
          width:fit-content;
          min-height:22px;
          padding:8px;
          border-radius:14px;
          border:1px solid #333;
          background:#161616;
          opacity:0;
          pointer-events:none;
          transform:translateY(-5px) scale(.985);
          transition:opacity .12s ease, transform .12s ease;
        }
        #settingsSlot.on #settingsPill{
          opacity:1;
          pointer-events:auto;
          transform:translateY(-2px) scale(1);
        }
        #queueWave{
          width:${t.wave.width}px;
          height:12px;
          display:block;
          opacity:.95;
          flex:0 0 ${t.wave.width}px;
        }
        #queueTimer{
          font-size:9px;
          font-weight:700;
          color:#d0d0d0;
          font-family:Menlo,ui-monospace,monospace;
          min-width:30px;
          text-align:right;
          line-height:1;
          flex:0 0 30px;
        }
        #wave{
          display:block;
          opacity:.95;
          width:${t.wave.width}px;
          height:${t.wave.height}px;
          flex:0 0 ${t.wave.width}px;
        }
        #quickPanel{
          display:flex;
          flex-direction:column;
          align-items:stretch;
          gap:4px;
          min-width:0;
          overflow:visible;
          flex:0 0 auto;
        }
        /* ── Shared capsule base ── */
        #quickUpscaleCapsule, #quickAutoSendCapsule, #quickAutoStopCapsule{
          display:flex;
          align-items:center;
          gap:5px;
          padding:0 6px 0 2px;
          height:22px;
          border-radius:999px;
          white-space:nowrap;
          min-width:0;
        }
        .capsuleLabel{
          font-size:10px;
          font-weight:650;
          letter-spacing:.01em;
          opacity:.92;
        }
        /* ── Shared toggle base ── */
        #quickUpscaleToggle, #quickAutoSendToggle, #quickAutoStopToggle{
          appearance:none;
          width:28px;
          height:16px;
          border-radius:999px;
          border:1px solid #444;
          background:#2a2a2a;
          position:relative;
          outline:none;
          cursor:pointer;
          flex:0 0 28px;
          transition:background .14s ease, border-color .14s ease;
        }
        #quickUpscaleToggle::before, #quickAutoSendToggle::before, #quickAutoStopToggle::before{
          content:"";
          position:absolute;
          left:2px;
          top:2px;
          width:10px;
          height:10px;
          border-radius:999px;
          background:#d2d2d2;
          transition:transform .14s ease, background .14s ease;
        }
        /* ── Upscale: PURPLE accent ── */
        #quickUpscaleCapsule{
          border:1px solid #3d2e52;
          background:#2a2234;
          color:#e0e0e0;
        }
        #quickUpscaleToggle:checked{
          background:#5a36a0;
          border-color:#7a50c8;
        }
        #quickUpscaleToggle:checked::before{
          transform:translateX(12px);
          background:#fff;
        }
        #quickUpscaleOffLabel{
          font-size:10px;
          font-weight:650;
          letter-spacing:.01em;
          opacity:.92;
        }
        /* ── AutoSend: GREEN accent ── */
        #quickAutoSendCapsule{
          border:1px solid #2e4a35;
          background:#1e2e22;
          color:#d0e8d4;
        }
        #quickAutoSendToggle:checked{
          background:#2e5c3a;
          border-color:#4a8a5a;
        }
        #quickAutoSendToggle:checked::before{
          transform:translateX(12px);
          background:#90e0a0;
        }
        /* ── AutoStop: YELLOW/AMBER accent ── */
        #quickAutoStopCapsule{
          border:1px solid #4a4428;
          background:#2a2818;
          color:#e0dcc0;
        }
        #quickAutoStopToggle:checked{
          background:#5c5020;
          border-color:#8a7a3a;
        }
        #quickAutoStopToggle:checked::before{
          transform:translateX(12px);
          background:#e8d860;
        }
        #quickAutoStopSecsLabel{
          display:inline-flex;
          align-items:center;
          gap:1px;
          margin-left:0;
        }
        #quickAutoStopSecs{
          appearance:none;
          -moz-appearance:textfield;
          width:24px;
          height:18px;
          border:1px solid #4a4428;
          border-radius:6px;
          background:#2a2818;
          color:#e0dcc0;
          font-size:10px;
          font-weight:700;
          text-align:center;
          padding:0 1px;
          outline:none;
          font-family:Menlo,ui-monospace,monospace;
        }
        #quickAutoStopSecs::-webkit-inner-spin-button,
        #quickAutoStopSecs::-webkit-outer-spin-button{
          appearance:none;
          margin:0;
        }
        #quickAutoStopSecs:focus{
          border-color:#8a7a3a;
        }
        .secsUnit{
          font-size:9px;
          font-weight:600;
          color:#8a8a60;
        }
        /* ── Upscale dropdown ── */
        #quickUpscaleDrop{
          position:relative;
        }
        #quickUpscaleBtn{
          appearance:none;
          border:1px solid #3d2e52;
          border-radius:999px;
          background:#2a2234;
          color:#eaeaea;
          height:18px;
          padding:0 18px 0 8px;
          font-size:10px;
          font-weight:600;
          max-width:96px;
          min-width:96px;
          text-align:left;
          cursor:pointer;
          position:relative;
        }
        #quickUpscaleBtn::after{
          content:"";
          position:absolute;
          right:6px;
          top:50%;
          width:8px;
          height:5px;
          transform:translateY(-50%);
          background-repeat:no-repeat;
          background-position:center;
          background-size:8px 5px;
          background-image:url("data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L4 4L7 1' stroke='rgba(220,220,220,0.7)' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E");
        }
        #quickUpscaleBtnText{
          display:block;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        #quickUpscaleMenu{
          position:absolute;
          left:0;
          top:22px;
          min-width:100%;
          border:1px solid #3d2e52;
          border-radius:10px;
          background:#1e1a24;
          display:none;
          z-index:5;
          max-height:160px;
          overflow:auto;
          padding:4px;
        }
        #quickUpscaleMenu.open{
          display:block;
        }
        .quickUpscaleItem{
          width:100%;
          appearance:none;
          border:0;
          border-radius:8px;
          height:22px;
          padding:0 8px;
          text-align:left;
          color:#eaeaea;
          background:transparent;
          font-size:10px;
          cursor:pointer;
        }
        .quickUpscaleItem:hover{
          background:#2e2e2e;
        }
        .quickUpscaleItem.active{
          background:#3a2a52;
        }
        #quickUpscaleCapsule.up-off #quickUpscaleDrop{
          display:none;
        }
        #quickUpscaleCapsule.up-on #quickUpscaleOffLabel{
          display:none;
        }
        /* quickSendEnterBtn removed — replaced by #quickAutoSendCapsule */
        #gearBtn{
          appearance:none;
          border:1px solid #333;
          border-radius:999px;
          background:#2a2a2a;
          width:22px;
          height:22px;
          padding:0;
          position:relative;
          flex:0 0 22px;
          cursor:pointer;
        }
        #gearBtn::before{
          content:"";
          position:absolute;
          left:50%;
          top:50%;
          width:11px;
          height:11px;
          transform:translate(-50%,-50%);
          background-repeat:no-repeat;
          background-position:center;
          background-size:11px 11px;
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M10.9 3.2a1 1 0 0 1 2.2 0l.4 1.2c.4.1.8.2 1.2.4l1.1-.6a1 1 0 0 1 1.2.2l1.6 1.6a1 1 0 0 1 .2 1.2l-.6 1.1c.2.4.3.8.4 1.2l1.2.4a1 1 0 0 1 0 2.2l-1.2.4a5.9 5.9 0 0 1-.4 1.2l.6 1.1a1 1 0 0 1-.2 1.2l-1.6 1.6a1 1 0 0 1-1.2.2l-1.1-.6c-.4.2-.8.3-1.2.4l-.4 1.2a1 1 0 0 1-2.2 0l-.4-1.2c-.4-.1-.8-.2-1.2-.4l-1.1.6a1 1 0 0 1-1.2-.2l-1.6-1.6a1 1 0 0 1-.2-1.2l.6-1.1a5.9 5.9 0 0 1-.4-1.2l-1.2-.4a1 1 0 0 1 0-2.2l1.2-.4c.1-.4.2-.8.4-1.2l-.6-1.1a1 1 0 0 1 .2-1.2l1.6-1.6a1 1 0 0 1 1.2-.2l1.1.6c.4-.2.8-.3 1.2-.4l.4-1.2Z' stroke='rgba(165,165,165,0.9)' stroke-width='1.4'/%3E%3Ccircle cx='12' cy='12' r='3' stroke='rgba(165,165,165,0.9)' stroke-width='1.4'/%3E%3C/svg%3E");
        }
        #gearBtn.on{
          border-color:#444;
          background:#3a3a3a;
        }
        #gearBtn.on::before{
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M10.9 3.2a1 1 0 0 1 2.2 0l.4 1.2c.4.1.8.2 1.2.4l1.1-.6a1 1 0 0 1 1.2.2l1.6 1.6a1 1 0 0 1 .2 1.2l-.6 1.1c.2.4.3.8.4 1.2l1.2.4a1 1 0 0 1 0 2.2l-1.2.4a5.9 5.9 0 0 1-.4 1.2l.6 1.1a1 1 0 0 1-.2 1.2l-1.6 1.6a1 1 0 0 1-1.2.2l-1.1-.6c-.4.2-.8.3-1.2.4l-.4 1.2a1 1 0 0 1-2.2 0l-.4-1.2c-.4-.1-.8-.2-1.2-.4l-1.1.6a1 1 0 0 1-1.2-.2l-1.6-1.6a1 1 0 0 1-.2-1.2l.6-1.1a5.9 5.9 0 0 1-.4-1.2l-1.2-.4a1 1 0 0 1 0-2.2l1.2-.4c.1-.4.2-.8.4-1.2l-.6-1.1a1 1 0 0 1 .2-1.2l1.6-1.6a1 1 0 0 1 1.2-.2l1.1.6c.4-.2.8-.3 1.2-.4l.4-1.2Z' stroke='rgba(236,236,236,0.95)' stroke-width='1.4'/%3E%3Ccircle cx='12' cy='12' r='3' stroke='rgba(236,236,236,0.95)' stroke-width='1.4'/%3E%3C/svg%3E");
        }
        #stateIcon{
          width:14px;
          height:14px;
          border-radius:50%;
          position:relative;
          display:inline-block;
          flex:0 0 14px;
          background:transparent;
          animation:none;
        }
        #stateIcon::before{
          content:"";
          position:absolute;
          left:50%;
          top:50%;
          width:8px;
          height:8px;
          transform:translate(-50%,-50%);
          border-radius:50%;
          background:rgba(180,180,180,.92);
          box-shadow:0 0 0 0 rgba(180,180,180,0);
        }
        #stateIcon::after{
          content:"";
          position:absolute;
          left:50%;
          top:50%;
          width:14px;
          height:14px;
          transform:translate(-50%,-50%);
          border-radius:50%;
          border:1px solid rgba(180,180,180,.2);
          opacity:0;
        }
        #stateIcon.rec{
          animation:none;
        }
        #stateIcon.rec::before{
          background:rgba(255,92,92,.94);
          border-radius:2px;
          animation:coreBreathe 1.35s ease-in-out infinite;
        }
        #stateIcon.rec::after{
          opacity:1;
          border:1px solid rgba(255,92,92,.44);
          animation:recHalo 1.35s ease-out infinite;
        }
        #stateIcon.transcribing::before{
          background:rgba(114,174,255,.98);
          box-shadow:0 0 8px rgba(114,174,255,.55);
        }
        #stateIcon.transcribing::after{
          opacity:1;
          border:1px solid rgba(114,174,255,.75);
          border-radius:38% 62% 44% 56% / 54% 42% 58% 46%;
          box-shadow:0 0 10px rgba(114,174,255,.36), inset 0 0 6px rgba(114,174,255,.28);
          animation:transBlob 1.05s ease-in-out infinite;
        }
        #stateIcon.ok{
          animation:none;
        }
        #stateIcon.upscaling::before{
          background:rgba(173,112,255,.98);
          box-shadow:0 0 8px rgba(173,112,255,.5);
        }
        #stateIcon.upscaling::after{
          opacity:1;
          border:1px solid rgba(173,112,255,.72);
          border-radius:38% 62% 44% 56% / 54% 42% 58% 46%;
          box-shadow:0 0 10px rgba(173,112,255,.34), inset 0 0 6px rgba(173,112,255,.26);
          animation:transBlob 1.05s ease-in-out infinite;
        }
        #stateIcon.autostop::before{
          background:rgba(255,196,74,.98);
          box-shadow:0 0 8px rgba(255,196,74,.46);
        }
        #stateIcon.autostop::after{
          opacity:1;
          border:1px solid rgba(255,196,74,.66);
          animation:okHalo .8s ease-out infinite;
        }
        #stateIcon.ok::before{
          background:rgba(112,210,136,.96);
          box-shadow:0 0 8px rgba(112,210,136,.4);
          animation:okBreathe .65s ease-out 1;
        }
        #stateIcon.ok::after{
          opacity:1;
          border:1px solid rgba(112,210,136,.35);
          animation:okHalo .7s ease-out 1;
        }
        #stateIcon.fail{
          animation:none;
        }
        #stateIcon.fail::before{
          background:rgba(184,184,184,.95);
        }
        #stateIcon.fail::after{
          opacity:0;
        }
        #timer{
          font-size:10px;
          font-weight:800;
          color:rgba(255,255,255,.96);
          font-family:Menlo,ui-monospace,monospace;
          min-width:36px;
          text-align:center;
          line-height:1;
          flex:0 0 36px;
        }
        @keyframes coreBreathe{
          0%,100%{transform:translate(-50%,-50%) scale(1)}
          50%{transform:translate(-50%,-50%) scale(1.1)}
        }
        @keyframes recHalo{
          0%{transform:translate(-50%,-50%) scale(1); opacity:.9}
          70%{transform:translate(-50%,-50%) scale(1.28); opacity:.16}
          100%{transform:translate(-50%,-50%) scale(1.36); opacity:0}
        }
        @keyframes transBlob{
          0%{
            transform:translate(-50%,-50%) rotate(0deg) scale(1);
            border-radius:38% 62% 44% 56% / 54% 42% 58% 46%;
          }
          33%{
            transform:translate(-50%,-50%) rotate(40deg) scale(1.07);
            border-radius:62% 38% 58% 42% / 40% 62% 38% 60%;
          }
          66%{
            transform:translate(-50%,-50%) rotate(84deg) scale(1.02);
            border-radius:46% 54% 40% 60% / 62% 36% 64% 38%;
          }
          100%{
            transform:translate(-50%,-50%) rotate(125deg) scale(1);
            border-radius:38% 62% 44% 56% / 54% 42% 58% 46%;
          }
        }
        @keyframes okBreathe{
          0%{transform:translate(-50%,-50%) scale(.86)}
          100%{transform:translate(-50%,-50%) scale(1)}
        }
        @keyframes okHalo{
          0%{transform:translate(-50%,-50%) scale(.92); opacity:.7}
          100%{transform:translate(-50%,-50%) scale(1.2); opacity:0}
        }
      </style>
      <script>
        let start = Date.now();
        const el = document.getElementById('timer');
        const cv = document.getElementById('wave');
        const ctx = cv.getContext('2d');
        const qPill = document.getElementById('queuePill');
        const qCv = document.getElementById('queueWave');
        const qCtx = qCv.getContext('2d');
        const qTimer = document.getElementById('queueTimer');
        const settingsSlot = document.getElementById('settingsSlot');
        const pill = document.getElementById('pill');
        const stateIcon = document.getElementById('stateIcon');
        const gearBtn = document.getElementById('gearBtn');
        const quickPanel = document.getElementById('quickPanel');
        const quickUpscaleCapsule = document.getElementById('quickUpscaleCapsule');
        const quickUpscaleToggle = document.getElementById('quickUpscaleToggle');
        const quickUpscaleBtn = document.getElementById('quickUpscaleBtn');
        const quickUpscaleBtnText = document.getElementById('quickUpscaleBtnText');
        const quickUpscaleMenu = document.getElementById('quickUpscaleMenu');
        const quickAutoSendToggle = document.getElementById('quickAutoSendToggle');
        let quickUpscaleOptions = [];
        let quickUpscaleSelected = 'builtin_clean';
        let timerId = null;
        let queueTimerId = null;
        let audioCtx = null;
        const bars = [];
        const queueBars = [];
        let lastLevelAt = 0;
        let lastQueueLevelAt = 0;
        let activeWave = true;
        let queueVisible = false;
        let queueStart = Date.now();
        let waveMode = 'recording';
        const dpr = Math.max(1, Math.min(3, Number(window.devicePixelRatio || 1)));
        const waveW = ${t.wave.width};
        const waveH = ${t.wave.height};
        const queueW = ${t.wave.width};
        const queueH = 12;
        cv.width = Math.round(waveW * dpr);
        cv.height = Math.round(waveH * dpr);
        cv.style.width = waveW + 'px';
        cv.style.height = waveH + 'px';
        qCv.width = Math.round(queueW * dpr);
        qCv.height = Math.round(queueH * dpr);
        qCv.style.width = queueW + 'px';
        qCv.style.height = queueH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        qCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const bw = ${t.wave.barWidth};
        const gap = ${t.wave.barGap};
        const maxBars = Math.floor(waveW / (bw + gap));
        const qBw = 1.2;
        const qGap = 0.8;
        const qMaxBars = Math.floor(queueW / (qBw + qGap));
        window.setLevel = (lv) => {
          if (waveMode !== 'recording') return;
          const raw = Math.max(0, Math.min(1, Number(lv) || 0));
          const level = Math.max(0, Math.min(1, Math.pow(raw, 0.72) * 1.45));
          lastLevelAt = Date.now();
          bars.push(level);
          while (bars.length > maxBars) bars.shift();
          render();
        };
        window.setQueueLevel = (lv) => {
          const raw = Math.max(0, Math.min(1, Number(lv) || 0));
          const level = Math.max(0, Math.min(1, Math.pow(raw, 0.7) * 1.55));
          lastQueueLevelAt = Date.now();
          queueBars.push(level);
          while (queueBars.length > qMaxBars) queueBars.shift();
          renderQueue();
        };
        window.setQueueVisible = (show) => {
          const prev = queueVisible;
          queueVisible = !!show;
          qPill.classList.toggle('on', queueVisible);
          if (queueVisible && !prev) {
            queueStart = Date.now();
            qTimer.textContent = '00:00';
            if (queueTimerId) clearInterval(queueTimerId);
            queueTimerId = setInterval(() => {
              const s = Math.max(0, Math.floor((Date.now() - queueStart) / 1000));
              const mm = String(Math.floor(s / 60)).padStart(2, '0');
              const ss = String(s % 60).padStart(2, '0');
              qTimer.textContent = mm + ':' + ss;
            }, ${t.timer.tickMs});
          }
          if (!queueVisible) {
            queueBars.length = 0;
            renderQueue();
            qTimer.textContent = '00:00';
            if (queueTimerId) {
              clearInterval(queueTimerId);
              queueTimerId = null;
            }
          }
        };
        window.resetQueueWave = () => {
          queueBars.length = 0;
          lastQueueLevelAt = 0;
          renderQueue();
        };
        window.resetWave = () => {
          bars.length = 0;
          lastLevelAt = 0;
          render();
        };
        window.setStatus = (s) => {
          const raw = String(s || '').trim().toLowerCase();
          activeWave = raw === 'starting' || raw === 'recording' || raw === 'auto stop';
          waveMode = raw === 'transcribing'
            ? 'transcribing'
            : (raw === 'upscaling'
              ? 'upscaling'
              : (raw === 'auto stop'
                ? 'autostop'
                : (activeWave ? 'recording' : 'idle')));
          stateIcon.className = '';
          if (raw === 'starting' || raw === 'recording') {
            stateIcon.classList.add('rec');
          } else if (raw === 'transcribing') {
            stateIcon.classList.add('transcribing');
          } else if (raw === 'upscaling') {
            stateIcon.classList.add('upscaling');
          } else if (raw === 'auto stop') {
            stateIcon.classList.add('autostop');
          } else if (raw === 'paste sent' || raw === 'pasted' || raw === 'sent' || raw === 'done' || raw === 'saved to app') {
            stateIcon.classList.add('ok');
          } else if (raw === 'paste failed' || raw === 'grant access' || raw === 'secure field' || raw === 'no text focus' || raw === 'clipboard error') {
            stateIcon.classList.add('fail');
          } else {
            stateIcon.classList.add('fail');
          }
        };
        window.setQuickOpen = (open) => {
          const on = !!open;
          settingsSlot.classList.toggle('on', on);
          gearBtn.classList.toggle('on', on);
        };
        window.setUpscaleEnabled = (enabled) => {
          const on = !!enabled;
          if (quickUpscaleToggle.checked !== on) quickUpscaleToggle.checked = on;
          quickUpscaleCapsule.classList.toggle('up-on', on);
          quickUpscaleCapsule.classList.toggle('up-off', !on);
        };
        window.setUpscaleOptions = (items, selected) => {
          const list = Array.isArray(items) ? items : [];
          quickUpscaleOptions = [];
          list.forEach((it) => {
            const id = String((it && it.id) || '').trim();
            if (!id) return;
            const name = String((it && it.name) || id).trim();
            quickUpscaleOptions.push({ id, name });
          });
          if (!quickUpscaleOptions.length) {
            quickUpscaleOptions.push({ id: 'builtin_clean', name: 'Clean' });
          }
          const next = String(selected || '').trim();
          quickUpscaleSelected = next && quickUpscaleOptions.some((o) => o.id === next) ? next : quickUpscaleOptions[0].id;
          renderUpscaleMenu();
        };
        window.setUpscale = (presetId) => {
          const v = String(presetId || '').trim();
          if (!v) return;
          if (!quickUpscaleOptions.some((o) => o.id === v)) return;
          quickUpscaleSelected = v;
          renderUpscaleMenu();
        };
        window.setAutoSendEnabled = (enabled) => {
          const on = !!enabled;
          if (quickAutoSendToggle.checked !== on) quickAutoSendToggle.checked = on;
        };

        // Make the entire core of the capsule clickable to stop recording
        document.getElementById('core').addEventListener('click', (e) => {
          if (waveMode === 'recording') {
            e.stopPropagation();
            document.title = '__overlay_stop__';
          }
        });

        gearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = !settingsSlot.classList.contains('on');
          window.setQuickOpen(next);
          document.title = '__overlay_settings__' + (next ? '1' : '0');
        });
        quickUpscaleToggle.addEventListener('change', () => {
          window.setUpscaleEnabled(quickUpscaleToggle.checked);
          document.title = '__overlay_upscale_enabled__' + (quickUpscaleToggle.checked ? '1' : '0');
        });
        quickUpscaleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          quickUpscaleMenu.classList.toggle('open');
        });
        document.addEventListener('click', () => quickUpscaleMenu.classList.remove('open'));
        quickAutoSendToggle.addEventListener('change', () => {
          const next = quickAutoSendToggle.checked;
          document.title = '__overlay_autosend__' + (next ? '1' : '0');
        });
        const quickAutoStopToggle = document.getElementById('quickAutoStopToggle');
        const quickAutoStopSecs = document.getElementById('quickAutoStopSecs');
        window.setAutoStopConfig = (enabled, seconds) => {
          const on = !!enabled;
          if (quickAutoStopToggle.checked !== on) quickAutoStopToggle.checked = on;
          const sec = Math.min(120, Math.max(1, Math.round(Number(seconds) || 2)));
          if (Number(quickAutoStopSecs.value) !== sec) quickAutoStopSecs.value = sec;
        };
        quickAutoStopToggle.addEventListener('change', () => {
          document.title = '__overlay_autostop_enabled__' + (quickAutoStopToggle.checked ? '1' : '0');
        });
        quickAutoStopSecs.addEventListener('focus', () => {
          document.title = '__overlay_input_focus__';
        });
        quickAutoStopSecs.addEventListener('blur', () => {
          const v = Math.min(120, Math.max(1, Math.round(Number(quickAutoStopSecs.value) || 2)));
          quickAutoStopSecs.value = v;
          document.title = '__overlay_autostop_secs__' + v;
          setTimeout(() => { document.title = '__overlay_input_blur__'; }, 50);
        });
        quickAutoStopSecs.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            quickAutoStopSecs.blur();
          }
        });
        window.setTimer = (t) => {
          const str = String(t || '').trim();
          if (/^\\d{2}:\\d{2}$/.test(str)) {
            el.textContent = str;
          }
        };
        window.resetTimer = () => {
          start = Date.now();
          tick();
        };
        window.startTimer = () => {
          if (timerId) clearInterval(timerId);
          timerId = setInterval(tick, ${t.timer.tickMs});
        };
        window.playCue = (kind) => {
          try {
            if (!audioCtx) {
              const AC = window.AudioContext || window.webkitAudioContext;
              if (!AC) return;
              audioCtx = new AC();
            }
            if (audioCtx.state === 'suspended') {
              audioCtx.resume().catch(() => {});
            }
            const now = audioCtx.currentTime;
            const cue = kind === 'stop' ? ${JSON.stringify(t.sounds.stop)} : ${JSON.stringify(t.sounds.start)};
            const dur = cue.durationSec;
            const base = cue.baseHz;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(base, now);
            osc.frequency.exponentialRampToValueAtTime(cue.endHz, now + dur);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(cue.gainPeak, now + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + dur + 0.01);
          } catch {}
        };
        window.stopTimer = () => {
          if (timerId) {
            clearInterval(timerId);
            timerId = null;
          }
        };
        const render = () => {
          ctx.clearRect(0, 0, waveW, waveH);
          for (let i = 0; i < bars.length; i++) {
            const v = bars[bars.length - 1 - i];
            const x = waveW - (i + 1) * (bw + gap);
            if (x < 0) break;
            const h = Math.max(2, Math.min(waveH - 2, v * (waveH - 2)));
            const y = (waveH - h) / 2;
            if (waveMode === 'recording') {
              ctx.fillStyle = 'rgba(255,77,77,.88)';
            } else if (waveMode === 'autostop') {
              ctx.fillStyle = 'rgba(255,196,74,.92)';
            } else if (waveMode === 'transcribing') {
              ctx.fillStyle = 'rgba(114,174,255,.92)';
            } else if (waveMode === 'upscaling') {
              ctx.fillStyle = 'rgba(173,112,255,.92)';
            } else {
              ctx.fillStyle = 'rgba(170,170,170,.62)';
            }
            ctx.fillRect(x, y, bw, h);
          }
        };
        const renderQueue = () => {
          qCtx.clearRect(0, 0, queueW, queueH);
          for (let i = 0; i < queueBars.length; i++) {
            const v = queueBars[queueBars.length - 1 - i];
            const x = queueW - (i + 1) * (qBw + qGap);
            if (x < 0) break;
            const h = Math.max(2, Math.min(queueH - 1, v * (queueH - 1)));
            const y = (queueH - h) / 2;
            qCtx.fillStyle = 'rgba(98,216,132,.94)';
            qCtx.fillRect(x, y, qBw, h);
          }
        };
        const renderUpscaleMenu = () => {
          const selected = quickUpscaleOptions.find((x) => x.id === quickUpscaleSelected) || quickUpscaleOptions[0] || { id: 'builtin_clean', name: 'Clean' };
          quickUpscaleBtnText.textContent = (selected.name || selected.id || 'Upscale');
          quickUpscaleMenu.innerHTML = '';
          quickUpscaleOptions.forEach((x) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'quickUpscaleItem' + (x.id === quickUpscaleSelected ? ' active' : '');
            b.textContent = x.name.length > 22 ? (x.name.slice(0, 22) + '…') : x.name;
            b.title = x.name;
            b.addEventListener('click', (ev) => {
              ev.stopPropagation();
              quickUpscaleSelected = x.id;
              renderUpscaleMenu();
              quickUpscaleMenu.classList.remove('open');
              document.title = '__overlay_upscale__' + encodeURIComponent(x.id);
            });
            quickUpscaleMenu.appendChild(b);
          });
        };
        const tick = () => {
          const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
          const mm = String(Math.floor(s / 60)).padStart(2, '0');
          const ss = String(s % 60).padStart(2, '0');
          el.textContent = mm + ':' + ss;
        };
        setInterval(() => {
          if (activeWave && Date.now() - lastLevelAt < ${t.wave.activeStaleMs}) return;
          const idle = activeWave
            ? (0.08 + Math.random() * 0.12)
            : ((waveMode === 'transcribing' || waveMode === 'upscaling') ? 0.055 : (0.03 + Math.random() * 0.03));
          bars.push(idle);
          while (bars.length > maxBars) bars.shift();
          render();
        }, ${t.wave.idleTickMs});
        setInterval(() => {
          if (!queueVisible) return;
          if (Date.now() - lastQueueLevelAt < ${t.wave.activeStaleMs}) return;
          queueBars.push(0.05 + Math.random() * 0.06);
          while (queueBars.length > qMaxBars) queueBars.shift();
          renderQueue();
        }, ${t.wave.idleTickMs});
        tick();
        window.startTimer();
        window.setQuickOpen(false);
        window.setUpscaleEnabled(false);
        window.setUpscaleOptions([{ id: 'builtin_clean', name: 'Clean' }], 'builtin_clean');
        window.setUpscale('builtin_clean');
        window.setAutoSendEnabled(false);
        window.setQueueVisible(false);

        // Mouse enter/leave: toggle click interception on the capsule.
        // When mouse is over the pill, we capture events; otherwise pass through.
        const stackEl = document.getElementById('stack');
        stackEl.addEventListener('mouseenter', () => {
          document.title = '__overlay_mouse_enter__';
        });
        stackEl.addEventListener('mouseleave', () => {
          document.title = '__overlay_mouse_leave__';
        });
      </script>
    </body>
  </html>`;
}

function ensureOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  overlayWin = new BrowserWindow({
    width: getOverlayWindowWidth(),
    height: OVERLAY_FIXED_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Allow clicks to pass through transparent regions around the capsule pill.
  // The overlay HTML reports mouse enter/leave on the pill so we toggle this.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.on("page-title-updated", (event, title) => {
    const raw = String(title || "");
    if (!raw.startsWith("__overlay_")) return;
    event.preventDefault();
    if (raw.startsWith("__overlay_stop__")) {
      overlayStopInFlight = true;
      if (win && !win.isDestroyed() && win.isVisible()) {
        safeExecSync("overlay_stop:winHide", () => win.hide());
      }
      stopRecordingFromOverlay().catch((e) => {
        appendMainLog(`[overlay] stop failed: ${e?.message || e}`);
        overlayStopInFlight = false;
        hideRecordingOverlay();
      });
      return;
    }
    if (raw.startsWith("__overlay_settings__")) {
      overlayQuickSettingsOpen = raw.endsWith("1");
      overlayQuickSettingsInitialized = true;
      applyOverlayWindowSize();
      lastOverlayUiInteractionAt = Date.now();
      if (win && !win.isDestroyed() && win.isVisible()) {
        safeExecSync("overlay_settings:winHide", () => win.hide());
      }
      void setRendererQuickSettingsOpenChoice(overlayQuickSettingsOpen);
      return;
    }
    if (raw.startsWith("__overlay_upscale_enabled__")) {
      const v = raw.endsWith("1");
      overlayQuickUpscaleEnabled = !!v;
      lastOverlayUiInteractionAt = Date.now();
      void setRendererUpscaleEnabledChoice(v);
      return;
    }
    if (raw.startsWith("__overlay_upscale__")) {
      const v = String(decodeURIComponent(raw.replace("__overlay_upscale__", "")) || "").trim();
      overlayQuickUpscalePreset = v;
      lastOverlayUiInteractionAt = Date.now();
      void setRendererUpscalePresetChoice(v);
      return;
    }
    if (raw.startsWith("__overlay_autosend__")) {
      const v = raw.endsWith("1");
      overlayQuickAutoSend = !!v;
      overlayQuickAutoSendInitialized = true;
      lastOverlayUiInteractionAt = Date.now();
      void setRendererAutoSendEnterChoice(v);
      return;
    }
    if (raw.startsWith("__overlay_autostop_enabled__")) {
      const v = raw.endsWith("1");
      overlayAutoStopConfig = { ...overlayAutoStopConfig, enabled: !!v };
      lastOverlayUiInteractionAt = Date.now();
      // Sync to renderer
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.executeJavaScript(
          `(() => { const el = document.getElementById('autoStopSilenceEnabled'); if (el) el.checked = ${v}; })();`,
          true
        ).catch(() => { });
      }
      return;
    }
    if (raw.startsWith("__overlay_autostop_secs__")) {
      const secStr = raw.replace("__overlay_autostop_secs__", "");
      const sec = Math.min(120, Math.max(1, Math.round(Number(secStr) || 2)));
      overlayAutoStopConfig = { ...overlayAutoStopConfig, seconds: sec };
      lastOverlayUiInteractionAt = Date.now();
      // Sync to renderer
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.executeJavaScript(
          `(() => { const el = document.getElementById('autoStopSilenceSeconds'); if (el) el.value = ${sec}; })();`,
          true
        ).catch(() => { });
      }
      return;
    }
    if (raw === "__overlay_input_focus__") {
      // User clicked into an input field — make overlay temporarily focusable for keyboard.
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.setFocusable(true);
        overlayWin.focus();
      }
      return;
    }
    if (raw === "__overlay_input_blur__") {
      // User left the input field — restore non-focusable overlay state.
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.setFocusable(false);
      }
      return;
    }
    if (raw === "__overlay_mouse_enter__") {
      // Mouse entered the pill — capture mouse events.
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.setIgnoreMouseEvents(false);
      }
      return;
    }
    if (raw === "__overlay_mouse_leave__") {
      // Mouse left the pill — pass clicks through to desktop.
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.setIgnoreMouseEvents(true, { forward: true });
      }
      return;
    }
  });
  overlayWin.on("closed", () => {
    overlayWin = null;
  });
  return overlayWin;
}

function positionOverlayWindow() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = overlayWin.getSize();
  const x = Math.round(wa.x + (wa.width - w) / 2);
  const y = Math.round(wa.y + wa.height - h - OVERLAY_TOKENS.window.bottomOffset);
  overlayWin.setPosition(x, y, false);
}

function getOverlayWindowWidth() {
  return overlayQuickSettingsOpen
    ? OVERLAY_TOKENS.window.expandedWidth
    : OVERLAY_TOKENS.window.collapsedWidth;
}

function applyOverlayWindowSize() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  safeExecSync("applyOverlayWindowSize", () => {
    overlayWin.setSize(getOverlayWindowWidth(), OVERLAY_FIXED_HEIGHT, false);
    positionOverlayWindow();
  });
}

async function syncOverlayQueueVisual(recordingHint = null) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  const isRec = typeof recordingHint === "boolean" ? recordingHint : await isRendererRecording();
  const showQueue = pendingTranscriptionCount > 0 && !!isRec;
  await safeExec("syncOverlayQueueVisual", () =>
    overlayWin.webContents.executeJavaScript(
      `window.setQueueVisible && window.setQueueVisible(${showQueue ? "true" : "false"});`,
      true
    )
  );
}

async function showRecordingOverlay() {
  // Preserve user's last quick-settings open/closed choice across runs.
  overlaySilenceStartedAt = 0;
  overlayAutoStopConfigRefreshAt = 0;
  overlayRecordingStartedAt = Date.now();
  overlaySeenAudioFrames = false;
  overlaySpeechRecoveryStartedAt = 0;
  if (overlayAutoStopTriggerTimer) {
    clearTimeout(overlayAutoStopTriggerTimer);
    overlayAutoStopTriggerTimer = null;
  }
  if (overlayTranscribingStatusTimer) {
    clearTimeout(overlayTranscribingStatusTimer);
    overlayTranscribingStatusTimer = null;
  }
  pasteTargetAppName = "";
  pasteTargetAppPid = 0;
  const front = await getFrontmostAppInfo();
  if (shouldUsePasteTarget(front)) {
    pasteTargetAppName = front.name || "";
    pasteTargetAppPid = front.pid || 0;
  }
  const ow = ensureOverlayWindow();
  positionOverlayWindow();
  if (!overlayLoaded) {
    await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
    overlayLoaded = true;
  }
  const upscaleCtx = await getRendererUpscalePresetContext();
  overlayQuickUpscaleEnabled = !!upscaleCtx.enabled;
  overlayQuickUpscalePreset = upscaleCtx.selected;
  if (!overlayQuickAutoSendInitialized) {
    overlayQuickAutoSend = await getRendererAutoSendEnterEnabled();
    overlayQuickAutoSendInitialized = true;
  }
  overlayAutoStopConfig = await getRendererAutoStopSilenceConfig();
  overlayAutoStopUiActive = false;
  if (!overlayQuickSettingsInitialized) {
    const rendererQuickOpen = await getRendererQuickSettingsOpen();
    if (rendererQuickOpen !== null) {
      overlayQuickSettingsOpen = rendererQuickOpen;
      overlayQuickSettingsInitialized = true;
    }
  }
  const hasQueuedTranscriptions = pendingTranscriptionCount > 0;
  try {
    const asCfg = overlayAutoStopConfig;
    await ow.webContents.executeJavaScript(
      `window.setUpscaleEnabled && window.setUpscaleEnabled(${overlayQuickUpscaleEnabled ? "true" : "false"}); window.setUpscaleOptions && window.setUpscaleOptions(${JSON.stringify(upscaleCtx.presets)}, ${JSON.stringify(overlayQuickUpscalePreset)}); window.setUpscale && window.setUpscale(${JSON.stringify(overlayQuickUpscalePreset)}); window.setAutoSendEnabled && window.setAutoSendEnabled(${overlayQuickAutoSend ? "true" : "false"}); window.setAutoStopConfig && window.setAutoStopConfig(${!!asCfg.enabled}, ${Number(asCfg.seconds) || 2}); window.setQuickOpen && window.setQuickOpen(${overlayQuickSettingsOpen ? "true" : "false"}); ${hasQueuedTranscriptions ? "" : "window.resetWave && window.resetWave(); window.resetTimer && window.resetTimer(); window.startTimer && window.startTimer(); window.setStatus && window.setStatus('Recording');"}`,
      true
    );
  } catch { }
  try {
    applyOverlayWindowSize();
  } catch { }
  await syncOverlayQueueVisual(true);
  ow.showInactive();
  await playOverlayCue("start");
  if (overlayWaveMonitor) {
    clearInterval(overlayWaveMonitor);
    overlayWaveMonitor = null;
  }
  overlayWaveMonitor = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
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
        if (!overlayWin || overlayWin.isDestroyed()) return;
        const safeLevel = Math.max(0, Math.min(1, Number(state?.vu) || 0));
        const safeRms = Math.max(0, Number(state?.rms) || 0);
        const safeLastFrameAt = Math.max(0, Number(state?.lastFrameAt) || 0);
        const isRec = !!state?.isRec;
        const cfg = overlayAutoStopConfig || { enabled: false, seconds: 2, thresholdDb: -42 };
        const now = Date.now();
        if (safeLastFrameAt > 0) overlaySeenAudioFrames = true;
        if (now - overlayAutoStopConfigRefreshAt > 1200) {
          overlayAutoStopConfigRefreshAt = now;
          getRendererAutoStopSilenceConfig().then((nextCfg) => {
            overlayAutoStopConfig = nextCfg;
          }).catch(() => { });
        }
        if (!isRec || !cfg.enabled || overlayStopInFlight) {
          overlaySilenceStartedAt = 0;
        } else {
          const thresholdRms = Math.pow(10, Number(cfg.thresholdDb) / 20);
          const warmupMs = 1500;
          if (overlayRecordingStartedAt && (now - overlayRecordingStartedAt) < warmupMs) {
            overlaySilenceStartedAt = 0;
            overlayWin.webContents.executeJavaScript(
              `window.setLevel(${safeLevel}); window.setQueueLevel && window.setQueueLevel(${safeLevel});`,
              true
            ).catch(() => { });
            return;
          }
          // Only use dB-based silence detection — no staleAudioFrames shortcut.
          // staleAudioFrames was causing false stops during active speech when
          // the audio pipeline had minor hiccups.
          const consideredSilent = safeRms <= thresholdRms;
          if (consideredSilent) {
            if (!overlaySilenceStartedAt) {
              overlaySilenceStartedAt = now;
            }
            const silentElapsed = now - overlaySilenceStartedAt;
            if (silentElapsed >= Number(cfg.seconds) * 1000) {
              overlaySilenceStartedAt = 0;
              overlayStopInFlight = true;
              // Immediately kill the wave monitor so no more VU levels
              // are pumped into the overlay (prevents yellow/red flicker)
              if (overlayWaveMonitor) {
                clearInterval(overlayWaveMonitor);
                overlayWaveMonitor = null;
              }
              appendMainLog(`[overlay-autostop] trigger level=${safeLevel.toFixed(4)} rms=${safeRms.toFixed(6)} lastFrameAge=${safeLastFrameAt ? (now - safeLastFrameAt) : -1} cfgSec=${Number(cfg.seconds)} cfgDb=${Number(cfg.thresholdDb)}`);
              guardedStopFromOverlay("autostop");
            }
          } else {
            overlaySilenceStartedAt = 0;
          }
          // Separate fail-safe: if audio pipeline is truly dead (no frames for 8 seconds),
          // force stop to avoid infinite hang. This is NOT silence detection.
          const staleAudioFrames = overlaySeenAudioFrames && safeLastFrameAt > 0 && (now - safeLastFrameAt) > 8000;
          if (staleAudioFrames && !overlayStopInFlight) {
            overlayStopInFlight = true;
            if (overlayWaveMonitor) {
              clearInterval(overlayWaveMonitor);
              overlayWaveMonitor = null;
            }
            appendMainLog(`[overlay-autostop-stale] audio pipeline dead for 8s, forcing stop`);
            guardedStopFromOverlay("autostop-stale");
          }
        }
        overlayWin.webContents.executeJavaScript(
          `window.setLevel(${safeLevel}); window.setQueueLevel && window.setQueueLevel(${safeLevel});`,
          true
        ).catch(() => { });
      })
      .catch(() => { });
  }, 120);
}

async function ensureOverlayVisible(options = {}) {
  const { resetTimer = false, startTimer = false, status = null } = options;
  const ow = ensureOverlayWindow();
  positionOverlayWindow();
  if (!overlayLoaded) {
    await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
    overlayLoaded = true;
  }
  await safeExec("ensureOverlayVisible:initializeQuickSettings", async () => {
    const upscaleCtx = await getRendererUpscalePresetContext();
    overlayQuickUpscaleEnabled = !!upscaleCtx.enabled;
    overlayQuickUpscalePreset = upscaleCtx.selected;
    if (!overlayQuickAutoSendInitialized) {
      overlayQuickAutoSend = await getRendererAutoSendEnterEnabled();
      overlayQuickAutoSendInitialized = true;
    }
    if (!overlayQuickSettingsInitialized) {
      const rendererQuickOpen = await getRendererQuickSettingsOpen();
      if (rendererQuickOpen !== null) {
        overlayQuickSettingsOpen = rendererQuickOpen;
        overlayQuickSettingsInitialized = true;
      }
    }
    await ow.webContents.executeJavaScript(
      `window.setUpscaleEnabled && window.setUpscaleEnabled(${overlayQuickUpscaleEnabled ? "true" : "false"}); window.setUpscaleOptions && window.setUpscaleOptions(${JSON.stringify(upscaleCtx.presets)}, ${JSON.stringify(overlayQuickUpscalePreset)}); window.setUpscale && window.setUpscale(${JSON.stringify(overlayQuickUpscalePreset)}); window.setAutoSendEnabled && window.setAutoSendEnabled(${overlayQuickAutoSend ? "true" : "false"}); window.setQuickOpen && window.setQuickOpen(${overlayQuickSettingsOpen ? "true" : "false"});`,
      true
    );
  });
  applyOverlayWindowSize();
  const jsParts = [];
  if (resetTimer) jsParts.push("window.resetTimer && window.resetTimer();");
  if (startTimer) jsParts.push("window.startTimer && window.startTimer();");
  if (typeof status === "string") jsParts.push(`window.setStatus && window.setStatus(${JSON.stringify(status)});`);
  if (jsParts.length) {
    await safeExec("ensureOverlayVisible:execJsParts", () =>
      ow.webContents.executeJavaScript(jsParts.join(" "), true)
    );
  }
  await syncOverlayQueueVisual();
  ow.showInactive();
}

async function setOverlayTimer(text) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  const value = String(text || "").trim();
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  await safeExec("setOverlayTimer", () =>
    overlayWin.webContents.executeJavaScript(`window.setTimer && window.setTimer(${JSON.stringify(value)});`, true)
  );
}

/**
 * Schedule a single hideRecordingOverlay() call after `ms` milliseconds.
 * Any previously scheduled call is cancelled first, so multiple in-flight
 * code paths converge on exactly one hide — eliminating the stacked-timer
 * race where a late second fire kills the wave monitor of a freshly started
 * new recording session.
 */
function scheduleOverlayHide(ms) {
  if (overlayHideTimer !== null) {
    clearTimeout(overlayHideTimer);
  }
  overlayHideTimer = setTimeout(() => {
    overlayHideTimer = null;
    hideRecordingOverlay();
  }, ms);
}

function hideRecordingOverlay() {
  if (overlayHideTimer !== null) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayLoaded) {
    overlayWin.webContents.executeJavaScript(`window.setQueueVisible && window.setQueueVisible(false);`, true).catch(() => { });
  }
  overlayWin.hide();
  overlayStopInFlight = false;
  overlaySilenceStartedAt = 0;
  overlayAutoStopConfigRefreshAt = 0;
  overlayRecordingStartedAt = 0;
  overlaySeenAudioFrames = false;
  overlaySpeechRecoveryStartedAt = 0;
  if (overlayAutoStopTriggerTimer) {
    clearTimeout(overlayAutoStopTriggerTimer);
    overlayAutoStopTriggerTimer = null;
  }
  if (overlayTranscribingStatusTimer) {
    clearTimeout(overlayTranscribingStatusTimer);
    overlayTranscribingStatusTimer = null;
  }
  overlayAutoStopUiActive = false;
  if (overlayWaveMonitor) {
    clearInterval(overlayWaveMonitor);
    overlayWaveMonitor = null;
  }
  // Safety net: when the overlay is fully dismissed and no worker is
  // actively draining the post-stop queue, both the counter and the
  // queue MUST be zero. If anything has drifted out of sync (e.g. a
  // crash in the worker left residual state), reset them now so a
  // future recording does not inherit a phantom "queued" indicator.
  if (!postStopWorkerRunning && postStopQueue.length === 0 && pendingTranscriptionCount !== 0) {
    appendMainLog(`[hide-overlay] reset-stale-pending=${pendingTranscriptionCount}`);
    pendingTranscriptionCount = 0;
  }
}

async function setOverlayStatus(text) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  await safeExec("setOverlayStatus", () =>
    overlayWin.webContents.executeJavaScript(
      `window.setStatus && window.setStatus(${JSON.stringify(String(text || ""))});`,
      true
    )
  );
}

async function showPostStopYellowThenTranscribing(delayMs = 500) {
  // Kill wave monitor so no more VU levels leak in during yellow/blue phase
  if (overlayWaveMonitor) {
    clearInterval(overlayWaveMonitor);
    overlayWaveMonitor = null;
  }
  await setOverlayStatus("Auto stop");
  if (overlayTranscribingStatusTimer) {
    clearTimeout(overlayTranscribingStatusTimer);
    overlayTranscribingStatusTimer = null;
  }
  overlayTranscribingStatusTimer = setTimeout(() => {
    overlayTranscribingStatusTimer = null;
    if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
    if (pendingTranscriptionCount > 0 || overlayStopInFlight) {
      void setOverlayStatus("Transcribing");
    }
  }, delayMs);
}

async function playOverlayCue(kind = "start") {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  const cue = kind === "stop" ? "stop" : "start";
  try {
    await overlayWin.webContents.executeJavaScript(
      `window.playCue && window.playCue(${JSON.stringify(cue)});`,
      true
    );
    appendMainLog(`[overlay-cue] kind=${cue}`);
  } catch (e) {
    appendMainLog(`[overlay-cue-error] kind=${cue} err=${compactLogText(e?.message || e)}`);
  }
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
      const ready = await win.webContents.executeJavaScript(
        `(() => !!(document.getElementById('btnStart') && document.getElementById('btnStop')) )();`,
        true
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
  // Track whether the captured paste target was consumed by an
  // enqueued task. If not (any failure path, or a start-recording
  // path), we clear it in the finally block so a stale target can
  // never leak into the NEXT recording's post-stop task.
  let pasteTargetConsumed = false;
  try {
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    const front = await getFrontmostAppInfo();
    traceStep(trace, "front_before", {
      name: front.name || "",
      pid: front.pid || 0,
    });
    if (shouldUsePasteTarget(front)) {
      pasteTargetAppName = front.name || "";
      pasteTargetAppPid = front.pid || 0;
    }
    await ensureOverlayVisible({ status: pendingTranscriptionCount > 0 ? null : "Starting", resetTimer: false, startTimer: false });
    traceStep(trace, "overlay_visible", { status: "Starting" });
    const micGranted = await requestMacMicrophonePermissionOnce();
    if (!micGranted) {
      traceStep(trace, "mic_permission_denied", {});
      await setOverlayStatus("Grant Access");
      scheduleOverlayHide(1200);
      traceEnd(trace, "failed", { reason: "mic-permission-denied" });
      return;
    }
    await ensureBackgroundWindow();
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "app_not_ready", {});
      await setOverlayStatus("App Not Ready");
      scheduleOverlayHide(1200);
      traceEnd(trace, "failed", { reason: "window-not-ready" });
      return;
    }

    const ready = await waitForRendererUiReady();
    traceStep(trace, "renderer_ready_check", { ready: !!ready });
    if (!ready) {
      await setOverlayStatus("App Loading");
      scheduleOverlayHide(1300);
      traceEnd(trace, "failed", { reason: "renderer-not-ready" });
      return;
    }

    const result = await win.webContents.executeJavaScript(
      `
      (() => {
        const isRec = !!(window.__transcriptorIsRecording);
        const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
        const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
        const autoSendEnter = !!(document.getElementById('autoSendEnterToggle') && document.getElementById('autoSendEnterToggle').classList.contains('active'));
        const timerText = (document.getElementById('timer')?.textContent || '00:00').trim();
        window.dispatchEvent(new Event('transcriptor-hotkey-toggle'));
        return { ok: true, recording: !isRec, auto, autoSendEnter, timerText, recordingId };
      })();
      `,
      true
    );

    if (!result?.ok) {
      traceStep(trace, "renderer_toggle_failed", { result: result || null });
      await setOverlayStatus("App Loading");
      scheduleOverlayHide(1300);
      traceEnd(trace, "failed", { reason: "renderer-toggle-failed" });
      return;
    }

    if (result.recording) {
      traceStep(trace, "recording_started", { auto: !!result.auto, timerText: result.timerText || "" });
      await showRecordingOverlay();
      traceEnd(trace, "recording-started", {});
      return;
    }

    await ensureOverlayVisible({ startTimer: false, resetTimer: false });
    if (result.timerText) {
      await setOverlayTimer(result.timerText);
    }
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => { });
    if (result.auto) {
      traceStep(trace, "recording_stopped", { autoTranscribe: true, timerText: result.timerText || "" });
      await playOverlayCue("stop");
      enqueuePostStopTask({
        autoTranscribe: true,
        autoSendEnter: !!result.autoSendEnter,
        stopRequestedAt: Date.now(),
        recordingId: Number(result.recordingId || 0),
        targetName: pasteTargetAppName,
        targetPid: pasteTargetAppPid,
      });
      // The task holds its own copy — we can release the globals now.
      pasteTargetConsumed = true;
      await syncOverlayQueueVisual(false);
      await showPostStopYellowThenTranscribing(700);
    } else {
      traceStep(trace, "recording_stopped", { autoTranscribe: false, timerText: result.timerText || "" });
      // Kill wave monitor immediately — recording is done
      if (overlayWaveMonitor) {
        clearInterval(overlayWaveMonitor);
        overlayWaveMonitor = null;
      }
      await playOverlayCue("stop");
      await setOverlayStatus("Saved To App");
      scheduleOverlayHide(1400);
    }
    traceEnd(trace, "done", {});
  } finally {
    shortcutToggleInFlight = false;
    // Guarantee no stale paste target leaks into a future session on
    // ANY exit path — renderer-not-ready, app-loading, mic-denied,
    // exception mid-flow, etc. The consumed flag means an enqueued
    // task already copied the value, so we are safe to clear here
    // regardless of which branch above ran.
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    // Silence unused-var warning if consumed flag is never flipped.
    void pasteTargetConsumed;
  }
}

/**
 * Fire-and-forget wrapper for ``stopRecordingFromOverlay`` with a
 * hard deadline. If the stop call hangs (e.g., renderer is
 * unresponsive), the overlay state-machine would be stuck with
 * ``overlayStopInFlight = true`` forever, permanently blocking new
 * recordings. This wrapper clears the flag on EVERY exit path —
 * resolve, reject, OR timeout — and hides the overlay if the stop
 * never completed.
 */
function guardedStopFromOverlay(reason) {
  const deadlineMs = 12000;
  let settled = false;
  const finish = (why, err) => {
    if (settled) return;
    settled = true;
    overlayStopInFlight = false;
    if (err) {
      appendMainLog(`[overlay-${reason}-error] ${compactLogText(err?.message || err)}`);
    } else if (why === "timeout") {
      appendMainLog(`[overlay-${reason}-timeout] stopRecordingFromOverlay exceeded ${deadlineMs}ms deadline`);
    }
    if (why !== "resolve") {
      hideRecordingOverlay();
    }
  };
  const timer = setTimeout(() => finish("timeout"), deadlineMs);
  stopRecordingFromOverlay().then(
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

async function stopRecordingFromOverlay() {
  await ensureBackgroundWindow();
  if (!win || win.isDestroyed() || !win.webContents) return;
  if (win.isVisible()) win.hide();

  try {
    const result = await win.webContents.executeJavaScript(
      `
      (() => {
        const isRec = !!(window.__transcriptorIsRecording);
        const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
        const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
        const timerText = (document.getElementById('timer')?.textContent || '00:00').trim();
        const autoSendEnter = !!(document.getElementById('autoSendEnterToggle') && document.getElementById('autoSendEnterToggle').classList.contains('active'));
        if (!isRec) return { ok: false, recording: false, timerText, recordingId, auto, autoSendEnter };
        // Use dedicated stop event — avoids dual-path race with btnStop.click().
        window.dispatchEvent(new Event('transcriptor-hotkey-stop'));
        return { ok: true, recording: false, timerText, recordingId, auto, autoSendEnter };
      })();
      `,
      true
    );

    await ensureOverlayVisible({ startTimer: false, resetTimer: false });
    if (result?.timerText) {
      await setOverlayTimer(result.timerText);
    }
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => { });

    if (result?.ok) {
      await playOverlayCue("stop");
      if (result.auto) {
        enqueuePostStopTask({
          autoTranscribe: true,
          autoSendEnter: !!result.autoSendEnter,
          stopRequestedAt: Date.now(),
          recordingId: Number(result.recordingId || 0),
          targetName: pasteTargetAppName,
          targetPid: pasteTargetAppPid,
        });
        await syncOverlayQueueVisual(false);
        await showPostStopYellowThenTranscribing(700);
      } else {
        await setOverlayStatus("Saved To App");
        scheduleOverlayHide(1400);
      }
    } else {
      await setOverlayStatus("Saved To App");
      scheduleOverlayHide(1400);
    }
  } finally {
    // Every exit path clears the paste target — the enqueued task
    // already holds its own copy, and any early-return branch must
    // not leak a stale target into the next recording.
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
  }
}

// Maximum time we wait on the renderer for a state snapshot. If the
// renderer is stuck (infinite loop, ongoing synchronous work, blocked
// on a pending IPC), ``executeJavaScript`` never resolves — and the
// overlay stop path sits forever waiting for getLatestTranscriptText.
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
      const status = (document.getElementById('statusText')?.textContent || '').trim();
      const finalText = (document.getElementById('finalOutput')?.textContent || '').trim();
      const liveText = (document.getElementById('liveOutput')?.textContent || '').trim();
      const busy = !!document.getElementById('btnStart')?.disabled;
      const progressVisible = document.getElementById('progressRow') ? !document.getElementById('progressRow').hidden : false;
      return {
        finishedAt,
        finishedRecordingId,
        finishedText,
        uiFinalAt,
        uiFinalRecordingId,
        uiFinalText,
        uiFinalKind,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLastTranscriptPath() {
  try {
    return path.join(app.getPath("userData"), LAST_TRANSCRIPT_FILE);
  } catch {
    return "";
  }
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
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ text: cleaned, updated_at: new Date().toISOString() }, null, 2),
      "utf8"
    );
    // Warm the cache with the value we just wrote so the next
    // ``loadLastTranscriptFromDisk`` does not need to re-read it.
    _lastTranscriptCacheText = cleaned;
    try {
      _lastTranscriptCacheMtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      _lastTranscriptCacheMtimeMs = -1;
    }
  } catch (e) {
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
  return (
    n === "electron" ||
    n === "electron helper" ||
    n.includes("electron helper") ||
    n.includes("helper (renderer)") ||
    n.includes("helper (gpu)") ||
    n.includes("helper (plugin)") ||
    n.includes("transcriptor")
  );
}

function shouldUsePasteTarget(front) {
  const pid = Number(front?.pid || 0);
  const name = String(front?.name || "").trim().toLowerCase();
  if (pid > 0 && pid === process.pid) return false;
  if (name.includes("transcriptor")) return false;
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

function overlayStatusForPasteFailure(reason) {
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

async function getFrontmostAppInfo() {
  if (process.platform === "win32") {
    const pwsh = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Window {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        }
"@
      $hwnd = [Window]::GetForegroundWindow()
      $pid = 0
      [Window]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      if ($proc) { Write-Output ($proc.Name + "||" + $pid) } else { Write-Output "||0" }
    `;
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
    if (!res.ok) return { name: "", pid: 0 };
    const raw = String(res.stdout || "").trim();
    const [name, pidText] = raw.split("||");
    return {
      name: String(name || "").trim(),
      pid: Number.parseInt(String(pidText || "0").trim(), 10) || 0
    };
  }
  const script = `
    tell application "System Events"
      set p to first process whose frontmost is true
      set n to name of p
      set u to unix id of p
      return (n as text) & "||" & (u as text)
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: 5000 });
  if (!res.ok) return { name: "", pid: 0 };
  const raw = String(res.stdout || "").trim();
  const [name, pidText] = raw.split("||");
  return {
    name: String(name || "").trim(),
    pid: Number.parseInt(String(pidText || "0").trim(), 10) || 0
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

/** Restore a clipboard snapshot produced by snapshotClipboard(). */
function restoreClipboard(snap) {
  try {
    if (!snap || !snap.formats || snap.formats.length === 0) {
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
    } else {
      clipboard.clear();
    }
  } catch {
    try { clipboard.clear(); } catch { }
  }
}

async function tryPasteToFocusedField(text, targetAppName = "", targetAppPid = 0) {
  const originalTargetName = String(targetAppName || "").trim();
  const originalTargetPid = Number(targetAppPid || 0);
  let effectiveTargetName = originalTargetName;
  let effectiveTargetPid = originalTargetPid;
  const trace = createTrace("paste", {
    targetAppName: originalTargetName,
    targetAppPid: originalTargetPid,
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
  });
  const targetLooksGenericElectron = /^electron$/i.test(effectiveTargetName);
  if (targetLooksGenericElectron && shouldUsePasteTarget(frontBefore)) {
    effectiveTargetName = String(frontBefore.name || "").trim();
    effectiveTargetPid = Number(frontBefore.pid || 0);
    traceStep(trace, "target_normalized_from_front", {
      fromName: originalTargetName,
      fromPid: originalTargetPid,
      toName: effectiveTargetName,
      toPid: effectiveTargetPid,
      reason: "generic-electron-target",
    });
  } else if (targetLooksGenericElectron) {
    // Avoid routing by generic app name when we don't have a safe concrete pid.
    effectiveTargetName = "";
    traceStep(trace, "target_name_cleared", {
      fromName: originalTargetName,
      reason: "generic-electron-without-safe-front",
    });
  }
  const targetHint = `${effectiveTargetName} ${String(frontBefore.name || "")}`.toLowerCase();
  const genericElectronTarget = /^electron$/i.test(effectiveTargetName);
  if (genericElectronTarget) {
    // For Electron-based third-party apps, process-level targeting can hit the shell process
    // instead of the real focused webview/editor. Force global frontmost route.
    traceStep(trace, "target_route_override", {
      fromName: effectiveTargetName,
      fromPid: effectiveTargetPid,
      toName: "",
      toPid: 0,
      reason: "generic-electron-use-frontmost-global",
    });
    effectiveTargetName = "";
    effectiveTargetPid = 0;
  }
  const preferTypedFirst = false;
  traceStep(trace, "paste_strategy", { preferTypedFirst, targetHint: compactLogText(targetHint, 80) });
  logPasteTrace("start", {
    targetAppName: effectiveTargetName,
    targetAppPid: effectiveTargetPid,
    frontBeforeName: frontBefore.name || "",
    frontBeforePid: frontBefore.pid || 0,
    textLen: String(text).length,
  });
  const savedClipboard = snapshotClipboard();
  try {
    clipboard.writeText(String(text));
  } catch {
    traceStep(trace, "clipboard_write_failed", {});
    logPasteTrace("clipboard_write_failed", {});
    traceEnd(trace, "failed", { reason: "clipboard-write-failed" });
    // Restore original clipboard.
    safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
    return { ok: false, reason: "clipboard-write-failed", method: "clipboard", verified: false };
  }
  traceStep(trace, "clipboard_write_ok", {});
  logPasteTrace("clipboard_write_ok", {});
  const escapedApp = escapeAppleScriptString(effectiveTargetName);
  const rawPid = Number.parseInt(String(effectiveTargetPid || 0), 10) || 0;
  // Defense-in-depth: reject any value that is not a safe non-negative integer
  // before interpolating it into the AppleScript source string.
  const pid = (Number.isFinite(rawPid) && rawPid >= 0 && rawPid < 2 ** 31) ? Math.trunc(rawPid) : 0;
  const robustPasteScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${pid}
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
      -- for several seconds and it makes the overlay look "stuck on transcribing".
      set frontmost of p to true
      delay 0.08
      
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

      logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "win_paste" });
      traceStep(trace, "method_begin", { method: "win_paste", attempt: attempt + 1 });

      const cmdStarted = Date.now();

      // Fast path: VBS SendKeys — no compilation, no .NET assembly
      // loading, executes in <100 ms on all Windows versions.
      const vbsPath = path.join(app.getPath("temp"), `transcriptor_paste_${Date.now()}.vbs`);
      try {
        const vbsLines = [
          'Set WshShell = CreateObject("WScript.Shell")',
        ];
        // Activate target window by PID if available
        if (effectiveTargetPid > 0) {
          vbsLines.push(`WshShell.AppActivate ${Math.trunc(effectiveTargetPid)}`);
          vbsLines.push('WScript.Sleep 80');
        } else if (effectiveTargetName) {
          // VBS string literals are terminated by CR/LF — a target name
          // that contains a newline would break out of the quoted string
          // and inject arbitrary VBS into the script. Doubling the ``"``
          // is the standard VBS escape; stripping CR/LF + NUL + all other
          // control characters prevents any line-break-based escape.
          // effectiveTargetName comes from the Windows process table, so
          // the attack surface is small (a process would have to register
          // with a pathological name), but the one-line fix is free.
          const sanitizedName = effectiveTargetName
            .replace(/[\x00-\x1f\x7f]/g, "")
            .replace(/"/g, '""');
          vbsLines.push(`WshShell.AppActivate "${sanitizedName}"`);
          vbsLines.push('WScript.Sleep 80');
        }
        vbsLines.push('WScript.Sleep 30');
        vbsLines.push('WshShell.SendKeys "^v"');
        vbsLines.push('WScript.Echo "OK:vbs-paste"');

        fs.writeFileSync(vbsPath, vbsLines.join("\r\n"), "utf8");
        const check = await runCommand("cscript", ["//Nologo", "//B", vbsPath], { timeoutMs: 2500 });

        // Clean up temp file
        try { fs.unlinkSync(vbsPath); } catch { }

        if (check.ok) {
          traceEnd(trace, "success", { method: "vbs_paste", attempt: attempt + 1, reason: "vbs_success", verified: false });
          setTimeout(() => {
            safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
          }, 1200);
          return { ok: true, reason: "OK:vbs_paste", method: "vbs_paste", verified: false };
        }
        lastReason = (check.stderr || check.stdout || "vbs-failed").trim();
      } catch (e) {
        try { fs.unlinkSync(vbsPath); } catch { }
        lastReason = `vbs-error: ${e?.message || e}`;
      }

      // Fallback: lightweight PowerShell (no C# compilation)
      if (attempt === 2) {
        const pwshSimple = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^{v}"); Write-Output "OK:pwsh-paste"`;
        const fallback = await runCommand("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", pwshSimple], { timeoutMs: 3000 });
        if (fallback.ok && (fallback.stdout || "").includes("OK:")) {
          traceEnd(trace, "success", { method: "pwsh_paste_fallback", attempt: attempt + 1 });
          setTimeout(() => {
            safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
          }, 1200);
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
    // Window activation: if ``effectiveTargetPid`` is known we use
    // ``wmctrl -ia`` on X11 (activates and raises). On Wayland there
    // is no standard cross-compositor window activation — we rely on
    // whatever already has focus (the user typically tab-ed to the
    // target before pressing the paste hotkey).
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

      // Try to focus the target window on X11 (wmctrl is X11-only).
      // Skip on pure Wayland to avoid spawning a process that will fail.
      if (hasX11 && effectiveTargetName) {
        const sanitized = String(effectiveTargetName).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120);
        if (sanitized) {
          await runCommand("wmctrl", ["-a", sanitized], { timeoutMs: 800 }).catch(() => {});
          await sleep(60);
        }
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
          setTimeout(() => {
            safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
          }, 1200);
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
        setTimeout(() => {
          safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
        }, 1200);
        return { ok: true, reason: out, method: "robust_paste", verified: false };
      }
      if (out === "ERR:secure-field") {
        traceEnd(trace, "failed", { reason: "secure-field" });
        safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
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
      setTimeout(() => {
        safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
      }, 1200);
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
  return { ok: false, reason: lastReason, method: "failed", verified: false };
}

async function sendCommandEnterToFocusedApp(targetAppName = "", targetAppPid = 0) {
  const targetName = String(targetAppName || "").trim();
  const targetPid = Number(targetAppPid || 0);
  if (targetPid > 0) {
    await activateAppByPid(targetPid);
    await sleep(110);
  } else if (targetName && !isBadActivationTarget(targetName)) {
    await activateAppByName(targetName);
    await sleep(110);
  }
  
  if (process.platform === "win32") {
      const pwsh = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      `;
      const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 3200 });
      if (res.ok) {
        return { ok: true, reason: "powershell-enter-sent" };
      }
      return { ok: false, reason: String(res.stderr || res.stdout || "powershell-enter-failed") };
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

function enqueuePostStopTask(options = {}) {
  const task = {
    autoTranscribe: !!options.autoTranscribe,
    autoSendEnter: !!options.autoSendEnter,
    stopRequestedAt: Number(options.stopRequestedAt || Date.now()),
    recordingId: Number(options.recordingId || 0),
    targetName: String(options.targetName || ""),
    targetPid: Number(options.targetPid || 0),
  };
  if (!task.autoTranscribe) return;
  postStopQueue.push(task);
  pendingTranscriptionCount += 1;
  appendMainLog(`[post-stop-queue] enqueue pending=${pendingTranscriptionCount} rec=${task.recordingId} target="${task.targetName}" pid=${task.targetPid}`);
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
          await setOverlayStatus("Saved To App").catch(() => { });
        }
      } finally {
        pendingTranscriptionCount = Math.max(0, pendingTranscriptionCount - 1);
      }
      // Read BOTH recording state and recordingId in one shot. We cannot
      // trust ``__transcriptorIsRecording`` alone here: stopLive sets it
      // to false LATE in its cleanup sequence (~line 5288), while
      // processPostStopTask can complete much earlier (Deepgram returns
      // committed segments within ~100 ms). During that window
      // ``isRec`` reads true even though no recording is actually
      // happening — the user perceives this as the overlay "auto-
      // restarting" a new red recording after the blue transcribe.
      //
      // The fix: compare recordingId against the task's. A genuinely
      // NEW recording bumps ``__transcriptorCurrentRecordingId`` via
      // ``++liveRecordingSeq`` in startLive. If the id matches the
      // task we just finished, we're still watching the old stopLive
      // clean up — treat as not-recording and hide the overlay.
      let rendererState = { recording: false, recordingId: 0 };
      try {
        if (win && !win.isDestroyed() && win.webContents) {
          rendererState = await win.webContents.executeJavaScript(
            `(() => ({ recording: !!window.__transcriptorIsRecording, recordingId: Number(window.__transcriptorCurrentRecordingId || 0) }))();`,
            true
          );
        }
      } catch (e) {
        appendMainLog(`[post-stop-queue] isRec-error err="${compactLogText(e?.message || e)}"`);
      }
      const taskRecId = Number(task.recordingId || 0);
      const newRecordingStarted = !!rendererState.recording
        && Number(rendererState.recordingId || 0) > 0
        && Number(rendererState.recordingId || 0) !== taskRecId;
      await syncOverlayQueueVisual(newRecordingStarted).catch(() => { });
      if (!newRecordingStarted) {
        if (pendingTranscriptionCount > 0) {
          await setOverlayStatus("Transcribing").catch(() => { });
        } else {
          scheduleOverlayHide(1400);
        }
      } else if (pendingTranscriptionCount === 0) {
        await overlayWin?.webContents.executeJavaScript(
          `window.setStatus && window.setStatus("Recording"); window.resetWave && window.resetWave(); window.resetTimer && window.resetTimer(); window.startTimer && window.startTimer();`,
          true
        ).catch(() => { });
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

async function processPostStopTask(task) {
  const trace = createTrace("post_stop", { autoTranscribe: !!task.autoTranscribe, queuePending: pendingTranscriptionCount });
  // Old value was 120000 (2 minutes!) which caused the overlay to
  // hang indefinitely showing "Transcribing..." when the renderer was
  // slow or unresponsive. 15 seconds is more than enough for any
  // realistic Deepgram/local transcription + upscale pass. If the
  // transcript hasn't arrived by then, we give up and hide the overlay
  // — the transcript will still appear in the main window when it
  // eventually resolves, the paste just won't happen automatically.
  const deadline = Date.now() + 15000;
  let transcript = "";
  let pollCount = 0;
  const stopRequestedAt = Number(task.stopRequestedAt || Date.now());
  let overlayPhase = "";

  while (Date.now() < deadline) {
    pollCount += 1;
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "poll_window_lost", { pollCount });
      await sleep(70);
      continue;
    }
    let state = null;
    try {
      state = await win.webContents.executeJavaScript(
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
          const status = (document.getElementById('statusText')?.textContent || '').trim();
          const finalText = (document.getElementById('finalOutput')?.textContent || '').trim();
          const liveText = (document.getElementById('liveOutput')?.textContent || '').trim();
          const busy = !!document.getElementById('btnStart')?.disabled;
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
      );
    } catch {
      traceStep(trace, "poll_js_error", { pollCount });
      await sleep(70);
      continue;
    }
    if (!state) {
      traceStep(trace, "poll_empty_state", { pollCount });
      await sleep(70);
      continue;
    }
    const statusLower = String(state.status || "").trim().toLowerCase();
    if (!state.isRec) {
      if (statusLower === "upscaling" && overlayPhase !== "upscaling") {
        await setOverlayStatus("Upscaling");
        overlayPhase = "upscaling";
      } else if ((statusLower === "processing" || statusLower === "transcribing") && overlayPhase !== "transcribing") {
        await setOverlayStatus("Transcribing");
        overlayPhase = "transcribing";
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
    if (doneLike) break;
    await sleep(30);
  }

  let overlayStatus = "Saved To App";
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

    // Paste target resolution. The start-time snapshot
    // (``task.targetName``/``task.targetPid``) captures the app the
    // user was in when they pressed the RECORD shortcut, but the
    // user may well have switched apps mid-recording — they pressed
    // the shortcut in Telegram, then Cmd-Tab to Slack to look at
    // something, speak, and press the shortcut again to stop + paste.
    // In that case the correct target is the CURRENT frontmost app
    // (Slack), not the app that was frontmost at record time
    // (Telegram).
    //
    // Strategy (latest-wins with safe fallback):
    //
    //   1. Snapshot the current frontmost app.
    //   2. If it is a real pasteable target (``shouldUsePasteTarget``
    //      returns true — not Transcriptor/overlay/helper), use it.
    //   3. Otherwise fall back to the start-time snapshot — the
    //      overlay might be transiently in front after the user
    //      clicked its Stop button, or some helper process might
    //      have taken focus. The start snapshot is still a valid
    //      best guess in that case.
    //   4. If even the start snapshot is absent, try to re-activate
    //      the start-time PID so whatever app was there when
    //      recording began comes back and receives the paste.
    let effectiveTargetName = task.targetName || "";
    let effectiveTargetPid = Number(task.targetPid || 0);
    try {
      const currentFront = await getFrontmostAppInfo();
      const currentName = String(currentFront.name || "").trim();
      const currentPid = Number(currentFront.pid || 0);
      if (shouldUsePasteTarget(currentFront)) {
        if (
          effectiveTargetPid > 0 &&
          currentPid > 0 &&
          currentPid !== effectiveTargetPid
        ) {
          traceStep(trace, "target_refreshed_from_current_front", {
            oldName: effectiveTargetName,
            oldPid: effectiveTargetPid,
            newName: currentName,
            newPid: currentPid,
          });
        }
        effectiveTargetName = currentName;
        effectiveTargetPid = currentPid;
      } else if (
        effectiveTargetPid > 0 &&
        currentPid !== effectiveTargetPid
      ) {
        // Front app is transcriptor/overlay/helper. Try to re-
        // activate the start-time target so it receives the paste.
        const stillRunning = await activateAppByPid(effectiveTargetPid);
        if (stillRunning) {
          traceStep(trace, "target_reactivated_start_pid", {
            name: effectiveTargetName,
            pid: effectiveTargetPid,
          });
        } else {
          traceStep(trace, "target_lost", {
            oldName: effectiveTargetName,
            oldPid: effectiveTargetPid,
          });
          effectiveTargetName = "";
          effectiveTargetPid = 0;
        }
      }
    } catch { }

    const pasted = await tryPasteToFocusedField(transcript, effectiveTargetName, effectiveTargetPid);
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-auto] target="${effectiveTargetName}" pid=${effectiveTargetPid} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${transcript.length}`
    );
    if (pasted.ok) {
      // Show success immediately once the paste actually happened.
      await setOverlayStatus("Pasted");
    }
    if (pasted.ok && task.autoSendEnter) {
      await sleep(220);
      const sent = await sendCommandEnterToFocusedApp(effectiveTargetName, effectiveTargetPid);
      traceStep(trace, "cmd_enter_result", {
        ok: !!sent.ok,
        reason: compactLogText(sent.reason || ""),
      });
      appendMainLog(
        `[cmd-enter] target="${effectiveTargetName}" pid=${effectiveTargetPid} ok=${sent.ok ? "1" : "0"} reason="${sent.reason || ""}"`
      );
      if (sent.ok) {
        await setOverlayStatus("Sent");
      }
      if (!sent.ok && looksLikeAutomationPermissionError(sent.reason)) {
        openPrivacyAccessibilitySettings();
      }
    }
    if (!pasted.ok && (looksLikeAutomationPermissionError(pasted.reason) || String(pasted.reason || "").includes("no-accessibility"))) {
      openPrivacyAccessibilitySettings();
    }
    overlayStatus = pasted.ok ? "Paste Sent" : overlayStatusForPasteFailure(pasted.reason);
  } else {
    traceStep(trace, "transcript_missing", { reason: "no-final-or-live-text-before-deadline" });
  }

  const isRecNow = await isRendererRecording();
  if (!isRecNow) {
    await setOverlayStatus(overlayStatus);
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
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    const front = await getFrontmostAppInfo();
    traceStep(trace, "front_before", {
      name: front.name || "",
      pid: front.pid || 0,
    });
    if (shouldUsePasteTarget(front)) {
      pasteTargetAppName = front.name || "";
      pasteTargetAppPid = front.pid || 0;
    }
    await ensureOverlayVisible({ status: "Pasting", resetTimer: false, startTimer: false });
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => { });

    const text = await getLatestTranscriptText();
    if (!text) {
      traceStep(trace, "no_text_available", {});
      await setOverlayStatus("No Text");
      scheduleOverlayHide(1200);
      pasteTargetAppName = "";
      pasteTargetAppPid = 0;
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

    const pasted = await tryPasteToFocusedField(text, pasteTargetAppName, pasteTargetAppPid);
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-last] target="${pasteTargetAppName}" pid=${pasteTargetAppPid} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${text.length}`
    );
    await setOverlayStatus(pasted.ok ? "Paste Sent" : overlayStatusForPasteFailure(pasted.reason));
    if (!pasted.ok) {
      if (String(pasted.reason || "").includes("no-accessibility")) {
        openPrivacyAccessibilitySettings();
      }
      appendMainLog(`[paste-last] failed: ${pasted.reason || "unknown"}`);
    }
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    scheduleOverlayHide(1300);
  } finally {
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
  return !!p && p.startsWith("/") && fs.existsSync(p);
}

function getPythonCandidates(repoRoot) {
  const fromEnv = (process.env.PYTHON || "").trim();
  const appVenvPy = path.join(getAppVenvDir(), "bin", "python3");
  const candidates = [
    fromEnv,
    appVenvPy,
    path.join(repoRoot, ".venv", "bin", "python3"),
    path.join(repoRoot, ".venv", "bin", "python"),
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "python"
  ].filter(Boolean);

  const out = [];
  for (const c of candidates) {
    if (c.startsWith("/")) {
      if (fileExists(c)) out.push(c);
      continue;
    }
    out.push(c);
  }
  return [...new Set(out)];
}

function runCommand(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { }
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\nTimed out` });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
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
    if (py.startsWith("/") && !fileExists(py)) continue;
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

async function resolvePython(repoRoot) {
  // 1) Try app venv (highest priority)
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

  // 3) Create app venv from system Python
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

async function ensureBackendRuntime(python, repoRoot) {
  const importCheck = await runCommand(
    python,
    ["-c", "import fastapi, uvicorn, multipart, cryptography"],
    { cwd: repoRoot, timeoutMs: 12000 }
  );

  if (importCheck.ok) return { ok: true };

  const requirementsPath = path.join(repoRoot, "requirements.txt");
  if (!fs.existsSync(requirementsPath)) {
    return { ok: false, details: "requirements.txt not found in app resources" };
  }

  setBackendBootStatus("Installing dependencies (first launch)…");

  // If Python is inside app venv, install directly (no --user needed)
  const isAppVenv = python.startsWith(getAppVenvDir());
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
    ["-c", "import fastapi, uvicorn, multipart, cryptography"],
    { cwd: repoRoot, timeoutMs: 12000 }
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
  if (backend) return;
  if (backendStartInFlight) return backendStartInFlight;

  // Absorb any queued crash-restart: the caller is asking for a
  // backend NOW, so the deferred restart is redundant. Clearing the
  // timer here also prevents it from firing mid-start and causing
  // startBackend() to re-enter itself.
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
    // Broadcast error to renderer
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.executeJavaScript(
        `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
        true
      ).catch(() => { });
    }
    return;
  }

  const runtime = await ensureBackendRuntime(python, repoRoot);
  if (!runtime.ok) {
    backendBootError = runtime.details || "Backend runtime is unavailable.";
    setBackendBootStatus("");
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.executeJavaScript(
        `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
        true
      ).catch(() => { });
    }
    return;
  }

  setBackendBootStatus("Starting backend…");

  const preferredPort = Number(process.env.TRANSCRIPTOR_PORT || DEFAULT_BACKEND_PORT) || DEFAULT_BACKEND_PORT;
  PORT = await pickBackendPort(HOST, preferredPort);
  BASE_URL = `http://${HOST}:${PORT}`;
  appendMainLog(`[backend-start] python="${python}" host=${HOST} port=${PORT} repo="${repoRoot}"`);

  const args = [
    "-m", "uvicorn",
    "backend.main:app",
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
  backend = spawn(python, args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: repoRoot + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""),
      TRANSCRIPTOR_DATA_DIR: process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData"),
    }
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
  });

  backend.on("exit", (code) => {
    appendMainLog(`[backend-exit] code=${code}`);
    backend = null;
    if (!isQuitting && Number(code || 0) !== 0) {
      if (backendRestartTimer) {
        clearTimeout(backendRestartTimer);
        backendRestartTimer = null;
      }
      const attempt = Math.min(backendRestartAttempts + 1, 8);
      backendRestartAttempts = attempt;
      const delay = Math.min(800 * attempt, 5000);
      appendMainLog(`[backend-restart-scheduled] attempt=${attempt} delayMs=${delay}`);
      backendRestartTimer = setTimeout(() => {
        backendRestartTimer = null;
        startBackend()
          .then(() => appendMainLog("[backend-restart] attempted"))
          .catch((e) => appendMainLog(`[backend-restart-error] ${e?.message || e}`));
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

function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Backend did not start in time"));
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(tick, 250);
        }
      });
      req.on("error", () => setTimeout(tick, 250));
    };
    tick();
  });
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
    if (showWindow && !win.isVisible()) {
      win.show();
      win.focus();
    }
    return;
  }

  win = new BrowserWindow({
    width: 1420,
    height: 780,
    minWidth: 1140,
    minHeight: 700,
    backgroundColor: "#1a1a1a",
    title: "Transcriptor",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      webSecurity: true
    }
  });

  const mediaPermissions = new Set(["media", "microphone", "audioCapture", "videoCapture"]);
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    const perm = String(permission || "");
    const url = wc?.getURL?.() || "";
    const allow = mediaPermissions.has(perm);
    appendMainLog(`[perm-request] perm=${perm} allow=${allow} url=${url}`);
    cb(allow);
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission) => {
    const perm = String(permission || "");
    const url = wc?.getURL?.() || "";
    const allow = mediaPermissions.has(perm);
    appendMainLog(`[perm-check] perm=${perm} allow=${allow} url=${url}`);
    return allow;
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    const reason = String(details?.reason || "unknown");
    const exitCode = details?.exitCode ?? "";
    appendMainLog(`[render-process-gone] reason=${reason} exitCode=${exitCode}`);
    // ``clean-exit`` happens on normal window close and does NOT
    // require recovery. Every other reason (crashed, killed,
    // oom, etc.) leaves the Electron main process holding stale
    // references — the overlay state machine, any in-flight
    // ``overlayStopInFlight`` flag, the ``pendingTranscriptionCount``
    // counter, and the ``shortcutToggleInFlight`` guard — that
    // would otherwise block every future hotkey press.
    if (reason === "clean-exit") return;
    // Reset the state machine so the NEXT hotkey press starts
    // cleanly instead of short-circuiting on a stale flag.
    overlayStopInFlight = false;
    shortcutToggleInFlight = false;
    pasteShortcutInFlight = false;
    if (pendingTranscriptionCount > 0) {
      appendMainLog(`[render-process-gone] dropping pendingTranscriptionCount=${pendingTranscriptionCount}`);
      pendingTranscriptionCount = 0;
    }
    // Tear down the overlay: it may be in "Transcribing" state
    // pointing at a transcript that will never arrive.
    try {
      hideRecordingOverlay();
    } catch (e) {
      appendMainLog(`[render-process-gone] hideRecordingOverlay failed: ${e?.message || e}`);
    }
    // The renderer is dead; ``reload()`` on a crashed webContents
    // throws. Schedule a fresh load so the user sees a working UI
    // on the next Spotlight/Dock click.
    setTimeout(() => {
      if (!win || win.isDestroyed() || !win.webContents) return;
      const baseUrl = `${BASE_URL}/`;
      win.loadURL(baseUrl).catch((e) => {
        appendMainLog(`[render-process-gone] reload failed: ${e?.message || e}`);
      });
    }, 500);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    appendMainLog(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on("did-finish-load", async () => {
    loadedFrontendBuildSignature = (await getFrontendBuildSignature()) || "";
    appendMainLog(`[did-finish-load] frontendSignature=${loadedFrontendBuildSignature || "none"}`);
  });

  win.on("close", (event) => {
    // Keep renderer warm on macOS so global-hotkey actions are instant and
    // don't steal focus by re-creating window each time.
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      win.hide();
      if (app.dock) app.dock.hide();
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

  const url = `${BASE_URL}/`;
  try {
    if (!backend) {
      await startBackend();
    }
    await waitForHttp(`${BASE_URL}/api/health`, 120_000);
    await refreshWindowForFrontendBuild(true);
    await win.loadURL(url);
    if (showWindow) {
      win.show();
      win.focus();
    }
  } catch (err) {
    const details = [
      err.message,
      backendBootError,
    ]
      .filter(Boolean)
      .join("\n\n");

    await win.loadURL(
      `data:text/html,${encodeURIComponent(`
      <html>
        <body style="background:#1a1a1a;color:#cfcfcf;font-family:-apple-system;padding:28px;line-height:1.6">
          <h2 style="margin:0 0 16px 0">Transcriptor — Backend startup failed</h2>
          <pre style="white-space:pre-wrap;background:#111;padding:14px;border-radius:8px;border:1px solid #333;margin-bottom:20px">${escapeHtml(details)}</pre>
          <div id="status" style="padding:10px 14px;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:8px;margin-bottom:16px;color:#7defa0;font-size:13px">⏳ Checking if backend is starting...</div>
          <h3 style="margin:0 0 10px 0;color:#e0e0e0">If it doesn't recover automatically</h3>
          <p style="color:#bbb;margin-bottom:6px">Find the <b>Voice Transcriptor</b> folder you downloaded:</p>
          <p style="color:#ddd;margin:8px 0"><b>→ Right-click</b> on <code style="background:#333;padding:2px 6px;border-radius:4px">setup.command</code> → <b>Open</b> → <b>Open</b></p>
          <p style="color:#666;font-size:12px;margin:12px 0 4px">Or paste in Terminal:</p>
          <pre style="background:#111;padding:10px 14px;border-radius:8px;border:1px solid #444;color:#7defa0;font-size:12px;user-select:all;cursor:text">bash ~/Downloads/Voice\\\\ Transcriptor/setup.command</pre>
          <script>
            let attempt = 0;
            function checkHealth() {
              attempt++;
              const s = document.getElementById('status');
              s.textContent = '⏳ Waiting for backend... (attempt ' + attempt + ')';
              fetch('${BASE_URL}/api/health', { signal: AbortSignal.timeout(3000) })
                .then(r => { if (r.ok) { s.textContent = '✅ Backend is up! Reloading...'; s.style.background='#1a3a1a'; s.style.borderColor='#2a6a2a'; setTimeout(() => location.reload(), 500); } else { setTimeout(checkHealth, 3000); } })
                .catch(() => setTimeout(checkHealth, 3000));
            }
            checkHealth();
          </script>
        </body>
      </html>
    `)}`
    );
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // In menu bar mode (dock hidden), ignore all activation events.
  if (process.platform === "darwin" && app.dock && !app.dock.isVisible()) {
    return;
  }
  // When the recording overlay is visible, clicking its buttons triggers
  // macOS app activation (even though the window is focusable:false).
  // Don't show the main window — the user is interacting with the overlay.
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
    return;
  }
  if (overlayStopInFlight) return;
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
  globalShortcut.unregisterAll();
  if (overlayMonitor) {
    clearInterval(overlayMonitor);
    overlayMonitor = null;
  }
  if (overlayWaveMonitor) {
    clearInterval(overlayWaveMonitor);
    overlayWaveMonitor = null;
  }
  if (overlayAutoStopTriggerTimer) {
    clearTimeout(overlayAutoStopTriggerTimer);
    overlayAutoStopTriggerTimer = null;
  }
  if (overlayTranscribingStatusTimer) {
    clearTimeout(overlayTranscribingStatusTimer);
    overlayTranscribingStatusTimer = null;
  }
  hideRecordingOverlay();
  if (overlayWin && !overlayWin.isDestroyed()) {
    try {
      overlayWin.close();
    } catch (e) {
      appendMainLog(`[before-quit] overlay close failed: ${e?.message || e}`);
    }
  }
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
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    appendMainLog(`[signal] ${sig}`);
    isQuitting = true;
    killBackendHard(`signal-${sig}`);
    // Let Electron's own handler run; don't call app.exit() ourselves
    // because that would skip before-quit cleanup.
  });
}

app.whenReady().then(async () => {
  process.on("uncaughtException", (err) => {
    appendMainLog(`[uncaughtException] ${err?.stack || err?.message || String(err)}`);
    console.error("[uncaughtException]", err);
  });
  process.on("unhandledRejection", (reason) => {
    appendMainLog(`[unhandledRejection] ${String(reason)}`);
    console.error("[unhandledRejection]", reason);
  });
  lastTranscriptText = loadLastTranscriptFromDisk();
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
  }
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
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

  function readShortcutsFromConfig() {
    const defaults = { record: "Alt+Left", paste: "Alt+Shift+7" };
    try {
      const dataDir = process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData");
      const cfgPath = path.join(dataDir, "config.json");
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const ui = raw?.preferences?.ui || {};
        return {
          record: String(ui.shortcut_record || defaults.record).trim() || defaults.record,
          paste: String(ui.shortcut_paste || defaults.paste).trim() || defaults.paste,
        };
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

  function registerGlobalShortcuts() {
    const shortcuts = readShortcutsFromConfig();
    // Unregister old shortcuts (keep devtools)
    if (registeredRecordHotkey) {
      try { globalShortcut.unregister(registeredRecordHotkey); } catch { }
    }
    if (registeredPasteHotkey) {
      try { globalShortcut.unregister(registeredPasteHotkey); } catch { }
    }
    // Clear stored values up-front — only set them back after a
    // successful registration, so a failed accelerator is never
    // tracked as "active" (which would cause the next reload to
    // unregister something that was never registered).
    registeredRecordHotkey = "";
    registeredPasteHotkey = "";

    const recordResult = safeRegisterShortcut(shortcuts.record, () => {
      toggleRecordingFromShortcut().catch((e) => {
        appendMainLog(`[shortcut] toggle failed: ${e?.message || e}`);
        hideRecordingOverlay();
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
        hideRecordingOverlay();
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
    if (win && !win.isDestroyed() && win.webContents) {
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
      };
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

  registerGlobalShortcuts();

  // Poll for live shortcut changes from the renderer settings UI
  setInterval(async () => {
    if (!win || win.isDestroyed() || !win.webContents) return;
    try {
      const pending = await win.webContents.executeJavaScript(
        `(() => { const p = window.__transcriptorPendingShortcuts; if (p) { delete window.__transcriptorPendingShortcuts; return p; } return null; })()`,
        true
      );
      if (pending && (pending.record || pending.paste)) {
        appendMainLog(`[shortcuts] live reload: record=${pending.record} paste=${pending.paste}`);
        registerGlobalShortcuts();
      }
    } catch { }
  }, 2000);

  await requestMacPastePermissionsOnce();
  await startBackend();
  await ensureWindowVisible();
  await requestMacMicrophonePermissionOnce();

  // Preload overlay once to avoid first-use delay after hotkey.
  try {
    const ow = ensureOverlayWindow();
    if (!overlayLoaded) {
      await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
      overlayLoaded = true;
    }
  } catch { }
});
