import "./styles.css";

type Provider = "local" | "openrouter" | "deepgram" | "";
type RemoteProvider = "openrouter" | "deepgram";
type JobStatus = "queued" | "running" | "done" | "error";
type KeyProvider = "openrouter" | "deepgram";

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
      remote_model_openrouter?: string;
      remote_model_deepgram?: string;
      shortcut_record?: string;
      shortcut_paste?: string;
    };
  };
}

interface RecordingItem {
  name: string;
  display_name: string;
  modified_at: string;
  size_bytes: number;
  provider: string;
  language: string;
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
    __setBackendBootStatus?: (msg: string) => void;
    __setBackendBootError?: (msg: string) => void;
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
    remoteChunkSettleWaitMs: 150,
    remoteChunkSettleTimeoutMs: 3_000,
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
    chunkIntervalMs: 4_000,
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
const DEEPGRAM_AUDIO_MODELS = ["nova-3"];

let isBusy = false;
let isRecording = false;
let mediaRecorder: MediaRecorder | null = null;
let recordedWebmChunks: Blob[] = [];
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
const remoteModelByProvider: Record<RemoteProvider, string> = {
  openrouter: OPENROUTER_AUDIO_MODELS[1],
  deepgram: DEEPGRAM_AUDIO_MODELS[0],
};
const MASKED_KEY_VALUE = "••••••••••••••••••••••••••••••••••••••••";
const keySavedState: Record<KeyProvider, boolean> = {
  openrouter: false,
  deepgram: false,
};

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
  ["btnStart", "btnStop", "btnTranscribeFile", "pickFileBtn", "providerSelect", "remoteModelSelect", "quickProviderSelect", "quickSettingsToggle", "upscaleToggle", "upscalePresetSelect", "upscalePresetAddBtn", "upscalePresetDeleteBtn", "upscalePresetSaveBtn", "upscalePresetCancelBtn", "orKeyActionBtn", "deepgramKeyActionBtn"].forEach((id) => {
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

function keyInput(provider: KeyProvider): HTMLInputElement {
  return $(provider === "openrouter" ? "orKey" : "deepgramKey") as HTMLInputElement;
}

function keyActionButton(provider: KeyProvider): HTMLButtonElement {
  return $(provider === "openrouter" ? "orKeyActionBtn" : "deepgramKeyActionBtn") as HTMLButtonElement;
}

function isMaskedKeyInput(el: HTMLInputElement): boolean {
  return el.dataset.masked === "1";
}

function markKeyMasked(provider: KeyProvider, saved: boolean): void {
  const el = keyInput(provider);
  const isSaved = !!saved;
  keySavedState[provider] = isSaved;
  if (isSaved) {
    el.value = MASKED_KEY_VALUE;
    el.dataset.masked = "1";
    el.readOnly = true;
    el.tabIndex = -1;
    el.style.cursor = "default";
    el.style.pointerEvents = "none";
  } else {
    el.value = "";
    delete el.dataset.masked;
    el.readOnly = false;
    el.tabIndex = 0;
    el.style.cursor = "";
    el.style.pointerEvents = "";
  }
}

function clearMaskedKeyOnEdit(provider: KeyProvider): void {
  const el = keyInput(provider);
  if (!isMaskedKeyInput(el)) return;
  el.value = "";
  delete el.dataset.masked;
}

function syncKeyActionButton(provider: KeyProvider): void {
  const btn = keyActionButton(provider);
  const input = keyInput(provider);
  const masked = isMaskedKeyInput(input);
  const hasTyped = !masked && !!input.value.trim();
  const canDelete = keySavedState[provider] && !hasTyped;
  const canSave = hasTyped;
  btn.classList.toggle("delete", canDelete);
  btn.classList.toggle("save", !canDelete);
  btn.disabled = !(canDelete || canSave);
  btn.title = canDelete ? "Delete key" : "Save key";
  btn.setAttribute("aria-label", canDelete ? "Delete key" : "Save key");
}

// Auto-stop silence detection is handled exclusively by the overlay main process
// (desktop/main.js showRecordingOverlay waveMonitor). No frontend-side auto-stop.

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
    const v = (remoteModelByProvider.openrouter || "").trim();
    return v || OPENROUTER_AUDIO_MODELS[1];
  }
  if (provider === "deepgram") {
    const v = (remoteModelByProvider.deepgram || "").trim();
    return v || DEEPGRAM_AUDIO_MODELS[0];
  }
  return ($("model") as HTMLSelectElement).value || "small";
}

function syncRemoteModelOptions(): void {
  const provider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const sel = $("remoteModelSelect") as HTMLSelectElement;
  if (provider === "local" || !provider) {
    sel.hidden = true;
    return;
  }
  if (provider === "deepgram") {
    sel.hidden = false;
    sel.innerHTML = "";
    DEEPGRAM_AUDIO_MODELS.forEach((model) => {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      sel.appendChild(opt);
    });
    const preferredDeepgram = (remoteModelByProvider.deepgram || "").trim() || DEEPGRAM_AUDIO_MODELS[0];
    sel.value = DEEPGRAM_AUDIO_MODELS.includes(preferredDeepgram) ? preferredDeepgram : DEEPGRAM_AUDIO_MODELS[0];
    remoteModelByProvider.deepgram = sel.value;
    return;
  }
  const preferred = (remoteModelByProvider.openrouter || "").trim() || OPENROUTER_AUDIO_MODELS[1];
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
  remoteModelByProvider.openrouter = sel.value;
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
  if (opts.provider === "openrouter" || opts.provider === "deepgram") {
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
  if (opts.provider === "openrouter" || opts.provider === "deepgram") {
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
  // Single implementation — kept as a named function for stack trace readability
  // and to provide a single place for future fallback/retry logic.
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
): Promise<{ job_id: string }> {
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
  const live = true;

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
    $("windowViewLabel").textContent = v === "settings" ? "Settings" : v === "recordings" ? "Recordings" : v === "graph" ? "Graph" : "Record";
    if (v === "recordings") {
      void loadRecordings(false);
    }
    if (v === "graph") {
      void loadGraphData();
    }
  });
});

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

