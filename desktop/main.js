const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage, systemPreferences, dialog, clipboard } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
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
let suppressActivateUntil = 0;
let suppressActivateDuringOverlayFlow = false;
let pasteTargetAppName = "";
let pasteTargetAppPid = 0;
let suppressMainWindowUntil = 0;
let overlayStopInFlight = false;
let pasteShortcutInFlight = false;
let lastTranscriptText = "";
let mainLogFilePath = "";

const HOST = "127.0.0.1";
const PORT = 8321;
const BASE_URL = `http://${HOST}:${PORT}`;
const LAST_TRANSCRIPT_FILE = "last_transcript.json";

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  ensureWindowVisible();
});

function appendMainLog(message) {
  try {
    if (!mainLogFilePath) {
      mainLogFilePath = path.join(app.getPath("userData"), "main.log");
    }
    fs.appendFileSync(mainLogFilePath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {}
}

async function shouldBlockMainWindowPresentation() {
  if (overlayStopInFlight) return true;
  if (Date.now() < suppressMainWindowUntil) return true;
  if (suppressActivateDuringOverlayFlow) return true;
  if (Date.now() < suppressActivateUntil) return true;
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) return true;
  try {
    return await isRendererRecording();
  } catch {
    return false;
  }
}

async function ensureWindowVisible() {
  if (await shouldBlockMainWindowPresentation()) return;
  if (Date.now() < suppressMainWindowUntil) return;
  if (!win || win.isDestroyed()) {
    await createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (backend === null) {
    await startBackend();
  }
  win.focus();
}

function getRepoRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "..");
}

function createOverlayHtml() {
  return `
  <html>
    <body style="margin:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;">
      <div id="pill">
        <canvas id="wave" width="56" height="20"></canvas>
        <span id="label">RECORDING</span>
        <span id="timer">00:00</span>
        <button id="stopBtn" aria-label="Stop recording" title="Stop recording"></button>
      </div>
      <style>
        #pill{
          width: fit-content;
          margin: 0 auto;
          margin-top: 6px;
          display:flex;
          align-items:center;
          justify-content:flex-start;
          gap:8px;
          padding:7px 9px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.18);
          background:linear-gradient(180deg,rgba(40,40,40,.97),rgba(24,24,24,.97));
          box-shadow:none;
          backdrop-filter:blur(8px) saturate(100%);
        }
        #wave{
          display:block;
          opacity:.95;
          width:66px;
          height:20px;
          flex:0 0 66px;
        }
        #label{
          font-size:9px;
          color:rgba(255,255,255,.86);
          letter-spacing:.14em;
          text-transform:uppercase;
          font-weight:700;
          line-height:1;
          white-space:nowrap;
          width:44px;
          text-align:center;
          flex:0 0 44px;
        }
        #timer{
          font-size:11px;
          font-weight:800;
          color:rgba(255,255,255,.96);
          font-family:Menlo,ui-monospace,monospace;
          min-width:42px;
          text-align:center;
          line-height:1;
          flex:0 0 42px;
        }
        #stopBtn{
          width:24px;
          height:24px;
          margin-left:0;
          border:1px solid rgba(255,255,255,.28);
          background:rgba(255,255,255,.1);
          border-radius:999px;
          padding:0;
          cursor:pointer;
          position:relative;
          flex:0 0 auto;
        }
        #stopBtn::before{
          content:"";
          position:absolute;
          left:50%;
          top:50%;
          width:8px;
          height:8px;
          transform:translate(-50%,-50%);
          border-radius:2px;
          background:rgba(255,255,255,.92);
        }
        #stopBtn:hover{background:rgba(255,255,255,.2)}
      </style>
      <script>
        let start = Date.now();
        const el = document.getElementById('timer');
        const cv = document.getElementById('wave');
        const ctx = cv.getContext('2d');
        const label = document.getElementById('label');
        const stopBtn = document.getElementById('stopBtn');
        let timerId = null;
        const bars = [];
        let lastLevelAt = 0;
        let activeWave = true;
        const bw = 3;
        const gap = 2;
        const maxBars = Math.floor(cv.width / (bw + gap));
        window.setLevel = (lv) => {
          const level = Math.max(0, Math.min(1, Number(lv) || 0));
          lastLevelAt = Date.now();
          bars.push(level);
          while (bars.length > maxBars) bars.shift();
          render();
        };
        window.resetWave = () => {
          bars.length = 0;
          lastLevelAt = 0;
          render();
        };
        window.setStatus = (s) => {
          const raw = String(s || '').trim().toLowerCase();
          activeWave = raw === 'starting' || raw === 'recording';
          const map = {
            'starting': 'REC',
            'recording': 'REC',
            'transcribing': 'TRS',
            'paste sent': 'OK',
            'paste failed': 'ERR',
            'saved to app': 'SAVE',
            'app loading': 'LOAD',
            'app not ready': 'WAIT',
            'no text': 'EMPTY'
          };
          label.textContent = (map[raw] || String(s || '').toUpperCase()).slice(0, 6);
        };
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
          timerId = setInterval(tick, 200);
        };
        window.stopTimer = () => {
          if (timerId) {
            clearInterval(timerId);
            timerId = null;
          }
        };
        const render = () => {
          ctx.clearRect(0, 0, cv.width, cv.height);
          for (let i = 0; i < bars.length; i++) {
            const v = bars[bars.length - 1 - i];
            const x = cv.width - (i + 1) * (bw + gap);
            if (x < 0) break;
            const h = Math.max(2, Math.min(cv.height - 2, v * (cv.height - 2)));
            const y = (cv.height - h) / 2;
            ctx.fillStyle = activeWave ? 'rgba(255,77,77,.85)' : 'rgba(170,170,170,.62)';
            ctx.fillRect(x, y, bw, h);
          }
        };
        const tick = () => {
          const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
          const mm = String(Math.floor(s / 60)).padStart(2, '0');
          const ss = String(s % 60).padStart(2, '0');
          el.textContent = mm + ':' + ss;
        };
        setInterval(() => {
          if (activeWave && Date.now() - lastLevelAt < 220) return;
          const idle = activeWave ? (0.08 + Math.random() * 0.12) : (0.03 + Math.random() * 0.03);
          bars.push(idle);
          while (bars.length > maxBars) bars.shift();
          render();
        }, 120);
        stopBtn.addEventListener('click', () => {
          document.title = '__overlay_stop__' + Date.now();
        });
        tick();
        window.startTimer();
      </script>
    </body>
  </html>`;
}

function ensureOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  overlayWin = new BrowserWindow({
    width: 274,
    height: 56,
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
  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.on("page-title-updated", (event, title) => {
    if (!String(title || "").startsWith("__overlay_stop__")) return;
    event.preventDefault();
    overlayStopInFlight = true;
    suppressActivateDuringOverlayFlow = true;
    suppressMainWindowUntil = Date.now() + 15000;
    if (win && !win.isDestroyed() && win.isVisible()) {
      try {
        win.hide();
      } catch {}
    }
    stopRecordingFromOverlay().catch((e) => {
      console.log("[overlay] stop failed:", e?.message || e);
      overlayStopInFlight = false;
      hideRecordingOverlay();
    });
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
  const y = Math.round(wa.y + wa.height - h - 10);
  overlayWin.setPosition(x, y, false);
}

async function showRecordingOverlay() {
  suppressActivateDuringOverlayFlow = true;
  pasteTargetAppName = "";
  pasteTargetAppPid = 0;
  const front = await getFrontmostAppInfo();
  if (front.name && !isBadActivationTarget(front.name)) {
    pasteTargetAppName = front.name;
    pasteTargetAppPid = front.pid;
  }
  const ow = ensureOverlayWindow();
  positionOverlayWindow();
  if (!overlayLoaded) {
    await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
    overlayLoaded = true;
  }
  try {
    await ow.webContents.executeJavaScript(
      `window.resetWave && window.resetWave(); window.resetTimer && window.resetTimer(); window.startTimer && window.startTimer(); window.setStatus && window.setStatus("Recording");`,
      true
    );
  } catch {}
  ow.showInactive();
  if (overlayWaveMonitor) {
    clearInterval(overlayWaveMonitor);
    overlayWaveMonitor = null;
  }
  overlayWaveMonitor = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
    if (!win || win.isDestroyed() || !win.webContents) return;
    win.webContents
      .executeJavaScript(
        `(() => { const lv = Number(window.__transcriptorVuLevel || 0); return Number.isFinite(lv) ? lv : 0; })();`,
        true
      )
      .then((lv) => {
        if (!overlayWin || overlayWin.isDestroyed()) return;
        overlayWin.webContents.executeJavaScript(`window.setLevel(${Math.max(0, Math.min(1, Number(lv) || 0))});`, true).catch(() => {});
      })
      .catch(() => {});
  }, 120);
}

async function ensureOverlayVisible(options = {}) {
  suppressActivateDuringOverlayFlow = true;
  const { resetTimer = false, startTimer = false, status = null } = options;
  const ow = ensureOverlayWindow();
  positionOverlayWindow();
  if (!overlayLoaded) {
    await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
    overlayLoaded = true;
  }
  const jsParts = [];
  if (resetTimer) jsParts.push("window.resetTimer && window.resetTimer();");
  if (startTimer) jsParts.push("window.startTimer && window.startTimer();");
  if (typeof status === "string") jsParts.push(`window.setStatus && window.setStatus(${JSON.stringify(status)});`);
  if (jsParts.length) {
    try {
      await ow.webContents.executeJavaScript(jsParts.join(" "), true);
    } catch {}
  }
  ow.showInactive();
}

async function setOverlayTimer(text) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  const value = String(text || "").trim();
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  try {
    await overlayWin.webContents.executeJavaScript(`window.setTimer && window.setTimer(${JSON.stringify(value)});`, true);
  } catch {}
}

function hideRecordingOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.hide();
  overlayStopInFlight = false;
  suppressActivateDuringOverlayFlow = false;
  if (overlayWaveMonitor) {
    clearInterval(overlayWaveMonitor);
    overlayWaveMonitor = null;
  }
}

async function setOverlayStatus(text) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  try {
    await overlayWin.webContents.executeJavaScript(
      `window.setStatus && window.setStatus(${JSON.stringify(String(text || ""))});`,
      true
    );
  } catch {}
}

async function isRendererRecording() {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  try {
    const recording = await win.webContents.executeJavaScript(
      `(() => { const b = document.getElementById('btnStop'); return !!(b && !b.disabled); })();`,
      true
    );
    return !!recording;
  } catch {
    return false;
  }
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
    } catch {}
    await sleep(120);
  }
  return false;
}

async function toggleRecordingFromShortcut() {
  if (shortcutToggleInFlight) return;
  shortcutToggleInFlight = true;
  try {
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    const front = await getFrontmostAppInfo();
    if (front.name && !isBadActivationTarget(front.name)) {
      pasteTargetAppName = front.name;
      pasteTargetAppPid = front.pid;
    }
    await ensureOverlayVisible({ status: "Starting", resetTimer: false, startTimer: false });
    await ensureBackgroundWindow();
    if (!win || win.isDestroyed() || !win.webContents) {
      await setOverlayStatus("App Not Ready");
      setTimeout(() => hideRecordingOverlay(), 1200);
      return;
    }

    const ready = await waitForRendererUiReady();
    if (!ready) {
      await setOverlayStatus("App Loading");
      setTimeout(() => hideRecordingOverlay(), 1300);
      return;
    }

    const result = await win.webContents.executeJavaScript(
      `
      (() => {
        const stopBtn = document.getElementById('btnStop');
        if (!stopBtn) return { ok: false, recording: false };
        const wasRecording = !stopBtn.disabled;
        const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
        const timerText = (document.getElementById('timer')?.textContent || '00:00').trim();
        window.dispatchEvent(new Event('transcriptor-hotkey-toggle'));
        return { ok: true, recording: !wasRecording, auto, timerText };
      })();
      `,
      true
    );

    if (!result?.ok) {
      await setOverlayStatus("App Loading");
      setTimeout(() => hideRecordingOverlay(), 1300);
      return;
    }

    if (result.recording) {
      await showRecordingOverlay();
      return;
    }

    await ensureOverlayVisible({ startTimer: false, resetTimer: false });
    if (result.timerText) {
      await setOverlayTimer(result.timerText);
    }
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => {});
    if (result.auto) {
      await setOverlayStatus("Transcribing");
      await handlePostStopFromShortcut(true);
    } else {
      await setOverlayStatus("Saved To App");
      setTimeout(() => hideRecordingOverlay(), 1400);
    }
  } finally {
    shortcutToggleInFlight = false;
  }
}

