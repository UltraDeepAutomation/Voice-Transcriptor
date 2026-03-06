import "./styles.css";

type Provider = "local" | "openrouter" | "deepgram" | "";
type JobStatus = "queued" | "running" | "done" | "error";

interface JobResultPayload {
  text?: string;
  [key: string]: unknown;
}

interface JobResponse {
  job_id: string;
  status: JobStatus;
  progress: number;
  error: string | null;
  result: JobResultPayload | null;
  result_files: Record<string, string> | null;
}

interface NetworkStatusResponse {
  online: boolean;
  latency_ms: number | null;
  backend_ok?: boolean;
}

interface AppConfig {
  providers?: {
    openrouter?: { key?: string };
    deepgram?: { key?: string };
  };
  _meta?: {
    config_path?: string;
  };
  preferences?: {
    remote_provider?: string;
    recordings_dir?: string;
    openrouter?: { model?: string };
    ui?: {
      mode?: string;
      provider?: string;
      language?: string;
      local_model?: string;
      mic_id?: string;
      auto_transcribe?: boolean;
      live_preview?: boolean;
      quick_settings_open?: boolean;
      upscale_enabled?: boolean;
      upscale_preset?: string;
      auto_send_enter?: boolean;
      auto_stop_silence_enabled?: boolean;
      auto_stop_silence_seconds?: number;
      auto_stop_silence_db?: number;
    };
  };
}

interface RecordingItem {
  name: string;
  display_name: string;
  modified_at: string;
  size_bytes: number;
}

interface RecordingsStats {
  total_recordings: number;
  total_words: number;
  total_chars: number;
  avg_words_per_recording: number;
  avg_chars_per_recording: number;
  avg_duration_sec: number;
  min_duration_sec: number;
  max_duration_sec: number;
  top_words: Array<{ word: string; count: number }>;
  providers: Array<{ name: string; count: number }>;
  languages: Array<{ name: string; count: number }>;
}

interface UpscalePresetItem {
  id: string;
  name: string;
  builtin: boolean;
  instruction?: string;
  default_instruction?: string;
}

interface FinishedRecordingEntry {
  recordingId: number;
  finishedAt: number;
  text: string;
}

declare global {
  interface Window {
    __TRANSCRIPTOR_API_TOKEN?: string;
    __transcriptorVuLevel?: number;
    __transcriptorRmsLevel?: number;
    __transcriptorLastFrameAt?: number;
    __transcriptorIsRecording?: boolean;
    __transcriptorLastFinishedText?: string;
    __transcriptorLastFinishedAt?: number;
    __transcriptorCurrentRecordingId?: number;
    __transcriptorLastFinishedRecordingId?: number;
    __transcriptorFinishedRecords?: FinishedRecordingEntry[];
    __transcriptorSetQuickSettingsOpen?: (open: boolean) => boolean;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
};

const fmtTime = (s: number): string => {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};
const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "-";
  return d.toLocaleString();
};
const fmtDur = (sec: number): string => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const fmtMs = (ms: number): string => {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
};

const wsBase = (): string => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_JOB_WAIT_MS = 45 * 60 * 1000;
const AUDIO_TOKENS = {
  liveSampleRateHz: 16_000,
  compactSampleRateHz: 8_000,
} as const;
const UI_TOKENS = {
  polling: {
    initialWaitMs: 180,
    maxWaitMs: 700,
    growth: 1.16,
    fastInitialWaitMs: 50,
    fastMaxWaitMs: 180,
    fastGrowth: 1.06,
    remoteChunkSettleWaitMs: 200,
    remoteChunkSettleTimeoutMs: 8_000,
  },
  draft: {
    autosaveIntervalMs: 1_200,
  },
  timer: {
    tickMs: 200,
  },
  network: {
    refreshIntervalMs: 10_000,
  },
  settings: {
    saveDebounceMs: 260,
  },
  capture: {
    fallbackInitDelayMs: 1_300,
    chunkIntervalMs: 8_000,
    chunkMinNewSamples: AUDIO_TOKENS.liveSampleRateHz, // 1 sec @ live sample rate
    tailMinSamples: Math.floor(AUDIO_TOKENS.liveSampleRateHz / 10), // 0.1 sec @ live sample rate
    vuAmplify: 4,
    waveformMixRms: 6.6,
    waveformMixPeak: 0.45,
  },
  drain: {
    maxWaitMs: 180,
    idleMs: 45,
    pollStepMs: 24,
  },
} as const;
const ALLOWED_AUDIO_MIME = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
]);
const ALLOWED_AUDIO_EXT = new Set(["wav", "mp3", "m4a", "flac", "ogg", "aac", "mp4", "webm"]);
const LIVE_DRAFT_KEY = "transcriptor.liveDraft.v1";
const OPENROUTER_AUDIO_MODELS = [
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-2.5-flash",
  "openai/gpt-4o-audio-preview",
];

let isBusy = false;
let isRecording = false;
let isNetworkOnline = true;
let hasOpenrouterKey = false;
let hasDeepgramKey = false;
let selectedFile: File | null = null;
let pollAbortController: AbortController | null = null;
let uiPrefSaveTimer: number | null = null;
let suppressUiPrefAutosave = false;
let preferredMicId = "";
let upscalePresets: UpscalePresetItem[] = [];
let pendingUpscalePresetId = "";
let silenceStartedAtMs = 0;
let autoStopTriggered = false;

const apiToken = (): string => {
  const token = (window.__TRANSCRIPTOR_API_TOKEN || "").trim();
  if (!token) {
    throw new Error("API token is missing. Restart app.");
  }
  return token;
};

const authHeaders = (): HeadersInit => ({ "X-Api-Token": apiToken() });

function setBusy(nextBusy: boolean): void {
  isBusy = !!nextBusy;
  ["btnStart", "btnStop", "btnTranscribeFile", "pickFileBtn", "mode", "providerSelect", "remoteModelSelect", "quickProviderSelect", "quickSettingsToggle", "upscaleToggle", "upscalePresetSelect", "upscalePresetAddBtn", "upscalePresetDeleteBtn", "upscalePresetSaveBtn", "upscalePresetCancelBtn"].forEach((id) => {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null;
    if (el) el.disabled = isBusy;
  });
}

function setRecordButton(recording: boolean): void {
  const b = $("btnStart") as HTMLButtonElement;
  b.classList.toggle("recording", recording);
  b.setAttribute("aria-label", recording ? "Stop recording" : "Start recording");
}