// --- Ring buffer for waveform bars (avoids GC-heavy Array.slice) ---
const WAVE_BUF_CAP = 512;
const waveBuf = new Float32Array(WAVE_BUF_CAP);
let waveBufHead = 0;
let waveBufLen = 0;
let maxBars = 0;
let waveAnimId = 0;
const BAR_W = 3;
const BAR_GAP = 2;
const WAVE_METER_INTERVAL_MS = 50;
const WAVE_PUSH_EVERY_FRAMES = 2;
let waveFrameCount = 0;
let waveDirty = false;

function waveBarAt(reverseIdx: number): number {
  const idx = (waveBufHead - 1 - reverseIdx + WAVE_BUF_CAP) % WAVE_BUF_CAP;
  return waveBuf[idx];
}

function wavePush(v: number): void {
  waveBuf[waveBufHead] = v;
  waveBufHead = (waveBufHead + 1) % WAVE_BUF_CAP;
  if (waveBufLen < WAVE_BUF_CAP) waveBufLen++;
  waveDirty = true;
}

function waveClear(): void {
  waveBufHead = 0;
  waveBufLen = 0;
}

function resize(): void {
  const r = (canvas.parentElement as HTMLElement).getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;
  maxBars = Math.max(32, Math.floor(r.width / (BAR_W + BAR_GAP)) + 4);
  draw();
}
new ResizeObserver(resize).observe(canvas.parentElement as Element);
resize();

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const mid = H / 2;
  if (waveBufLen === 0) {
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
    return;
  }

  const count = Math.min(maxBars, waveBufLen);
  for (let i = 0; i < count; i++) {
    const v = waveBarAt(i);
    const x = W - (i + 1) * (BAR_W + BAR_GAP);
    if (x < 0) break;

    const h = Math.max(2, Math.min(H - 4, v * (H * 0.92)));
    const y = (H - h) / 2;

    ctx.fillStyle = "rgba(170,170,170,0.28)";
    ctx.fillRect(x, y, BAR_W, h);
    ctx.fillStyle = "rgba(210,210,210,0.7)";
    ctx.fillRect(x, y + h * 0.15, BAR_W, h * 0.7);
  }
  waveDirty = false;
}

// --- rAF-driven render loop (decoupled from data collection) ---
let waveLoopRunning = false;
function waveLoop(): void {
  if (!waveLoopRunning) return;
  if (waveDirty) draw();
  requestAnimationFrame(waveLoop);
}
function startWaveLoop(): void {
  if (waveLoopRunning) return;
  waveLoopRunning = true;
  requestAnimationFrame(waveLoop);
}
function stopWaveLoop(): void {
  waveLoopRunning = false;
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
    mode: "live",
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
    remote_model_openrouter: (remoteModelByProvider.openrouter || "").trim() || OPENROUTER_AUDIO_MODELS[1],
    remote_model_deepgram: (remoteModelByProvider.deepgram || "").trim() || DEEPGRAM_AUDIO_MODELS[0],
    shortcut_record: currentShortcuts.record,
    shortcut_paste: currentShortcuts.paste,
  };
}

// ── Keyboard Shortcut Picker ────────────────────────────────────────────────

const DEFAULT_SHORTCUTS = { record: "Alt+Left", paste: "Alt+Shift+7" };
let currentShortcuts = { ...DEFAULT_SHORTCUTS };
let activeShortcutBtn: HTMLButtonElement | null = null;

/** Convert Electron accelerator string → human-readable macOS symbols */
function acceleratorToDisplay(acc: string): string {
  if (!acc) return "—";
  const parts = acc.split("+");
  const symbols: string[] = [];
  for (const p of parts) {
    const lc = p.trim().toLowerCase();
    if (lc === "command" || lc === "cmd" || lc === "meta" || lc === "super") { symbols.push("⌘"); continue; }
    if (lc === "control" || lc === "ctrl" || lc === "commandorcontrol" || lc === "cmdorctrl") { symbols.push("⌃"); continue; }
    if (lc === "alt" || lc === "option") { symbols.push("⌥"); continue; }
    if (lc === "shift") { symbols.push("⇧"); continue; }
    // Arrow keys
    if (lc === "left" || lc === "arrowleft") { symbols.push("←"); continue; }
    if (lc === "right" || lc === "arrowright") { symbols.push("→"); continue; }
    if (lc === "up" || lc === "arrowup") { symbols.push("↑"); continue; }
    if (lc === "down" || lc === "arrowdown") { symbols.push("↓"); continue; }
    if (lc === "space") { symbols.push("␣"); continue; }
    if (lc === "enter" || lc === "return") { symbols.push("↩"); continue; }
    if (lc === "backspace" || lc === "delete") { symbols.push("⌫"); continue; }
    if (lc === "tab") { symbols.push("⇥"); continue; }
    if (lc === "escape" || lc === "esc") { symbols.push("⎋"); continue; }
    symbols.push(p.trim().toUpperCase());
  }
  return symbols.join(" ");
}

