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
let traceCounter = 0;

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

function logPasteTrace(step, details = {}) {
  try {
    appendMainLog(`[paste-trace] ${JSON.stringify({ step, ...details })}`);
  } catch {}
}

function compactLogText(value, max = 180) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
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
        <canvas id="wave" width="54" height="16"></canvas>
        <span id="timer">00:00</span>
        <span id="stateIcon" aria-hidden="true"></span>
      </div>
      <style>
        #pill{
          width: fit-content;
          margin: 0 auto;
          margin-top: 6px;
          display:flex;
          align-items:center;
          justify-content:flex-start;
          gap:9px;
          padding:6px 10px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.18);
          background:linear-gradient(180deg,rgba(40,40,40,.97),rgba(24,24,24,.97));
          box-shadow:none;
          backdrop-filter:blur(8px) saturate(100%);
        }
        #wave{
          display:block;
          opacity:.95;
          width:54px;
          height:16px;
          flex:0 0 54px;
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
        const stateIcon = document.getElementById('stateIcon');
        let timerId = null;
        let audioCtx = null;
        const bars = [];
        let lastLevelAt = 0;
        let activeWave = true;
        let waveMode = 'recording';
        const bw = 1.4;
        const gap = 1.0;
        const maxBars = Math.floor(cv.width / (bw + gap));
        window.setLevel = (lv) => {
          const raw = Math.max(0, Math.min(1, Number(lv) || 0));
          const level = Math.max(0, Math.min(1, Math.pow(raw, 0.72) * 1.45));
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
          waveMode = raw === 'transcribing' ? 'transcribing' : (activeWave ? 'recording' : 'idle');
          stateIcon.className = '';
          if (raw === 'starting' || raw === 'recording') {
            stateIcon.classList.add('rec');
          } else if (raw === 'transcribing') {
            stateIcon.classList.add('transcribing');
          } else if (raw === 'paste sent') {
            stateIcon.classList.add('ok');
          } else if (raw === 'paste failed' || raw === 'grant access' || raw === 'secure field' || raw === 'no text focus' || raw === 'clipboard error') {
            stateIcon.classList.add('fail');
          } else {
            stateIcon.classList.add('fail');
          }
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
            const dur = kind === 'stop' ? 0.09 : 0.075;
            const base = kind === 'stop' ? 560 : 760;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(base, now);
            osc.frequency.exponentialRampToValueAtTime(kind === 'stop' ? 420 : 980, now + dur);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(kind === 'stop' ? 0.055 : 0.04, now + 0.012);
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
          ctx.clearRect(0, 0, cv.width, cv.height);
          for (let i = 0; i < bars.length; i++) {
            const v = bars[bars.length - 1 - i];
            const x = cv.width - (i + 1) * (bw + gap);
            if (x < 0) break;
            const h = Math.max(2, Math.min(cv.height - 2, v * (cv.height - 2)));
            const y = (cv.height - h) / 2;
            if (waveMode === 'recording') {
              ctx.fillStyle = 'rgba(255,77,77,.88)';
            } else if (waveMode === 'transcribing') {
              ctx.fillStyle = 'rgba(114,174,255,.92)';
            } else {
              ctx.fillStyle = 'rgba(170,170,170,.62)';
            }
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
          const idle = activeWave
            ? (0.08 + Math.random() * 0.12)
            : (waveMode === 'transcribing' ? (0.07 + Math.random() * 0.11) : (0.03 + Math.random() * 0.03));
          bars.push(idle);
          while (bars.length > maxBars) bars.shift();
          render();
        }, 120);
        tick();
        window.startTimer();
      </script>
    </body>
  </html>`;
}

function ensureOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  overlayWin = new BrowserWindow({
    width: 228,
    height: 47,
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
  try {
    await ow.webContents.executeJavaScript(
      `window.resetWave && window.resetWave(); window.resetTimer && window.resetTimer(); window.startTimer && window.startTimer(); window.setStatus && window.setStatus("Recording");`,
      true
    );
  } catch {}
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
  const trace = createTrace("toggle_hotkey", {});
  shortcutToggleInFlight = true;
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
    await ensureOverlayVisible({ status: "Starting", resetTimer: false, startTimer: false });
    traceStep(trace, "overlay_visible", { status: "Starting" });
    await ensureBackgroundWindow();
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "app_not_ready", {});
      await setOverlayStatus("App Not Ready");
      setTimeout(() => hideRecordingOverlay(), 1200);
      traceEnd(trace, "failed", { reason: "window-not-ready" });
      return;
    }

    const ready = await waitForRendererUiReady();
    traceStep(trace, "renderer_ready_check", { ready: !!ready });
    if (!ready) {
      await setOverlayStatus("App Loading");
      setTimeout(() => hideRecordingOverlay(), 1300);
      traceEnd(trace, "failed", { reason: "renderer-not-ready" });
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
      traceStep(trace, "renderer_toggle_failed", { result: result || null });
      await setOverlayStatus("App Loading");
      setTimeout(() => hideRecordingOverlay(), 1300);
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
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => {});
    if (result.auto) {
      traceStep(trace, "recording_stopped", { autoTranscribe: true, timerText: result.timerText || "" });
      await playOverlayCue("stop");
      await setOverlayStatus("Transcribing");
      await handlePostStopFromShortcut(true);
    } else {
      traceStep(trace, "recording_stopped", { autoTranscribe: false, timerText: result.timerText || "" });
      await playOverlayCue("stop");
      await setOverlayStatus("Saved To App");
      setTimeout(() => hideRecordingOverlay(), 1400);
    }
    traceEnd(trace, "done", {});
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
    await playOverlayCue("stop");
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
  if (r.includes("no-accessibility")) return "Grant Access";
  if (r.includes("secure-field")) return "Secure Field";
  if (r.includes("no-focus") || r.includes("not-editable") || r.includes("ax-failed")) return "No Text Focus";
  if (r.includes("clipboard")) return "Clipboard Error";
  if (looksLikeAutomationPermissionError(r)) return "Grant Access";
  return "Paste Failed";
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
  } catch {}
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
  const preferTypedFirst =
    targetHint.includes("codex") ||
    targetHint.includes("obsidian") ||
    targetHint.includes("chatgpt") ||
    genericElectronTarget;
  traceStep(trace, "paste_strategy", { preferTypedFirst, targetHint: compactLogText(targetHint, 80) });
  logPasteTrace("start", {
    targetAppName: effectiveTargetName,
    targetAppPid: effectiveTargetPid,
    frontBeforeName: frontBefore.name || "",
    frontBeforePid: frontBefore.pid || 0,
    textLen: String(text).length,
  });
  try {
    clipboard.writeText(String(text));
  } catch {
    traceStep(trace, "clipboard_write_failed", {});
    logPasteTrace("clipboard_write_failed", {});
    traceEnd(trace, "failed", { reason: "clipboard-write-failed" });
    return { ok: false, reason: "clipboard-write-failed", method: "clipboard", verified: false };
  }
  traceStep(trace, "clipboard_write_ok", {});
  logPasteTrace("clipboard_write_ok", {});
  const escapedApp = escapeAppleScriptString(effectiveTargetName);
  const pid = Number.parseInt(String(effectiveTargetPid || 0), 10) || 0;
  const axInsertScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set targetText to ""
      try
        set targetText to the clipboard as text
      on error
        return "ERR:clipboard-read"
      end try
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
      set roleName to ""
      set subroleName to ""
      try
        set roleName to role of focusedElement
      end try
      try
        set subroleName to subrole of focusedElement
      end try
      if roleName is "AXSecureTextField" or subroleName is "AXSecureTextField" then
        return "ERR:secure-field"
      end if
      try
        set value of attribute "AXSelectedText" of focusedElement to targetText
        return "OK:ax-selected-text"
      on error
      end try
      return "ERR:ax-failed"
    end tell
  `;
  const pasteScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set targetText to ""
      try
        set targetText to the clipboard as text
      on error
        return "ERR:clipboard-read"
      end try
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
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set targetText to ""
      try
        set targetText to the clipboard as text
      on error
        return "ERR:clipboard-read"
      end try
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
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set targetText to ""
      try
        set targetText to the clipboard as text
      on error
        return "ERR:clipboard-read"
      end try
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
  const typedInsertScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set targetText to ""
      try
        set targetText to the clipboard as text
      on error
        return "ERR:clipboard-read"
      end try
      if targetText is "" then return "ERR:empty-text"
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
          set frontmost of p to true
          delay 0.18
          tell p to keystroke targetText
          delay 0.12
          return "OK:typed-pid"
        end if
      else if targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
          tell p to set frontmost to true
          delay 0.18
          tell p to keystroke targetText
          delay 0.12
          return "OK:typed-app"
        end if
      end if
      keystroke targetText
      delay 0.12
      return "OK:typed"
    end tell
  `;

  const runTypedInsert = async (stageLabel = "typed") => {
    if (String(text).length > 1800) {
      traceStep(trace, "method_skipped", {
        method: stageLabel,
        reason: "text-too-long",
        len: String(text).length,
        limit: 1800,
      });
      return null;
    }
    traceStep(trace, "method_begin", { method: stageLabel, len: String(text).length });
    const typedStarted = Date.now();
    const typedInsert = await runCommand("osascript", ["-e", typedInsertScript], { timeoutMs: 14000 });
    traceStep(trace, "method_result", {
      method: stageLabel,
      ms: Date.now() - typedStarted,
      ok: !!typedInsert.ok,
      code: typedInsert.code,
      stdout: compactLogText(typedInsert.stdout),
      stderr: compactLogText(typedInsert.stderr),
    });
    logPasteTrace("typed_result", {
      stage: stageLabel,
      ok: !!typedInsert.ok,
      code: typedInsert.code,
      stdout: compactLogText(typedInsert.stdout),
      stderr: compactLogText(typedInsert.stderr),
    });
    if (typedInsert.ok) {
      const typedOut = (typedInsert.stdout || "").trim();
      if (typedOut.startsWith("OK:")) {
        logPasteTrace("success", { method: stageLabel, reason: typedOut, verified: false });
        traceEnd(trace, "success", { method: stageLabel, reason: typedOut, verified: false });
        return { ok: true, reason: typedOut, method: "typed", verified: false };
      }
      lastReason = typedOut || lastReason;
      return null;
    }
    lastReason = (typedInsert.stderr || typedInsert.stdout || lastReason).trim();
    return null;
  };

  let lastReason = "paste-no-attempt";
  traceStep(trace, "method_begin", { method: "ax" });
  const axStarted = Date.now();
  const ax = await runCommand("osascript", ["-e", axInsertScript], { timeoutMs: 14000 });
  traceStep(trace, "method_result", {
    method: "ax",
    ms: Date.now() - axStarted,
    ok: !!ax.ok,
    code: ax.code,
    stdout: compactLogText(ax.stdout),
    stderr: compactLogText(ax.stderr),
  });
  logPasteTrace("ax_result", {
    ok: !!ax.ok,
    code: ax.code,
    stdout: compactLogText(ax.stdout),
    stderr: compactLogText(ax.stderr),
  });
  if (ax.ok) {
    const axOut = (ax.stdout || "").trim();
    if (axOut.startsWith("OK:")) {
      logPasteTrace("success", { method: "ax", reason: axOut });
      traceEnd(trace, "success", { method: "ax", reason: axOut, verified: true });
      return { ok: true, reason: axOut, method: "ax", verified: true };
    }
    lastReason = axOut || lastReason;
  } else {
    lastReason = (ax.stderr || ax.stdout || "ax-insert-failed").trim();
  }

  if (preferTypedFirst) {
    const typedPreferred = await runTypedInsert("typed_preferred");
    if (typedPreferred) return typedPreferred;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    logPasteTrace("fallback_attempt", { attempt: attempt + 1, method: "cmd_v_then_keycode" });
    traceStep(trace, "method_begin", { method: "cmd_v", attempt: attempt + 1 });
    const cmdStarted = Date.now();
    const check = await runCommand("osascript", ["-e", pasteScript], { timeoutMs: 14000 });
    traceStep(trace, "method_result", {
      method: "cmd_v",
      attempt: attempt + 1,
      ms: Date.now() - cmdStarted,
      ok: !!check.ok,
      code: check.code,
      stdout: compactLogText(check.stdout),
      stderr: compactLogText(check.stderr),
    });
    logPasteTrace("cmdv_result", {
      attempt: attempt + 1,
      ok: !!check.ok,
      code: check.code,
      stdout: compactLogText(check.stdout),
      stderr: compactLogText(check.stderr),
    });
    if (check.ok) {
      const out = (check.stdout || "").trim();
      if (out.startsWith("OK:")) {
        logPasteTrace("success", { method: "cmd_v", attempt: attempt + 1, reason: out });
        traceEnd(trace, "success", { method: "cmd_v", attempt: attempt + 1, reason: out, verified: false });
        return { ok: true, reason: out, method: "cmd_v", verified: false };
      }
      lastReason = out || "paste-return-unknown";
    } else {
      lastReason = (check.stderr || check.stdout || "osascript-failed").trim();
    }
    traceStep(trace, "method_begin", { method: "keycode", attempt: attempt + 1 });
    const keyStarted = Date.now();
    const check2 = await runCommand("osascript", ["-e", keycodePasteScript], { timeoutMs: 14000 });
    traceStep(trace, "method_result", {
      method: "keycode",
      attempt: attempt + 1,
      ms: Date.now() - keyStarted,
      ok: !!check2.ok,
      code: check2.code,
      stdout: compactLogText(check2.stdout),
      stderr: compactLogText(check2.stderr),
    });
    logPasteTrace("keycode_result", {
      attempt: attempt + 1,
      ok: !!check2.ok,
      code: check2.code,
      stdout: compactLogText(check2.stdout),
      stderr: compactLogText(check2.stderr),
    });
    if (check2.ok) {
      const out2 = (check2.stdout || "").trim();
      if (out2.startsWith("OK:")) {
        logPasteTrace("success", { method: "keycode", attempt: attempt + 1, reason: out2 });
        traceEnd(trace, "success", { method: "keycode", attempt: attempt + 1, reason: out2, verified: false });
        return { ok: true, reason: out2, method: "keycode", verified: false };
      }
      lastReason = out2 || lastReason;
    } else {
      lastReason = (check2.stderr || check2.stdout || lastReason).trim();
    }
    await sleep(100);
  }

  if (targetAppName || pid > 0) {
    traceStep(trace, "method_begin", { method: "menu" });
    const menuStarted = Date.now();
    const menuPaste = await runCommand("osascript", ["-e", menuPasteScript], { timeoutMs: 14000 });
    traceStep(trace, "method_result", {
      method: "menu",
      ms: Date.now() - menuStarted,
      ok: !!menuPaste.ok,
      code: menuPaste.code,
      stdout: compactLogText(menuPaste.stdout),
      stderr: compactLogText(menuPaste.stderr),
    });
    logPasteTrace("menu_result", {
      ok: !!menuPaste.ok,
      code: menuPaste.code,
      stdout: compactLogText(menuPaste.stdout),
      stderr: compactLogText(menuPaste.stderr),
    });
    if (menuPaste.ok) {
      const menuOut = (menuPaste.stdout || "").trim();
      if (menuOut.startsWith("OK:")) {
        logPasteTrace("success", { method: "menu", reason: menuOut, verified: false });
        traceEnd(trace, "success", { method: "menu", reason: menuOut, verified: false });
        return { ok: true, reason: menuOut, method: "menu", verified: false };
      }
      lastReason = menuOut || lastReason;
    } else {
      lastReason = (menuPaste.stderr || menuPaste.stdout || lastReason).trim();
    }
  }

  const typedFallback = await runTypedInsert("typed_fallback");
  if (typedFallback) return typedFallback;
  let frontAfter = { name: "", pid: 0 };
  try {
    frontAfter = await getFrontmostAppInfo();
  } catch {}
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
  return { ok: false, reason: lastReason, method: "failed", verified: false };
}

async function handlePostStopFromShortcut(autoTranscribe) {
  const trace = createTrace("post_stop", { autoTranscribe: !!autoTranscribe });
  if (!autoTranscribe) {
    traceEnd(trace, "skipped", { reason: "autoTranscribe-disabled" });
    return;
  }
  const deadline = Date.now() + 120000;
  let transcript = "";
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount += 1;
    const s = await queryRendererState();
    if (!s) {
      traceStep(trace, "poll_empty_state", { pollCount });
      await sleep(300);
      continue;
    }
    if (s.finalText && s.finalText.length > 0) {
      transcript = s.finalText;
    } else if (!transcript && s.liveText && s.liveText.length > 0) {
      transcript = s.liveText;
    }
    const doneLike = !s.busy && !s.progressVisible && (s.status === "Done" || s.status === "Error" || s.status === "Idle");
    traceStep(trace, "poll_state", {
      pollCount,
      status: s.status || "",
      busy: !!s.busy,
      progressVisible: !!s.progressVisible,
      finalLen: String(s.finalText || "").length,
      liveLen: String(s.liveText || "").length,
      doneLike,
    });
    if (doneLike) break;
    await sleep(320);
  }

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
    } catch {}
    const pasted = await tryPasteToFocusedField(transcript, pasteTargetAppName, pasteTargetAppPid);
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-auto] target="${pasteTargetAppName}" pid=${pasteTargetAppPid} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${transcript.length}`
    );
    if (!pasted.ok) {
      console.log("[paste] not inserted:", pasted.reason || "unknown");
      if (looksLikeAutomationPermissionError(pasted.reason)) {
        openPrivacyAccessibilitySettings();
      }
    }
    await setOverlayStatus(pasted.ok ? "Paste Sent" : overlayStatusForPasteFailure(pasted.reason));
  } else {
    traceStep(trace, "transcript_missing", { reason: "no-final-or-live-text-before-deadline" });
    await setOverlayStatus("Saved To App");
  }
  pasteTargetAppName = "";
  pasteTargetAppPid = 0;
  setTimeout(() => hideRecordingOverlay(), 1500);
  traceEnd(trace, "done", { transcriptFound: !!transcript, pollCount });
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
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => {});

    const text = await getLatestTranscriptText();
    if (!text) {
      traceStep(trace, "no_text_available", {});
      await setOverlayStatus("No Text");
      setTimeout(() => hideRecordingOverlay(), 1200);
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
    } catch {}

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
      console.log("[paste-last] failed:", pasted.reason || "unknown");
    }
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    setTimeout(() => hideRecordingOverlay(), 1300);
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
  const trayMenu = Menu.buildFromTemplate([
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
  ]);
  tray.on("click", (event) => {
    // macOS: Ctrl+left-click should behave as right-click.
    if (event?.ctrlKey) {
      tray?.popUpContextMenu(trayMenu);
      return;
    }
    ensureWindowVisible();
  });
  tray.on("right-click", () => {
    tray?.popUpContextMenu(trayMenu);
  });
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