function setStatus(st: string): void {
  $("statusText").textContent = st;
  const dot = $("statusDot");
  dot.className =
    "status-dot" + (st === "Recording" ? " rec" : st === "Processing" ? " process" : st === "Done" ? " done" : "");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getAutoStopSilenceConfig(): { enabled: boolean; seconds: number; thresholdDb: number } {
  const enabled = !!($("autoStopSilenceEnabled") as HTMLInputElement).checked;
  const secondsRaw = Number(($("autoStopSilenceSeconds") as HTMLInputElement).value);
  const thresholdRaw = Number(($("autoStopSilenceDb") as HTMLInputElement).value);
  const seconds = clampNumber(Number.isFinite(secondsRaw) ? Math.round(secondsRaw) : 2, 1, 120);
  const thresholdDb = clampNumber(Number.isFinite(thresholdRaw) ? Math.round(thresholdRaw) : -42, -80, -10);
  return { enabled, seconds, thresholdDb };
}

function evaluateSilenceAutoStop(rms: number): void {
  if (!isRecording || autoStopTriggered) return;
  const cfg = getAutoStopSilenceConfig();
  if (!cfg.enabled) {
    silenceStartedAtMs = 0;
    return;
  }
  const dbfs = rms > 1e-8 ? 20 * Math.log10(rms) : -96;
  if (dbfs >= cfg.thresholdDb) {
    silenceStartedAtMs = 0;
    return;
  }
  const now = Date.now();
  if (!silenceStartedAtMs) {
    silenceStartedAtMs = now;
    return;
  }
  if (now - silenceStartedAtMs < cfg.seconds * 1000) return;
  autoStopTriggered = true;
  setStatus("Auto stop");
  window.setTimeout(() => {
    if (isRecording) void stopLive(shouldAutoTranscribe());
  }, 0);
}

async function parseError(r: Response): Promise<string> {
  let details = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`;
  try {
    const j: unknown = await r.json();
    if (typeof j === "object" && j && "detail" in j) {
      const detail = (j as { detail?: unknown }).detail;
      const raw = typeof detail === "string" ? detail : JSON.stringify(j);
      details = `${details}: ${raw}`;
    } else {
      details = `${details}: ${JSON.stringify(j)}`;
    }
  } catch {
    try {
      const txt = await r.text();
      if (txt && txt.trim()) details = `${details}: ${txt.trim()}`;
    } catch { }
  }
  return details || `HTTP ${r.status}`;
}

async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { headers: authHeaders(), signal });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

async function apiPut<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as T;
}

function downsample(buf: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate === inRate) return new Float32Array(buf);
  const r = inRate / outRate;
  const out = new Float32Array(Math.round(buf.length / r));
  let off = 0;
  for (let i = 0; i < out.length; i++) {
    const next = Math.round((i + 1) * r);
    let sum = 0;
    let n = 0;
    for (let j = off; j < next && j < buf.length; j++) {
      sum += buf[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
    off = next;
  }
  return out;
}

function encodeWav(float32: Float32Array, sr: number): Blob {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const s = (o: number, str: string): void => {
    for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
  };
  s(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  s(8, "WAVE");
  s(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  s(36, "data");
  v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Encode Float32 PCM → compact WAV at a lower sample rate for remote providers.
 * Downsamples 16kHz → 8kHz to halve the payload size. This is instant (pure math)
 * unlike MediaRecorder which requires real-time playback duration.
 * 8kHz mono is the telephony standard and all speech recognition APIs accept it.
 */
function encodeCompactWav(
  float32: Float32Array,
  inputSr: number,
  outputSr: number = AUDIO_TOKENS.compactSampleRateHz
): Blob {
  const resampled = inputSr === outputSr ? float32 : downsample(float32, inputSr, outputSr);
  return encodeWav(resampled, outputSr);
}

function getRemoteModelValue(provider: Provider): string {
  if (provider === "openrouter") {
    const v = (($("remoteModelSelect") as HTMLSelectElement).value || "").trim();
    if (v) return v;
    return "google/gemini-2.5-flash";
  }
  if (provider === "deepgram") return "";
  return ($("model") as HTMLSelectElement).value || "small";
}

function syncRemoteModelOptions(defaultOpenrouterModel?: string): void {
  const provider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const sel = $("remoteModelSelect") as HTMLSelectElement;
  if (provider === "local" || !provider) {
    sel.hidden = true;
    return;
  }
  if (provider === "deepgram") {
    sel.hidden = true;
    return;
  }
  const preferred =
    (defaultOpenrouterModel || "").trim() ||
    (($("orModel") as HTMLInputElement)?.value || "").trim() ||
    OPENROUTER_AUDIO_MODELS[0];
  const models = new Set<string>(OPENROUTER_AUDIO_MODELS);
  if (preferred) models.add(preferred);
  sel.hidden = false;
  sel.innerHTML = "";
  Array.from(models).forEach((model) => {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    sel.appendChild(opt);
  });
  sel.value = preferred;
}

async function remoteJob(
  file: File,
  opts: { provider: Provider; language: string; diarize: boolean; openrouterModel?: string }
): Promise<{ job_id: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "openrouter");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  if (opts.provider === "openrouter") {
    fd.set("openrouter_model", (opts.openrouterModel || "").trim());
  }
  const r = await fetch("/api/remote/jobs", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as { job_id: string };
}

async function remoteJobSync(
  file: File,
  opts: { provider: Provider; language: string; diarize: boolean; openrouterModel?: string }
): Promise<{ text: string; provider: string; model?: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "openrouter");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  if (opts.provider === "openrouter") {
    fd.set("openrouter_model", (opts.openrouterModel || "").trim());
  }
  const r = await fetch("/api/remote/transcribe-sync", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
  const js = (await r.json()) as { ok?: boolean; result?: { text?: string; provider?: string; model?: string } };
  return {
    text: String(js?.result?.text || "").trim(),
    provider: String(js?.result?.provider || opts.provider || ""),
    model: String(js?.result?.model || "").trim() || undefined,
  };
}

function isTransientRemoteNetworkError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || "").toLowerCase();
  return (
    msg.includes("bad gateway") ||
    msg.includes("httpsconnectionpool") ||
    msg.includes("failed to establish a new connection") ||
    msg.includes("nodename nor servname provided") ||
    msg.includes("name or service not known") ||
    msg.includes("temporary failure in name resolution") ||
    msg.includes("network error") ||
    msg.includes("connection error") ||
    msg.includes("timed out")
  );
}

async function remoteJobSyncWithFallback(
  file: File,
  opts: { provider: Provider; language: string; diarize: boolean; openrouterModel?: string }
): Promise<{ text: string; provider: string; model?: string }> {
  return remoteJobSync(file, opts);
}

function isProviderKeyConfigured(provider: Provider): boolean {
  if (provider === "local" || !provider) return true;
  if (provider === "openrouter") {
    const typed = (($("orKey") as HTMLInputElement).value || "").trim();
    return hasOpenrouterKey || !!typed;
  }
  if (provider === "deepgram") {
    const typed = (($("deepgramKey") as HTMLInputElement).value || "").trim();
    return hasDeepgramKey || !!typed;
  }
  return true;
}

function providerKeyErrorMessage(provider: Provider): string {
  if (provider === "deepgram") {
    return "Deepgram API key is not configured. Add it in Settings -> API Keys.";
  }
  if (provider === "openrouter") {
    return "OpenRouter API key is not configured. Add it in Settings -> API Keys.";
  }
  return "Provider API key is not configured.";
}

async function localJob(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean }
): Promise<any> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || "small");
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/jobs", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as { job_id: string };
}

function resolveFastLocalLanguage(language: string): string {
  const raw = String(language || "").trim();
  if (raw && raw.toLowerCase() !== "auto") return raw;
  return "auto";
}

function resolveFastLiveLocalModel(model: string): string {
  const raw = String(model || "").trim() || "small";
  if (raw === "medium" || raw === "large-v3") return "small";
  return raw;
}

async function pollJob(
  jobId: string,
  signal: AbortSignal,
  cb?: (j: JobResponse) => void,
  opts?: { initialWaitMs?: number; maxWaitMs?: number; growth?: number }
): Promise<JobResponse> {
  const started = Date.now();
  let waitMs = Math.max(20, Math.floor(Number(opts?.initialWaitMs ?? UI_TOKENS.polling.initialWaitMs)));
  const maxWaitMs = Math.max(waitMs, Math.floor(Number(opts?.maxWaitMs ?? UI_TOKENS.polling.maxWaitMs)));
  const growth = Math.max(1.01, Number(opts?.growth ?? UI_TOKENS.polling.growth));
  while (true) {
    if (signal.aborted) {
      throw new Error("Request canceled");
    }
    if (Date.now() - started > MAX_JOB_WAIT_MS) {
      throw new Error("Job timeout (45 min)");
    }
    const j = await apiGet<JobResponse>("/api/jobs/" + jobId, signal);
    cb && cb(j);
    if (j.status === "done" || j.status === "error") return j;
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs = Math.min(maxWaitMs, Math.round(waitMs * growth));
  }
}

function syncMode(): void {
  const mode = ($("mode") as HTMLSelectElement).value;
  const live = mode === "live";
  $("modeHint").textContent = live
    ? "Live mode: fast local stream from microphone."
    : "Remote mode: upload file and transcribe with selected provider.";

  $("livePane").hidden = !live;
  $("splitGap").hidden = !live;
  $("waveCanvas").hidden = !live;
  $("uploadPanel").hidden = live;
  $("btnStart").style.display = live ? "inline-flex" : "none";

  if (!live && isRecording) {
    void stopLive(false);
  }
  if (live) {
    setSelectedFile(null);
  }
}

function setNetworkState(online: boolean, latencyMs: number | null = null): void {
  isNetworkOnline = !!online;
  const dot = $("netDot");
  const text = $("netText");
  dot.className = "net-dot" + (online ? " online" : " offline");
  text.textContent = online ? "Online" : "Offline";
  const pill = $("netPill");
  if (!online) {
    pill.setAttribute("title", "Internet unavailable");
    return;
  }
  pill.setAttribute("title", latencyMs != null ? `Internet is available (${latencyMs} ms)` : "Internet is available");
}

function resolveEffectiveProvider(preferred: Provider): Provider {
  if (preferred === "local") return "local";
  if (isNetworkOnline) return preferred;
  return "local";
}

async function refreshNetworkState(): Promise<void> {
  try {
    const health = await fetch("/api/health");
    if (!health.ok) throw new Error(`health ${health.status}`);
    // /api/network is public for UI indicator; token issues should not force Offline.
    const netResp = await fetch("/api/network");
    if (!netResp.ok) {
      setNetworkState(true, null);
      return;
    }
    const s = (await netResp.json()) as NetworkStatusResponse;
    setNetworkState(true, s.latency_ms ?? null);
  } catch {
    setNetworkState(false, null);
  }
}

document.querySelectorAll(".sb-item").forEach((e) => {
  e.addEventListener("click", () => {
    const v = (e as HTMLElement).dataset.view;
    document.querySelectorAll(".view").forEach((el) => ((el as HTMLElement).hidden = (el as HTMLElement).dataset.view !== v));
    document.querySelectorAll(".sb-item").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.view === v));
    $("windowViewLabel").textContent = v === "settings" ? "Settings" : v === "recordings" ? "Recordings" : "Record";
    if (v === "recordings") {
      void loadRecordings(false);
    }
  });
});

($("mode") as HTMLSelectElement).onchange = syncMode;

async function loadMics(forceReload = false): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    ($("micSelect") as HTMLSelectElement).innerHTML = '<option value="">Microphone API unavailable</option>';
    return;
  }
  try {
    const sel = $("micSelect") as HTMLSelectElement;
    if (forceReload) {
      sel.innerHTML = '<option value="">Loading...</option>';
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const curVal = sel.value;
    sel.innerHTML = '<option value="">Default</option>';
    const mics = devs.filter((d) => d.kind === "audioinput");
    if (mics.length === 0) {
      sel.innerHTML = '<option value="">No microphones</option>';
    } else {
      mics.forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || "Microphone " + (i + 1);
        sel.appendChild(o);
      });
    }
    const nextVal = curVal || preferredMicId || "";
    if (nextVal && Array.from(sel.options).some((o) => o.value === nextVal)) {
      sel.value = nextVal;
    }
  } catch (e) {
    console.error("Error loading microphones:", e);
    const sel = $("micSelect") as HTMLSelectElement;
    if (forceReload || !sel.options.length || /loading/i.test(sel.value || "")) {
      sel.innerHTML = '<option value="">Permission denied</option>';
    }
  }
}

($("micSelect") as HTMLSelectElement).onclick = () => void loadMics(true);

const canvas = $("waveCanvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
let waveBars: number[] = [];
let maxBars = 0;
let waveAnimId = 0;
const BAR_W = 3;
const BAR_GAP = 2;
const WAVE_PUSH_EVERY_FRAMES = 5;
let waveFrameCount = 0;

function resize(): void {
  const r = (canvas.parentElement as HTMLElement).getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;
  maxBars = Math.max(32, Math.floor(r.width / (BAR_W + BAR_GAP)) + 4);
  if (waveBars.length > maxBars) {
    waveBars = waveBars.slice(-maxBars);
  }
  draw();
}
new ResizeObserver(resize).observe(canvas.parentElement as Element);
resize();

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const mid = H / 2;
  if (waveBars.length === 0) {
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
    return;
  }

  const count = Math.min(maxBars, waveBars.length);
  for (let i = 0; i < count; i++) {
    const v = waveBars[waveBars.length - 1 - i];
    const x = W - (i + 1) * (BAR_W + BAR_GAP);
    if (x < 0) break;

    const h = Math.max(2, Math.min(H - 4, v * (H * 0.92)));
    const y = (H - h) / 2;

    ctx.fillStyle = "rgba(170,170,170,0.28)";
    ctx.fillRect(x, y, BAR_W, h);
    ctx.fillStyle = "rgba(210,210,210,0.7)";
    ctx.fillRect(x, y + h * 0.15, BAR_W, h * 0.7);
  }
}

let vu = 0;
function setVU(rms: number): void {
  window.__transcriptorRmsLevel = Math.max(0, Number.isFinite(rms) ? rms : 0);
  vu = vu * 0.7 + rms * 0.3;
  const pct = Math.min(100, vu * 400);
  window.__transcriptorVuLevel = Math.max(0, Math.min(1, vu * UI_TOKENS.capture.vuAmplify));
  $("vuFill").style.width = pct + "%";
  $("vuFill").style.background = pct < 40 ? "#aaa" : pct < 70 ? "#888" : "#666";
}

function resetVU(): void {
  vu = 0;
  window.__transcriptorRmsLevel = 0;
  window.__transcriptorVuLevel = 0;
  setVU(0);
}

function persistLiveDraft(recording: boolean): void {
  try {
    const liveText = ($("liveOutput").textContent || "").trim();
    const finalText = ($("finalOutput").textContent || "").trim();
    const timerText = ($("timer").textContent || "00:00").trim();
    const title = "Recording " + new Date(startAt || Date.now()).toLocaleString();
    const draft = {
      started_at: startAt || Date.now(),
      updated_at: Date.now(),
      recording,
      timer: timerText,
      title,
      source_text: liveText,
      transcript_text: finalText,
      provider: ($("providerSelect") as HTMLSelectElement).value || "local",
      model: getRemoteModelValue((($("providerSelect") as HTMLSelectElement).value || "local") as Provider),
      language: ($("language") as HTMLSelectElement).value,
    };
    localStorage.setItem(LIVE_DRAFT_KEY, JSON.stringify(draft));
  } catch { }
}

function clearLiveDraft(): void {
  try {
    localStorage.removeItem(LIVE_DRAFT_KEY);
  } catch { }
}

async function recoverLiveDraftIfAny(): Promise<void> {
  let raw = "";
  try {
    raw = localStorage.getItem(LIVE_DRAFT_KEY) || "";
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const draft = JSON.parse(raw) as {
      title?: string;
      source_text?: string;
      transcript_text?: string;
      provider?: string;
      model?: string;
      language?: string;
      updated_at?: number;
    };
    const sourceText = String(draft.source_text || "").trim();
    const transcriptText = String(draft.transcript_text || "").trim();
    if (!sourceText && !transcriptText) {
      clearLiveDraft();
      return;
    }
    const stamp = Number(draft.updated_at || Date.now());
    await saveRecordingText({
      title: String(draft.title || "Recovered recording") + " (Recovered)",
      sourceText,
      transcriptText,
      provider: String(draft.provider || "local"),
      model: String(draft.model || "-"),
      language: String(draft.language || "auto"),
    });
    $("finalOutput").textContent = transcriptText || sourceText;
    setStatus("Recovered " + new Date(stamp).toLocaleTimeString());
    clearLiveDraft();
  } catch {
    // Keep draft for next startup attempt.
  }
}

function collectUiPreferences(): NonNullable<NonNullable<AppConfig["preferences"]>["ui"]> {
  const silence = getAutoStopSilenceConfig();
  return {
    mode: (($("mode") as HTMLSelectElement).value || "live").trim(),
    provider: (($("providerSelect") as HTMLSelectElement).value || "local").trim(),
    language: (($("language") as HTMLSelectElement).value || "auto").trim(),
    local_model: (($("model") as HTMLSelectElement).value || "small").trim(),
    mic_id: (($("micSelect") as HTMLSelectElement).value || "").trim(),
    auto_transcribe: !!($("autoTranscribeToggle") as HTMLInputElement).checked,
    live_preview: !!($("livePreviewToggle") as HTMLInputElement).checked,
    quick_settings_open: !$("quickSettingsPanel").hidden,
    upscale_enabled: !!($("upscaleToggle") as HTMLInputElement).checked,
    upscale_preset: (($("upscalePresetSelect") as HTMLSelectElement).value || "builtin_clean").trim(),
    auto_send_enter: !!($("autoSendEnterToggle") as HTMLButtonElement).classList.contains("active"),
    auto_stop_silence_enabled: silence.enabled,
    auto_stop_silence_seconds: silence.seconds,
    auto_stop_silence_db: silence.thresholdDb,
  };
}

function shouldUpscale(): boolean {
  return !!($("upscaleToggle") as HTMLInputElement).checked;
}

function setAutoSendEnterEnabled(enabled: boolean): void {
  const btn = $("autoSendEnterToggle") as HTMLButtonElement;
  const on = !!enabled;
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? "Auto send after paste: ON" : "Auto send after paste: OFF";
}

function upscalePresetId(): string {
  return (($("upscalePresetSelect") as HTMLSelectElement).value || "builtin_clean").trim();
}

function selectedUpscalePreset(): UpscalePresetItem | undefined {
  const id = upscalePresetId();
  return upscalePresets.find((x) => x.id === id);
}

function syncUpscalePresetControls(): void {
  const delBtn = $("upscalePresetDeleteBtn") as HTMLButtonElement;
  const canDelete = !!(selectedUpscalePreset() && !selectedUpscalePreset()!.builtin);
  delBtn.disabled = !canDelete;
  delBtn.classList.toggle("can-delete", canDelete);
}

async function loadUpscalePresets(preferredId = ""): Promise<void> {
  const sel = $("upscalePresetSelect") as HTMLSelectElement;
  const prev = preferredId || sel.value || pendingUpscalePresetId || "";
  const r = await apiGet<{ items: UpscalePresetItem[] }>("/api/upscale/presets");
  upscalePresets = Array.isArray(r.items) ? r.items : [];
  sel.innerHTML = "";
  if (!upscalePresets.length) {
    const o = document.createElement("option");
    o.value = "builtin_clean";
    o.textContent = "Clean";
    sel.appendChild(o);
    upscalePresets = [{ id: "builtin_clean", name: "Clean", builtin: true }];
  } else {
    upscalePresets.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      sel.appendChild(o);
    });
  }
  const next = upscalePresets.some((x) => x.id === prev) ? prev : (upscalePresets[0]?.id || "builtin_clean");
  sel.value = next;
  pendingUpscalePresetId = "";
  const addBtn = $("upscalePresetAddBtn") as HTMLButtonElement;
  const customCount = upscalePresets.filter((x) => !x.builtin).length;
  addBtn.disabled = customCount >= 3;
  syncUpscalePresetControls();
}

function openUpscalePresetModal(): void {
  const modal = $("upscalePresetModal");
  const name = $("upscalePresetNameInput") as HTMLInputElement;
  const instruction = $("upscalePresetInstructionInput") as HTMLTextAreaElement;
  $("upscalePresetMsg").textContent = "";
  name.value = "";
  instruction.value =
    "Improve transcript quality: keep same language as input, preserve meaning, fix punctuation and grammar. Return only final transcript text without quotes.";
  modal.hidden = false;
  name.focus();
}

function closeUpscalePresetModal(): void {
  $("upscalePresetModal").hidden = true;
}

function openUpscalePromptModal(): void {
  const preset = selectedUpscalePreset();
  if (!preset) return;
  ($("upscalePromptPresetName") as HTMLInputElement).value = preset.name || preset.id;
  ($("upscalePromptPresetId") as HTMLInputElement).value = preset.id;
  ($("upscalePromptInstructionInput") as HTMLTextAreaElement).value =
    String(preset.instruction || preset.default_instruction || "").trim();
  $("upscalePromptMsg").textContent = "";
  $("upscalePromptModal").hidden = false;
  ($("upscalePromptInstructionInput") as HTMLTextAreaElement).focus();
}

function closeUpscalePromptModal(): void {
  $("upscalePromptModal").hidden = true;
}

async function runUpscaleIfEnabled(text: string): Promise<string> {
  const input = String(text || "").trim();
  if (!input) return "";
  if (!shouldUpscale()) {
    $("upscaleOutput").textContent = "";
    $("upscaleLatency").textContent = "--";
    return input;
  }
  setStatus("Upscaling");
  $("upscaleOutput").textContent = "Upscaling...";
  const t0 = performance.now();
  const remoteModel = (($("remoteModelSelect") as HTMLSelectElement).value || ($("orModel") as HTMLInputElement).value || "").trim();
  try {
    const r = await apiPost<{ ok: boolean; text: string; preset_id: string; model: string }>("/api/upscale", {
      text: input,
      preset_id: upscalePresetId(),
      model: remoteModel || undefined,
    });
    const out = String(r.text || "").trim();
    if (!out) throw new Error("Upscale returned empty text");
    $("upscaleOutput").textContent = out;
    $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
    setStatus("Done");
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e || "Unknown upscale error");
    $("upscaleOutput").textContent = `Upscale failed: ${msg}\n\nUsing original transcript.`;
    $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
    setStatus("Done");
    return input;
  }
}

function queueUiPreferencesSave(): void {
  if (suppressUiPrefAutosave) return;
  if (uiPrefSaveTimer) {
    clearTimeout(uiPrefSaveTimer);
    uiPrefSaveTimer = null;
  }
  uiPrefSaveTimer = window.setTimeout(() => {
    uiPrefSaveTimer = null;
    const provider = (($("providerSelect") as HTMLSelectElement).value || "local").trim();
    const remoteProvider = provider === "openrouter" || provider === "deepgram" ? provider : "openrouter";
    const openrouterModel = (($("remoteModelSelect") as HTMLSelectElement).value || ($("orModel") as HTMLInputElement).value || "").trim();
    void apiPost<{ ok: boolean }>("/api/config", {
      preferences: {
        recordings_dir: ($("recordingsDirInput") as HTMLInputElement).value.trim(),
        remote_provider: remoteProvider,
        openrouter: { model: openrouterModel || "google/gemini-2.5-flash" },
        ui: collectUiPreferences(),
      },
    }).catch(() => { });
  }, UI_TOKENS.settings.saveDebounceMs);
}

async function loadCfg(): Promise<void> {
  suppressUiPrefAutosave = true;
  try {
    const cfg = await apiGet<AppConfig>("/api/config");
    const orK = ((cfg.providers || {}).openrouter || {}).key;
    const dgK = ((cfg.providers || {}).deepgram || {}).key;
    hasOpenrouterKey = !!String(orK || "").trim();
    hasDeepgramKey = !!String(dgK || "").trim();
    ($("orKey") as HTMLInputElement).placeholder = orK ? "(saved)" : "OPENROUTER_API_KEY";
    ($("deepgramKey") as HTMLInputElement).placeholder = dgK ? "(saved)" : "DEEPGRAM_API_KEY";
    ($("orKey") as HTMLInputElement).value = "";
    ($("deepgramKey") as HTMLInputElement).value = "";
    $("configPathLabel").textContent = "Config: " + (((cfg._meta || {}).config_path as string) || "-");
    const cfgOpenrouterModel = (cfg.preferences || {}).openrouter?.model || "google/gemini-2.5-flash";
    ($("orModel") as HTMLInputElement).value = cfgOpenrouterModel;
    ($("recordingsDirInput") as HTMLInputElement).value = (cfg.preferences || {}).recordings_dir || "";
    const ui = (cfg.preferences || {}).ui || {};
    const languageSel = $("language") as HTMLSelectElement;
    const providerSel = $("providerSelect") as HTMLSelectElement;
    const quickProviderSel = $("quickProviderSelect") as HTMLSelectElement;
    const modelSel = $("model") as HTMLSelectElement;
    const modeSel = $("mode") as HTMLSelectElement;
    if (ui.mode && Array.from(modeSel.options).some((o) => o.value === ui.mode)) {
      modeSel.value = ui.mode;
      syncMode();
    }
    if (ui.language && Array.from(languageSel.options).some((o) => o.value === ui.language)) {
      languageSel.value = ui.language;
    }
    const providerCandidate = String(ui.provider || "").trim();
    if (providerCandidate && Array.from(providerSel.options).some((o) => o.value === providerCandidate)) {
      providerSel.value = providerCandidate;
    }
    quickProviderSel.value = providerSel.value;
    if (ui.local_model && Array.from(modelSel.options).some((o) => o.value === ui.local_model)) {
      modelSel.value = ui.local_model;
    }
    const auto = $("autoTranscribeToggle") as HTMLInputElement;
    const livePreview = $("livePreviewToggle") as HTMLInputElement;
    auto.checked = ui.auto_transcribe !== false;
    livePreview.checked = ui.live_preview !== false;
    const autoStopEnabledEl = $("autoStopSilenceEnabled") as HTMLInputElement;
    const autoStopSecondsEl = $("autoStopSilenceSeconds") as HTMLInputElement;
    const autoStopDbEl = $("autoStopSilenceDb") as HTMLInputElement;
    autoStopEnabledEl.checked = ui.auto_stop_silence_enabled === true;
    autoStopSecondsEl.value = String(
      clampNumber(
        Number.isFinite(Number(ui.auto_stop_silence_seconds)) ? Number(ui.auto_stop_silence_seconds) : 2,
        1,
        120
      )
    );
    autoStopDbEl.value = String(
      clampNumber(
        Number.isFinite(Number(ui.auto_stop_silence_db)) ? Number(ui.auto_stop_silence_db) : -42,
        -80,
        -10
      )
    );
    const upscaleToggle = $("upscaleToggle") as HTMLInputElement;
    upscaleToggle.checked = ui.upscale_enabled === true;
    setAutoSendEnterEnabled(ui.auto_send_enter === true);
    pendingUpscalePresetId = String(ui.upscale_preset || "").trim();
    preferredMicId = String(ui.mic_id || "").trim();
    syncRemoteModelOptions(cfgOpenrouterModel);
    const remoteSel = $("remoteModelSelect") as HTMLSelectElement;
    if (providerSel.value === "openrouter" && cfgOpenrouterModel) {
      remoteSel.value = cfgOpenrouterModel;
    }
    await loadUpscalePresets(pendingUpscalePresetId);
    syncQuickSettingsVisibility(ui.quick_settings_open === true);
    $("cfgMsg").textContent = "Loaded";
  } catch {
    $("cfgMsg").textContent = "Error loading config";
    try {
      await loadUpscalePresets("builtin_clean");
    } catch { }
  } finally {
    suppressUiPrefAutosave = false;
  }
}

async function saveCfg(): Promise<void> {
  $("cfgMsg").textContent = "Saving...";
  const cfg = {
    providers: {
      openrouter: { key: ($("orKey") as HTMLInputElement).value.trim() },
      deepgram: { key: ($("deepgramKey") as HTMLInputElement).value.trim() },
    },
    preferences: {
      remote_provider: ((($("providerSelect") as HTMLSelectElement).value || "openrouter").trim() || "openrouter"),
      recordings_dir: ($("recordingsDirInput") as HTMLInputElement).value.trim(),
      openrouter: { model: ($("orModel") as HTMLInputElement).value.trim() },
      ui: collectUiPreferences(),
    },
  };
  await apiPost<{ ok: boolean }>("/api/config", cfg);
  hasOpenrouterKey = hasOpenrouterKey || !!(($("orKey") as HTMLInputElement).value || "").trim();
  hasDeepgramKey = hasDeepgramKey || !!(($("deepgramKey") as HTMLInputElement).value || "").trim();
  ($("orKey") as HTMLInputElement).value = "";
  ($("deepgramKey") as HTMLInputElement).value = "";
  await loadCfg();
  $("cfgMsg").textContent = "Saved";
}

$("saveBtn").addEventListener("click", () => void saveCfg().catch((e: Error) => ($("cfgMsg").textContent = e.message)));
$("reloadBtn").addEventListener("click", () => void loadCfg().catch((e: Error) => ($("cfgMsg").textContent = e.message)));
($("mode") as HTMLSelectElement).addEventListener("change", () => queueUiPreferencesSave());
($("recordingsDirInput") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceEnabled") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceSeconds") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceDb") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("upscaleToggle") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoSendEnterToggle") as HTMLButtonElement).addEventListener("click", () => {
  const btn = $("autoSendEnterToggle") as HTMLButtonElement;
  setAutoSendEnterEnabled(!btn.classList.contains("active"));
  queueUiPreferencesSave();
});
($("upscalePresetSelect") as HTMLSelectElement).addEventListener("change", () => {
  syncUpscalePresetControls();
  queueUiPreferencesSave();
});
($("upscalePresetAddBtn") as HTMLButtonElement).addEventListener("click", () => openUpscalePresetModal());
($("upscalePresetEditBtn") as HTMLButtonElement).addEventListener("click", () => openUpscalePromptModal());
($("upscalePresetCancelBtn") as HTMLButtonElement).addEventListener("click", () => closeUpscalePresetModal());
($("upscalePresetModal") as HTMLDivElement).addEventListener("click", (e) => {
  if (e.target === $("upscalePresetModal")) closeUpscalePresetModal();
});
($("upscalePromptCancelBtn") as HTMLButtonElement).addEventListener("click", () => closeUpscalePromptModal());
($("upscalePromptModal") as HTMLDivElement).addEventListener("click", (e) => {
  if (e.target === $("upscalePromptModal")) closeUpscalePromptModal();
});
($("upscalePresetSaveBtn") as HTMLButtonElement).addEventListener("click", () => {
  const name = (($("upscalePresetNameInput") as HTMLInputElement).value || "").trim();
  const instruction = (($("upscalePresetInstructionInput") as HTMLTextAreaElement).value || "").trim();
  const msg = $("upscalePresetMsg");
  if (!name) {
    msg.textContent = "Preset name is required.";
    return;
  }
  if (!instruction) {
    msg.textContent = "Instruction is required.";
    return;
  }
  msg.textContent = "Saving...";
  void apiPost<{ ok: boolean; item: UpscalePresetItem }>("/api/upscale/presets", { name, instruction })
    .then(async (r) => {
      closeUpscalePresetModal();
      await loadUpscalePresets(r.item?.id || "");
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      msg.textContent = e.message;
    });
});
($("upscalePromptSaveBtn") as HTMLButtonElement).addEventListener("click", () => {
  const presetId = (($("upscalePromptPresetId") as HTMLInputElement).value || "").trim();
  const instruction = (($("upscalePromptInstructionInput") as HTMLTextAreaElement).value || "").trim();
  const msg = $("upscalePromptMsg");
  if (!presetId) {
    msg.textContent = "Preset is missing.";
    return;
  }
  if (!instruction) {
    msg.textContent = "Instruction is required.";
    return;
  }
  msg.textContent = "Saving...";
  void apiPut<{ ok: boolean; item: UpscalePresetItem }>(`/api/upscale/presets/${encodeURIComponent(presetId)}`, { instruction })
    .then(async () => {
      await loadUpscalePresets(presetId);
      queueUiPreferencesSave();
      msg.textContent = "Saved";
      setTimeout(() => closeUpscalePromptModal(), 220);
    })
    .catch((e: Error) => {
      msg.textContent = e.message;
    });
});
($("upscalePromptDefaultBtn") as HTMLButtonElement).addEventListener("click", () => {
  const presetId = (($("upscalePromptPresetId") as HTMLInputElement).value || "").trim();
  const msg = $("upscalePromptMsg");
  if (!presetId) return;
  msg.textContent = "Resetting...";
  void apiPost<{ ok: boolean; item: UpscalePresetItem }>(`/api/upscale/presets/${encodeURIComponent(presetId)}/reset-default`, {})
    .then(async () => {
      await loadUpscalePresets(presetId);
      const preset = selectedUpscalePreset();
      ($("upscalePromptInstructionInput") as HTMLTextAreaElement).value =
        String(preset?.instruction || preset?.default_instruction || "").trim();
      queueUiPreferencesSave();
      msg.textContent = "Default applied";
    })
    .catch((e: Error) => {
      msg.textContent = e.message;
    });
});
($("upscalePresetDeleteBtn") as HTMLButtonElement).addEventListener("click", () => {
  const cur = selectedUpscalePreset();
  if (!cur || cur.builtin) return;
  void fetch(`/api/upscale/presets/${encodeURIComponent(cur.id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(await parseError(r));
      await loadUpscalePresets("");
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      $("upscaleOutput").textContent = `Preset delete failed: ${e.message}`;
    });
});
($("orModel") as HTMLInputElement).addEventListener("change", () => {
  syncRemoteModelOptions(($("orModel") as HTMLInputElement).value.trim());
  queueUiPreferencesSave();
});
$("pickRecordingsDirBtn").addEventListener("click", () =>
  void apiPost<{ path: string }>("/api/recordings/pick-folder", {})
    .then((r) => {
      ($("recordingsDirInput") as HTMLInputElement).value = r.path || "";
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      $("cfgMsg").textContent = e.message;
    })
);