/** Convert KeyboardEvent → Electron accelerator string */
function keyEventToAccelerator(e: KeyboardEvent): string | null {
  // Must have at least one modifier
  if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) return null;
  // Ignore standalone modifier keys
  if (["Alt", "Control", "Meta", "Shift"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Map the key
  const key = e.key;
  if (key === "ArrowLeft") parts.push("Left");
  else if (key === "ArrowRight") parts.push("Right");
  else if (key === "ArrowUp") parts.push("Up");
  else if (key === "ArrowDown") parts.push("Down");
  else if (key === " ") parts.push("Space");
  else if (key === "Enter") parts.push("Enter");
  else if (key === "Backspace") parts.push("Backspace");
  else if (key === "Delete") parts.push("Delete");
  else if (key === "Tab") parts.push("Tab");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join("+");
}

function updateShortcutDisplay(btnId: string, accelerator: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return;
  const keysSpan = btn.querySelector(".shortcut-keys");
  if (keysSpan) keysSpan.textContent = acceleratorToDisplay(accelerator);
}

function startShortcutRecording(btn: HTMLButtonElement): void {
  // Cancel any existing recording
  stopShortcutRecording(false);
  activeShortcutBtn = btn;
  btn.classList.add("recording");
  const keysSpan = btn.querySelector(".shortcut-keys");
  if (keysSpan) keysSpan.textContent = "Press keys...";
  // Add global keydown listener
  document.addEventListener("keydown", handleShortcutKeydown, true);
}

function stopShortcutRecording(restoreDisplay: boolean): void {
  if (!activeShortcutBtn) return;
  activeShortcutBtn.classList.remove("recording");
  if (restoreDisplay) {
    const id = activeShortcutBtn.dataset.shortcutId;
    const acc = id === "record" ? currentShortcuts.record : currentShortcuts.paste;
    const keysSpan = activeShortcutBtn.querySelector(".shortcut-keys");
    if (keysSpan) keysSpan.textContent = acceleratorToDisplay(acc);
  }
  document.removeEventListener("keydown", handleShortcutKeydown, true);
  activeShortcutBtn = null;
}

function handleShortcutKeydown(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (e.key === "Escape") {
    stopShortcutRecording(true);
    return;
  }

  const accelerator = keyEventToAccelerator(e);
  if (!accelerator) return; // Still pressing only modifiers

  if (!activeShortcutBtn) return;
  const id = activeShortcutBtn.dataset.shortcutId;
  if (id === "record") {
    currentShortcuts.record = accelerator;
  } else if (id === "paste") {
    currentShortcuts.paste = accelerator;
  }

  // Update display
  const keysSpan = activeShortcutBtn.querySelector(".shortcut-keys");
  if (keysSpan) keysSpan.textContent = acceleratorToDisplay(accelerator);

  stopShortcutRecording(false);

  // Persist to config
  queueUiPreferencesSave();

  // Signal the Electron main process to reload shortcuts
  (window as any).__transcriptorPendingShortcuts = {
    record: currentShortcuts.record,
    paste: currentShortcuts.paste,
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
    const openrouterModel = (remoteModelByProvider.openrouter || "").trim() || OPENROUTER_AUDIO_MODELS[1];
    ($("orModel") as HTMLInputElement).value = openrouterModel;
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
    markKeyMasked("openrouter", hasOpenrouterKey);
    markKeyMasked("deepgram", hasDeepgramKey);
    keyInput("openrouter").placeholder = "OPENROUTER_API_KEY";
    keyInput("deepgram").placeholder = "DEEPGRAM_API_KEY";
    syncKeyActionButton("openrouter");
    syncKeyActionButton("deepgram");
    const cfgOpenrouterModel = (cfg.preferences || {}).openrouter?.model || "google/gemini-2.5-flash";
    ($("orModel") as HTMLInputElement).value = cfgOpenrouterModel;
    ($("recordingsDirInput") as HTMLInputElement).value = (cfg.preferences || {}).recordings_dir || "";
    const ui = (cfg.preferences || {}).ui || {};
    remoteModelByProvider.openrouter = String(ui.remote_model_openrouter || cfgOpenrouterModel || "").trim() || OPENROUTER_AUDIO_MODELS[1];
    remoteModelByProvider.deepgram = String(ui.remote_model_deepgram || DEEPGRAM_AUDIO_MODELS[0] || "").trim() || DEEPGRAM_AUDIO_MODELS[0];
    const languageSel = $("language") as HTMLSelectElement;
    const providerSel = $("providerSelect") as HTMLSelectElement;
    const quickProviderSel = $("quickProviderSelect") as HTMLSelectElement;
    const modelSel = $("model") as HTMLSelectElement;
    syncMode();
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
    livePreview.checked = ui.live_preview === true;
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
    syncRemoteModelOptions();
    const remoteSel = $("remoteModelSelect") as HTMLSelectElement;
    if (providerSel.value === "openrouter") {
      remoteSel.value = getRemoteModelValue("openrouter");
    } else if (providerSel.value === "deepgram") {
      remoteSel.value = getRemoteModelValue("deepgram");
    }
    await loadUpscalePresets(pendingUpscalePresetId);
    syncQuickSettingsVisibility(ui.quick_settings_open === true);
    // Load keyboard shortcuts
    if (ui.shortcut_record) currentShortcuts.record = ui.shortcut_record;
    if (ui.shortcut_paste) currentShortcuts.paste = ui.shortcut_paste;
    updateShortcutDisplay("shortcutRecord", currentShortcuts.record);
    updateShortcutDisplay("shortcutPaste", currentShortcuts.paste);
  } catch {
    try {
      await loadUpscalePresets("builtin_clean");
    } catch { }
  } finally {
    suppressUiPrefAutosave = false;
  }
}

async function saveProviderKey(provider: KeyProvider): Promise<void> {
  const input = keyInput(provider);
  const value = isMaskedKeyInput(input) ? "" : input.value.trim();
  if (!value) return;
  await apiPost<{ ok: boolean }>("/api/config", {
    providers: {
      [provider]: { key: value },
    },
  });
  if (provider === "openrouter") {
    hasOpenrouterKey = true;
  } else {
    hasDeepgramKey = true;
  }
  markKeyMasked(provider, true);
  syncKeyActionButton(provider);
}

async function deleteProviderKey(provider: KeyProvider): Promise<void> {
  await apiPost<{ ok: boolean }>("/api/config", {
    providers: {
      [provider]: { key: "" },
    },
  });
  if (provider === "openrouter") {
    hasOpenrouterKey = false;
  } else {
    hasDeepgramKey = false;
  }
  markKeyMasked(provider, false);
  syncKeyActionButton(provider);
}

async function handleKeyAction(provider: KeyProvider): Promise<void> {
  const btn = keyActionButton(provider);
  if (btn.classList.contains("delete")) {
    await deleteProviderKey(provider);
    return;
  }
  await saveProviderKey(provider);
}

($("recordingsDirInput") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceEnabled") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceSeconds") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("autoStopSilenceDb") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
($("upscaleToggle") as HTMLInputElement).addEventListener("change", () => queueUiPreferencesSave());
["openrouter", "deepgram"].forEach((providerName) => {
  const provider = providerName as KeyProvider;
  const input = keyInput(provider);
  const btn = keyActionButton(provider);
  input.addEventListener("focus", () => {
    clearMaskedKeyOnEdit(provider);
    syncKeyActionButton(provider);
  });
  input.addEventListener("input", () => {
    syncKeyActionButton(provider);
  });
  btn.addEventListener("click", () => {
    void handleKeyAction(provider).catch((e: Error) => {
      console.error(e.message);
      syncKeyActionButton(provider);
    });
  });
});
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
  remoteModelByProvider.openrouter = (($("orModel") as HTMLInputElement).value || "").trim() || OPENROUTER_AUDIO_MODELS[1];
  syncRemoteModelOptions();
  queueUiPreferencesSave();
});
$("pickRecordingsDirBtn").addEventListener("click", () =>
  void apiPost<{ path: string }>("/api/recordings/pick-folder", {})
    .then((r) => {
      ($("recordingsDirInput") as HTMLInputElement).value = r.path || "";
      queueUiPreferencesSave();
    })
    .catch((e: Error) => {
      console.error(e.message);
    })
);
$("openRecordingsDirBtn").addEventListener("click", () =>
  void apiPost<{ ok: boolean; path: string }>("/api/recordings/open-folder", {
    path: ($("recordingsDirInput") as HTMLInputElement).value.trim(),
  })
    .catch((e: Error) => {
      console.error(e.message);
    })
);

