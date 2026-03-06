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
let suppressActivateUntil = 0;
let suppressActivateDuringOverlayFlow = false;
let pasteTargetAppName = "";
let pasteTargetAppPid = 0;
let suppressMainWindowUntil = 0;
let manualWindowRevealUntil = 0;
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
let overlayAutoStopYellowSince = 0;
let lastOverlayUiInteractionAt = 0;
let postStopQueue = [];
let postStopWorkerRunning = false;
let pendingTranscriptionCount = 0;
let backendRestartTimer = null;
let backendRestartAttempts = 0;
let micPermissionChecked = false;
const OVERLAY_FIXED_HEIGHT = 96;

const HOST = "127.0.0.1";
let PORT = 8321;
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
  } catch { }
}

function logPasteTrace(step, details = {}) {
  try {
    appendMainLog(`[paste-trace] ${JSON.stringify({ step, ...details })}`);
  } catch { }
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

function isMeaningfulTranscriptText(value) {
  const txt = String(value || "").trim();
  if (!txt) return false;
  const lower = txt.toLowerCase();
  if (lower === "error" || lower === "[websocket error]" || lower === "[silence]") return false;
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

async function shouldBlockMainWindowPresentation(options = {}) {
  const allowDuringRecording = !!options.allowDuringRecording;
  const force = !!options.force;
  if (overlayStopInFlight) return true;
  if (force) return false;
  if (!allowDuringRecording && Date.now() < suppressMainWindowUntil) return true;
  if (Date.now() < suppressActivateUntil) return true;
  if (!allowDuringRecording) {
    if (suppressActivateDuringOverlayFlow) return true;
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) return true;
  }
  if (allowDuringRecording) return false;
  try {
    return await isRendererRecording();
  } catch {
    return false;
  }
}

async function ensureWindowVisible(options = {}) {
  const manual = !!options.manual;
  const force = !!options.force;
  if (await shouldBlockMainWindowPresentation({ allowDuringRecording: manual, force })) return;
  if (!force && Date.now() < suppressMainWindowUntil) return;
  if (!win || win.isDestroyed()) {
    await createWindow();
    return;
  }
  if (manual) {
    manualWindowRevealUntil = Date.now() + 4000;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (backend === null) {
    await startBackend();
  }
  win.focus();
}

async function restoreFrontAppFocusAfterOverlayUi() {
  const targetPid = Number(pasteTargetAppPid || 0);
  if (!targetPid) return;
  try {
    await activateAppByPid(targetPid);
  } catch { }
}

function getRepoRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "..");
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
      `(() => { const p = document.getElementById('quickSettingsPanel'); return !!(p && !p.hidden); })();`,
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
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
}

async function setRendererUpscaleEnabledChoice(enabled) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = !!enabled;
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
}

async function setRendererQuickSettingsOpenChoice(open) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = !!open;
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
}

async function setRendererAutoSendEnterChoice(enabled) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const target = !!enabled;
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
}

async function setRendererProviderChoice(provider) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const normalized = normalizeProviderChoice(provider);
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
}

async function setRendererLocalModelChoice(model) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const normalized = normalizeLocalModelChoice(model);
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
}