let recordingItems: RecordingItem[] = [];
let selectedRecordingName = "";
let recordingsStatsOpen = true;

function syncRecordingsStatsVisibility(): void {
  $("recordingsStatsPanel").hidden = !recordingsStatsOpen;
  const btn = $("recordingsStatsBtn") as HTMLButtonElement;
  if (recordingsStatsOpen) {
    btn.classList.add("active");
  } else {
    btn.classList.remove("active");
  }
}

function updateRecordingCopyState(): void {
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  const hasText = !!($("recordingContent").textContent || "").trim();
  btn.disabled = !hasText;
}

async function copyRecordingText(): Promise<void> {
  const text = ($("recordingContent").textContent || "").trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  const prevLabel = btn.getAttribute("aria-label") || "Copy recording text";
  btn.setAttribute("aria-label", "Copied");
  btn.title = "Copied";
  window.setTimeout(() => {
    btn.setAttribute("aria-label", prevLabel);
    btn.title = "Copy";
  }, 900);
}

async function copyTextContent(text: string): Promise<void> {
  const value = String(text || "").trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function renderRecordingsList(): void {
  const list = $("recordingsList");
  list.innerHTML = "";
  if (!recordingItems.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No recordings yet.";
    list.appendChild(empty);
    return;
  }
  recordingItems.forEach((it) => {
    const btn = document.createElement("button");
    btn.className = "recording-item" + (it.name === selectedRecordingName ? " active" : "");
    btn.type = "button";
    btn.innerHTML = `<span class="title">${it.display_name}</span><span class="meta">${fmtDateTime(it.modified_at)} · ${Math.round(
      it.size_bytes / 1024
    )} KB</span>`;
    btn.onclick = () => void openRecording(it.name);
    list.appendChild(btn);
  });
}

async function loadRecordings(keepSelection: boolean): Promise<void> {
  const r = await apiGet<{ items: RecordingItem[]; directory: string }>("/api/recordings");
  recordingItems = r.items || [];
  $("recordingsDirLabel").textContent = "Directory: " + (r.directory || "-");
  $("recordingsCountLabel").textContent = `Total recordings: ${recordingItems.length}`;
  if (!keepSelection || !recordingItems.some((x) => x.name === selectedRecordingName)) {
    selectedRecordingName = recordingItems[0]?.name || "";
  }
  renderRecordingsList();
  await loadRecordingsStats();
  if (selectedRecordingName) {
    await openRecording(selectedRecordingName);
  } else {
    $("recordingTitle").textContent = "Select recording";
    $("recordingMeta").textContent = "";
    $("recordingContent").textContent = "";
    updateRecordingCopyState();
  }
}

async function loadRecordingsStats(): Promise<void> {
  const s = await apiGet<RecordingsStats>("/api/recordings/stats/summary");
  $("statsTotal").textContent = String(s.total_recordings || 0);
  $("statsWords").textContent = String(s.total_words || 0);
  $("statsChars").textContent = String(s.total_chars || 0);
  $("statsWpr").textContent = String(s.avg_words_per_recording || 0);
  $("statsAvgDur").textContent = fmtDur(s.avg_duration_sec || 0);
  $("statsMinDur").textContent = fmtDur(s.min_duration_sec || 0);
  $("statsMaxDur").textContent = fmtDur(s.max_duration_sec || 0);
  const top = $("statsTopWords");
  top.innerHTML = "";
  if (!s.top_words?.length) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "No word stats yet.";
    top.appendChild(empty);
    return;
  }
  s.top_words.forEach((w) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = `${w.word} (${w.count})`;
    top.appendChild(chip);
  });

  const providers = $("statsProviders");
  providers.innerHTML = "";
  (s.providers || []).slice(0, 8).forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = `${p.name} (${p.count})`;
    providers.appendChild(chip);
  });
  if (!providers.children.length) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "No provider data.";
    providers.appendChild(empty);
  }

  const languages = $("statsLanguages");
  languages.innerHTML = "";
  (s.languages || []).slice(0, 8).forEach((l) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = `${l.name} (${l.count})`;
    languages.appendChild(chip);
  });
  if (!languages.children.length) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "No language data.";
    languages.appendChild(empty);
  }
}