// ── Shortcut picker click listeners ─────────────────────────────────────────
$("shortcutRecord").addEventListener("click", (e) => {
  e.preventDefault();
  startShortcutRecording($("shortcutRecord") as HTMLButtonElement);
});
$("shortcutPaste").addEventListener("click", (e) => {
  e.preventDefault();
  startShortcutRecording($("shortcutPaste") as HTMLButtonElement);
});

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
    const providerBadge = it.provider && it.provider !== "unknown" ? `<span class="rec-provider">${it.provider}</span>` : "";
    btn.innerHTML = `<span class="rec-title">${it.display_name}</span><span class="rec-meta">${fmtDateTime(it.modified_at)} · ${Math.round(
      it.size_bytes / 1024
    )} KB${providerBadge ? " · " + providerBadge : ""}</span>`;
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
  const providerTotals = new Map<string, number>();
  (s.providers || []).forEach((p) => {
    const key = String(p.name || "").trim().toLowerCase();
    if (!key || key === "fal" || key === "fal.ai" || key === "falai") return;
    providerTotals.set(key, (providerTotals.get(key) || 0) + Number(p.count || 0));
  });
  ["local", "openrouter", "deepgram"].forEach((key) => {
    if (!providerTotals.has(key)) providerTotals.set(key, 0);
  });
  const providerItems = Array.from(providerTotals.entries())
    .sort((a, b) => {
      const order = ["local", "openrouter", "deepgram"];
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return b[1] - a[1];
    })
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  providerItems.forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = `${p.name} (${p.count})`;
    providers.appendChild(chip);
  });

  const languages = $("statsLanguages");
  languages.innerHTML = "";
  const languageTotals = new Map<string, number>();
  (s.languages || []).forEach((l) => {
    const key = String(l.name || "").trim().toLowerCase();
    if (!key) return;
    languageTotals.set(key, (languageTotals.get(key) || 0) + Number(l.count || 0));
  });
  if (!languageTotals.has("auto")) languageTotals.set("auto", 0);
  const languageItems = Array.from(languageTotals.entries())
    .sort((a, b) => {
      if (a[0] === "auto") return -1;
      if (b[0] === "auto") return 1;
      return b[1] - a[1];
    })
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  languageItems.forEach((l) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = `${l.name} (${l.count})`;
    languages.appendChild(chip);
  });
}