async function stopRecordingFromOverlay() {
  suppressActivateUntil = Date.now() + 2500;
  suppressMainWindowUntil = Date.now() + 10000;
  await ensureBackgroundWindow();
  if (!win || win.isDestroyed() || !win.webContents) return;
  if (win.isVisible()) win.hide();

  const result = await win.webContents.executeJavaScript(
    `
    (() => {
      const stopBtn = document.getElementById('btnStop');
      if (!stopBtn) return { ok: false, recording: false };
      const recording = !stopBtn.disabled;
      const timerText = (document.getElementById('timer')?.textContent || '00:00').trim();
      if (!recording) return { ok: false, recording, timerText };
      stopBtn.click();
      return { ok: true, recording: false, timerText };
    })();
    `,
    true
  );

  await ensureOverlayVisible({ startTimer: false, resetTimer: false });
  if (result?.timerText) {
    await setOverlayTimer(result.timerText);
  }
  await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => {});

  if (result?.ok) {
    await setOverlayStatus("Transcribing");
    await handlePostStopFromShortcut(true);
  } else {
    await setOverlayStatus("Saved To App");
    setTimeout(() => hideRecordingOverlay(), 1400);
  }
}

async function queryRendererState() {
  if (!win || win.isDestroyed() || !win.webContents) return null;
  try {
    return await win.webContents.executeJavaScript(
      `
      (() => {
        const status = (document.getElementById('statusText')?.textContent || '').trim();
        const finalText = (document.getElementById('finalOutput')?.textContent || '').trim();
        const liveText = (document.getElementById('liveOutput')?.textContent || '').trim();
        const busy = !!document.getElementById('btnStart')?.disabled;
        const progressVisible = document.getElementById('progressRow') ? !document.getElementById('progressRow').hidden : false;
        return { status, finalText, liveText, busy, progressVisible };
      })();
      `,
      true
    );
  } catch {
    return null;
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

function loadLastTranscriptFromDisk() {
  const p = getLastTranscriptPath();
  if (!p || !fs.existsSync(p)) return "";
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.text || "").trim();
  } catch {
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
  } catch {}
}

function escapeAppleScriptString(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

function looksLikeAutomationPermissionError(reason) {
  const r = String(reason || "").toLowerCase();
  return (
    r.includes("not authorized") ||
    r.includes("not permitted") ||
    r.includes("system events got an error") ||
    r.includes("-1743")
  );
}

function openPrivacyAccessibilitySettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
    timeoutMs: 5000
  }).catch(() => {});
}

function openPrivacyAutomationSettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], {
    timeoutMs: 5000
  }).catch(() => {});
}

async function getFrontmostAppName() {
  const res = await runCommand(
    "osascript",
    ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
    { timeoutMs: 5000 }
  );
  if (!res.ok) return "";
  return (res.stdout || "").trim();
}