async function openRecording(name: string): Promise<void> {
  selectedRecordingName = name;
  renderRecordingsList();
  const r = await apiGet<{ name: string; modified_at: string; size_bytes: number; content: string }>(
    "/api/recordings/" + encodeURIComponent(name)
  );
  $("recordingTitle").textContent = r.name || name;
  $("recordingMeta").textContent = `${fmtDateTime(r.modified_at)} · ${Math.round((r.size_bytes || 0) / 1024)} KB`;
  $("recordingContent").textContent = r.content || "";
  updateRecordingCopyState();
}

async function saveRecordingText(opts: {
  title: string;
  sourceText: string;
  transcriptText: string;
  provider: string;
  model: string;
  language: string;
}): Promise<void> {
  const sourceText = (opts.sourceText || "").trim();
  const transcriptText = (opts.transcriptText || "").trim();
  if (!sourceText && !transcriptText) return;
  await apiPost<{ ok: boolean; name: string }>("/api/recordings/save", {
    title: opts.title,
    source_text: sourceText,
    transcript_text: transcriptText,
    provider: opts.provider,
    model: opts.model,
    language: opts.language,
  });
  // Fire-and-forget: don't block critical path for recordings list reload.
  loadRecordings(true).catch(() => { });
}

$("recordingsRefreshBtn").addEventListener("click", () =>
  void loadRecordings(true).catch((e: Error) => {
    $("recordingContent").textContent = e.message;
    updateRecordingCopyState();
  })
);
$("recordingsStatsBtn").addEventListener("click", () => {
  recordingsStatsOpen = !recordingsStatsOpen;
  syncRecordingsStatsVisibility();
});
$("recordingCopyBtn").addEventListener("click", () => void copyRecordingText());
$("resultCopyBtn").addEventListener("click", () => void copyTextContent($("finalOutput").textContent || ""));
$("upscaleCopyBtn").addEventListener("click", () => void copyTextContent($("upscaleOutput").textContent || ""));