async function openRecording(name: string): Promise<void> {
  selectedRecordingName = name;
  renderRecordingsList();
  const r = await apiGet<{ name: string; modified_at: string; size_bytes: number; content: string }>(
    "/api/recordings/" + encodeURIComponent(name)
  );
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

// ── Delete All recordings ──
$("recordingsDeleteAllBtn").addEventListener("click", () => {
  ($("deleteAllModal") as HTMLElement).hidden = false;
});
$("deleteAllCancelBtn").addEventListener("click", () => {
  ($("deleteAllModal") as HTMLElement).hidden = true;
});
$("deleteAllConfirmBtn").addEventListener("click", async () => {
  try {
    const r = await fetch(`/api/recordings?token=${encodeURIComponent(apiToken())}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    $("recordingContent").textContent = `Deleted ${data.deleted} recording(s).`;
    $("recordingMeta").textContent = "";
    await loadRecordings(true);
  } catch (e: unknown) {
    $("recordingContent").textContent = `Delete failed: ${(e as Error).message}`;
  } finally {
    ($("deleteAllModal") as HTMLElement).hidden = true;
  }
});

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
  if (!livePreviewToggle.checked && ws) {
    try {
      ws.close();
    } catch { }
    ws = null;
    if (isRecording) setStatus("Recording");
  }
  queueUiPreferencesSave();
});

function shouldAutoTranscribe(): boolean {
  return autoToggle.checked;
}

function shouldLivePreview(): boolean {
  return livePreviewToggle.checked;
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
  const provider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  if (v && provider === "openrouter") {
    remoteModelByProvider.openrouter = v;
    ($("orModel") as HTMLInputElement).value = v;
  }
  if (v && provider === "deepgram") {
    remoteModelByProvider.deepgram = v;
  }
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
let chunkSubmitTimer: number | null = null;
let chunkAbortController: AbortController | null = null;
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

// (Chunked pipeline removed — single sync call is faster and simpler.)

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
  // CRITICAL: set __transcriptorRmsLevel here too, not just in setVU.
  // The overlay main process reads this for silence detection.
  // setVU runs in rAF which stalls when the window is hidden.
  window.__transcriptorRmsLevel = Math.max(0, Number.isFinite(rms) ? rms : 0);
  window.__transcriptorVuLevel = Math.max(0, Math.min(1, rms * UI_TOKENS.capture.vuAmplify));
  if (!ac) return;
  const ds = downsample(input, ac.sampleRate, AUDIO_TOKENS.liveSampleRateHz);
  chunks.push(new Float32Array(ds));
  // Enterprise memory management: consolidate fragments periodically to avoid
  // GC pressure and O(n) merge cost at stop time for long recordings.
  if (chunks.length > 500) {
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    chunks.length = 0;
    chunks.push(merged);
  }
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
  // Recording started — transcription happens on stop via single sync call.
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
      if (!shouldLivePreview()) return;
      $("liveOutput").textContent += "\n[WebSocket error]";
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      if (!shouldLivePreview()) return;
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
    recordedWebmChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedWebmChunks.push(e.data);
      };
      mediaRecorder.start(1000);
    } catch (e) {
      console.warn("MediaRecorder failed, falling back to WAV encoder", e);
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
    // Use setInterval instead of requestAnimationFrame.
    // rAF throttles to ~0 fps when the Electron window is hidden (which it
    // always is during overlay recording). setInterval keeps firing reliably.
    let vuIntervalId: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      if (!analyser) {
        if (vuIntervalId) { clearInterval(vuIntervalId); vuIntervalId = null; }
        return;
      }
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

      waveFrameCount += 1;
      if (waveFrameCount % WAVE_PUSH_EVERY_FRAMES === 0) {
        const level = Math.min(1, rms * UI_TOKENS.capture.waveformMixRms + peak * UI_TOKENS.capture.waveformMixPeak);
        wavePush(level);
      }
    };
    vuIntervalId = setInterval(tick, WAVE_METER_INTERVAL_MS);
    startWaveLoop();

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
        if (shouldLivePreview()) {
          const cur = $("liveOutput").textContent || "";
          if (!cur.includes("[Mic fallback engaged]")) {
            $("liveOutput").textContent = (cur ? `${cur}\n` : "") + "[Mic fallback engaged]";
          }
        }
      } catch { }
    }, UI_TOKENS.capture.fallbackInitDelayMs);
    
    if (chunkSubmitTimer) {
      clearInterval(chunkSubmitTimer);
    }
    let chunkInFlight = false;
    chunkAbortController = new AbortController();
    chunkSubmitTimer = window.setInterval(async () => {
      if (!isRecording || recordedWebmChunks.length < 3) return;
      if (chunkInFlight) return; // Don't stack concurrent API calls
      const providerStr = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
      const provider = resolveEffectiveProvider(providerStr);
      if (provider === "local" || !isProviderKeyConfigured(provider)) return;

      const webmBlob = new Blob(recordedWebmChunks, { type: "audio/webm" });
      const file = new File([webmBlob], `live-snap-${Date.now()}.webm`, { type: webmBlob.type });

      chunkInFlight = true;
      try {
        const out = await remoteJobSyncWithFallback(file, {
          provider,
          language: ($("language") as HTMLSelectElement).value,
          diarize: ($("diarizeCheck") as HTMLInputElement).checked,
          openrouterModel: getRemoteModelValue(provider),
        });
        if (isRecording && out && out.text) {
          $("liveOutput").textContent = out.text;
          $("liveOutput").scrollTop = $("liveOutput").scrollHeight;
          persistLiveDraft(true);
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          console.warn("Chunk upload failed", e);
        }
      } finally {
        chunkInFlight = false;
      }
    }, 5000);

  } catch (e) {
    if (shouldLivePreview()) {
      $("liveOutput").textContent = micErrorTag(e) || (e as Error).message;
    }
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
  let title = "Recording " + new Date().toLocaleString();
  const _smartTitle = (text: string): string => {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) return title;
    const preview = words.slice(0, 8).join(" ");
    return preview.length > 80 ? preview.slice(0, 77) + "..." : preview;
  };
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

  // ── Fast path for remote providers: fire API call BEFORE cleanup ──────────
  // Snapshot audio and start the Deepgram/OpenRouter request immediately.
  // The ~2s API latency overlaps with the ~400ms of UI cleanup below.
  const provider = effectiveProvider;
  const isRemote = provider !== "local" && !!provider && enhance && chunks.length > 0;
  let remoteApiPromise: Promise<{ text: string; provider: string; model?: string }> | null = null;

  if (isRemote && isProviderKeyConfigured(provider)) {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        mediaRecorder!.onstop = () => resolve();
        mediaRecorder!.stop();
      });
      const webmBlob = new Blob(recordedWebmChunks, { type: "audio/webm" });
      const file = new File([webmBlob], `live-${Date.now()}.webm`, { type: webmBlob.type });
      remoteApiPromise = remoteJobSyncWithFallback(file, {
        provider,
        language: (document.getElementById("language") as HTMLSelectElement).value,
        diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
        openrouterModel: getRemoteModelValue(provider),
      });
    } else {
      // Snapshot chunks NOW (before cleanup clears them)
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      chunks.forEach((c) => { merged.set(c, off); off += c.length; });
      const audioBlob = encodeCompactWav(merged, AUDIO_TOKENS.liveSampleRateHz, AUDIO_TOKENS.compactSampleRateHz);
      const file = new File([audioBlob], `live-${Date.now()}.wav`, { type: audioBlob.type });
      // Fire API call NOW — don't await, let it run during cleanup
      remoteApiPromise = remoteJobSyncWithFallback(file, {
        provider,
        language: (document.getElementById("language") as HTMLSelectElement).value,
        diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
        openrouterModel: getRemoteModelValue(provider),
      });
    }
  }

  // ── Cleanup (runs while API call is in flight) ──────────────────────────
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (chunkSubmitTimer) {
    clearInterval(chunkSubmitTimer);
    chunkSubmitTimer = null;
  }
  if (chunkAbortController) {
    chunkAbortController.abort();
    chunkAbortController = null;
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
  mediaRecorder = null;
  recordedWebmChunks = [];
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
  waveClear();
  stopWaveLoop();
  draw();
  resetVU();

  if (silentCapture) {
    $("finalOutput").textContent = "[ Silence ]";
    setStatus("Done");
    try {
      await saveRecordingText({
        title: _smartTitle(sourceLiveText),
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
        title: _smartTitle(sourceLiveText),
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

  if (!provider) {
    try {
      await saveRecordingText({
        title: _smartTitle(sourceLiveText),
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
    let transcriptRaw = "";
    if (provider === "local") {
      // Local provider: encode and submit job
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      chunks.forEach((c) => { merged.set(c, off); off += c.length; });
      const audioBlob = encodeWav(merged, AUDIO_TOKENS.liveSampleRateHz);
      const file = new File([audioBlob], `live-${Date.now()}.wav`, { type: audioBlob.type });
      const localAbortController = new AbortController();
      const create = await localJob(file, {
        language: resolveFastLocalLanguage(($("language") as HTMLSelectElement).value),
        model: resolveFastLiveLocalModel(($("model") as HTMLSelectElement).value),
        splitStereo: false,
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
      // ── Remote provider: instant draft + background refinement ─────────
      // Show chunk-timer preview text IMMEDIATELY so user sees results
      // in <100ms. The full-audio API result replaces it when ready.
      const chunkDraft = ($("liveOutput").textContent || "").trim();
      if (chunkDraft) {
        $("finalOutput").textContent = chunkDraft;
        transcriptRaw = chunkDraft;
        setStatus("Refining...");
      }
      $("progressFill").style.width = "50%";
      $("progressText").textContent = "50%";
      if (remoteApiPromise) {
        try {
          const syncOut = await remoteApiPromise;
          const finalText = String(syncOut.text || "").trim();
          if (finalText) {
            transcriptRaw = finalText;
          }
        } catch (e) {
          console.warn("Final transcription failed, using draft:", e);
          // Keep the chunkDraft as transcriptRaw
        }
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
      title = _smartTitle(transcriptRaw);
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
        title: _smartTitle(sourceLiveText),
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

// ══════════════════════════════════════════════════════════════
// ██  Graph Tab — Semantic Cluster Graph                    ██
// ══════════════════════════════════════════════════════════════

interface GraphNode {
  name: string;
  displayName: string;
  provider: string;
  keywords: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const GRAPH_COLORS: Record<string, string> = {
  local: "#888888",
  openrouter: "#6c90c6",
  deepgram: "#79b88a",
  unknown: "#777777",
  toi: "#a888cc",
};
const GRAPH_PROVIDER_LABELS: Record<string, string> = {
  local: "Local", openrouter: "OpenRouter", deepgram: "Deepgram", unknown: "Unknown", toi: "TOI",
};

const G_ZOOM_FACTOR = 1.1;
const G_ZOOM_MIN = 0.02;
const G_ZOOM_MAX = 12;
const G_DRAG_THRESHOLD = 4;

let gNodes: GraphNode[] = [];
let gEdges: [number, number][] = [];
let gZoom = 1;
let gPanX = 0;
let gPanY = 0;
let gDragging = false;
let gDragStartX = 0;
let gDragStartY = 0;
let gDragPanStartX = 0;
let gDragPanStartY = 0;
let gDragDist = 0;
let gHovered: GraphNode | null = null;
let gCssW = 0;
let gCssH = 0;

function gHex(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function gColor(p: string): string { return GRAPH_COLORS[p] || GRAPH_COLORS.unknown; }

function gKeywordSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const w of a) { if (setB.has(w)) shared++; }
  return shared / Math.max(a.length, b.length);
}

/** O(N) keyword-cluster layout — groups nodes by top keyword, places clusters in spiral */
function gClusterLayout(): void {
  const clusters: Map<string, number[]> = new Map();
  gNodes.forEach((n, i) => {
    const key = n.keywords.length > 0 ? n.keywords[0] : "__none__";
    let arr = clusters.get(key);
    if (!arr) { arr = []; clusters.set(key, arr); }
    arr.push(i);
  });

  const clusterList = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  const spacing = Math.max(80, Math.sqrt(gNodes.length) * 10);
  let angle = 0;
  let spiralR = 0;

  clusterList.forEach(([, indices], ci) => {
    let cx: number, cy: number;
    if (ci === 0) {
      cx = 0; cy = 0;
    } else {
      angle += 2.4 / Math.sqrt(ci);
      spiralR += spacing / (2 * Math.PI);
      cx = Math.cos(angle) * spiralR;
      cy = Math.sin(angle) * spiralR;
    }

    const n = indices.length;
    const clusterR = Math.max(20, Math.sqrt(n) * 14);
    indices.forEach((nodeIdx, j) => {
      if (n === 1) {
        gNodes[nodeIdx].x = cx + (Math.random() - 0.5) * 6;
        gNodes[nodeIdx].y = cy + (Math.random() - 0.5) * 6;
      } else {
        const a2 = (2 * Math.PI * j) / n;
        const r2 = clusterR * (0.3 + 0.7 * Math.random());
        gNodes[nodeIdx].x = cx + Math.cos(a2) * r2;
        gNodes[nodeIdx].y = cy + Math.sin(a2) * r2;
      }
    });
  });
}

/** Pre-compute edges, capped at 400 strongest */
function gComputeEdges(): void {
  const N = gNodes.length;
  const MAX_EDGES = 400;
  const candidates: { i: number; j: number; sim: number }[] = [];

  if (N > 300) {
    const kwMap: Map<string, number[]> = new Map();
    gNodes.forEach((nd, i) => {
      for (const kw of nd.keywords) {
        let arr = kwMap.get(kw);
        if (!arr) { arr = []; kwMap.set(kw, arr); }
        arr.push(i);
      }
    });
    const seen = new Set<string>();
    kwMap.forEach((indices) => {
      for (let a = 0; a < Math.min(indices.length, 40); a++) {
        for (let b = a + 1; b < Math.min(indices.length, 40); b++) {
          const ii = indices[a], jj = indices[b];
          const key = ii < jj ? `${ii}_${jj}` : `${jj}_${ii}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sim = gKeywordSimilarity(gNodes[ii].keywords, gNodes[jj].keywords);
          if (sim >= 0.3) candidates.push({ i: ii, j: jj, sim });
        }
      }
    });
  } else {
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const sim = gKeywordSimilarity(gNodes[i].keywords, gNodes[j].keywords);
        if (sim >= 0.2) candidates.push({ i, j, sim });
      }
    }
  }

  candidates.sort((a, b) => b.sim - a.sim);
  gEdges = candidates.slice(0, MAX_EDGES).map((cc) => [cc.i, cc.j]);
}