async function setRendererModelChoice(provider, model) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const p = normalizeProviderChoice(provider);
  const target = String(model || "").trim();
  try {
    await win.webContents.executeJavaScript(
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
    );
  } catch { }
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
            <button id="quickSendEnterBtn" aria-label="Auto send after paste" title="Auto send after paste"></button>
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
          padding:${t.pill.padY}px 8px;
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
          height:34px;
          display:flex;
          align-items:center;
          justify-content:center;
          margin-bottom:2px;
        }
        #settingsPill{
          width:fit-content;
          min-height:22px;
          padding:6px 8px;
          border-radius:999px;
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
          align-items:center;
          gap:4px;
          max-width:230px;
          min-width:0;
          overflow:hidden;
          flex:0 0 auto;
        }
        #quickUpscaleCapsule{
          display:inline-flex;
          align-items:center;
          gap:6px;
          padding:0 5px 0 3px;
          height:22px;
          border-radius:999px;
          border:1px solid #3d2e52;
          background:#2a2234;
          color:#e0e0e0;
          white-space:nowrap;
          min-width:0;
          width:auto;
        }
        #quickUpscaleToggle{
          appearance:none;
          width:28px;
          height:16px;
          border-radius:999px;
          border:1px solid #333;
          background:#2a2a2a;
          position:relative;
          outline:none;
          cursor:pointer;
        }
        #quickUpscaleToggle::before{
          content:"";
          position:absolute;
          left:2px;
          top:2px;
          width:10px;
          height:10px;
          border-radius:999px;
          background:#d2d2d2;
          transition:transform .14s ease;
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
        #quickSendEnterBtn{
          appearance:none;
          border:1px solid #333;
          border-radius:999px;
          background:#2a2a2a;
          width:20px;
          height:20px;
          padding:0;
          position:relative;
          flex:0 0 20px;
          cursor:pointer;
        }
        #quickSendEnterBtn::before{
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
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M2 8H12' stroke='rgba(184,184,184,0.95)' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M8.9 4.8L12 8L8.9 11.2' stroke='rgba(184,184,184,0.95)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        }
        #quickSendEnterBtn.on{
          border-color:#4a8a5a;
          background:#2e5c3a;
        }
        #quickSendEnterBtn.on::before{
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M2 8H12' stroke='rgba(210,248,220,0.96)' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M8.9 4.8L12 8L8.9 11.2' stroke='rgba(210,248,220,0.96)' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        }
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
        const quickSendEnterBtn = document.getElementById('quickSendEnterBtn');
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
          if (waveMode === 'transcribing') return;
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
          quickSendEnterBtn.classList.toggle('on', on);
          quickSendEnterBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        gearBtn.addEventListener('click', () => {
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
        quickSendEnterBtn.addEventListener('click', () => {
          const next = !quickSendEnterBtn.classList.contains('on');
          window.setAutoSendEnabled(next);
          document.title = '__overlay_autosend__' + (next ? '1' : '0');
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
      suppressActivateDuringOverlayFlow = true;
      suppressMainWindowUntil = Date.now() + 15000;
      if (win && !win.isDestroyed() && win.isVisible()) {
        try {
          win.hide();
        } catch { }
      }
      stopRecordingFromOverlay().catch((e) => {
        console.log("[overlay] stop failed:", e?.message || e);
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
      suppressActivateUntil = Date.now() + 3000;
      suppressMainWindowUntil = Date.now() + 3000;
      if (win && !win.isDestroyed() && win.isVisible()) {
        try { win.hide(); } catch { }
      }
      void setRendererQuickSettingsOpenChoice(overlayQuickSettingsOpen);
      void restoreFrontAppFocusAfterOverlayUi();
      return;
    }
    if (raw.startsWith("__overlay_upscale_enabled__")) {
      const v = raw.endsWith("1");
      overlayQuickUpscaleEnabled = !!v;
      lastOverlayUiInteractionAt = Date.now();
      suppressActivateUntil = Date.now() + 3000;
      suppressMainWindowUntil = Date.now() + 3000;
      void setRendererUpscaleEnabledChoice(v);
      void restoreFrontAppFocusAfterOverlayUi();
      return;
    }
    if (raw.startsWith("__overlay_upscale__")) {
      const v = String(decodeURIComponent(raw.replace("__overlay_upscale__", "")) || "").trim();
      overlayQuickUpscalePreset = v;
      lastOverlayUiInteractionAt = Date.now();
      suppressActivateUntil = Date.now() + 3000;
      suppressMainWindowUntil = Date.now() + 3000;
      void setRendererUpscalePresetChoice(v);
      void restoreFrontAppFocusAfterOverlayUi();
      return;
    }
    if (raw.startsWith("__overlay_autosend__")) {
      const v = raw.endsWith("1");
      overlayQuickAutoSend = !!v;
      overlayQuickAutoSendInitialized = true;
      lastOverlayUiInteractionAt = Date.now();
      suppressActivateUntil = Date.now() + 3000;
      suppressMainWindowUntil = Date.now() + 3000;
      void setRendererAutoSendEnterChoice(v);
      void restoreFrontAppFocusAfterOverlayUi();
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
  try {
    overlayWin.setSize(getOverlayWindowWidth(), OVERLAY_FIXED_HEIGHT, false);
    positionOverlayWindow();
  } catch { }
}

async function syncOverlayQueueVisual(recordingHint = null) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  const isRec = typeof recordingHint === "boolean" ? recordingHint : await isRendererRecording();
  const showQueue = pendingTranscriptionCount > 0 && !!isRec;
  try {
    await overlayWin.webContents.executeJavaScript(
      `window.setQueueVisible && window.setQueueVisible(${showQueue ? "true" : "false"});`,
      true
    );
  } catch { }
}

async function showRecordingOverlay() {
  suppressActivateDuringOverlayFlow = true;
  // Preserve user's last quick-settings open/closed choice across runs.
  overlaySilenceStartedAt = 0;
  overlayAutoStopConfigRefreshAt = 0;
  overlayRecordingStartedAt = Date.now();
  overlaySeenAudioFrames = false;
  overlaySpeechRecoveryStartedAt = 0;
  overlayAutoStopYellowSince = 0;
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
    await ow.webContents.executeJavaScript(
      `window.setUpscaleEnabled && window.setUpscaleEnabled(${overlayQuickUpscaleEnabled ? "true" : "false"}); window.setUpscaleOptions && window.setUpscaleOptions(${JSON.stringify(upscaleCtx.presets)}, ${JSON.stringify(overlayQuickUpscalePreset)}); window.setUpscale && window.setUpscale(${JSON.stringify(overlayQuickUpscalePreset)}); window.setAutoSendEnabled && window.setAutoSendEnabled(${overlayQuickAutoSend ? "true" : "false"}); window.setQuickOpen && window.setQuickOpen(${overlayQuickSettingsOpen ? "true" : "false"}); ${hasQueuedTranscriptions ? "" : "window.resetWave && window.resetWave(); window.resetTimer && window.resetTimer(); window.startTimer && window.startTimer(); window.setStatus && window.setStatus('Recording');"}`,
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
          overlaySpeechRecoveryStartedAt = 0;
          overlayAutoStopYellowSince = 0;
          if (overlayAutoStopUiActive) {
            overlayAutoStopUiActive = false;
            overlayWin.webContents.executeJavaScript(`window.setStatus && window.setStatus("Recording");`, true).catch(() => { });
          }
        } else {
          const thresholdRms = Math.pow(10, Number(cfg.thresholdDb) / 20);
          const warmupMs = 1200;
          if (overlayRecordingStartedAt && (now - overlayRecordingStartedAt) < warmupMs) {
            overlaySilenceStartedAt = 0;
            overlaySpeechRecoveryStartedAt = 0;
            overlayAutoStopYellowSince = 0;
            if (overlayAutoStopUiActive) {
              overlayAutoStopUiActive = false;
              overlayWin.webContents.executeJavaScript(`window.setStatus && window.setStatus("Recording");`, true).catch(() => { });
            }
            overlayWin.webContents.executeJavaScript(
              `window.setLevel(${safeLevel}); window.setQueueLevel && window.setQueueLevel(${safeLevel});`,
              true
            ).catch(() => { });
            return;
          }
          const silentByDb = safeRms <= thresholdRms;
          const staleAudioFrames = overlaySeenAudioFrames && safeLastFrameAt > 0 && (now - safeLastFrameAt) > 1400;
          const consideredSilent = silentByDb || staleAudioFrames;
          if (!consideredSilent) {
            overlaySilenceStartedAt = 0;
            overlaySpeechRecoveryStartedAt = 0;
            overlayAutoStopYellowSince = 0;
            if (overlayAutoStopUiActive) {
              overlayAutoStopUiActive = false;
              overlayWin.webContents.executeJavaScript(`window.setStatus && window.setStatus("Recording");`, true).catch(() => { });
            }
          } else if (!overlaySilenceStartedAt) {
            overlaySilenceStartedAt = now;
            overlaySpeechRecoveryStartedAt = 0;
            overlayAutoStopYellowSince = 0;
          } else {
            overlaySpeechRecoveryStartedAt = 0;
            const silentElapsed = now - overlaySilenceStartedAt;
            const armYellowAfterMs = Number(cfg.seconds) * 1000;
            const yellowLeadMs = 500;
            if (!overlayAutoStopUiActive && silentElapsed >= armYellowAfterMs) {
              overlayAutoStopUiActive = true;
              overlayAutoStopYellowSince = now;
              overlayWin.webContents.executeJavaScript(`window.setStatus && window.setStatus("Auto stop");`, true).catch(() => { });
            }
            if (overlayAutoStopUiActive && overlayAutoStopYellowSince > 0 && (now - overlayAutoStopYellowSince) >= yellowLeadMs) {
            overlaySilenceStartedAt = 0;
            overlayAutoStopUiActive = false;
            overlaySpeechRecoveryStartedAt = 0;
            overlayAutoStopYellowSince = 0;
            overlayStopInFlight = true;
            appendMainLog(`[overlay-autostop] trigger level=${safeLevel.toFixed(4)} rms=${safeRms.toFixed(6)} lastFrameAge=${safeLastFrameAt ? (now - safeLastFrameAt) : -1} cfgSec=${Number(cfg.seconds)} cfgDb=${Number(cfg.thresholdDb)}`);
            stopRecordingFromOverlay().catch((e) => {
              appendMainLog(`[overlay-autostop-error] ${compactLogText(e?.message || e)}`);
              overlayStopInFlight = false;
              hideRecordingOverlay();
            });
            }
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
  suppressActivateDuringOverlayFlow = true;
  const { resetTimer = false, startTimer = false, status = null } = options;
  const ow = ensureOverlayWindow();
  positionOverlayWindow();
  if (!overlayLoaded) {
    await ow.loadURL(`data:text/html,${encodeURIComponent(createOverlayHtml())}`);
    overlayLoaded = true;
  }
  try {
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
  } catch { }
  try {
    applyOverlayWindowSize();
  } catch { }
  const jsParts = [];
  if (resetTimer) jsParts.push("window.resetTimer && window.resetTimer();");
  if (startTimer) jsParts.push("window.startTimer && window.startTimer();");
  if (typeof status === "string") jsParts.push(`window.setStatus && window.setStatus(${JSON.stringify(status)});`);
  if (jsParts.length) {
    try {
      await ow.webContents.executeJavaScript(jsParts.join(" "), true);
    } catch { }
  }
  await syncOverlayQueueVisual();
  ow.showInactive();
}

async function setOverlayTimer(text) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayLoaded) return;
  const value = String(text || "").trim();
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  try {
    await overlayWin.webContents.executeJavaScript(`window.setTimer && window.setTimer(${JSON.stringify(value)});`, true);
  } catch { }
}

function hideRecordingOverlay() {
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
  overlayAutoStopYellowSince = 0;
  overlayAutoStopUiActive = false;
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
  } catch { }
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
      `(() => { return !!(window.__transcriptorIsRecording); })();`,
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
    } catch { }
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
    await ensureOverlayVisible({ status: pendingTranscriptionCount > 0 ? null : "Starting", resetTimer: false, startTimer: false });
    traceStep(trace, "overlay_visible", { status: "Starting" });
    const micGranted = await requestMacMicrophonePermissionOnce();
    if (!micGranted) {
      traceStep(trace, "mic_permission_denied", {});
      await setOverlayStatus("Grant Access");
      setTimeout(() => hideRecordingOverlay(), 1200);
      traceEnd(trace, "failed", { reason: "mic-permission-denied" });
      return;
    }
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
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => { });
    if (result.auto) {
      traceStep(trace, "recording_stopped", { autoTranscribe: true, timerText: result.timerText || "" });
      await playOverlayCue("stop");
      await setOverlayStatus("Transcribing");
      enqueuePostStopTask({
        autoTranscribe: true,
        autoSendEnter: !!result.autoSendEnter,
        stopRequestedAt: Date.now(),
        recordingId: Number(result.recordingId || 0),
        targetName: pasteTargetAppName,
        targetPid: pasteTargetAppPid,
      });
      pasteTargetAppName = "";
      pasteTargetAppPid = 0;
      await syncOverlayQueueVisual(false);
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
      const isRec = !!(window.__transcriptorIsRecording);
      const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
      const timerText = (document.getElementById('timer')?.textContent || '00:00').trim();
      const autoSendEnter = !!(document.getElementById('autoSendEnterToggle') && document.getElementById('autoSendEnterToggle').classList.contains('active'));
      if (!isRec) return { ok: false, recording: false, timerText, recordingId, autoSendEnter };
      // Use dedicated stop event — avoids dual-path race with btnStop.click().
      window.dispatchEvent(new Event('transcriptor-hotkey-stop'));
      return { ok: true, recording: false, timerText, recordingId, autoSendEnter };
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
    await setOverlayStatus("Transcribing");
    enqueuePostStopTask({
      autoTranscribe: true,
      autoSendEnter: !!result.autoSendEnter,
      stopRequestedAt: Date.now(),
      recordingId: Number(result.recordingId || 0),
      targetName: pasteTargetAppName,
      targetPid: pasteTargetAppPid,
    });
    pasteTargetAppName = "";
    pasteTargetAppPid = 0;
    await syncOverlayQueueVisual(false);
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
  } catch { }
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
  }).catch(() => { });
}

function openPrivacyAutomationSettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], {
    timeoutMs: 5000
  }).catch(() => { });
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
  let savedClipboard = "";
  try {
    savedClipboard = clipboard.readText() || "";
  } catch { }
  try {
    clipboard.writeText(String(text));
  } catch {
    traceStep(trace, "clipboard_write_failed", {});
    logPasteTrace("clipboard_write_failed", {});
    traceEnd(trace, "failed", { reason: "clipboard-write-failed" });
    // Restore original clipboard.
    if (savedClipboard) { try { clipboard.writeText(savedClipboard); } catch { } }
    return { ok: false, reason: "clipboard-write-failed", method: "clipboard", verified: false };
  }
  traceStep(trace, "clipboard_write_ok", {});
  logPasteTrace("clipboard_write_ok", {});
  const escapedApp = escapeAppleScriptString(effectiveTargetName);
  const pid = Number.parseInt(String(effectiveTargetPid || 0), 10) || 0;
  const robustPasteScript = `
    set targetApp to "${escapedApp}"
    set targetPid to ${Math.trunc(pid)}
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
  // We simply invoke the robust layout-agnostic Cmd+V via AppleScript 'key code 9'.
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
          if (savedClipboard) { try { clipboard.writeText(savedClipboard); } catch { } }
        }, 1200);
        return { ok: true, reason: out, method: "robust_paste", verified: false };
      }
      if (out === "ERR:secure-field") {
        traceEnd(trace, "failed", { reason: "secure-field" });
        if (savedClipboard) { try { clipboard.writeText(savedClipboard); } catch { } }
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
        if (savedClipboard) { try { clipboard.writeText(savedClipboard); } catch { } }
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
  // BUG-5: Restore original clipboard if all paste methods failed.
  if (savedClipboard) {
    try { clipboard.writeText(savedClipboard); } catch { }
  }
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
      try {
        await processPostStopTask(task);
      } catch (e) {
        appendMainLog(`[post-stop-queue] task-error rec=${task.recordingId} err="${compactLogText(e?.message || e)}"`);
        await setOverlayStatus("Saved To App");
      }
      pendingTranscriptionCount = Math.max(0, pendingTranscriptionCount - 1);
      const isRec = await isRendererRecording();
      await syncOverlayQueueVisual(isRec);
      if (!isRec) {
        if (pendingTranscriptionCount > 0) {
          await setOverlayStatus("Transcribing");
        } else {
          setTimeout(() => hideRecordingOverlay(), 1400);
        }
      } else if (pendingTranscriptionCount === 0) {
        await overlayWin?.webContents.executeJavaScript(
          `window.setStatus && window.setStatus("Recording"); window.resetWave && window.resetWave(); window.resetTimer && window.resetTimer(); window.startTimer && window.startTimer();`,
          true
        ).catch(() => { });
      }
    }
  } finally {
    postStopWorkerRunning = false;
  }
}

async function processPostStopTask(task) {
  const trace = createTrace("post_stop", { autoTranscribe: !!task.autoTranscribe, queuePending: pendingTranscriptionCount });
  const deadline = Date.now() + 45000;
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
          return { finishedAt, finishedRecordingId, finishedText, finishedRecords, isRec, status, finalText, liveText, busy, progressVisible };
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
    const readyByRecording = !!byRecording || (task.recordingId > 0 && Number(state.finishedRecordingId || 0) === task.recordingId);
    const readyByTime = !!byTime || (task.recordingId <= 0 && state.finishedAt > stopRequestedAt);
    if (readyByRecording || readyByTime) {
      transcript = String(byRecording?.text || byTime?.text || state.finishedText || state.finalText || state.liveText || "").trim();
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
        finishedRecordingId: Number(byRecording?.recordingId || state.finishedRecordingId || 0),
        expectedRecordingId: task.recordingId || 0,
        delay: Number(byRecording?.finishedAt || byTime?.finishedAt || state.finishedAt || 0) - stopRequestedAt,
        textLen: transcript.length,
      });
      break;
    }
    const canUseUnscopedFinalText =
      !state.isRec &&
      !state.busy &&
      !state.progressVisible &&
      (statusLower === "done" || statusLower === "idle") &&
      !!(state.finalText && String(state.finalText).trim());
    if (canUseUnscopedFinalText) {
      transcript = String(state.finalText || "").trim();
      if (!isMeaningfulTranscriptText(transcript)) {
        transcript = "";
        await sleep(30);
        continue;
      }
      traceStep(trace, "final_text_fallback_ready", {
        pollCount,
        textLen: transcript.length,
        status: state.status || "",
        busy: !!state.busy,
        progressVisible: !!state.progressVisible,
      });
      break;
    }
    const canUseFinalTextFallback =
      !state.isRec &&
      !state.busy &&
      !state.progressVisible &&
      pollCount >= 3 &&
      !!(state.finalText && String(state.finalText).trim());
    if (canUseFinalTextFallback) {
      transcript = String(state.finalText || "").trim();
      if (!isMeaningfulTranscriptText(transcript)) {
        transcript = "";
        await sleep(30);
        continue;
      }
      traceStep(trace, "final_text_recording_fallback", {
        pollCount,
        textLen: transcript.length,
        status: state.status || "",
        expectedRecordingId: task.recordingId || 0,
      });
      break;
    }
    if (!transcript && state.liveText && state.liveText.length > 0) {
      transcript = state.liveText;
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

    let effectiveTargetName = task.targetName || "";
    let effectiveTargetPid = Number(task.targetPid || 0);
    try {
      const currentFront = await getFrontmostAppInfo();
      const currentName = String(currentFront.name || "").trim();
      const currentPid = Number(currentFront.pid || 0);
      if (effectiveTargetPid > 0 && currentPid > 0 && currentPid !== effectiveTargetPid) {
        const stillRunning = await activateAppByPid(effectiveTargetPid);
        if (!stillRunning && shouldUsePasteTarget(currentFront)) {
          traceStep(trace, "target_refreshed", {
            oldName: effectiveTargetName,
            oldPid: effectiveTargetPid,
            newName: currentName,
            newPid: currentPid,
          });
          effectiveTargetName = currentName;
          effectiveTargetPid = currentPid;
        }
      } else if (!effectiveTargetName && shouldUsePasteTarget(currentFront)) {
        effectiveTargetName = currentName;
        effectiveTargetPid = currentPid;
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
    await overlayWin?.webContents.executeJavaScript(`window.stopTimer && window.stopTimer();`, true).catch(() => { });

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

async function pickBackendPort(host, preferred = 8321) {
  const start = Number(preferred || 8321);
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

  const preferredPort = Number(process.env.TRANSCRIPTOR_PORT || 8321) || 8321;
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

  backend = spawn(python, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });

  backend.stdout.on("data", (d) => {
    const msg = d.toString();
    console.log("[backend stdout]", msg);
    appendMainLog(`[backend-stdout] ${compactLogText(msg, 1400)}`);
  });
  backend.stderr.on("data", (d) => {
    const msg = d.toString();
    console.log("[backend stderr]", msg);
    appendMainLog(`[backend-stderr] ${compactLogText(msg, 1400)}`);
  });

  backend.on("exit", (code) => {
    console.log("[backend] exited with code", code);
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
    width: 1240,
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
        if (Date.now() < manualWindowRevealUntil) return;
        try {
          win.hide();
        } catch { }
      })
      .catch(() => { });
  });

  win.on("closed", () => {
    win = null;
  });

  const url = `${BASE_URL}/`;
  try {
    if (!backend) {
      await startBackend();
    }
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
  // Allow explicit Dock/Menu activation even while recording/transcribing.
  ensureWindowVisible({ manual: true, force: true });
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
    } catch { }
  }
  if (tray) {
    try {
      tray.destroy();
    } catch { }
    tray = null;
  }
  if (backend) {
    try {
      backend.kill();
    } catch { }
  }
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
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
        ensureWindowVisible({ manual: true, force: true });
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
      console.log("[app] failed to register devtools shortcut");
    }
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