// ── Transcribe settings gear popup ──
const transcribeSettingsBtn = $("transcribeSettingsBtn") as HTMLButtonElement;
const transcribeSettingsPopup = $("transcribeSettingsPopup") as HTMLElement;
transcribeSettingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  transcribeSettingsPopup.hidden = !transcribeSettingsPopup.hidden;
});
document.addEventListener("click", (e) => {
  if (!transcribeSettingsPopup.hidden && !transcribeSettingsPopup.contains(e.target as Node) && e.target !== transcribeSettingsBtn) {
    transcribeSettingsPopup.hidden = true;
  }
});

syncRecordingsStatsVisibility();

const autoToggle = $("autoTranscribeToggle") as HTMLInputElement;
autoToggle.addEventListener("change", () => {
  queueUiPreferencesSave();
});
const livePreviewToggle = $("livePreviewToggle") as HTMLInputElement;
livePreviewToggle.addEventListener("change", () => {
  queueUiPreferencesSave();
});

function shouldAutoTranscribe(): boolean {
  return autoToggle.checked && ($("mode") as HTMLSelectElement).value === "live";
}

function shouldLivePreview(): boolean {
  return livePreviewToggle.checked && ($("mode") as HTMLSelectElement).value === "live";
}

($("providerSelect") as HTMLSelectElement).addEventListener("change", () => {
  const main = $("providerSelect") as HTMLSelectElement;
  const quick = $("quickProviderSelect") as HTMLSelectElement;
  if (quick.value !== main.value) quick.value = main.value;
  syncRemoteModelOptions();
  queueUiPreferencesSave();
});
($("remoteModelSelect") as HTMLSelectElement).addEventListener("change", () => {
  const v = (($("remoteModelSelect") as HTMLSelectElement).value || "").trim();
  if (v) ($("orModel") as HTMLInputElement).value = v;
  queueUiPreferencesSave();
});
($("quickProviderSelect") as HTMLSelectElement).addEventListener("change", () => {
  const quick = $("quickProviderSelect") as HTMLSelectElement;
  const main = $("providerSelect") as HTMLSelectElement;
  if (main.value !== quick.value) {
    main.value = quick.value;
    main.dispatchEvent(new Event("change"));
  }
});

function syncQuickSettingsVisibility(open: boolean): void {
  const panel = $("quickSettingsPanel");
  const btn = $("quickSettingsToggle") as HTMLButtonElement;
  panel.hidden = !open;
  btn.classList.toggle("active", open);
  btn.setAttribute("aria-pressed", open ? "true" : "false");
}

function applyQuickSettingsFromMain(open: boolean): boolean {
  const panel = $("quickSettingsPanel");
  const next = !!open;
  const changed = panel.hidden === next;
  syncQuickSettingsVisibility(next);
  if (changed) queueUiPreferencesSave();
  return changed;
}

function initQuickControls(): void {
  const main = $("providerSelect") as HTMLSelectElement;
  const quick = $("quickProviderSelect") as HTMLSelectElement;
  quick.value = main.value;
  syncRemoteModelOptions();

  ($("quickSettingsToggle") as HTMLButtonElement).addEventListener("click", () => {
    const next = $("quickSettingsPanel").hidden;
    syncQuickSettingsVisibility(next);
    queueUiPreferencesSave();
  });
  window.__transcriptorSetQuickSettingsOpen = applyQuickSettingsFromMain;
}

($("language") as HTMLSelectElement).addEventListener("change", () => queueUiPreferencesSave());
($("model") as HTMLSelectElement).addEventListener("change", () => queueUiPreferencesSave());
($("micSelect") as HTMLSelectElement).addEventListener("change", () => queueUiPreferencesSave());