function gCenterView(): void {
  if (gNodes.length === 0) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  gNodes.forEach((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); });
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const spanX = maxX - minX + 100, spanY = maxY - minY + 100;
  const cw = gCssW || 800, ch = gCssH || 600;
  gZoom = Math.min(cw / spanX, ch / spanY, 2);
  gZoom = Math.max(G_ZOOM_MIN, Math.min(G_ZOOM_MAX, gZoom));
  gPanX = cw / 2 - cx * gZoom;
  gPanY = ch / 2 - cy * gZoom;
}

function gExtractKeywordsFromTitle(title: string): string[] {
  const words = (title || "").toLowerCase().replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  return words.slice(0, 8);
}

async function loadGraphData(): Promise<void> {
  try {
    let items: Array<{ name: string; display_name: string; provider: string; keywords: string[] }> = [];
    try {
      const r = await apiGet<{ nodes: Array<{ name: string; display_name: string; provider: string; keywords: string[]; size_bytes: number }> }>("/api/recordings/graph");
      items = (r.nodes || []).map((it) => ({
        name: it.name, display_name: it.display_name,
        provider: it.provider || "unknown", keywords: it.keywords || [],
      }));
    } catch {
      const r = await apiGet<{ items: RecordingItem[] }>("/api/recordings");
      items = (r.items || []).map((it) => ({
        name: it.name, display_name: it.display_name,
        provider: it.provider || "unknown",
        keywords: gExtractKeywordsFromTitle(it.display_name),
      }));
    }

    gNodes = items.map((it) => ({
      name: it.name, displayName: it.display_name,
      provider: it.provider || "unknown", keywords: it.keywords || [],
      x: 0, y: 0, vx: 0, vy: 0,
      r: Math.max(3, Math.min(10, 3 + Math.sqrt(Math.max((it.keywords || []).length, 1)) * 1.5)),
    }));
    $("graphInfoText").textContent = `${gNodes.length} recording${gNodes.length === 1 ? "" : "s"}`;
    if (gNodes.length === 0) { gRender(); return; }

    gClusterLayout();
    gComputeEdges();
    gCenterView();
    gRender();
  } catch (e) {
    $("graphInfoText").textContent = "Error: " + (e as Error).message;
  }
}