async function getFrontmostAppInfo() {
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
  } catch {}
  if (!trusted) {
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch {}
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

async function tryPasteToFocusedField(text, targetAppName = "", targetAppPid = 0) {
  if (!text || !text.trim()) return { ok: false, reason: "empty-text" };
  const escaped = escapeAppleScriptString(text);
  const escapedApp = escapeAppleScriptString(targetAppName);
  const pid = Number.parseInt(String(targetAppPid || 0), 10) || 0;
  const axInsertScript = `
    set targetText to "${escaped}"
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      set p to missing value
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      else if targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if
      if p is missing value then
        set p to first process whose frontmost is true
      end if
      set frontmost of p to true
      delay 0.12
      set focusedElement to missing value
      try
        set focusedElement to value of attribute "AXFocusedUIElement" of p
      on error
        return "ERR:no-focus"
      end try
      try
        set value of attribute "AXSelectedText" of focusedElement to targetText
        return "OK:ax-selected-text"
      on error
      end try
      return "ERR:ax-failed"
    end tell
  `;
  const pasteScript = `
    set targetText to "${escaped}"
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
          set frontmost of p to true
          delay 0.20
          set the clipboard to targetText
          delay 0.12
          tell p
            keystroke "v" using {command down}
          end tell
          delay 0.16
          return "OK:paste-pid"
        end if
      else if targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
          tell p
            set frontmost to true
          end tell
          delay 0.20
          set the clipboard to targetText
          delay 0.12
          tell p
            keystroke "v" using {command down}
          end tell
          delay 0.16
          return "OK:paste-app"
        end if
      end if
      set the clipboard to targetText
      delay 0.18
      keystroke "v" using {command down}
      delay 0.18
      return "OK:paste"
    end tell
  `;
  const menuPasteScript = `
    set targetText to "${escaped}"
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      set p to missing value
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      else if targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if
      if p is missing value then
        return "ERR:no-process"
      end if
      set frontmost of p to true
      delay 0.18
      set the clipboard to targetText
      delay 0.12
      try
        click menu item "Paste" of menu "Edit" of menu bar item "Edit" of menu bar 1 of p
        delay 0.16
        return "OK:menu-paste"
      on error errMsg
        return "ERR:menu-paste:" & errMsg
      end try
    end tell
  `;
  const keycodePasteScript = `
    set targetText to "${escaped}"
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
          set frontmost of p to true
          delay 0.18
          set the clipboard to targetText
          delay 0.10
          tell p
            key code 9 using {command down}
          end tell
          delay 0.16
          return "OK:keycode-pid"
        end if
      else if targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
          tell p
            set frontmost to true
          end tell
          delay 0.18
          set the clipboard to targetText
          delay 0.10
          tell p
            key code 9 using {command down}
          end tell
          delay 0.16
          return "OK:keycode-app"
        end if
      end if
      set the clipboard to targetText
      delay 0.18
      key code 9 using {command down}
      delay 0.18
      return "OK:keycode"
    end tell
  `;

  let lastReason = "paste-no-attempt";
  const ax = await runCommand("osascript", ["-e", axInsertScript], { timeoutMs: 14000 });
  if (ax.ok) {
    const axOut = (ax.stdout || "").trim();
    if (axOut.startsWith("OK:")) return { ok: true, reason: axOut };
    lastReason = axOut || lastReason;
  } else {
    lastReason = (ax.stderr || ax.stdout || "ax-insert-failed").trim();
  }

  if (targetAppName || pid > 0) {
    const menuPaste = await runCommand("osascript", ["-e", menuPasteScript], { timeoutMs: 14000 });
    if (menuPaste.ok) {
      const menuOut = (menuPaste.stdout || "").trim();
      if (menuOut.startsWith("OK:")) return { ok: true, reason: menuOut };
      lastReason = menuOut || lastReason;
    } else {
      lastReason = (menuPaste.stderr || menuPaste.stdout || lastReason).trim();
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const check = await runCommand("osascript", ["-e", pasteScript], { timeoutMs: 14000 });
    if (check.ok) {
      const out = (check.stdout || "").trim();
      if (out.startsWith("OK:")) return { ok: true, reason: out };
      lastReason = out || "paste-return-unknown";
    } else {
      lastReason = (check.stderr || check.stdout || "osascript-failed").trim();
    }
    const check2 = await runCommand("osascript", ["-e", keycodePasteScript], { timeoutMs: 14000 });
    if (check2.ok) {
      const out2 = (check2.stdout || "").trim();
      if (out2.startsWith("OK:")) return { ok: true, reason: out2 };
      lastReason = out2 || lastReason;
    } else {
      lastReason = (check2.stderr || check2.stdout || lastReason).trim();
    }
    await sleep(100);
  }
  return { ok: false, reason: lastReason };
}

async function handlePostStopFromShortcut(autoTranscribe) {
  if (!autoTranscribe) return;
  const deadline = Date.now() + 120000;
  let transcript = "";
  while (Date.now() < deadline) {
    const s = await queryRendererState();
    if (!s) {
      await sleep(300);
      continue;
    }
    if (s.finalText && s.finalText.length > 0) {
      transcript = s.finalText;
    } else if (!transcript && s.liveText && s.liveText.length > 0) {
      transcript = s.liveText;
    }
    const doneLike = !s.busy && !s.progressVisible && (s.status === "Done" || s.status === "Error" || s.status === "Idle");
    if (doneLike) break;
    await sleep(320);
  }

  if (transcript) {
    lastTranscriptText = transcript;
    saveLastTranscriptToDisk(transcript);
    try {
      clipboard.writeText(transcript);
    } catch {}
    const pasted = await tryPasteToFocusedField(transcript, pasteTargetAppName, pasteTargetAppPid);
    appendMainLog(
      `[paste-auto] target="${pasteTargetAppName}" pid=${pasteTargetAppPid} ok=${pasted.ok} reason="${pasted.reason || ""}" len=${transcript.length}`
    );
    if (!pasted.ok) {
      console.log("[paste] not inserted:", pasted.reason || "unknown");
      if (looksLikeAutomationPermissionError(pasted.reason)) {
        openPrivacyAccessibilitySettings();
      }
    }
    await setOverlayStatus(pasted.ok ? "Paste Sent" : "Paste Failed");
  } else {
    await setOverlayStatus("Saved To App");
  }
  pasteTargetAppName = "";
  pasteTargetAppPid = 0;
  setTimeout(() => hideRecordingOverlay(), 1500);
}

async function getLatestTranscriptText() {
  const s = await queryRendererState();
  const current = String(s?.finalText || s?.liveText || "").trim();
  if (current) {
    lastTranscriptText = current;
    saveLastTranscriptToDisk(current);
    return current;
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
  pasteShortcutInFlight = true;
  try {
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    const front = await getFrontmostAppInfo();
    if (front.name && !isBadActivationTarget(front.name)) {
      pasteTargetAppName = front.name;
      pasteTargetAppPid = front.pid;
    }
    await ensureOverlayVisible({ status: "Pasting", resetTimer: false, startTimer: false });
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => {});

    const text = await getLatestTranscriptText();
    if (!text) {
      await setOverlayStatus("No Text");
      setTimeout(() => hideRecordingOverlay(), 1200);
      pasteTargetAppName = "";
      pasteTargetAppPid = 0;
      return;
    }
    try {
      clipboard.writeText(text);
    } catch {}

    const pasted = await tryPasteToFocusedField(text, pasteTargetAppName, pasteTargetAppPid);
    appendMainLog(
      `[paste-last] target="${pasteTargetAppName}" pid=${pasteTargetAppPid} ok=${pasted.ok} reason="${pasted.reason || ""}" len=${text.length}`
    );
    await setOverlayStatus(pasted.ok ? "Paste Sent" : "Paste Failed");
    if (!pasted.ok) {
      console.log("[paste-last] failed:", pasted.reason || "unknown");
    }
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    setTimeout(() => hideRecordingOverlay(), 1300);
  } finally {
    pasteShortcutInFlight = false;
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
  const candidates = [
    fromEnv,
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
      } catch {}
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

async function resolvePython(repoRoot) {
  const candidates = getPythonCandidates(repoRoot);
  for (const py of candidates) {
    const check = await runCommand(py, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot,
      timeoutMs: 8000
    });
    if (check.ok) {
      const resolved = (check.stdout || "").trim() || py;
      return resolved;
    }
  }
  return null;
}

async function ensureBackendRuntime(python, repoRoot) {
  const importCheck = await runCommand(
    python,
    ["-c", "import fastapi, uvicorn, multipart"],
    { cwd: repoRoot, timeoutMs: 12000 }
  );

  if (importCheck.ok) return { ok: true };

  const requirementsPath = path.join(repoRoot, "requirements.txt");
  if (!fs.existsSync(requirementsPath)) {
    return { ok: false, details: "requirements.txt not found in app resources" };
  }

  const install = await runCommand(
    python,
    ["-m", "pip", "install", "--user", "-r", requirementsPath],
    { cwd: repoRoot, timeoutMs: 300000 }
  );

  if (!install.ok) {
    return {
      ok: false,
      details: [
        "Python dependencies are missing and auto-install failed.",
        `python: ${python}`,
        (install.stderr || install.stdout || "").trim()
      ].join("\n")
    };
  }

  const recheck = await runCommand(
    python,
    ["-c", "import fastapi, uvicorn, multipart"],
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
  const repoRoot = getRepoRoot();
  const python = await resolvePython(repoRoot);

  if (!python) {
    backendBootError = "Python 3 interpreter was not found.";
    return;
  }

  const runtime = await ensureBackendRuntime(python, repoRoot);
  if (!runtime.ok) {
    backendBootError = runtime.details || "Backend runtime is unavailable.";
    return;
  }

  const args = [
    "-m", "uvicorn",
    "backend.main:app",
    "--host", HOST,
    "--port", String(PORT),
    "--log-level", "info"
  ];

  backend = spawn(python, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });

  backend.stdout.on("data", (d) => console.log("[backend stdout]", d.toString()));
  backend.stderr.on("data", (d) => console.log("[backend stderr]", d.toString()));

  backend.on("exit", (code) => {
    console.log("[backend] exited with code", code);
    appendMainLog(`[backend-exit] code=${code}`);
    backend = null;
  });

  backend.on("error", (err) => {
    backendBootError = err.message;
    console.log("[backend] spawn error:", err.message);
    appendMainLog(`[backend-error] ${err.message}`);
  });
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
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 960,
    minHeight: 680,
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

  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    const url = wc.getURL() || "";
    const trusted = url.startsWith(BASE_URL) || url.startsWith("about:blank");
    cb(trusted && permission === "media");
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    appendMainLog(`[render-process-gone] reason=${details?.reason || "unknown"} exitCode=${details?.exitCode ?? ""}`);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    appendMainLog(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
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
    isRendererRecording()
      .then((recording) => {
        if (!recording) return;
        try {
          win.hide();
        } catch {}
      })
      .catch(() => {});
  });

  win.on("closed", () => {
    win = null;
  });

  const url = `${BASE_URL}/`;
  try {
    await waitForHttp(`${BASE_URL}/api/health`, 20000);
    await win.loadURL(url);
    if (showWindow) {
      win.show();
      win.focus();
    }
  } catch (err) {
    const details = [
      err.message,
      backendBootError,
      `resources: ${getRepoRoot()}`
    ]
      .filter(Boolean)
      .join("\n\n");

    await win.loadURL(
      `data:text/html,${encodeURIComponent(`
      <html>
        <body style="background:#1a1a1a;color:#cfcfcf;font-family:-apple-system;padding:28px;line-height:1.5">
          <h2 style="margin:0 0 12px 0">Transcriptor backend startup error</h2>
          <pre style="white-space:pre-wrap;background:#111;padding:14px;border-radius:8px;border:1px solid #333">${escapeHtml(details)}</pre>
        </body>
      </html>
    `)}
    `
    );
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (await shouldBlockMainWindowPresentation()) return;
  ensureWindowVisible();
});

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
  hideRecordingOverlay();
  if (overlayWin && !overlayWin.isDestroyed()) {
    try {
      overlayWin.close();
    } catch {}
  }
  if (tray) {
    try {
      tray.destroy();
    } catch {}
    tray = null;
  }
  if (backend) {
    try {
      backend.kill();
    } catch {}
  }
});

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
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("●");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Transcriptor",
        click: () => {
          ensureWindowVisible();
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => app.quit()
      }
    ])
  );
  tray.on("click", () => ensureWindowVisible());
  const devKey = process.platform === "darwin" ? "Command+Shift+D" : "Control+Shift+D";
  const ok = globalShortcut.register(devKey, () => {
    if (!win?.webContents) return;
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    else win.webContents.openDevTools();
  });
  if (!ok) {
    console.log("[app] failed to register devtools shortcut");
  }

  const recordHotkey = process.platform === "darwin" ? "Alt+Left" : "Alt+Left";
  const hotkeyOk = globalShortcut.register(recordHotkey, () => {
    toggleRecordingFromShortcut().catch((e) => {
      console.log("[shortcut] toggle failed:", e?.message || e);
      hideRecordingOverlay();
    });
  });
  if (!hotkeyOk) {
    console.log("[app] failed to register recording shortcut:", recordHotkey);
  }
  const pasteLastHotkey = process.platform === "darwin" ? "Alt+Shift+7" : "Alt+Shift+7";
  const pasteLastHotkeyOk = globalShortcut.register(pasteLastHotkey, () => {
    pasteLatestTranscriptFromShortcut().catch((e) => {
      console.log("[shortcut] paste-last failed:", e?.message || e);
      hideRecordingOverlay();
    });
  });
  if (!pasteLastHotkeyOk) {
    console.log("[app] failed to register paste-last shortcut:", pasteLastHotkey);
  }

  await requestMacPastePermissionsOnce();
  await startBackend();
  await ensureWindowVisible();

  // Preload overlay once to avoid first-use delay after hotkey.
  try {
    const ow = ensureOverlayWindow();
    if (!overlayLoaded) {
      await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
      overlayLoaded = true;
    }
  } catch {}
});