let ws: WebSocket | null = null;
let ac: AudioContext | null = null;
let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let scriptSinkGain: GainNode | null = null;
let src: MediaStreamAudioSourceNode | null = null;
let timer: number | null = null;
let startAt = 0;
let chunks: Float32Array[] = [];
let draftSaveTimer: number | null = null;
let workletLastFrameAt = 0;
let fallbackCaptureTimer: number | null = null;
let captureFrameCount = 0;
let captureRmsAccum = 0;
let capturePeakMax = 0;
let liveRecordingSeq = 0;
let currentRecordingId = 0;

// ── Chunked transcription pipeline ──────────────────────────────────────────
// During recording with a remote provider, we send audio in fixed-size chunks
// for parallel transcription. By the time the user stops, ~90% of text is ready.
let chunkTimer: number | null = null;
let chunkTranscriptions: string[] = [];  // ordered partial results
let chunkStates: Array<"pending" | "done" | "failed"> = [];
let chunkLastSentSamples = 0;             // how many samples already sent
let chunkPendingCount = 0;                // in-flight requests

function chunkTranscribeSchedulerTick(): void {
  const providerValue = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const effectiveProvider = resolveEffectiveProvider(providerValue);
  if (effectiveProvider === "local" || !effectiveProvider || !isRecording) return;
  // Count total samples accumulated
  let totalSamples = 0;
  for (const c of chunks) totalSamples += c.length;
  // Only send if we have at least 1 second of new audio (16000 samples)
  const newSamples = totalSamples - chunkLastSentSamples;
  if (newSamples < UI_TOKENS.capture.chunkMinNewSamples) return;
  // Extract only the new audio since last send
  const allMerged = new Float32Array(totalSamples);
  let off = 0;
  for (const c of chunks) { allMerged.set(c, off); off += c.length; }
  const newAudio = allMerged.slice(chunkLastSentSamples);
  const chunkIndex = chunkTranscriptions.length;
  chunkTranscriptions.push("");  // placeholder
  chunkStates.push("pending");
  chunkLastSentSamples = totalSamples;
  chunkPendingCount++;
  // Fire-and-forget background transcription
  const audioBlob = encodeCompactWav(newAudio, AUDIO_TOKENS.liveSampleRateHz, AUDIO_TOKENS.compactSampleRateHz);
  const file = new File([audioBlob], `chunk-${chunkIndex}.wav`, { type: audioBlob.type });
  remoteJobSync(file, {
    provider: effectiveProvider,
    language: ($("language") as HTMLSelectElement).value,
    diarize: ($("diarizeCheck") as HTMLInputElement).checked,
    openrouterModel: getRemoteModelValue(effectiveProvider),
  }).then((r) => {
    chunkTranscriptions[chunkIndex] = r.text;
    chunkStates[chunkIndex] = "done";
    chunkPendingCount--;
  }).catch(() => {
    chunkStates[chunkIndex] = "failed";
    chunkPendingCount--;
  });
}

function startChunkScheduler(): void {
  stopChunkScheduler();
  chunkTranscriptions = [];
  chunkStates = [];
  chunkLastSentSamples = 0;
  chunkPendingCount = 0;
  const providerValue = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const effectiveProvider = resolveEffectiveProvider(providerValue);
  if (effectiveProvider === "local" || !effectiveProvider) return;
  chunkTimer = window.setInterval(chunkTranscribeSchedulerTick, UI_TOKENS.capture.chunkIntervalMs);
}

function stopChunkScheduler(): void {
  if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
}

function publishFinishedRecording(recordingId: number, text: string): void {
  const rid = Math.max(0, Number(recordingId || 0));
  const payload = String(text || "").trim();
  const lower = payload.toLowerCase();
  const invalid =
    !payload ||
    lower === "error" ||
    lower === "[websocket error]" ||
    lower.startsWith("http ");
  if (invalid) return;
  if (!rid || !payload) return;
  const finishedAt = Date.now();
  window.__transcriptorLastFinishedText = payload;
  window.__transcriptorLastFinishedAt = finishedAt;
  window.__transcriptorLastFinishedRecordingId = rid;
  const list = Array.isArray(window.__transcriptorFinishedRecords) ? window.__transcriptorFinishedRecords.slice() : [];
  const next = list.filter((x) => Number(x?.recordingId || 0) !== rid);
  next.push({ recordingId: rid, finishedAt, text: payload });
  window.__transcriptorFinishedRecords = next.slice(-30);
}

function resetOutputs(): void {
  $("liveOutput").textContent = "";
  $("finalOutput").textContent = "";
  $("upscaleOutput").textContent = "";
  $("transcribeLatency").textContent = "--";
  $("upscaleLatency").textContent = "--";
  $("timer").textContent = "00:00";
  $("progressRow").hidden = true;
  $("downloadRow").hidden = true;
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "0%";
}

function applyJobResult(j: JobResponse): void {
  $("progressRow").hidden = true;
  const resultText = j.result?.text;
  if (j.status === "done" && typeof resultText === "string" && resultText) {
    $("finalOutput").textContent = resultText;
    $("downloadRow").hidden = false;
    ($("dlTxt") as HTMLAnchorElement).href = `/api/jobs/${j.job_id}/download/txt`;
    ($("dlJson") as HTMLAnchorElement).href = `/api/jobs/${j.job_id}/download/json`;
    setStatus("Done");
    return;
  }
  $("finalOutput").textContent = j.error || "Error";
  setStatus("Error");
}

function pushCapturedFrame(input: Float32Array): void {
  if (!(input instanceof Float32Array) || !input.length) return;
  workletLastFrameAt = Date.now();
  window.__transcriptorLastFrameAt = workletLastFrameAt;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / input.length);
  captureFrameCount += 1;
  captureRmsAccum += rms;
  if (peak > capturePeakMax) capturePeakMax = peak;
  window.__transcriptorVuLevel = Math.max(0, Math.min(1, rms * UI_TOKENS.capture.vuAmplify));
  if (!ac) return;
  const ds = downsample(input, ac.sampleRate, AUDIO_TOKENS.liveSampleRateHz);
  chunks.push(new Float32Array(ds));
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const pcm = new ArrayBuffer(ds.length * 2);
  const dv = new DataView(pcm);
  for (let i = 0; i < ds.length; i++) {
    const x = Math.max(-1, Math.min(1, ds[i]));
    dv.setInt16(i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  try {
    ws.send(pcm);
  } catch { }
}

function micErrorTag(e: unknown): string {
  const err = e as { name?: unknown; message?: unknown };
  const name = String(err?.name || "").trim();
  const msg = String(err?.message || "").trim();
  return [name, msg].filter(Boolean).join(": ");
}

async function startLive(): Promise<void> {
  if (isBusy) return;
  resetOutputs();
  chunks = [];
  workletLastFrameAt = 0;
  silenceStartedAtMs = 0;
  autoStopTriggered = false;
  captureFrameCount = 0;
  captureRmsAccum = 0;
  capturePeakMax = 0;
  setBusy(true);
  isRecording = true;
  currentRecordingId = ++liveRecordingSeq;
  startChunkScheduler();
  window.__transcriptorIsRecording = true;
  window.__transcriptorLastFrameAt = Date.now();
  window.__transcriptorLastFinishedText = "";
  window.__transcriptorLastFinishedAt = 0;
  window.__transcriptorCurrentRecordingId = currentRecordingId;
  window.__transcriptorLastFinishedRecordingId = 0;
  setRecordButton(true);
  // Keep single mic button interactive while recording.
  ($("btnStart") as HTMLButtonElement).disabled = false;
  (document.getElementById("btnStop") as HTMLButtonElement).disabled = false;
  setStatus("Starting");
  window.__transcriptorVuLevel = 0;
  window.__transcriptorRmsLevel = 0;
  window.__transcriptorLastFrameAt = 0;

  startAt = Date.now();
  persistLiveDraft(true);
  if (draftSaveTimer) {
    clearInterval(draftSaveTimer);
    draftSaveTimer = null;
  }
  draftSaveTimer = window.setInterval(() => persistLiveDraft(true), UI_TOKENS.draft.autosaveIntervalMs);
  timer = window.setInterval(() => {
    $("timer").textContent = fmtTime((Date.now() - startAt) / 1000);
  }, UI_TOKENS.timer.tickMs);

  const enableLivePreview = shouldLivePreview();
  if (enableLivePreview) {
    ws = new WebSocket(
      wsBase() +
      "/ws/transcribe?" +
      new URLSearchParams({
        model: resolveFastLiveLocalModel(($("model") as HTMLSelectElement).value),
        language: ($("language") as HTMLSelectElement).value,
        token: apiToken(),
      })
    );
    ws.binaryType = "arraybuffer";
    ws.onopen = () => setStatus("Recording");
    ws.onerror = () => {
      $("liveOutput").textContent += "\n[WebSocket error]";
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      let m: unknown;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof m !== "object" || m === null) return;
      const msg = m as { type?: unknown; error?: unknown; segments?: unknown };
      if (msg.type === "error") {
        $("liveOutput").textContent += `\n[${String(msg.error ?? "error")}]`;
        return;
      }
      if (msg.type === "segments" && Array.isArray(msg.segments)) {
        const lines = msg.segments
          .map((s) => (typeof s === "object" && s && "text" in s ? String((s as { text?: unknown }).text ?? "").trim() : ""))
          .filter(Boolean);
        if (lines.length) {
          // Segments payload is cumulative; render snapshot to avoid duplicate growth.
          $("liveOutput").textContent = lines.join("\n");
          $("liveOutput").scrollTop = $("liveOutput").scrollHeight;
          persistLiveDraft(true);
        }
      }
    };
  } else {
    setStatus("Recording");
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    await loadMics(true);
    const devId = (($("micSelect") as HTMLSelectElement).value || "").trim();
    try {
      stream = await navigator.mediaDevices.getUserMedia(devId ? { audio: { deviceId: { exact: devId } } } : { audio: true });
    } catch (e) {
      const msg = String((e as Error)?.message || e || "").toLowerCase();
      const recoverable =
        msg.includes("overconstrained") ||
        msg.includes("notfound") ||
        msg.includes("device") ||
        msg.includes("constraint");
      if (!recoverable) throw e;
      // Selected mic could disappear after reconnect/sleep. Use system default fallback.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
      throw new Error("Microphone stream is not live");
    }
    ac = new AudioContext();
    if (ac.state !== "running") {
      try {
        await ac.resume();
      } catch { }
    }
    src = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    await ac.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url).href);
    workletNode = new AudioWorkletNode(ac, "pcm-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    const buf = new Float32Array(analyser.fftSize);
    const tick = (): void => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i];
        sum += s * s;
        const a = Math.abs(s);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      setVU(rms);
      evaluateSilenceAutoStop(rms);

      waveFrameCount += 1;
      if (waveFrameCount % WAVE_PUSH_EVERY_FRAMES === 0) {
        const level = Math.min(1, rms * UI_TOKENS.capture.waveformMixRms + peak * UI_TOKENS.capture.waveformMixPeak);
        waveBars.push(level);
        if (waveBars.length > maxBars) waveBars = waveBars.slice(-maxBars);
      }
      draw();
      waveAnimId = requestAnimationFrame(tick);
    };
    tick();

    workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const input = ev.data;
      pushCapturedFrame(input);
    };

    src.connect(workletNode);

    // Enterprise fallback: if AudioWorklet path is silent/stalled on this host,
    // switch to ScriptProcessor capture so recording still works.
    if (fallbackCaptureTimer) {
      clearTimeout(fallbackCaptureTimer);
      fallbackCaptureTimer = null;
    }
    fallbackCaptureTimer = window.setTimeout(() => {
      if (!ac || !src || !isRecording) return;
      const noFrames = captureFrameCount < 3;
      if (!noFrames) return;
      try {
        scriptNode = ac.createScriptProcessor(4096, 1, 1);
        scriptSinkGain = ac.createGain();
        scriptSinkGain.gain.value = 0;
        scriptNode.onaudioprocess = (ev: AudioProcessingEvent) => {
          const ch = ev.inputBuffer.getChannelData(0);
          if (!ch || !ch.length) return;
          pushCapturedFrame(new Float32Array(ch));
        };
        src.connect(scriptNode);
        scriptNode.connect(scriptSinkGain);
        scriptSinkGain.connect(ac.destination);
        const cur = $("liveOutput").textContent || "";
        if (!cur.includes("[Mic fallback engaged]")) {
          $("liveOutput").textContent = (cur ? `${cur}\n` : "") + "[Mic fallback engaged]";
        }
      } catch { }
    }, UI_TOKENS.capture.fallbackInitDelayMs);
  } catch (e) {
    $("liveOutput").textContent = micErrorTag(e) || (e as Error).message;
    await stopLive(false);
    setStatus("Error");
  }
}