function gRender(): void {
  const gc = $("graphCanvas") as HTMLCanvasElement;
  const container = $("graphContainer");
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  gCssW = rect.width; gCssH = rect.height;
  gc.width = rect.width * dpr; gc.height = rect.height * dpr;
  gc.style.width = rect.width + "px"; gc.style.height = rect.height + "px";
  const c = gc.getContext("2d")!;
  c.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  c.fillStyle = "#121212";
  c.fillRect(0, 0, W, H);

  if (gNodes.length === 0) {
    c.fillStyle = "#8f8f8f"; c.font = "13px 'SF Pro Text', -apple-system, sans-serif";
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText("No recordings to display", W / 2, H / 2);
    c.font = "10px 'SF Pro Text', -apple-system, sans-serif"; c.fillStyle = "#666";
    c.fillText("Create recordings to see them visualized here", W / 2, H / 2 + 22);
    return;
  }

  // Viewport in graph coords
  const vl = -gPanX / gZoom, vt = -gPanY / gZoom;
  const vr = (W - gPanX) / gZoom, vb = (H - gPanY) / gZoom;
  const pad = 20 / gZoom;

  c.save();
  c.translate(gPanX, gPanY);
  c.scale(gZoom, gZoom);

  // Edges — single batched path
  if (gEdges.length > 0) {
    c.beginPath();
    c.strokeStyle = "rgba(255,255,255,0.04)";
    c.lineWidth = 0.4;
    for (const [ai, bi] of gEdges) {
      const ax = gNodes[ai].x, ay = gNodes[ai].y;
      const bx = gNodes[bi].x, by = gNodes[bi].y;
      if (Math.max(ax, bx) < vl || Math.min(ax, bx) > vr || Math.max(ay, by) < vt || Math.min(ay, by) > vb) continue;
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
    }
    c.stroke();
  }

  // Nodes — batched per color
  const byColor: Map<string, GraphNode[]> = new Map();
  for (const n of gNodes) {
    if (n.x + n.r + pad < vl || n.x - n.r - pad > vr || n.y + n.r + pad < vt || n.y - n.r - pad > vb) continue;
    const col = gColor(n.provider);
    let arr = byColor.get(col);
    if (!arr) { arr = []; byColor.set(col, arr); }
    arr.push(n);
  }

  byColor.forEach((nodes, col) => {
    c.beginPath();
    c.fillStyle = gHex(col, 0.7);
    for (const n of nodes) {
      if (n === gHovered) continue;
      c.moveTo(n.x + n.r, n.y);
      c.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    }
    c.fill();
  });

  // Hovered node
  if (gHovered) {
    const n = gHovered;
    const col = gColor(n.provider);
    const grd = c.createRadialGradient(n.x, n.y, n.r, n.x, n.y, n.r + 16);
    grd.addColorStop(0, gHex(col, 0.3)); grd.addColorStop(1, gHex(col, 0));
    c.beginPath(); c.arc(n.x, n.y, n.r + 16, 0, Math.PI * 2); c.fillStyle = grd; c.fill();
    c.beginPath(); c.arc(n.x, n.y, n.r, 0, Math.PI * 2); c.fillStyle = col; c.fill();
    c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = "#fff";
    c.font = `${Math.max(10, 11 / gZoom)}px 'SF Pro Text', -apple-system, sans-serif`;
    c.textAlign = "center"; c.textBaseline = "bottom";
    c.fillText(n.displayName, n.x, n.y - n.r - 6);
  }

  c.restore();

  // Legend
  const providers = [...new Set(gNodes.map((n) => n.provider))];
  let ly = 16;
  c.textAlign = "right"; c.textBaseline = "middle";
  c.font = "9px 'SF Pro Text', -apple-system, sans-serif";
  for (const p of providers) {
    const col = gColor(p);
    const lx = W - 56;
    c.beginPath(); c.arc(lx + 10, ly, 4, 0, Math.PI * 2); c.fillStyle = col; c.fill();
    c.fillStyle = "#999"; c.fillText(GRAPH_PROVIDER_LABELS[p] || p, lx + 2, ly);
    ly += 16;
  }
}