async function waitForWorkletDrain(
  maxWaitMs = UI_TOKENS.drain.maxWaitMs,
  idleMs = UI_TOKENS.drain.idleMs
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const last = workletLastFrameAt || 0;
    if (!last || Date.now() - last >= idleMs) return;
    await new Promise((r) => setTimeout(r, UI_TOKENS.drain.pollStepMs));
  }
}

async function stopLive(enhance: boolean): Promise<void> {
  const recordingId = currentRecordingId;
  const sourceLiveText = ($("liveOutput").textContent || "").trim();
  const recordedMs = startAt > 0 ? Math.max(0, Date.now() - startAt) : 0;
  const recordedSec = recordedMs / 1000;
  const title = "Recording " + new Date().toLocaleString();
  const providerValue = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const languageValue = ($("language") as HTMLSelectElement).value;
  const effectiveProvider = resolveEffectiveProvider(providerValue);
  const modelValue =
    effectiveProvider === "local"
      ? resolveFastLiveLocalModel(($("model") as HTMLSelectElement).value)
      : getRemoteModelValue(effectiveProvider);
  const avgCaptureRms = captureFrameCount > 0 ? captureRmsAccum / captureFrameCount : 0;
  const noLiveText = !sourceLiveText;
  const hardSilence = avgCaptureRms < 0.0009 && capturePeakMax < 0.012;
  const likelySilenceWithoutPreview = noLiveText && avgCaptureRms < 0.003 && capturePeakMax < 0.045;
  const tooShortToTrust = recordedSec < 1.25;
  const silentCapture =
    captureFrameCount < 6 ||
    (tooShortToTrust && hardSilence) ||
    (tooShortToTrust && likelySilenceWithoutPreview);

  stopChunkScheduler();
  // Let the last worklet buffers arrive before disconnecting graph.
  await waitForWorkletDrain();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (draftSaveTimer) {
    clearInterval(draftSaveTimer);
    draftSaveTimer = null;
  }
  persistLiveDraft(false);
  if (waveAnimId) {
    cancelAnimationFrame(waveAnimId);
    waveAnimId = 0;
  }
  if (fallbackCaptureTimer) {
    clearTimeout(fallbackCaptureTimer);
    fallbackCaptureTimer = null;
  }
  try {
    if (workletNode) {
      workletNode.disconnect();
      workletNode.port.onmessage = null;
    }
  } catch { }
  try {
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode.onaudioprocess = null;
    }
  } catch { }
  try {
    if (scriptSinkGain) scriptSinkGain.disconnect();
  } catch { }
  try {
    if (analyser) analyser.disconnect();
  } catch { }
  try {
    if (src) src.disconnect();
  } catch { }
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch { }
  stream = null;
  try {
    if (ac) ac.close().catch(() => { });
  } catch { }
  ac = null;
  workletNode = null;
  scriptNode = null;
  scriptSinkGain = null;
  src = null;
  analyser = null;
  try {
    if (ws) ws.close();
  } catch { }
  ws = null;
  isRecording = false;
  silenceStartedAtMs = 0;
  autoStopTriggered = false;
  currentRecordingId = 0;
  window.__transcriptorIsRecording = false;
  window.__transcriptorRmsLevel = 0;
  window.__transcriptorLastFrameAt = 0;
  window.__transcriptorCurrentRecordingId = 0;
  setRecordButton(false);
  waveFrameCount = 0;
  waveBars = [];
  draw();
  resetVU();

  if (silentCapture) {
    $("finalOutput").textContent = "[ Silence ]";
    setStatus("Done");
    try {
      await saveRecordingText({
        title,
        sourceText: sourceLiveText,
        transcriptText: "[ Silence ]",
        provider: providerValue,
        model: modelValue,
        language: languageValue,
      });
    } catch { }
    clearLiveDraft();
    setBusy(false);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    publishFinishedRecording(recordingId, "[ Silence ]");
    return;
  }

  if (!enhance || chunks.length === 0) {
    try {
      await saveRecordingText({
        title,
        sourceText: sourceLiveText,
        transcriptText: "",
        provider: providerValue,
        model: modelValue,
        language: languageValue,
      });
    } catch { }
    clearLiveDraft();
    setBusy(false);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatus("Idle");
    return;
  }

  const provider = effectiveProvider;
  if (!provider) {
    try {
      await saveRecordingText({
        title,
        sourceText: sourceLiveText,
        transcriptText: "",
        provider: "local",
        model: modelValue,
        language: languageValue,
      });
    } catch { }
    clearLiveDraft();
    setBusy(false);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatus("Idle");
    return;
  }

  if (providerValue !== effectiveProvider) {
    setStatus("Processing (Offline Local)");
  } else {
    setStatus("Processing");
  }
  if (provider !== "local" && !isProviderKeyConfigured(provider)) {
    const msg = providerKeyErrorMessage(provider);
    $("progressRow").hidden = true;
    $("finalOutput").textContent = msg;
    setStatus("Error");
    clearLiveDraft();
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    return;
  }
  const transcribeStartedAt = performance.now();
  $("progressRow").hidden = false;
  // Allow next hotkey/session to start while this recording is transcribing.
  setBusy(false);
  try {
    const localAbortController = new AbortController();
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    chunks.forEach((c) => {
      merged.set(c, off);
      off += c.length;
    });
    // For remote providers, use compact WAV (8kHz) — halves payload instantly.
    // For local, use full 16kHz WAV (faster-whisper expects higher quality).
    let audioBlob: Blob;
    let audioName: string;
    if (provider !== "local") {
      audioBlob = encodeCompactWav(merged, AUDIO_TOKENS.liveSampleRateHz, AUDIO_TOKENS.compactSampleRateHz);
      audioName = `live-${Date.now()}.wav`;
    } else {
      audioBlob = encodeWav(merged, AUDIO_TOKENS.liveSampleRateHz);
      audioName = `live-${Date.now()}.wav`;
    }
    const file = new File([audioBlob], audioName, { type: audioBlob.type });
    let transcriptRaw = "";
    if (provider === "local") {
      const create = await localJob(file, {
        language: resolveFastLocalLanguage(($("language") as HTMLSelectElement).value),
        model: resolveFastLiveLocalModel(($("model") as HTMLSelectElement).value),
        splitStereo: false,
        // Live hotkey flow never needs per-word timestamps; disabling speeds up local decoding.
        wordTimestamps: false,
      });
      const { job_id } = create;
      const j = await pollJob(job_id, localAbortController.signal, (job) => {
        $("progressFill").style.width = Math.round((job.progress || 0) * 100) + "%";
        $("progressText").textContent = Math.round((job.progress || 0) * 100) + "%";
      }, {
        initialWaitMs: UI_TOKENS.polling.fastInitialWaitMs,
        maxWaitMs: UI_TOKENS.polling.fastMaxWaitMs,
        growth: UI_TOKENS.polling.fastGrowth,
      });
      applyJobResult(j);
      transcriptRaw = typeof j.result?.text === "string" ? j.result.text.trim() : "";
    } else {
      // Remote provider — use chunked transcription if chunks were pre-transcribed.
      const hasPreTranscribed = chunkTranscriptions.length > 0;
      let tailText = "";
      let forceFullSync = false;

      // Transcribe the remaining tail audio (samples not yet sent by the scheduler).
      let totalSamples = 0;
      for (const c of chunks) totalSamples += c.length;
      const remainingSamples = totalSamples - chunkLastSentSamples;
      if (remainingSamples > UI_TOKENS.capture.tailMinSamples) {
        const allMerged = new Float32Array(totalSamples);
        let mOff = 0;
        for (const c of chunks) { allMerged.set(c, mOff); mOff += c.length; }
        const tailAudio = allMerged.slice(chunkLastSentSamples);
        const tailBlob = encodeCompactWav(tailAudio, AUDIO_TOKENS.liveSampleRateHz, AUDIO_TOKENS.compactSampleRateHz);
        const tailFile = new File([tailBlob], `tail-${Date.now()}.wav`, { type: tailBlob.type });
        try {
          const tailResult = await remoteJobSyncWithFallback(tailFile, {
            provider,
            language: ($("language") as HTMLSelectElement).value,
            diarize: ($("diarizeCheck") as HTMLInputElement).checked,
            openrouterModel: getRemoteModelValue(provider),
          });
          tailText = String(tailResult.text || "").trim();
        } catch { }
      }

      // Wait for any in-flight chunk transcriptions to finish (max 8s).
      if (chunkPendingCount > 0) {
        const deadline = Date.now() + UI_TOKENS.polling.remoteChunkSettleTimeoutMs;
        while (chunkPendingCount > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, UI_TOKENS.polling.remoteChunkSettleWaitMs));
        }
        if (chunkPendingCount > 0) forceFullSync = true;
      }
      if (chunkStates.some((s) => s === "pending" || s === "failed")) {
        forceFullSync = true;
      }

      if (hasPreTranscribed) {
        // Merge all chunk results + tail.
        const parts = chunkTranscriptions
          .map((text, idx) => ({ text: String(text || "").trim(), state: chunkStates[idx] || "failed" }))
          .filter((x) => x.state === "done" && !!x.text)
          .map((x) => x.text);
        if (tailText) parts.push(tailText);
        transcriptRaw = parts.join(" ").trim();
      } else {
        // No chunks were pre-transcribed (recording was too short) — use tail result.
        if (tailText) {
          transcriptRaw = tailText;
        } else {
          // Fallback: send entire recording.
          $("progressFill").style.width = "65%";
          $("progressText").textContent = "65%";
          const syncOut = await remoteJobSyncWithFallback(file, {
            provider,
            language: ($("language") as HTMLSelectElement).value,
            diarize: ($("diarizeCheck") as HTMLInputElement).checked,
            openrouterModel: getRemoteModelValue(provider),
          });
          transcriptRaw = String(syncOut.text || "").trim();
        }
      }

      // Guarantee completeness: if any dispatched chunk did not settle successfully
      // before stop, run one authoritative full-file transcription pass.
      if (forceFullSync || !transcriptRaw) {
        $("progressFill").style.width = "80%";
        $("progressText").textContent = "80%";
        const syncOut = await remoteJobSyncWithFallback(file, {
          provider,
          language: ($("language") as HTMLSelectElement).value,
          diarize: ($("diarizeCheck") as HTMLInputElement).checked,
          openrouterModel: getRemoteModelValue(provider),
        });
        transcriptRaw = String(syncOut.text || "").trim();
      }

      $("finalOutput").textContent = transcriptRaw;
      $("progressFill").style.width = "100%";
      $("progressText").textContent = "100%";
      $("progressRow").hidden = true;
      setStatus("Done");
    }
    let transcriptForPaste = "";
    // Publish raw transcript immediately so paste can happen without waiting for upscale.
    if (transcriptRaw) {
      $("finalOutput").textContent = transcriptRaw;
      publishFinishedRecording(recordingId, transcriptRaw);
      transcriptForPaste = await runUpscaleIfEnabled(transcriptRaw);
      // If upscale changed the text, publish the upgraded version.
      if (transcriptForPaste && transcriptForPaste !== transcriptRaw) {
        publishFinishedRecording(recordingId, transcriptForPaste);
      }
    }
    // saveRecordingText is non-blocking for recordings list reload.
    try {
      await saveRecordingText({
        title,
        sourceText: sourceLiveText,
        transcriptText: transcriptRaw,
        provider,
        model: modelValue,
        language: languageValue,
      });
    } catch { }
    $("transcribeLatency").textContent = fmtMs(performance.now() - transcribeStartedAt);
  } catch (e) {
    $("progressRow").hidden = true;
    $("finalOutput").textContent = (e as Error).message;
    setStatus("Error");
    try {
      await saveRecordingText({
        title,
        sourceText: sourceLiveText,
        transcriptText: "",
        provider,
        model: modelValue,
        language: languageValue,
      });
    } catch { }
    $("transcribeLatency").textContent = fmtMs(performance.now() - transcribeStartedAt);
  } finally {
    clearLiveDraft();
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
  }
  // Signal desktop main process that transcription is complete with final text.
  const _finishedText = (($("upscaleOutput").textContent || "").trim() || ($("finalOutput").textContent || $("liveOutput").textContent || "").trim());
  publishFinishedRecording(recordingId, _finishedText);
}

function setSelectedFile(file: File | null): void {
  if (file && file.size > MAX_FILE_BYTES) {
    selectedFile = null;
    $("fileName").textContent = "No file selected";
    $("finalOutput").textContent = `File is too large. Max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`;
    setStatus("Error");
    return;
  }
  if (file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mimeOk = !file.type || ALLOWED_AUDIO_MIME.has(file.type);
    const extOk = !!ext && ALLOWED_AUDIO_EXT.has(ext);
    if (!mimeOk && !extOk) {
      selectedFile = null;
      $("fileName").textContent = "No file selected";
      $("finalOutput").textContent = "Unsupported audio format. Allowed: WAV, MP3, M4A, FLAC, OGG, AAC, MP4, WEBM.";
      setStatus("Error");
      return;
    }
  }
  selectedFile = file;
  $("fileName").textContent = file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "No file selected";
}

async function transcribeSelectedFile(): Promise<void> {
  if (isBusy) return;
  if (!selectedFile) {
    $("finalOutput").textContent = "Please choose an audio file first.";
    setStatus("Error");
    return;
  }

  resetOutputs();
  setBusy(true);
  const selectedProvider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const provider = resolveEffectiveProvider(selectedProvider);
  if (selectedProvider !== provider) {
    setStatus("Processing (Offline Local)");
  } else {
    setStatus("Processing");
  }
  if (provider !== "local" && !isProviderKeyConfigured(provider)) {
    const msg = providerKeyErrorMessage(provider);
    $("progressRow").hidden = true;
    $("finalOutput").textContent = msg;
    setStatus("Error");
    setBusy(false);
    return;
  }
  const transcribeStartedAt = performance.now();
  $("progressRow").hidden = false;

  try {
    pollAbortController?.abort();
    pollAbortController = new AbortController();
    let create: { job_id: string } | null = null;
    if (provider === "local") {
      create = await localJob(selectedFile, {
        language: resolveFastLocalLanguage(($("language") as HTMLSelectElement).value),
        model: ($("model") as HTMLSelectElement).value,
        splitStereo: ($("splitStereoCheck") as HTMLInputElement).checked,
        wordTimestamps: ($("wordTsCheck") as HTMLInputElement).checked,
      });
    } else {
      const syncOut = await remoteJobSyncWithFallback(selectedFile, {
        provider,
        language: ($("language") as HTMLSelectElement).value,
        diarize: ($("diarizeCheck") as HTMLInputElement).checked,
        openrouterModel: getRemoteModelValue(provider),
      });
      $("finalOutput").textContent = syncOut.text || "";
      $("progressFill").style.width = "100%";
      $("progressText").textContent = "100%";
      $("progressRow").hidden = true;
      setStatus("Done");
      const transcriptRaw = String(syncOut.text || "").trim();
      if (transcriptRaw) {
        await runUpscaleIfEnabled(transcriptRaw);
      }
      $("transcribeLatency").textContent = fmtMs(performance.now() - transcribeStartedAt);
      return;
    }

    const j = await pollJob((create as { job_id: string }).job_id, pollAbortController.signal, (job) => {
      $("progressFill").style.width = Math.round((job.progress || 0) * 100) + "%";
      $("progressText").textContent = Math.round((job.progress || 0) * 100) + "%";
    });
    applyJobResult(j);
    const transcriptRaw = typeof j.result?.text === "string" ? j.result.text.trim() : "";
    if (transcriptRaw) {
      $("finalOutput").textContent = transcriptRaw;
      await runUpscaleIfEnabled(transcriptRaw);
    }
    $("transcribeLatency").textContent = fmtMs(performance.now() - transcribeStartedAt);
  } catch (e) {
    $("progressRow").hidden = true;
    $("finalOutput").textContent = (e as Error).message;
    setStatus("Error");
    $("transcribeLatency").textContent = fmtMs(performance.now() - transcribeStartedAt);
  } finally {
    pollAbortController = null;
    setBusy(false);
  }
}

const drop = $("uploadDrop");
const fileInput = $("fileInput") as HTMLInputElement;

$("pickFileBtn").addEventListener("click", () => fileInput.click());
fileInput.onchange = () => {
  const file = fileInput.files && fileInput.files[0];
  setSelectedFile(file || null);
};

drop.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach((ev) => {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((ev) => {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("drag");
  });
});
drop.addEventListener("drop", (e: DragEvent) => {
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  setSelectedFile(files[0]);
});

$("btnTranscribeFile").addEventListener("click", () => void transcribeSelectedFile());
$("btnStart").addEventListener("click", () => {
  if (isRecording) {
    void stopLive(shouldAutoTranscribe());
  } else {
    void startLive();
  }
});
$("btnStop").addEventListener("click", () => void stopLive(shouldAutoTranscribe()));

window.addEventListener("transcriptor-hotkey-toggle", () => {
  if (isRecording) {
    void stopLive(shouldAutoTranscribe());
  } else {
    void startLive();
  }
});

// Dedicated stop event for overlay stop — avoids dual-path race.
window.addEventListener("transcriptor-hotkey-stop", () => {
  if (isRecording) {
    void stopLive(shouldAutoTranscribe());
  }
});

void loadCfg().then(() => loadMics(false));
initQuickControls();
syncRemoteModelOptions();
void refreshNetworkState();
window.setInterval(() => void refreshNetworkState(), UI_TOKENS.network.refreshIntervalMs);
window.addEventListener("online", () => void refreshNetworkState());
window.addEventListener("offline", () => void refreshNetworkState());
void loadRecordings(false).catch(() => { });
void recoverLiveDraftIfAny();
draw();
syncMode();
setStatus("Idle");
setRecordButton(false);
updateRecordingCopyState();