function gHitTest(mx: number, my: number): GraphNode | null {
  const gx = (mx - gPanX) / gZoom, gy = (my - gPanY) / gZoom;
  let best: GraphNode | null = null;
  let bestD = Infinity;
  for (const n of gNodes) {
    const dx = n.x - gx, dy = n.y - gy;
    const d = dx * dx + dy * dy;
    const rr = (n.r + 6) * (n.r + 6);
    if (d <= rr && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function gShowTooltip(node: GraphNode, mx: number, my: number): void {
  const tt = $("graphTooltip");
  $("graphTooltipTitle").textContent = node.displayName;
  $("graphTooltipMeta").textContent = node.provider + (node.keywords.length ? " · " + node.keywords.slice(0, 5).join(", ") : "");
  $("graphTooltipPreview").textContent = "";
  tt.hidden = false;
  const rect = $("graphContainer").getBoundingClientRect();
  let left = mx + 16, top = my - 10;
  if (left + 280 > rect.width) left = mx - 290;
  if (left < 4) left = 4;
  if (top < 4) top = 4;
  if (top + 80 > rect.height) top = rect.height - 84;
  tt.style.left = left + "px"; tt.style.top = top + "px";
}

function gHideTooltip(): void {
  $("graphTooltip").hidden = true;
  gHovered = null;
}

function gNavToRecording(node: GraphNode): void {
  document.querySelectorAll(".view").forEach((el) => ((el as HTMLElement).hidden = (el as HTMLElement).dataset.view !== "recordings"));
  document.querySelectorAll(".sb-item").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.view === "recordings"));
  $("windowViewLabel").textContent = "Recordings";
  selectedRecordingName = node.name;
  void loadRecordings(true);
}

(() => {
  const gc = $("graphCanvas") as HTMLCanvasElement;
  const ct = $("graphContainer");

  ct.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault();
    const rect = ct.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const dir = e.deltaY < 0 ? G_ZOOM_FACTOR : 1 / G_ZOOM_FACTOR;
    const nz = Math.max(G_ZOOM_MIN, Math.min(G_ZOOM_MAX, gZoom * dir));
    gPanX = mx - (mx - gPanX) * (nz / gZoom);
    gPanY = my - (my - gPanY) * (nz / gZoom);
    gZoom = nz;
    gRender();
  }, { passive: false });

  ct.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    gDragging = true; gDragDist = 0;
    gDragStartX = e.clientX; gDragStartY = e.clientY;
    gDragPanStartX = gPanX; gDragPanStartY = gPanY;
  });

  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (gDragging) {
      const dx = e.clientX - gDragStartX, dy = e.clientY - gDragStartY;
      gDragDist = Math.sqrt(dx * dx + dy * dy);
      gPanX = gDragPanStartX + dx; gPanY = gDragPanStartY + dy;
      gRender();
      return;
    }
    const rect = ct.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
      if (gHovered) { gHideTooltip(); gRender(); }
      return;
    }
    const hit = gHitTest(mx, my);
    if (hit !== gHovered) {
      gHovered = hit;
      if (hit) gShowTooltip(hit, mx, my); else gHideTooltip();
      gRender();
    } else if (hit) {
      gShowTooltip(hit, mx, my);
    }
  });

  window.addEventListener("mouseup", () => { gDragging = false; });

  gc.addEventListener("click", (e: MouseEvent) => {
    if (gDragDist > G_DRAG_THRESHOLD) return;
    const rect = ct.getBoundingClientRect();
    const hit = gHitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) gNavToRecording(hit);
  });

  $("graphZoomIn").addEventListener("click", () => {
    const nz = Math.min(G_ZOOM_MAX, gZoom * G_ZOOM_FACTOR);
    gPanX = gCssW / 2 - (gCssW / 2 - gPanX) * (nz / gZoom);
    gPanY = gCssH / 2 - (gCssH / 2 - gPanY) * (nz / gZoom);
    gZoom = nz; gRender();
  });
  $("graphZoomOut").addEventListener("click", () => {
    const nz = Math.max(G_ZOOM_MIN, gZoom / G_ZOOM_FACTOR);
    gPanX = gCssW / 2 - (gCssW / 2 - gPanX) * (nz / gZoom);
    gPanY = gCssH / 2 - (gCssH / 2 - gPanY) * (nz / gZoom);
    gZoom = nz; gRender();
  });
  $("graphZoomReset").addEventListener("click", () => { gCenterView(); gRender(); });

  new ResizeObserver(() => {
    if (!ct.closest("[hidden]")) gRender();
  }).observe(ct);
})();

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

// ── Backend boot status / error display ──
window.__setBackendBootStatus = (msg: string) => {
  if (msg) {
    setStatus(msg);
  }
};
window.__setBackendBootError = (msg: string) => {
  setStatus("Backend Error");
  ($("statusDot") as HTMLElement).className = "status-dot error";
  $("liveOutput").textContent = msg || "Backend failed to start.";
};
