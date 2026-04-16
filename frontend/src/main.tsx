import "./styles.css";

type Provider = "local" | "openrouter" | "deepgram" | "";
type RemoteProvider = "openrouter" | "deepgram";
type KeyProvider = "openrouter" | "deepgram";
type ViewName = "record" | "recordings" | "settings" | "graph";
type UiTone = "neutral" | "info" | "success" | "warning" | "error";

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
      upscale_model?: string;
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
  has_audio?: boolean;
  audio_name?: string;
  audio_size_bytes?: number;
  audio_mime?: string;
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

/**
 * Canonical live recording session state — single source of truth.
 *
 * Every field listed here is either rendered to the UI (see
 * ``renderCurrentRecordingSummary``) or consumed by a reconcile /
 * conflict-detection path. Fields that had no consumer were removed in
 * the SSOT cleanup (provider/model/language/durationSec/audioBytes/
 * transcriptChars/transcriptWords/recovered) — they used to be written
 * to a now-deleted context strip and were ghost state.
 */
interface CurrentRecordingSummary {
  /** Short human title derived from the live draft. Rendered indirectly
   *  via ``setStatus`` chips that prefer status over title. */
  title: string;
  /** User-visible status line. Rendered via ``setStatus`` on every
   *  update and into the session notice banner when tone escalates. */
  status: string;
  /** Drives status-dot colour and the notice banner tone. */
  tone: UiTone;
  /** Wall-clock milliseconds from stop → transcript-ready. Rendered
   *  into the ``transcribeLatency`` pill on every update. */
  transcribeLatencyMs?: number;
  /** Name of the persisted file inside the archive. The reconcile
   *  helper reads this to catch the case where the archive has been
   *  mutated outside the app. */
  savedName?: string;
}

type StatusKind = "idle" | "recording" | "processing" | "done" | "error" | "warning" | "info";

interface LatestSavedAudioState {
  savedName?: string;
  archiveDir?: string;
  title: string;
  sizeBytes?: number;
  downloadName?: string;
  mimeType?: string;
  file?: File | null;
}

interface SavedRecordingRef {
  name: string;
  archiveDir: string;
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Deepgram diarization index when enabled. undefined otherwise. */
  speaker?: number;
}

interface LocalTranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  durationSec: number;
}

interface LiveSessionSnapshot {
  provider: Provider;
  effectiveProvider: Provider;
  model: string;
  language: string;
  assistLocalModel: string;
  finalLocalModel: string;
}

type LiveWsMode = "local-assist" | "deepgram-stream";

interface LiveFinalEnvelope {
  text: string;
  segments: TranscriptSegment[];
  durationSec: number;
  source: string;
  error?: string;
}

/**
 * Discriminated union of server → client messages on /ws/transcribe.
 *
 * Matches the protocol documented on the Python side in ``backend.main``
 * and ``backend.remote_deepgram_live``. The ``parseLiveWsMessage``
 * helper below is the ONLY place we cast ``unknown`` into this type —
 * every consumer should use its narrowed output.
 */
type LiveWsMessage =
  | { type: "segments"; segments: TranscriptSegment[]; isFinal: boolean; speechFinal: boolean }
  | { type: "interim"; segment: TranscriptSegment }
  | {
      type: "final";
      text: string;
      segments: TranscriptSegment[];
      durationSec: number;
      source: string;
      error?: string;
    }
  | { type: "error"; error: string; fatal: boolean };

function parseLiveWsMessage(raw: string): LiveWsMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = String(obj.type || "").trim();

  if (type === "segments") {
    const rawSegs = Array.isArray(obj.segments) ? obj.segments : [];
    const segments = rawSegs
      .map((s) => normalizeTranscriptSegment(s))
      .filter((s): s is TranscriptSegment => !!s);
    return {
      type: "segments",
      segments,
      isFinal: !!obj.is_final,
      speechFinal: !!obj.speech_final,
    };
  }

  if (type === "interim") {
    const segment = normalizeTranscriptSegment(obj.segment);
    if (!segment) return null;
    return { type: "interim", segment };
  }

  if (type === "final") {
    const rawSegs = Array.isArray(obj.segments) ? obj.segments : [];
    const segments = rawSegs
      .map((s) => normalizeTranscriptSegment(s))
      .filter((s): s is TranscriptSegment => !!s);
    const error = typeof obj.error === "string" && obj.error ? obj.error : undefined;
    return {
      type: "final",
      text: String(obj.text || ""),
      segments,
      durationSec: Math.max(0, Number(obj.durationSec) || 0),
      source: String(obj.source || ""),
      error,
    };
  }

  if (type === "error") {
    return {
      type: "error",
      error: String(obj.error || "live stream error"),
      fatal: !!obj.fatal,
    };
  }

  return null;
}

type UiStatusTone = "neutral" | "info" | "success" | "warning" | "error";
type RecordingFinalSignalKind = "" | "transcript" | "status" | "error";

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
    __transcriptorLastUiFinalText?: string;
    __transcriptorLastUiFinalAt?: number;
    __transcriptorLastUiFinalRecordingId?: number;
    __transcriptorLastUiFinalKind?: RecordingFinalSignalKind;
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
const fmtBytes = (bytes: number): string => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

const wsBase = (): string => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const AUDIO_TOKENS = {
  liveSampleRateHz: 16_000,
} as const;
const UI_TOKENS = {
  polling: {
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
    vuAmplify: 4,
    waveformMixRms: 6.6,
    waveformMixPeak: 0.45,
  },
  finalize: {
    segmentEpsilonSec: 0.08,
  },
  drain: {
    maxWaitMs: 450,
    idleMs: 120,
    pollStepMs: 30,
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

/**
 * Text-generation models suitable for upscaling a raw transcript into
 * polished prose. These are separate from ``OPENROUTER_AUDIO_MODELS``
 * — audio models like ``gpt-4o-audio-preview`` accept audio input but
 * don't take the "text + instruction → text" shape that upscaling
 * needs. The first entry is the default selection on fresh installs.
 *
 * Each entry has an ``id`` (what OpenRouter expects on the wire) and
 * a ``label`` (what we render in the dropdown). The label is kept
 * short so the select doesn't force the upscale pane toolbar to wrap
 * onto a second row.
 */
interface UpscaleModelOption {
  id: string;
  label: string;
}
const OPENROUTER_UPSCALE_MODELS: UpscaleModelOption[] = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
];
const DEFAULT_UPSCALE_MODEL = OPENROUTER_UPSCALE_MODELS[0].id;

function labelForUpscaleModel(id: string): string {
  const known = OPENROUTER_UPSCALE_MODELS.find((m) => m.id === id);
  if (known) return known.label;
  // Custom/unknown IDs: strip the vendor prefix and any ``-preview``
  // suffix so long paths like ``openai/gpt-4.1-mini-preview`` don't
  // blow out the dropdown width.
  const short = id.split("/").pop() || id;
  return short.replace(/-preview$/, "").trim() || id;
}

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
let currentRecordingAudioObjectUrl = "";
let activeLiveSessionId = "";
let activeLiveArchiveDir = "";
let activeLiveSessionSnapshot: LiveSessionSnapshot | null = null;
let activeUiSessionToken = "";
let currentRecordingSummary: CurrentRecordingSummary | null = null;
let latestSavedAudioState: LatestSavedAudioState | null = null;
let recordSessionNoticeTimer: number | null = null;
let busyScopeToken = "";
let liveStartAbortReason = "";
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

function createClientSessionId(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `live-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function revokeCurrentRecordingAudioUrl(): void {
  if (!currentRecordingAudioObjectUrl) return;
  URL.revokeObjectURL(currentRecordingAudioObjectUrl);
  currentRecordingAudioObjectUrl = "";
}

function isCurrentUiSession(token = ""): boolean {
  if (!token) return true;
  return token === activeUiSessionToken;
}

function latestRecordingAudioUrl(savedName = "", archiveDir = ""): string {
  const safeName = String(savedName || "").trim();
  if (!safeName) return "";
  const params = new URLSearchParams({ token: apiToken() });
  const safeArchiveDir = String(archiveDir || "").trim();
  if (safeArchiveDir) params.set("archive_dir", safeArchiveDir);
  return `/api/recordings/${encodeURIComponent(safeName)}/audio?${params.toString()}`;
}

function renderLatestSavedAudio(): void {
  const row = $("currentRecordingAudioRow");
  const audioEl = $("currentRecordingAudio") as HTMLAudioElement;
  const metaEl = $("currentRecordingAudioMeta");

  audioEl.pause();
  revokeCurrentRecordingAudioUrl();

  if (!latestSavedAudioState) {
    row.hidden = true;
    audioEl.removeAttribute("src");
    audioEl.load();
    metaEl.textContent = "";
    return;
  }

  const backendUrl = latestRecordingAudioUrl(
    latestSavedAudioState.savedName || "",
    latestSavedAudioState.archiveDir || ""
  );
  const playbackUrl = latestSavedAudioState.file
    ? URL.createObjectURL(latestSavedAudioState.file)
    : backendUrl;
  if (!playbackUrl) {
    row.hidden = true;
    audioEl.removeAttribute("src");
    audioEl.load();
    metaEl.textContent = "";
    return;
  }
  currentRecordingAudioObjectUrl = latestSavedAudioState.file ? playbackUrl : "";
  audioEl.src = playbackUrl;
  audioEl.load();
  row.hidden = false;
  metaEl.textContent = latestSavedAudioState.sizeBytes
    ? fmtBytes(latestSavedAudioState.sizeBytes)
    : latestSavedAudioState.title;
  // Show Re-transcribe button when we have a saved audio file
  const retranscribeBtn = document.getElementById("retranscribeBtn");
  if (retranscribeBtn) {
    retranscribeBtn.hidden = !latestSavedAudioState.savedName;
  }
}

function setLatestSavedAudio(state: LatestSavedAudioState | null): void {
  latestSavedAudioState = state
    ? {
      title: String(state.title || "").trim() || "Recording audio",
      savedName: String(state.savedName || "").trim(),
      archiveDir: String(state.archiveDir || "").trim(),
      sizeBytes: Math.max(0, Number(state.sizeBytes) || 0),
      downloadName: String(state.downloadName || "").trim(),
      mimeType: String(state.mimeType || "").trim(),
      file: state.file || null,
    }
    : null;
  renderLatestSavedAudio();
}

function setCurrentRecordingAudio(file: File | null, savedName = "", archiveDir = "", _sessionToken = ""): void {
  if (!file) {
    setLatestSavedAudio(null);
    return;
  }
  setLatestSavedAudio({
    title: savedName ? "Saved audio" : "Session audio",
    savedName,
    archiveDir,
    sizeBytes: file.size,
    downloadName: file.name || "recording.wav",
    mimeType: file.type || "",
    file,
  });
}

function providerLabel(provider: string): string {
  const value = String(provider || "").trim().toLowerCase();
  if (!value || value === "unknown") return "Unknown";
  if (value === "local") return "Local";
  if (value === "openrouter") return "OpenRouter";
  if (value === "deepgram") return "Deepgram";
  return provider;
}

function countWords(text: string): number {
  const value = String(text || "").trim();
  if (!value) return 0;
  return value.split(/\s+/).filter(Boolean).length;
}

function sanitizeUiErrorMessage(error: unknown, fallback: string): string {
  const raw = normalizeTranscriptWhitespace(String((error as Error)?.message || error || ""));
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/^(referenceerror|typeerror|error):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  if (
    /is not defined/i.test(cleaned) ||
    /cannot read properties/i.test(cleaned) ||
    /undefined is not an object/i.test(cleaned) ||
    /script error/i.test(cleaned) ||
    /failed to fetch dynamically imported module/i.test(cleaned) ||
    /unexpected token/i.test(cleaned)
  ) {
    return fallback;
  }
  return cleaned.length > 160 ? fallback : cleaned;
}

function normalizeTranscriptWhitespace(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function joinTranscriptSegments(segments: TranscriptSegment[]): string {
  return segments.map((segment) => normalizeTranscriptWhitespace(segment.text)).filter(Boolean).join(" ").trim();
}

function normalizeTranscriptSegment(raw: unknown, timeOffsetSec = 0): TranscriptSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
  const text = normalizeTranscriptWhitespace(String(source.text || ""));
  const start = Math.max(0, Number(source.start || 0) + timeOffsetSec);
  const end = Math.max(start, Number(source.end || 0) + timeOffsetSec);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const segment: TranscriptSegment = { start, end, text };
  if (source.speaker !== undefined && source.speaker !== null) {
    const speakerIndex = Number(source.speaker);
    if (Number.isFinite(speakerIndex) && speakerIndex >= 0) {
      segment.speaker = Math.floor(speakerIndex);
    }
  }
  return segment;
}

function mergeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (!segments.length) return [];
  const epsilon = UI_TOKENS.finalize.segmentEpsilonSec;
  const ordered = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TranscriptSegment[] = [];
  for (const segment of ordered) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.start - segment.start) <= epsilon &&
      Math.abs(prev.end - segment.end) <= epsilon &&
      prev.text === segment.text
    ) {
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

/**
 * Format an ordered list of transcript segments for display.
 *
 * When ``speaker`` is populated (Deepgram diarize), consecutive
 * segments from the same speaker are coalesced under one ``Speaker N:``
 * prefix. Speaker transitions start a new paragraph so the user can
 * visually separate voices in the live preview.
 */
function formatSegmentsForDisplay(segments: TranscriptSegment[], separator: string): string {
  if (!segments.length) return "";
  const parts: string[] = [];
  let lastSpeaker: number | undefined;
  for (const seg of segments) {
    const t = seg.text.trim();
    if (!t) continue;
    if (seg.speaker !== undefined && seg.speaker !== lastSpeaker) {
      // New speaker — add a speaker-prefixed chunk.
      if (parts.length) parts.push("\n");
      parts.push(`Speaker ${seg.speaker}: ${t}`);
      lastSpeaker = seg.speaker;
    } else {
      if (parts.length && parts[parts.length - 1] !== "\n") {
        parts.push(separator);
      }
      parts.push(t);
    }
  }
  return parts.join("").trim();
}

function recordingTitleFromName(name: string): string {
  return decodeURIComponent(String(name || "").replace(/\.txt$/i, ""));
}

function resetRecordSessionNotice(): void {
  if (recordSessionNoticeTimer) {
    window.clearTimeout(recordSessionNoticeTimer);
    recordSessionNoticeTimer = null;
  }
  const el = $("recordSessionNotice");
  el.hidden = true;
  el.className = "session-notice";
  $("recordSessionNoticeText").textContent = "";
}

function showRecordSessionNotice(message: string, tone: UiTone = "info", timeoutMs = 7000, sessionToken = ""): void {
  if (!isCurrentUiSession(sessionToken)) return;
  if (tone === "info" || tone === "success") {
    resetRecordSessionNotice();
    return;
  }
  const text = String(message || "").trim();
  if (!text) {
    resetRecordSessionNotice();
    return;
  }
  if (recordSessionNoticeTimer) {
    window.clearTimeout(recordSessionNoticeTimer);
    recordSessionNoticeTimer = null;
  }
  const el = $("recordSessionNotice");
  el.hidden = false;
  el.className = `session-notice ${tone}`;
  $("recordSessionNoticeText").textContent = text;
  if (timeoutMs > 0) {
    recordSessionNoticeTimer = window.setTimeout(() => {
      resetRecordSessionNotice();
    }, timeoutMs);
  }
}

/**
 * Render the current recording summary to the live DOM.
 *
 * The summary is the SSOT for "what is happening right now". Every time
 * it changes we push:
 *   - the status text into the header status pill (``setStatus``)
 *   - warning/error tones into the session notice banner so the user
 *     gets a persistent visual cue without extra wiring at call sites.
 *
 * Rendering is debounced against a previous-state snapshot so that no
 * identical status line is re-broadcast twice. This keeps the notice
 * banner from flashing on repeated patches with the same text.
 */
let lastRenderedStatusText = "";
let lastRenderedStatusTone: UiTone = "neutral";
let lastNoticedStatusKey = "";

function toneToStatusKind(tone: UiTone, fallbackText: string): StatusKind {
  switch (tone) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "success":
      return inferStatusKindFromText(fallbackText) === "recording" ? "recording" : "done";
    case "info":
      return inferStatusKindFromText(fallbackText) === "recording" ? "recording" : "processing";
    default:
      return inferStatusKindFromText(fallbackText);
  }
}

function inferStatusKindFromText(text: string): StatusKind {
  const t = (text || "").trim();
  if (!t) return "idle";
  if (t === "Recording" || t.startsWith("Recording")) return "recording";
  if (t === "Done") return "done";
  if (t === "Error" || t === "Backend Error" || t.startsWith("Error")) return "error";
  if (t === "Idle") return "idle";
  if (
    t === "Processing" ||
    t.startsWith("Processing") ||
    t === "Starting" ||
    t === "Refining..." ||
    t.startsWith("Finalizing") ||
    t.startsWith("Transcribing") ||
    t.startsWith("Upscaling")
  ) {
    return "processing";
  }
  return "info";
}

let lastRenderedLatencyMs: number | null = null;

function renderCurrentRecordingSummary(
  summary: CurrentRecordingSummary | null,
  sessionToken = ""
): void {
  if (!summary) {
    lastRenderedStatusText = "";
    lastRenderedStatusTone = "neutral";
    lastNoticedStatusKey = "";
    lastRenderedLatencyMs = null;
    return;
  }
  const status = String(summary.status || "").trim();
  const tone = (summary.tone || "neutral") as UiTone;
  if (status && (status !== lastRenderedStatusText || tone !== lastRenderedStatusTone)) {
    lastRenderedStatusText = status;
    lastRenderedStatusTone = tone;
    setStatus(status, toneToStatusKind(tone, status));
    if (tone === "warning" || tone === "error") {
      const noticeKey = `${tone}::${status}`;
      if (noticeKey !== lastNoticedStatusKey) {
        lastNoticedStatusKey = noticeKey;
        showRecordSessionNotice(status, tone, 7000, sessionToken);
      }
    }
  }
  if (
    summary.transcribeLatencyMs !== undefined &&
    summary.transcribeLatencyMs !== lastRenderedLatencyMs
  ) {
    lastRenderedLatencyMs = summary.transcribeLatencyMs;
    $("transcribeLatency").textContent = fmtMs(summary.transcribeLatencyMs);
  }
}

function setCurrentRecordingSummary(summary: CurrentRecordingSummary | null, sessionToken = ""): void {
  if (!isCurrentUiSession(sessionToken)) return;
  currentRecordingSummary = summary ? { ...summary } : null;
  renderCurrentRecordingSummary(currentRecordingSummary, sessionToken);
}

function patchCurrentRecordingSummary(patch: Partial<CurrentRecordingSummary>, sessionToken = ""): void {
  if (!isCurrentUiSession(sessionToken)) return;
  const next: CurrentRecordingSummary = {
    title: currentRecordingSummary?.title || "Recording summary",
    status: currentRecordingSummary?.status || "",
    tone: currentRecordingSummary?.tone || "neutral",
    ...(currentRecordingSummary || {}),
    ...patch,
  };
  setCurrentRecordingSummary(next, sessionToken);
}

function setBusy(nextBusy: boolean, scopeToken = ""): void {
  if (scopeToken) {
    if (nextBusy) {
      busyScopeToken = scopeToken;
    } else if (busyScopeToken && busyScopeToken !== scopeToken) {
      return;
    } else {
      busyScopeToken = "";
    }
  } else if (!nextBusy) {
    busyScopeToken = "";
  }
  isBusy = !!nextBusy;
  ["btnStart", "btnStop", "btnTranscribeFile", "pickFileBtn", "providerSelect", "remoteModelSelect", "quickProviderSelect", "quickSettingsToggle", "upscaleToggle", "upscalePresetSelect", "upscalePresetAddBtn", "upscalePresetDeleteBtn", "upscalePresetSaveBtn", "upscalePresetCancelBtn", "orKeyActionBtn", "deepgramKeyActionBtn"].forEach((id) => {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null;
    if (el) el.disabled = isBusy;
  });
}

function setStatusScoped(scopeToken: string, st: string, kind?: StatusKind): void {
  if (!isCurrentUiSession(scopeToken)) return;
  setStatus(st, kind);
}

function setRecordButton(recording: boolean): void {
  const b = $("btnStart") as HTMLButtonElement;
  b.classList.toggle("recording", recording);
  b.setAttribute("aria-label", recording ? "Stop recording" : "Start recording");
}

function statusKindToDotClass(kind: StatusKind): string {
  switch (kind) {
    case "recording":
      return " rec";
    case "processing":
      return " process";
    case "done":
      return " done";
    case "error":
      return " error";
    case "warning":
      return " warn";
    case "info":
      return " process";
    case "idle":
    default:
      return "";
  }
}

/** Maximum length for a status line that fits the pill without
 *  truncation at the current column width. Longer messages are
 *  abbreviated in the pill and shown in full via the hover title and
 *  the session notice banner. */
const STATUS_PILL_MAX_CHARS = 42;

function abbreviateForStatusPill(text: string): string {
  const t = (text || "").trim();
  if (t.length <= STATUS_PILL_MAX_CHARS) return t;
  // Prefer the part before the first ":" or "—" — usually the
  // high-level phrase ("Live stream error") without the raw cause.
  const head = t.split(/[:\u2014\u2013]/)[0].trim();
  if (head && head.length <= STATUS_PILL_MAX_CHARS) return head + "…";
  return t.slice(0, STATUS_PILL_MAX_CHARS - 1).trimEnd() + "…";
}

function setStatus(st: string, kind?: StatusKind): void {
  const full = String(st || "").trim();
  const short = abbreviateForStatusPill(full);
  const el = $("statusText");
  el.textContent = short;
  el.setAttribute("title", full);
  const resolvedKind: StatusKind = kind || inferStatusKindFromText(full);
  const dot = $("statusDot");
  dot.className = "status-dot" + statusKindToDotClass(resolvedKind);
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
    // Body wasn't JSON; fall through to text parsing.
    try {
      const txt = await r.text();
      if (txt && txt.trim()) details = `${details}: ${txt.trim()}`;
    } catch (textError) {
      console.debug("parseError: response body unavailable", textError);
    }
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

function createWavFileFromSamples(samples: Float32Array, sampleRate: number, name: string): File {
  const audioBlob = encodeWav(samples, sampleRate);
  return new File([audioBlob], name, { type: audioBlob.type || "audio/wav" });
}

// ── PCM capture sink ──────────────────────────────────────────────────
//
// A bounded-memory replacement for the old ``chunks: Float32Array[]``
// module-level array. Two implementations:
//
//   * ``OpfsPcmSink`` — spools PCM16LE samples to the Origin Private
//     File System (``navigator.storage.getDirectory()``) in real time
//     so the JS heap never holds more than a handful of milliseconds
//     of audio at once. At finalize, a WAV header is prepended and a
//     ``File`` backed by the concatenated [header + spooled bytes] is
//     returned. Cleanup is explicit via ``destroy()``.
//
//   * ``MemoryPcmSink`` — in-memory fallback for environments without
//     OPFS (old browsers, test harnesses) or when a mid-recording
//     write fails. Keeps samples as ``Int16Array`` chunks (half the
//     footprint of the old Float32Array path) and assembles a WAV
//     ``File`` at finalize.
//
// The factory ``createPcmSink`` tries OPFS first and gracefully
// degrades to memory on any failure, so callers never have to
// branch. ``isDiskBacked`` lets the UI report which mode is active.
//
// Orphan cleanup: if the app crashes mid-recording, a ``.pcm16`` file
// is left in ``pcm-spool/`` inside OPFS. ``cleanupOrphanPcmSpool``
// runs once at module load and removes every file older than the
// current session, so the cleanup window never grows without bound.

interface PcmSink {
  append(samples: Float32Array): void;
  finalize(sampleRate: number, name?: string): Promise<File>;
  destroy(): Promise<void>;
  readonly totalSamples: number;
  readonly isDiskBacked: boolean;
  readonly lastWriteError: Error | null;
}

function floatSamplesToInt16LE(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const clamped = x < -1 ? -1 : x > 1 ? 1 : x;
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}

function buildWavHeader(sampleRate: number, dataBytes: number, channels = 1): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  // "RIFF" chunk
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, 0x57415645, false);
  // "fmt " subchunk
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true); // subchunk1Size (PCM)
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byteRate
  view.setUint16(32, channels * 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  // "data" subchunk
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataBytes, true);
  return header;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type OpfsFileSystemWritableFileStream = {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};
interface OpfsFileSystemFileHandle {
  name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsFileSystemWritableFileStream>;
  getFile(): Promise<File>;
}
interface OpfsFileSystemDirectoryHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileSystemFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileSystemDirectoryHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<OpfsFileSystemFileHandle & { kind: "file" | "directory" }>;
}

const PCM_SPOOL_DIR = "pcm-spool";

async function getPcmSpoolDir(create = true): Promise<OpfsFileSystemDirectoryHandle | null> {
  // The built-in ``FileSystemDirectoryHandle`` type in some TS lib
  // versions doesn't yet declare ``values()`` / ``getFileHandle()``
  // with the exact shape we need, so we fence off the entire OPFS
  // surface area as ``unknown`` and take ownership of the types via
  // our ``OpfsFileSystem*`` interfaces. All subsequent calls are
  // structurally typed against our contract and will fail loudly at
  // runtime if the browser diverges (caught by the try/catch).
  const navStorage = (navigator as { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  if (!navStorage || typeof navStorage.getDirectory !== "function") {
    return null;
  }
  try {
    const root = (await navStorage.getDirectory()) as unknown as OpfsFileSystemDirectoryHandle;
    return await root.getDirectoryHandle(PCM_SPOOL_DIR, { create });
  } catch (e) {
    console.debug("OPFS spool dir unavailable:", e);
    return null;
  }
}

async function cleanupOrphanPcmSpool(): Promise<void> {
  const dir = await getPcmSpoolDir(true);
  if (!dir) return;
  try {
    const victims: string[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && entry.name.endsWith(".pcm16")) {
        victims.push(entry.name);
      }
    }
    for (const name of victims) {
      try {
        await dir.removeEntry(name);
      } catch (e) {
        console.debug("pcm-spool: failed to remove orphan", name, e);
      }
    }
    if (victims.length) {
      console.info(`pcm-spool: cleaned ${victims.length} orphaned capture file(s)`);
    }
  } catch (e) {
    console.debug("pcm-spool: orphan scan skipped:", e);
  }
}

class OpfsPcmSink implements PcmSink {
  private dir: OpfsFileSystemDirectoryHandle;
  private fileHandle: OpfsFileSystemFileHandle;
  private writable: OpfsFileSystemWritableFileStream | null;
  private pendingChunks: Int16Array[] = [];
  private pendingBytes = 0;
  private flushInProgress = false;
  private flushScheduled = false;
  private destroyed = false;
  totalSamples = 0;
  readonly isDiskBacked = true;
  lastWriteError: Error | null = null;

  constructor(
    dir: OpfsFileSystemDirectoryHandle,
    fileHandle: OpfsFileSystemFileHandle,
    writable: OpfsFileSystemWritableFileStream,
  ) {
    this.dir = dir;
    this.fileHandle = fileHandle;
    this.writable = writable;
  }

  static async create(sessionId: string): Promise<OpfsPcmSink | null> {
    const dir = await getPcmSpoolDir(true);
    if (!dir) return null;
    try {
      const safeId = sessionId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 96) || `s${Date.now()}`;
      const name = `${safeId}.pcm16`;
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      return new OpfsPcmSink(dir, handle, writable);
    } catch (e) {
      console.warn("OpfsPcmSink: create failed, falling back to memory sink", e);
      return null;
    }
  }

  append(samples: Float32Array): void {
    if (this.destroyed || this.lastWriteError) return;
    if (!samples.length) return;
    const int16 = floatSamplesToInt16LE(samples);
    this.pendingChunks.push(int16);
    this.pendingBytes += int16.byteLength;
    this.totalSamples += int16.length;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flushPending();
    });
  }

  private async flushPending(): Promise<void> {
    if (this.flushInProgress) return;
    if (this.destroyed) return;
    if (!this.writable) return;
    if (!this.pendingChunks.length) return;
    this.flushInProgress = true;
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    try {
      const totalBytes = chunks.reduce((a, c) => a + c.byteLength, 0);
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        merged.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offset);
        offset += c.byteLength;
      }
      await this.writable.write(merged);
    } catch (e) {
      this.lastWriteError = e instanceof Error ? e : new Error(String(e));
      // Re-enqueue the failed chunks so finalize() can still produce a
      // WAV from in-memory data via the WebM fallback path. Without this
      // the samples in ``chunks`` are GC'd and permanently lost.
      this.pendingChunks = [...chunks, ...this.pendingChunks];
      this.pendingBytes = this.pendingChunks.reduce((a, c) => a + c.byteLength, 0);
      console.warn("OpfsPcmSink: write failed — disk may be full or permissions revoked", e);
    } finally {
      this.flushInProgress = false;
      if (this.pendingChunks.length && !this.lastWriteError) {
        this.scheduleFlush();
      }
    }
  }

  async finalize(sampleRate: number, name = `live-${Date.now()}.wav`): Promise<File> {
    // Drain any pending chunks first.
    await this.flushPending();
    // Wait for any flush in progress to complete.
    let guard = 0;
    while (this.flushInProgress && guard < 200) {
      await new Promise((r) => setTimeout(r, 5));
      guard++;
    }
    // One more drain for anything that arrived during the wait.
    await this.flushPending();

    if (this.writable) {
      try {
        await this.writable.close();
      } catch (e) {
        console.debug("OpfsPcmSink: close failed", e);
      }
      this.writable = null;
    }

    if (this.lastWriteError) {
      // The spool file may be truncated or corrupt. Return an empty
      // File so the caller can fall back to the WebM container.
      return new File([new Blob([], { type: "audio/wav" })], name, { type: "audio/wav" });
    }

    const spool = await this.fileHandle.getFile();
    const dataBytes = spool.size;
    const header = buildWavHeader(sampleRate, dataBytes);
    const blob = new Blob([header, spool], { type: "audio/wav" });
    return new File([blob], name, { type: "audio/wav" });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.writable) {
      try {
        await this.writable.close();
      } catch (e) {
        console.debug("OpfsPcmSink: destroy close failed", e);
      }
      this.writable = null;
    }
    try {
      await this.dir.removeEntry(this.fileHandle.name);
    } catch (e) {
      console.debug("OpfsPcmSink: destroy remove failed", e);
    }
    this.pendingChunks = [];
    this.pendingBytes = 0;
  }
}

class MemoryPcmSink implements PcmSink {
  private chunks: Int16Array[] = [];
  private destroyed = false;
  totalSamples = 0;
  readonly isDiskBacked = false;
  lastWriteError: Error | null = null;

  append(samples: Float32Array): void {
    if (this.destroyed) return;
    if (!samples.length) return;
    const int16 = floatSamplesToInt16LE(samples);
    this.chunks.push(int16);
    this.totalSamples += int16.length;
  }

  async finalize(sampleRate: number, name = `live-${Date.now()}.wav`): Promise<File> {
    const totalBytes = this.chunks.reduce((a, c) => a + c.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offset);
      offset += c.byteLength;
    }
    const header = buildWavHeader(sampleRate, totalBytes);
    const blob = new Blob([header, merged], { type: "audio/wav" });
    return new File([blob], name, { type: "audio/wav" });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.chunks = [];
    this.totalSamples = 0;
  }
}

async function createPcmSink(sessionId: string): Promise<PcmSink> {
  const opfs = await OpfsPcmSink.create(sessionId);
  if (opfs) return opfs;
  console.info("PcmSink: OPFS unavailable, using in-memory sink");
  return new MemoryPcmSink();
}

async function probeAudioFileDuration(file: File): Promise<number | null> {
  if (!(file instanceof File) || file.size <= 0) return null;
  const url = URL.createObjectURL(file);
  try {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const duration = await new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (value: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      audio.onloadedmetadata = () => {
        const value = Number(audio.duration);
        finish(Number.isFinite(value) && value > 0 ? value : null);
      };
      audio.onerror = () => finish(null);
      window.setTimeout(() => finish(null), 2500);
      audio.src = url;
    });
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function selectCanonicalCapturedAudio(opts: {
  /** Pre-built WAV file returned by ``PcmSink.finalize``. The file
   *  is either a Blob backed by an OPFS spool entry (disk-spilled)
   *  or an in-memory Int16 buffer. Either way it's already a valid
   *  WAV — no encoding happens here. */
  pcmFile: File | null;
  /** Total sample count reported by the sink. Used to derive
   *  duration without loading the file back into an
   *  ``HTMLAudioElement``. */
  pcmSampleCount: number;
  pcmSampleRate: number;
  recordedChunks: Blob[];
  expectedDurationSec: number;
}): Promise<{ file: File | null; durationSec: number; kind: "pcm" | "container" | "none" }> {
  const expectedDurationSec = Math.max(0, Number(opts.expectedDurationSec) || 0);
  const candidates: Array<{ file: File; durationSec: number; kind: "pcm" | "container"; fidelityBias: number }> = [];

  // A valid WAV from the sink has header (44 bytes) + payload. Empty
  // or header-only files indicate a sink write error; skip them and
  // fall back to the WebM container candidate below.
  if (opts.pcmFile && opts.pcmFile.size > 44 && opts.pcmSampleCount > 0) {
    const pcmDurationSec = opts.pcmSampleCount / opts.pcmSampleRate;
    const pcmFile = opts.pcmFile;
    // FAST PATH: if the PCM capture is complete (covers >= 95% of
    // the expected duration), skip the slow WebM probing step
    // altogether — the sink already produced a ready-to-play WAV
    // and we know the exact sample count.
    const pcmCoverage =
      expectedDurationSec > 0 ? pcmDurationSec / expectedDurationSec : 1;
    if (pcmCoverage >= 0.95) {
      return { file: pcmFile, durationSec: pcmDurationSec, kind: "pcm" };
    }
    candidates.push({ file: pcmFile, durationSec: pcmDurationSec, kind: "pcm", fidelityBias: 0 });
  }

  if (opts.recordedChunks.length > 0) {
    const webmBlob = new Blob(opts.recordedChunks, { type: "audio/webm" });
    const webmFile = new File([webmBlob], `live-${Date.now()}.webm`, { type: webmBlob.type || "audio/webm" });
    const webmDurationSec = await probeAudioFileDuration(webmFile);
    if (webmDurationSec && webmDurationSec > 0) {
      candidates.push({ file: webmFile, durationSec: webmDurationSec, kind: "container", fidelityBias: 0.08 });
    } else if (!candidates.length) {
      candidates.push({ file: webmFile, durationSec: 0, kind: "container", fidelityBias: 0.16 });
    }
  }

  if (!candidates.length) return { file: null, durationSec: 0, kind: "none" };
  if (candidates.length === 1) {
    const only = candidates[0];
    return { file: only.file, durationSec: only.durationSec, kind: only.kind };
  }

  const scored = candidates
    .map((candidate) => {
      const diff = Math.abs(expectedDurationSec - candidate.durationSec);
      const underCapturePenalty = candidate.durationSec + 0.35 < expectedDurationSec ? 0.45 : 0;
      return {
        ...candidate,
        score: diff + underCapturePenalty + candidate.fidelityBias,
      };
    })
    .sort((a, b) => a.score - b.score || b.durationSec - a.durationSec || a.fidelityBias - b.fidelityBias);

  const best = scored[0];
  return { file: best.file, durationSec: best.durationSec, kind: best.kind };
}

// Hardwired local timeout for ``stopMediaRecorderAndFlush``.
//
// The old code reused ``UI_TOKENS.polling.remoteChunkSettleTimeoutMs``
// (3000 ms) as a safety ceiling. That was sized for the old stop
// order where MediaRecorder had to fully flush WHILE the mic stream
// was still live — the recorder's ``stop`` event could take up to a
// second on some platforms. After the tail-fix reorder, stream.stop()
// runs BEFORE this function, so the MediaRecorder has no more data
// coming and fires its ``stop`` event within a handful of
// milliseconds. 500 ms is plenty of safety margin for any platform
// hiccup and saves up to 2.5 seconds on the stop path in the worst
// case.
const MEDIA_RECORDER_STOP_FALLBACK_MS = 500;

async function stopMediaRecorderAndFlush(): Promise<void> {
  const recorder = mediaRecorder;
  if (!recorder || recorder.state === "inactive") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    recorder.addEventListener("stop", finish, { once: true });
    window.setTimeout(finish, MEDIA_RECORDER_STOP_FALLBACK_MS);
    try {
      recorder.requestData();
    } catch (e) {
      console.debug("MediaRecorder requestData rejected (harmless)", e);
    }
    try {
      recorder.stop();
    } catch (e) {
      console.debug("MediaRecorder stop rejected (harmless)", e);
      finish();
    }
  });
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

function syncLiveLocalModelVisibility(): void {
  const provider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const effective = resolveEffectiveProvider(provider);
  const group = document.getElementById("liveLocalModelGroup");
  const toolbarRow = document.getElementById("livePaneToolbarRow");
  if (!group || !toolbarRow) return;
  // The Whisper model selector is only meaningful when live transcription
  // uses local faster-whisper. For Deepgram-as-primary mode the selector
  // is a confusing leftover (it doesn't control Deepgram's model) so we
  // hide it and collapse the row when nothing else lives there.
  const shouldShow = effective === "local";
  group.hidden = !shouldShow;
  toolbarRow.hidden = !shouldShow;
}

function syncRemoteModelOptions(): void {
  const provider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const sel = $("remoteModelSelect") as HTMLSelectElement;
  syncLiveLocalModelVisibility();
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
  opts: { provider: Provider; language: string; diarize: boolean; openrouterModel?: string; signal?: AbortSignal }
): Promise<{ text: string; provider: string; model?: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "openrouter");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  if (opts.provider === "openrouter" || opts.provider === "deepgram") {
    fd.set("openrouter_model", (opts.openrouterModel || "").trim());
  }
  const r = await fetch("/api/remote/transcribe-sync", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
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

function syncRecordingsSearchControls(): void {
  const clearBtn = $("recordingsSearchClearBtn") as HTMLButtonElement;
  const hasQuery = !!recordingsSearchQuery.trim();
  clearBtn.disabled = recordingsUiLoading || !hasQuery;
}

function modalFocusableElements(modal: HTMLElement): HTMLElement[] {
  return Array.from(
    modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute("hidden"));
}

function openModal(modalId: string, focusSelector = ""): void {
  const modal = $(modalId);
  lastModalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  activeModalId = modalId;
  const focusTarget = focusSelector ? (modal.querySelector(focusSelector) as HTMLElement | null) : null;
  const fallback = modalFocusableElements(modal)[0] || modal;
  (focusTarget || fallback).focus();
}

function closeModal(modalId: string): void {
  const modal = $(modalId);
  modal.hidden = true;
  if (activeModalId === modalId) activeModalId = "";
  if (lastModalFocus && document.contains(lastModalFocus)) {
    lastModalFocus.focus();
  }
  lastModalFocus = null;
}

async function localJobSync(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean }
): Promise<LocalTranscriptionResult> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || "small");
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/transcribe-sync", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
  const js = (await r.json()) as {
    ok?: boolean;
    result?: {
      text?: string;
      duration?: number;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };
  };
  const rawSegments = Array.isArray(js?.result?.segments) ? js.result?.segments || [] : [];
  const segments = rawSegments
    .map((segment) => normalizeTranscriptSegment(segment))
    .filter((segment): segment is TranscriptSegment => !!segment);
  return {
    text: normalizeTranscriptWhitespace(String(js?.result?.text || "")),
    segments,
    durationSec: Math.max(0, Number(js?.result?.duration || 0)),
  };
}

async function transcribeCanonicalAudioLocally(file: File, language: string, model: string): Promise<LocalTranscriptionResult> {
  return localJobSync(file, {
    language: resolveFastLocalLanguage(language),
    model: (model || "").trim() || "small",
    splitStereo: false,
    wordTimestamps: false,
  });
}

async function warmLocalModel(model: string): Promise<void> {
  const resolvedModel = (model || "").trim() || "small";
  const fd = new FormData();
  fd.set("model", resolvedModel);
  const r = await fetch("/api/transcribe/warmup", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
}

async function discardLiveRecovery(sessionId: string): Promise<void> {
  const safeSessionId = (sessionId || "").trim();
  if (!safeSessionId) return;
  const r = await fetch(`/api/live/recoveries/${encodeURIComponent(safeSessionId)}/discard`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(await parseError(r));
}

async function recoverBackendAudioSessions(): Promise<void> {
  const r = await apiGet<{ items: Array<{ session_id: string }> }>("/api/live/recoveries");
  const items = Array.isArray(r.items) ? r.items : [];
  if (!items.length) return;
  const archiveDir = currentArchiveDirSnapshot();
  // Process each recovery independently. A single failure (e.g. a
  // spool file that's under the minimum duration threshold and hits
  // a 400 "live recovery too short") must NOT abort the loop — the
  // remaining recoveries still deserve to be promoted. We collect
  // counts and surface a single notice at the end.
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    const sessionId = String(item?.session_id || "").trim();
    if (!sessionId) continue;
    try {
      const resp = await fetch(`/api/live/recoveries/${encodeURIComponent(sessionId)}/promote`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(archiveDir ? { archive_dir: archiveDir } : {}),
      });
      if (!resp.ok) {
        failed += 1;
        console.warn(
          `Recovery promote failed for ${sessionId}:`,
          await parseError(resp),
        );
        continue;
      }
      succeeded += 1;
    } catch (e) {
      failed += 1;
      console.warn(`Recovery promote exception for ${sessionId}:`, e);
    }
  }
  if (succeeded > 0) {
    showRecordSessionNotice(
      `Recovered ${succeeded} interrupted recording${succeeded === 1 ? "" : "s"} into Recordings.`,
      "success",
      9000,
    );
    loadRecordings(true).catch(() => { });
  }
  if (failed > 0 && succeeded === 0) {
    showRecordSessionNotice(
      `Could not recover ${failed} interrupted recording${failed === 1 ? "" : "s"}. Check the Recordings folder manually.`,
      "warning",
      9000,
    );
  }
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

function resolveLivePreviewLocalModel(model: string): string {
  const raw = String(model || "").trim() || "small";
  if (raw === "tiny" || raw === "base") return raw;
  return "tiny";
}

function resolveSessionLocalModels(selectedProvider: Provider): { assistLocalModel: string; finalLocalModel: string } {
  const configuredLocalModel = (($("model") as HTMLSelectElement).value || "small").trim();
  const finalLocalModel = configuredLocalModel || "small";
  const effectiveProvider = resolveEffectiveProvider(selectedProvider);
  return {
    assistLocalModel: effectiveProvider === "local" ? resolveFastLiveLocalModel(configuredLocalModel) : resolveLivePreviewLocalModel(configuredLocalModel),
    finalLocalModel,
  };
}

/**
 * Returns the WebSocket mode for a given session snapshot.
 *
 * SSOT routing rules:
 *   - deepgram (online)  → dedicated Deepgram streaming WebSocket
 *   - any other provider → local faster-whisper assist pipeline
 */
function resolveLiveWsMode(snapshot: LiveSessionSnapshot | null): LiveWsMode {
  const provider = snapshot?.effectiveProvider
    || resolveEffectiveProvider((($("providerSelect") as HTMLSelectElement).value || "local") as Provider);
  if (provider === "deepgram" && isProviderKeyConfigured("deepgram")) {
    return "deepgram-stream";
  }
  return "local-assist";
}

function getCanonicalLiveSourceText(): string {
  // Include BOTH committed segments AND the best available interim so
  // the tail of the utterance is never lost.
  //
  // Why ``lastInterimSnapshot``: when Deepgram sends an ``is_final``
  // event, ``appendLiveTranscriptSegments`` clears ``liveInterimText``
  // (correct for live display — the interim is replaced by the final).
  // But if Deepgram finalized only PART of what was in the interim
  // (e.g. "последние" out of "последние слова"), the cleared interim
  // loses "слова" and the committed cache only has "последние". By
  // the time stopLive reads this function, the tail word is gone.
  //
  // ``lastInterimSnapshot`` preserves the interim text from just
  // before the last clear. We pick whichever is LONGEST among:
  //   1. Current ``liveInterimText`` (if Deepgram sent a fresh interim
  //      after the last is_final)
  //   2. ``lastInterimSnapshot`` (the interim just before the last
  //      is_final wiped it)
  //
  // Deduplication: if the chosen interim is already a SUBSTRING of
  // ``committed``, skip it to avoid "foo bar bar" artifacts.
  const committed = liveDraftText.trim();
  const currentInterim = liveInterimText.trim();
  const snapshotInterim = lastInterimSnapshot.trim();
  const interim =
    currentInterim.length >= snapshotInterim.length
      ? currentInterim
      : snapshotInterim;
  if (!interim) return committed;
  if (!committed) return interim;
  // Dedup: if committed already ends with the interim text, skip.
  if (committed.endsWith(interim)) return committed;
  // Dedup: if the interim is entirely contained in the committed tail,
  // it was already finalized — skip.
  const lastCommittedWords = committed.split(/\s+/).slice(-10).join(" ");
  if (lastCommittedWords.includes(interim)) return committed;
  return `${committed} ${interim}`;
}

function getVisibleLivePreviewText(): string {
  const committed = liveDraftDisplayText.trim();
  const interim = liveInterimText.trim();
  if (committed && interim) return `${committed} ${interim}`;
  return committed || interim;
}

function scheduleLocalWarmup(): void {
  const selectedProvider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const sessionModels = resolveSessionLocalModels(selectedProvider);
  const modelsToWarm = new Set<string>();
  if ($("uploadPanel").hidden) {
    modelsToWarm.add(sessionModels.assistLocalModel);
    if (resolveEffectiveProvider(selectedProvider) === "local") {
      modelsToWarm.add(sessionModels.finalLocalModel);
    }
  } else {
    modelsToWarm.add((($("model") as HTMLSelectElement).value || "small").trim() || "small");
  }
  modelsToWarm.forEach((model) => {
    warmLocalModel(model).catch((e) => {
      console.warn(`Local model warmup failed for ${model}`, e);
    });
  });
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

function switchView(view: ViewName): void {
  document.querySelectorAll(".view").forEach((el) => {
    const node = el as HTMLElement;
    node.hidden = node.dataset.view !== view;
  });
  document.querySelectorAll(".sb-item").forEach((el) => {
    const active = (el as HTMLElement).dataset.view === view;
    el.classList.toggle("active", active);
    if (active) {
      el.setAttribute("aria-current", "page");
    } else {
      el.removeAttribute("aria-current");
    }
  });
  $("windowViewLabel").textContent =
    view === "settings" ? "Settings" : view === "recordings" ? "Recordings" : view === "graph" ? "Graph" : "Record";
  if (view === "recordings") {
    // Only reload from the server if we have no cached items yet. If
    // the list was already loaded (e.g. from initRecordingsBootstrap
    // or a previous tab visit), just re-render without a network call
    // to prevent the list "shaking" / reloading every time the user
    // switches tabs. A manual Refresh button or a new recording save
    // still triggers a full reload.
    if (!recordingItems.length) {
      void loadRecordings(true).catch(() => { });
    }
  }
  if (view === "graph") {
    void loadGraphData();
  }
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
    const v = ((e as HTMLElement).dataset.view || "record") as ViewName;
    switchView(v);
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

($("refreshMicsBtn") as HTMLButtonElement).addEventListener("click", () => void loadMics(true));

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
  if (waveDirty && document.visibilityState === "visible") draw();
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
    const liveText = getCanonicalLiveSourceText();
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
      provider: activeLiveSessionSnapshot?.provider || (($("providerSelect") as HTMLSelectElement).value || "local"),
      model:
        activeLiveSessionSnapshot?.model ||
        getRemoteModelValue((($("providerSelect") as HTMLSelectElement).value || "local") as Provider),
      language: activeLiveSessionSnapshot?.language || (($("language") as HTMLSelectElement).value || "auto"),
      archive_dir: activeLiveArchiveDir || currentArchiveDirSnapshot(),
    };
    localStorage.setItem(LIVE_DRAFT_KEY, JSON.stringify(draft));
  } catch (e) {
    // localStorage quota or serialization problems are non-fatal.
    console.debug("persistLiveDraft skipped", e);
  }
}

function clearLiveDraft(): void {
  try {
    localStorage.removeItem(LIVE_DRAFT_KEY);
  } catch (e) {
    console.debug("clearLiveDraft skipped", e);
  }
}

interface PersistedLiveDraft {
  title?: string;
  source_text?: string;
  transcript_text?: string;
  provider?: string;
  model?: string;
  language?: string;
  archive_dir?: string;
  updated_at?: number;
}

function parsePersistedLiveDraft(raw: string): PersistedLiveDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn("live draft: invalid JSON, discarding", e);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("live draft: top-level is not an object, discarding");
    return null;
  }
  // Structural type guard: every field that we use is coerced to its
  // expected type; anything unparseable degrades to empty string /
  // zero. This is stricter than a bare ``as`` cast and guarantees
  // downstream code never sees ``null`` / ``undefined`` / arrays /
  // wrong types in fields we promise are strings.
  const obj = parsed as Record<string, unknown>;
  const pickString = (key: string): string => {
    const v = obj[key];
    return typeof v === "string" ? v : "";
  };
  const pickNumber = (key: string): number => {
    const v = obj[key];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    title: pickString("title"),
    source_text: pickString("source_text"),
    transcript_text: pickString("transcript_text"),
    provider: pickString("provider"),
    model: pickString("model"),
    language: pickString("language"),
    archive_dir: pickString("archive_dir"),
    updated_at: pickNumber("updated_at"),
  };
}

async function recoverLiveDraftIfAny(): Promise<void> {
  let raw = "";
  try {
    raw = localStorage.getItem(LIVE_DRAFT_KEY) || "";
  } catch (e) {
    console.debug("live draft: localStorage read failed", e);
    return;
  }
  if (!raw) return;
  const draft = parsePersistedLiveDraft(raw);
  if (!draft) {
    clearLiveDraft();
    return;
  }
  try {
    const sourceText = String(draft.source_text || "").trim();
    const transcriptText = String(draft.transcript_text || "").trim();
    if (!sourceText && !transcriptText) {
      clearLiveDraft();
      return;
    }
    const stamp = Number(draft.updated_at || Date.now());
    const recovered = await saveRecordingText({
      archiveDir: String(draft.archive_dir || "").trim() || currentArchiveDirSnapshot(),
      title: String(draft.title || "Recovered recording") + " (Recovered)",
      sourceText,
      transcriptText,
      provider: String(draft.provider || "local"),
      model: String(draft.model || "-"),
      language: String(draft.language || "auto"),
    });
    const recoveredText = transcriptText || sourceText;
    publishRecordingOutput({
      recordingId: 0,
      pasteText: recoveredText,
      domText: recoveredText,
      kind: "transcript",
    });
    setCurrentRecordingSummary({
      title: String(draft.title || "Recovered recording"),
      status: "Recovered unsaved draft from the previous session.",
      tone: "warning",
      savedName: recovered.name,
    });
    showRecordSessionNotice("Recovered the last unsaved draft from a previous session.", "warning", 9000);
    setStatus("Recovered " + new Date(stamp).toLocaleTimeString());
    clearLiveDraft();
  } catch (e) {
    console.warn("Live draft recovery failed; keeping draft for next startup", e);
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
    upscale_model: getUpscaleModelValue(),
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
  const upscaleEnabled = shouldUpscale();
  const sel = $("upscalePresetSelect") as HTMLSelectElement;
  const wrap = $("upscalePresetWrap") as HTMLDivElement;
  const editBtn = $("upscalePresetEditBtn") as HTMLButtonElement;
  const addBtn = $("upscalePresetAddBtn") as HTMLButtonElement;
  const delBtn = $("upscalePresetDeleteBtn") as HTMLButtonElement;
  // The preset dropdown (Clean / Business / AI & Code / Refine) must
  // ALWAYS be visible so the user can see what upscale variations
  // exist and choose one BEFORE turning the toggle on. Hiding the
  // controls when upscale is off made the whole toolbar look empty
  // and the user reported "вариации апскейла не отображаются". We
  // now disable instead of hiding — the controls dim out at 0.5
  // opacity when the toggle is off, signalling that they are
  // inactive but still available, and become fully interactive the
  // moment the toggle is flipped on.
  wrap.hidden = false;
  sel.disabled = !upscaleEnabled;
  editBtn.hidden = false;
  editBtn.disabled = !upscaleEnabled;
  addBtn.hidden = false;
  addBtn.disabled = !upscaleEnabled;
  delBtn.hidden = false;
  const canDelete = !!(selectedUpscalePreset() && !selectedUpscalePreset()!.builtin);
  delBtn.disabled = !upscaleEnabled || !canDelete;
  delBtn.classList.toggle("can-delete", upscaleEnabled && canDelete);
  // Visual dimming for the entire toolbar when upscale is OFF.
  const toolbar = wrap.closest(".pane-toolbar-actions-upscale") as HTMLElement | null;
  if (toolbar) {
    toolbar.style.opacity = upscaleEnabled ? "1" : "0.5";
    toolbar.style.pointerEvents = upscaleEnabled ? "" : "";
  }
}

async function loadUpscalePresets(preferredId = ""): Promise<void> {
  const sel = $("upscalePresetSelect") as HTMLSelectElement;
  const prev = preferredId || sel.value || pendingUpscalePresetId || "";
  let items: UpscalePresetItem[] = [];
  try {
    const r = await apiGet<{ items: UpscalePresetItem[] }>("/api/upscale/presets");
    items = Array.isArray(r.items) ? r.items : [];
  } catch (e) {
    // Backend may still be booting or temporarily unreachable. Fall
    // back to the client-side builtins so the dropdown is NEVER empty
    // — the user can still choose a preset and record; the actual
    // instruction text is resolved server-side at upscale time, so
    // having only the id+name locally is enough.
    console.warn("loadUpscalePresets: API call failed, using client-side builtins", e);
    items = BUILTIN_UPSCALE_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      builtin: true,
    }));
  }
  upscalePresets = items;
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
  // Default selection strategy when the user hasn't saved a preference yet:
  //   1. Honour explicitly-requested preferredId / pendingUpscalePresetId
  //   2. Prefer the "Clean" builtin — it's the safest, most neutral style
  //   3. Fall back to the first preset in the list
  //   4. Hard-code "builtin_clean" if even the list is empty
  let next: string;
  if (prev && upscalePresets.some((x) => x.id === prev)) {
    next = prev;
  } else if (upscalePresets.some((x) => x.id === "builtin_clean")) {
    next = "builtin_clean";
  } else {
    next = upscalePresets[0]?.id || "builtin_clean";
  }
  sel.value = next;
  pendingUpscalePresetId = "";
  const addBtn = $("upscalePresetAddBtn") as HTMLButtonElement;
  const customCount = upscalePresets.filter((x) => !x.builtin).length;
  addBtn.disabled = customCount >= 3;
  syncUpscalePresetControls();
}

function openUpscalePresetModal(): void {
  const name = $("upscalePresetNameInput") as HTMLInputElement;
  const instruction = $("upscalePresetInstructionInput") as HTMLTextAreaElement;
  $("upscalePresetMsg").textContent = "";
  name.value = "";
  instruction.value =
    "Improve transcript quality: keep same language as input, preserve meaning, fix punctuation and grammar. Return only final transcript text without quotes.";
  openModal("upscalePresetModal", "#upscalePresetNameInput");
}

function closeUpscalePresetModal(): void {
  closeModal("upscalePresetModal");
}

function openUpscalePromptModal(): void {
  const preset = selectedUpscalePreset();
  if (!preset) return;
  ($("upscalePromptPresetName") as HTMLInputElement).value = preset.name || preset.id;
  ($("upscalePromptPresetId") as HTMLInputElement).value = preset.id;
  ($("upscalePromptInstructionInput") as HTMLTextAreaElement).value =
    String(preset.instruction || preset.default_instruction || "").trim();
  $("upscalePromptMsg").textContent = "";
  openModal("upscalePromptModal", "#upscalePromptInstructionInput");
}

function closeUpscalePromptModal(): void {
  closeModal("upscalePromptModal");
}

function getUpscaleModelValue(): string {
  const el = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  const fromDropdown = (el?.value || "").trim();
  if (fromDropdown) return fromDropdown;
  return DEFAULT_UPSCALE_MODEL;
}

function populateUpscaleModelOptions(): void {
  const sel = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  if (!sel) return;
  const preferred = (sel.value || "").trim() || DEFAULT_UPSCALE_MODEL;
  const ids = new Set<string>(OPENROUTER_UPSCALE_MODELS.map((m) => m.id));
  // Keep any user-added custom model by merging it into the list.
  if (preferred) ids.add(preferred);
  sel.innerHTML = "";
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = labelForUpscaleModel(id);
    // Keep the full id in the title attribute for hover — the short
    // label in the dropdown is for layout, not for hiding the source
    // model.
    opt.title = id;
    sel.appendChild(opt);
  }
  sel.value = ids.has(preferred) ? preferred : DEFAULT_UPSCALE_MODEL;
}

// Built-in upscale presets mirrored from ``BUILTIN_UPSCALE_PRESETS`` in
// ``backend/main.py``. We keep a synchronous client-side copy so the
// preset dropdown is never empty during the one round-trip window
// between module init and the async ``/api/upscale/presets`` fetch.
// The async ``loadUpscalePresets`` call overlays the authoritative
// list (including user-created custom presets) when it resolves.
const BUILTIN_UPSCALE_PRESETS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "builtin_clean", name: "Clean" },
  { id: "builtin_business", name: "Business" },
  { id: "builtin_ai_code", name: "AI & Code" },
  { id: "builtin_refine", name: "Refine" },
];

function populateBuiltinUpscalePresetOptions(): void {
  const sel = document.getElementById("upscalePresetSelect") as HTMLSelectElement | null;
  if (!sel) return;
  // Only seed if the select is empty — once ``loadUpscalePresets`` has
  // run, its options are authoritative and we must not clobber them
  // (they may contain custom presets the user created).
  if (sel.options.length > 0) return;
  const preferred = pendingUpscalePresetId || "builtin_clean";
  sel.innerHTML = "";
  for (const p of BUILTIN_UPSCALE_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  // Seed the in-memory list too so ``selectedUpscalePreset`` and
  // other helpers do not see an empty array before the async load.
  if (upscalePresets.length === 0) {
    upscalePresets = BUILTIN_UPSCALE_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      builtin: true,
    }));
  }
  sel.value = BUILTIN_UPSCALE_PRESETS.some((p) => p.id === preferred)
    ? preferred
    : "builtin_clean";
}

/**
 * Serialises upscale calls so the user can never accidentally fire
 * two concurrent requests on the same input (e.g., by stopping one
 * recording and immediately stopping another, or by toggling the
 * upscale switch mid-flight).
 *
 * Keyed by sessionToken to guarantee that only one upscale per
 * session is in flight, but multiple sessions can still process in
 * parallel (important when the user stops B while A is still being
 * upscaled). The in-flight promise is returned so the second caller
 * observes the same result as the first.
 */
const upscaleInFlightBySession = new Map<string, Promise<string>>();

async function runUpscaleIfEnabled(text: string, sessionToken = ""): Promise<string> {
  const input = String(text || "").trim();
  if (!input) return "";
  if (!shouldUpscale()) {
    if (isCurrentUiSession(sessionToken)) {
      $("upscaleOutput").textContent = "";
      $("upscaleLatency").textContent = "--";
    }
    return input;
  }
  const inflightKey = sessionToken || "__no_session__";
  const existing = upscaleInFlightBySession.get(inflightKey);
  if (existing) {
    return existing;
  }
  const promise = (async (): Promise<string> => {
    setStatusScoped(sessionToken, "Upscaling");
    if (isCurrentUiSession(sessionToken)) {
      $("upscaleOutput").textContent = "Upscaling...";
    }
    const t0 = performance.now();
    const upscaleModel = getUpscaleModelValue();
    try {
      const r = await apiPost<{ ok: boolean; text: string; preset_id: string; model: string }>("/api/upscale", {
        text: input,
        preset_id: upscalePresetId(),
        model: upscaleModel || undefined,
      });
      const out = String(r.text || "").trim();
      if (!out) throw new Error("Upscale returned empty text");
      if (isCurrentUiSession(sessionToken)) {
        $("upscaleOutput").textContent = out;
        $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
      }
      setStatusScoped(sessionToken, "Done");
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || "Unknown upscale error");
      if (isCurrentUiSession(sessionToken)) {
        $("upscaleOutput").textContent = `Upscale failed: ${msg}\n\nUsing original transcript.`;
        $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
      }
      setStatusScoped(sessionToken, "Done");
      return input;
    } finally {
      upscaleInFlightBySession.delete(inflightKey);
    }
  })();
  upscaleInFlightBySession.set(inflightKey, promise);
  return promise;
}

// Serialized settings-save pipeline.
//
// ``queueUiPreferencesSave`` can be called many times per second
// (slider drag, select change, toggle click). We debounce so only
// the LAST change within ``settings.saveDebounceMs`` fires, but
// two rapid bursts could still produce back-to-back fire events
// whose apiPost calls overlap — and the backend ``save_config``
// is not atomic against concurrent writes (load_config → merge →
// tmp write → replace). Overlapping saves can lose fields or
// serialize updates in the wrong order.
//
// We serialize with an in-flight chain: each new save awaits the
// previous save's completion before issuing its own request. The
// debounce still batches bursts, and the chain guarantees FIFO
// ordering so the last write always wins.
let uiPrefInFlightChain: Promise<void> = Promise.resolve();

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
    const nextRecordingsDir = ($("recordingsDirInput") as HTMLInputElement).value.trim();
    const shouldRefreshRecordingsArchive = nextRecordingsDir !== configuredRecordingsDir;
    ($("orModel") as HTMLInputElement).value = openrouterModel;
    const payload = {
      preferences: {
        recordings_dir: nextRecordingsDir,
        remote_provider: remoteProvider,
        openrouter: { model: openrouterModel || "google/gemini-2.5-flash" },
        ui: collectUiPreferences(),
      },
    };
    // Chain each save after the previous one's completion (success
    // or failure — we don't want one transient 500 to block all
    // future saves). The ``Promise.resolve()`` tail guarantees the
    // chain never carries a rejected state forward.
    uiPrefInFlightChain = uiPrefInFlightChain
      .catch(() => { })
      .then(async () => {
        try {
          await apiPost<{ ok: boolean }>("/api/config", payload);
          configuredRecordingsDir = nextRecordingsDir;
          if (!shouldRefreshRecordingsArchive) return;
          activeResolvedRecordingsDir = "";
          recordingsBootstrapReady = false;
          const reloadTask = loadRecordings(false).catch((e) => {
            console.warn("Recordings archive reload failed", e);
          });
          const trackedReloadPromise = reloadTask.finally(() => {
            if (recordingsBootstrapPromise === trackedReloadPromise) {
              recordingsBootstrapPromise = null;
            }
            recordingsBootstrapReady = !!currentArchiveDirSnapshot();
          });
          recordingsBootstrapPromise = trackedReloadPromise;
        } catch {
          // Swallow: a transient 500 will retry on the next change.
        }
      });
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
    configuredRecordingsDir = (cfg.preferences || {}).recordings_dir || "";
    ($("recordingsDirInput") as HTMLInputElement).value = configuredRecordingsDir;
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
    // Live preview defaults to ON for new users. Previously this was
    // ``ui.live_preview === true`` (strict equal) — which returned
    // false for any fresh config without that key, leaving the user
    // with an empty Live Preview pane they never saw fill in. The
    // "live транскрипция не работает" report was caused by the
    // default, not by broken streaming. Using ``!== false`` keeps
    // backwards compatibility: explicit ``false`` stays off.
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
    // Restore persisted upscale model; populateUpscaleModelOptions
    // merges it into the dropdown if it's not in the built-in list.
    const storedUpscaleModel = String(ui.upscale_model || "").trim();
    const upscaleModelSelectEl = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
    if (upscaleModelSelectEl) {
      upscaleModelSelectEl.value = storedUpscaleModel || DEFAULT_UPSCALE_MODEL;
    }
    populateUpscaleModelOptions();
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
  } catch (configError) {
    console.warn("Initial config load failed, retrying with built-in preset", configError);
    try {
      await loadUpscalePresets("builtin_clean");
    } catch (presetError) {
      console.warn("Built-in preset fallback also failed", presetError);
    }
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
($("recordingsDirInput") as HTMLInputElement).addEventListener("input", () => {
});
($("autoStopSilenceEnabled") as HTMLInputElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("autoStopSilenceSeconds") as HTMLInputElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("autoStopSilenceDb") as HTMLInputElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("upscaleToggle") as HTMLInputElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
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
$("resetShortcutsBtn").addEventListener("click", () => {
  currentShortcuts = { ...DEFAULT_SHORTCUTS };
  updateShortcutDisplay("shortcutRecord", currentShortcuts.record);
  updateShortcutDisplay("shortcutPaste", currentShortcuts.paste);
  // Push to main process for live reload.
  (window as unknown as { __transcriptorPendingShortcuts?: unknown }).__transcriptorPendingShortcuts = {
    record: currentShortcuts.record,
    paste: currentShortcuts.paste,
  };
  queueUiPreferencesSave();
});

let recordingItems: RecordingItem[] = [];
let selectedRecordingName = "";
let recordingsStatsOpen = false;
let recordingsSearchQuery = "";
let recordingsLoadRequestSeq = 0;
let recordingOpenRequestSeq = 0;
let recordingsStatsRequestSeq = 0;
let recordingsUiLoading = false;
let configuredRecordingsDir = "";
let activeResolvedRecordingsDir = "";
let recordingsBootstrapReady = false;
let recordingsBootstrapPromise: Promise<void> | null = null;
let activeModalId = "";
let lastModalFocus: HTMLElement | null = null;

function syncRecordingsStatsVisibility(): void {
  $("recordingsStatsPanel").hidden = !recordingsStatsOpen;
  const btn = $("recordingsStatsBtn") as HTMLButtonElement;
  if (recordingsStatsOpen) {
    btn.classList.add("active");
    btn.textContent = "Hide";
    btn.setAttribute("aria-label", "Hide stats");
    btn.setAttribute("aria-pressed", "true");
  } else {
    btn.classList.remove("active");
    btn.textContent = "Stats";
    btn.setAttribute("aria-label", "Show stats");
    btn.setAttribute("aria-pressed", "false");
  }
}

function updateRecordingCopyState(): void {
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  const hasText = !!($("recordingContent").textContent || "").trim();
  btn.disabled = !hasText;
}

function resetRecordingViewer(placeholder = "Choose a recording from the left list..."): void {
  $("recordingTitleLabel").textContent = "Choose a recording";
  $("recordingMeta").textContent = "";
  $("recordingContent").setAttribute("aria-busy", "false");
  $("recordingContent").setAttribute("data-placeholder", placeholder);
  $("recordingContent").textContent = "";
  const player = $("recordingAudio") as HTMLAudioElement;
  player.pause();
  player.removeAttribute("src");
  player.load();
  $("recordingAudioRow").hidden = true;
  updateRecordingCopyState();
}

function setRecordingViewerLoading(displayName: string): void {
  $("recordingTitleLabel").textContent = displayName || "Loading recording";
  $("recordingMeta").textContent = "Loading…";
  $("recordingContent").setAttribute("aria-busy", "true");
  $("recordingContent").setAttribute("data-placeholder", "Loading recording...");
  $("recordingContent").textContent = "";
  const player = $("recordingAudio") as HTMLAudioElement;
  player.pause();
  player.removeAttribute("src");
  player.load();
  $("recordingAudioRow").hidden = true;
  updateRecordingCopyState();
}

function reconcileCurrentRecordingSummaryWithArchive(): void {
  const savedName = String(currentRecordingSummary?.savedName || "").trim();
  if (!savedName) return;
  if (recordingItems.some((item) => item.name === savedName)) return;
  setCurrentRecordingSummary({
    ...(currentRecordingSummary as CurrentRecordingSummary),
    savedName: "",
    tone: currentRecordingSummary?.tone === "error" ? "error" : "warning",
    status: "Saved files for this session are no longer present in the active recordings archive.",
  });
}

function syncLatestSavedAudioFromRecordings(): void {
  reconcileCurrentRecordingSummaryWithArchive();
  // If the current audio state holds an in-memory File blob from an
  // active or just-completed stopLive session, do NOT overwrite it.
  // The in-memory blob is the authoritative audio for the CURRENT
  // recording and is always the freshest. Overwriting it with a
  // backend-served URL from ``recordingItems`` can regress to a STALE
  // recording if the recordings list hasn't refreshed yet or if audio
  // retention hasn't pruned the old file. The user reported "старая
  // голосовуха всё ещё висит" because this function ran from a fire-
  // and-forget ``loadRecordings`` and replaced the fresh in-memory
  // blob with a backend reference to the previous recording's audio.
  if (latestSavedAudioState?.file) return;

  const freshestWithAudio = recordingItems.find((item) => item.has_audio);
  if (!freshestWithAudio) {
    setLatestSavedAudio(null);
    return;
  }
  const current = latestSavedAudioState;
  const sameRecording = !!current?.savedName && current.savedName === freshestWithAudio.name;
  setLatestSavedAudio({
    title: freshestWithAudio.display_name || recordingTitleFromName(freshestWithAudio.name),
    savedName: freshestWithAudio.name,
    archiveDir: currentArchiveDirSnapshot(),
    sizeBytes: Number(freshestWithAudio.audio_size_bytes || current?.sizeBytes || 0),
    downloadName: freshestWithAudio.audio_name || current?.downloadName || `${freshestWithAudio.name.replace(/\.txt$/i, "")}.wav`,
    mimeType: freshestWithAudio.audio_mime || current?.mimeType || "",
    file: sameRecording ? (current?.file || null) : null,
  });
}

function getFilteredRecordings(): RecordingItem[] {
  const query = recordingsSearchQuery.trim().toLowerCase();
  if (!query) return recordingItems;
  return recordingItems.filter((item) => {
    const haystack = [item.display_name, item.name, item.provider, item.language].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function setRecordingsUiLoading(nextLoading: boolean): void {
  recordingsUiLoading = !!nextLoading;
  $("recordingsList").setAttribute("aria-busy", recordingsUiLoading ? "true" : "false");
  ($("recordingsRefreshBtn") as HTMLButtonElement).disabled = recordingsUiLoading;
  ($("recordingsSearchInput") as HTMLInputElement).disabled = recordingsUiLoading;
  ($("recordingsSearchClearBtn") as HTMLButtonElement).disabled = recordingsUiLoading || !recordingsSearchQuery.trim();
}

function flashButtonFeedback(btn: HTMLButtonElement, copiedLabel: string, defaultTitle: string): void {
  const prevAria = btn.getAttribute("aria-label") || defaultTitle;
  const prevTitle = btn.title || defaultTitle;
  btn.setAttribute("aria-label", copiedLabel);
  btn.title = copiedLabel;
  window.setTimeout(() => {
    btn.setAttribute("aria-label", prevAria);
    btn.title = prevTitle;
  }, 900);
}

async function copyRecordingText(): Promise<void> {
  const text = ($("recordingContent").textContent || "").trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback path for browsers that block ``navigator.clipboard`` (Safari
    // private mode, http: origins on old Chromium, denied user permission).
    // ``execCommand("copy")`` can itself throw in those same environments
    // — wrap in try/finally so the detached <textarea> is guaranteed to be
    // removed from the DOM even if the copy itself fails. Otherwise a
    // repeated copy attempt accumulates invisible <textarea> ghosts that
    // leak memory and can interfere with focus management.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      document.execCommand("copy");
    } catch (e) {
      console.warn("execCommand copy fallback failed", e);
    } finally {
      ta.remove();
    }
  }
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  flashButtonFeedback(btn, "Copied", "Copy recording text");
}

async function copyTextContent(text: string, btnId = ""): Promise<void> {
  const value = String(text || "").trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // See copyRecordingText for the rationale behind the try/finally
    // wrapper — guarantees the fallback <textarea> is always removed.
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      document.execCommand("copy");
    } catch (e) {
      console.warn("execCommand copy fallback failed", e);
    } finally {
      ta.remove();
    }
  }
  if (btnId) {
    const btn = $(btnId) as HTMLButtonElement;
    flashButtonFeedback(btn, "Copied", btnId === "resultCopyBtn" ? "Copy result text" : "Copy upscale text");
  }
}

function isArchiveMutationConflict(error: unknown): boolean {
  const message = String((error as Error)?.message || "").toLowerCase();
  return message.includes("no longer exists in the target archive") || message.includes("archive directory is no longer available");
}

function currentArchiveDirSnapshot(): string {
  return String(activeResolvedRecordingsDir || "").trim();
}

async function ensureRecordingsArchiveReady(): Promise<string> {
  if (currentArchiveDirSnapshot()) {
    recordingsBootstrapReady = true;
    return currentArchiveDirSnapshot();
  }
  if (recordingsBootstrapPromise) {
    await recordingsBootstrapPromise;
    const resolved = currentArchiveDirSnapshot();
    if (resolved) {
      recordingsBootstrapReady = true;
      return resolved;
    }
  }
  await loadRecordings(false);
  const resolved = currentArchiveDirSnapshot();
  if (!resolved) {
    throw new Error("Recordings archive is not ready yet. Please try again.");
  }
  recordingsBootstrapReady = true;
  return resolved;
}

function renderRecordingsEmptyState(message: string, actionLabel: string, onClick: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "recordings-empty-state";
  const text = document.createElement("p");
  text.className = "hint";
  text.textContent = message;
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost recordings-empty-action";
  btn.type = "button";
  btn.textContent = actionLabel;
  btn.onclick = onClick;
  wrap.appendChild(text);
  wrap.appendChild(btn);
  return wrap;
}

function renderRecordingsList(): void {
  const list = $("recordingsList");
  list.replaceChildren();
  const filteredItems = getFilteredRecordings();
  syncRecordingsSearchControls();
  if (!recordingItems.length) {
    list.appendChild(
      renderRecordingsEmptyState("No recordings yet.", "Start Recording", () => {
        switchView("record");
      })
    );
    return;
  }
  if (!filteredItems.length) {
    list.appendChild(
      renderRecordingsEmptyState("No recordings match the current search.", "Clear Search", () => {
        recordingsSearchQuery = "";
        const input = $("recordingsSearchInput") as HTMLInputElement;
        input.value = "";
        renderRecordingsList();
        if (!selectedRecordingName && recordingItems.length) {
          selectedRecordingName = recordingItems[0].name;
          void openRecording(selectedRecordingName);
        }
      })
    );
    return;
  }
  filteredItems.forEach((it) => {
    const btn = document.createElement("button");
    btn.className = "recording-item" + (it.name === selectedRecordingName ? " active" : "");
    btn.type = "button";
    btn.dataset.recordingName = it.name;
    btn.setAttribute("aria-current", it.name === selectedRecordingName ? "true" : "false");
    const title = document.createElement("span");
    title.className = "rec-title";
    title.textContent = it.display_name;
    const meta = document.createElement("span");
    meta.className = "rec-meta";
    meta.textContent = `${fmtDateTime(it.modified_at)} · ${fmtBytes(it.size_bytes)}`;
    const badges = document.createElement("div");
    badges.className = "rec-badges";
    if (it.provider && it.provider !== "unknown") {
      const providerBadge = document.createElement("span");
      providerBadge.className = "rec-provider rec-provider-provider";
      providerBadge.textContent = providerLabel(it.provider);
      badges.appendChild(providerBadge);
    }
    if (it.language) {
      const languageBadge = document.createElement("span");
      languageBadge.className = "rec-provider rec-provider-language";
      languageBadge.textContent = String(it.language).toUpperCase();
      badges.appendChild(languageBadge);
    }
    if (it.has_audio) {
      const audioBadge = document.createElement("span");
      audioBadge.className = "rec-provider rec-provider-audio";
      audioBadge.textContent = "Audio";
      badges.appendChild(audioBadge);
    }
    btn.appendChild(title);
    btn.appendChild(meta);
    // Always attach the badges container even when empty — its
    // ``min-height: 22px`` rule gives every recording-item the same
    // intrinsic content height, so old recordings (no provider,
    // no language, no audio) render at the same size as new ones
    // with full badge metadata. The "у старых записей огромного
    // размера разросшиеся" report was caused by the mix of
    // differently-tall items across new/old content.
    btn.appendChild(badges);
    btn.onclick = () => void openRecording(it.name);
    list.appendChild(btn);
  });
}

async function moveRecordingSelection(step: number): Promise<void> {
  const filteredItems = getFilteredRecordings();
  if (!filteredItems.length) return;
  const currentIndex = Math.max(0, filteredItems.findIndex((item) => item.name === selectedRecordingName));
  const nextIndex = Math.min(filteredItems.length - 1, Math.max(0, currentIndex + step));
  const next = filteredItems[nextIndex];
  if (!next) return;
  selectedRecordingName = next.name;
  renderRecordingsList();
  await openRecording(next.name);
  const target = $("recordingsList").querySelector<HTMLElement>(`[data-recording-name="${CSS.escape(next.name)}"]`);
  target?.focus();
}

async function loadRecordings(keepSelection: boolean): Promise<void> {
  const requestSeq = ++recordingsLoadRequestSeq;
  setRecordingsUiLoading(true);
  try {
    const r = await apiGet<{ items: RecordingItem[]; directory: string }>("/api/recordings");
    if (requestSeq !== recordingsLoadRequestSeq) return;
    recordingItems = r.items || [];
    activeResolvedRecordingsDir = String(r.directory || "").trim();
    syncLatestSavedAudioFromRecordings();
    const filteredItems = getFilteredRecordings();
    if (!keepSelection || !filteredItems.some((x) => x.name === selectedRecordingName)) {
      selectedRecordingName = filteredItems[0]?.name || "";
    }
    renderRecordingsList();
    await loadRecordingsStats();
    if (selectedRecordingName) {
      await openRecording(selectedRecordingName);
    } else {
      resetRecordingViewer(recordingsSearchQuery ? "No recordings match the current search." : "Choose a recording from the left list...");
    }
  } finally {
    // Always clear loading state — even for superseded requests. The
    // old code only cleared when requestSeq matched, which left the UI
    // in a permanent loading state when a superseded request errored.
    setRecordingsUiLoading(false);
  }
}

async function loadRecordingsStats(): Promise<void> {
  const requestSeq = ++recordingsStatsRequestSeq;
  const s = await apiGet<RecordingsStats>("/api/recordings/stats/summary");
  if (requestSeq !== recordingsStatsRequestSeq) return;
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
  const requestSeq = ++recordingOpenRequestSeq;
  const pendingDisplayName = recordingItems.find((item) => item.name === name)?.display_name || recordingTitleFromName(name);
  setRecordingViewerLoading(pendingDisplayName);
  try {
    const r = await apiGet<{
      name: string;
      modified_at: string;
      size_bytes: number;
      content: string;
      has_audio?: boolean;
      audio_name?: string;
      audio_size_bytes?: number;
    }>(
      "/api/recordings/" + encodeURIComponent(name)
    );
    if (requestSeq !== recordingOpenRequestSeq || selectedRecordingName !== name) return;
    const displayName = recordingItems.find((item) => item.name === name)?.display_name || recordingTitleFromName(name);
    $("recordingTitleLabel").textContent = displayName;
    $("recordingMeta").textContent = `${fmtDateTime(r.modified_at)} · ${fmtBytes(r.size_bytes || 0)}`;
    $("recordingContent").setAttribute("aria-busy", "false");
    $("recordingContent").setAttribute("data-placeholder", "Transcription will appear here...");
    $("recordingContent").textContent = (r as { display_text?: string }).display_text || r.content || "";
    const player = $("recordingAudio") as HTMLAudioElement;
    const audioRow = $("recordingAudioRow");
    if (r.has_audio) {
      const audioUrl = latestRecordingAudioUrl(name, currentArchiveDirSnapshot());
      audioRow.hidden = false;
      player.src = audioUrl;
      player.load();
    } else {
      player.pause();
      player.removeAttribute("src");
      player.load();
      audioRow.hidden = true;
    }
    updateRecordingCopyState();
  } catch (e) {
    if (requestSeq !== recordingOpenRequestSeq || selectedRecordingName !== name) return;
    const message = sanitizeUiErrorMessage(e, "Could not open this recording.");
    $("recordingTitleLabel").textContent = pendingDisplayName;
    $("recordingMeta").textContent = "Load failed";
    $("recordingContent").setAttribute("aria-busy", "false");
    $("recordingContent").setAttribute("data-placeholder", "Recording failed to load.");
    $("recordingContent").textContent = message;
    const player = $("recordingAudio") as HTMLAudioElement;
    player.pause();
    player.removeAttribute("src");
    player.load();
    $("recordingAudioRow").hidden = true;
    updateRecordingCopyState();
  }
}

async function saveRecordingText(opts: {
  name?: string;
  archiveDir?: string;
  requireExisting?: boolean;
  title: string;
  sourceText: string;
  transcriptText: string;
  provider: string;
  model: string;
  language: string;
  audioFile?: File | null;
  refreshList?: boolean;
}): Promise<SavedRecordingRef> {
  if (!opts.archiveDir && !recordingsBootstrapReady) {
    await ensureRecordingsArchiveReady();
  }
  const sourceText = (opts.sourceText || "").trim();
  const transcriptText = (opts.transcriptText || "").trim();
  const audioFile = opts.audioFile || null;
  const existingName = (opts.name || "").trim();
  const archiveDir = (opts.archiveDir || currentArchiveDirSnapshot()).trim();
  const requireExisting = !!opts.requireExisting;
  if (!sourceText && !transcriptText && !audioFile) {
    return { name: existingName, archiveDir };
  }
  let savedName = existingName;
  let savedArchiveDir = archiveDir;
  if (audioFile) {
    const fd = new FormData();
    fd.append("file", audioFile, audioFile.name || "recording.wav");
    if (existingName) fd.set("name", existingName);
    if (archiveDir) fd.set("archive_dir", archiveDir);
    if (requireExisting) fd.set("require_existing", "true");
    fd.set("title", opts.title);
    fd.set("source_text", sourceText);
    fd.set("transcript_text", transcriptText);
    fd.set("provider", opts.provider);
    fd.set("model", opts.model);
    fd.set("language", opts.language);
    const r = await fetch("/api/recordings/save-with-audio", { method: "POST", body: fd, headers: authHeaders() });
    if (!r.ok) throw new Error(await parseError(r));
    const js = (await r.json()) as { name?: string; archive_dir?: string };
    savedName = String(js.name || existingName || "").trim();
    savedArchiveDir = String(js.archive_dir || archiveDir || "").trim();
  } else {
    const js = await apiPost<{ ok: boolean; name: string; archive_dir?: string }>("/api/recordings/save", {
      name: existingName,
      archive_dir: archiveDir,
      require_existing: requireExisting,
      title: opts.title,
      source_text: sourceText,
      transcript_text: transcriptText,
      provider: opts.provider,
      model: opts.model,
      language: opts.language,
    });
    savedName = String(js.name || existingName || "").trim();
    savedArchiveDir = String(js.archive_dir || archiveDir || "").trim();
  }
  // Fire-and-forget: don't block critical path for recordings list reload.
  if (opts.refreshList !== false) {
    loadRecordings(true).catch(() => { });
  }
  return { name: savedName, archiveDir: savedArchiveDir };
}

$("recordingsRefreshBtn").addEventListener("click", () =>
  void loadRecordings(true).catch((e: Error) => {
    $("recordingContent").textContent = sanitizeUiErrorMessage(e, "Could not refresh the archive.");
    updateRecordingCopyState();
  })
);
$("recordingsSearchInput").addEventListener("input", (ev) => {
  recordingsSearchQuery = String((ev.target as HTMLInputElement).value || "").trim().toLowerCase();
  const filteredItems = getFilteredRecordings();
  if (selectedRecordingName && !filteredItems.some((item) => item.name === selectedRecordingName)) {
    selectedRecordingName = filteredItems[0]?.name || "";
    renderRecordingsList();
    if (selectedRecordingName) {
      void openRecording(selectedRecordingName);
    } else {
      resetRecordingViewer("No recordings match the current search.");
    }
    return;
  }
  renderRecordingsList();
});
$("recordingsSearchClearBtn").addEventListener("click", () => {
  if (!recordingsSearchQuery) return;
  recordingsSearchQuery = "";
  const input = $("recordingsSearchInput") as HTMLInputElement;
  input.value = "";
  renderRecordingsList();
  if (!selectedRecordingName && recordingItems.length) {
    selectedRecordingName = recordingItems[0].name;
    void openRecording(selectedRecordingName);
  }
});
($("recordingsList") as HTMLDivElement).addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    void moveRecordingSelection(1);
    return;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    void moveRecordingSelection(-1);
    return;
  }
  if (ev.key === "Home") {
    ev.preventDefault();
    const first = getFilteredRecordings()[0];
    if (!first) return;
    selectedRecordingName = first.name;
    renderRecordingsList();
    void openRecording(first.name).then(() => {
      const target = $("recordingsList").querySelector<HTMLElement>(`[data-recording-name="${CSS.escape(first.name)}"]`);
      target?.focus();
    });
    return;
  }
  if (ev.key === "End") {
    ev.preventDefault();
    const filtered = getFilteredRecordings();
    const last = filtered[filtered.length - 1];
    if (!last) return;
    selectedRecordingName = last.name;
    renderRecordingsList();
    void openRecording(last.name).then(() => {
      const target = $("recordingsList").querySelector<HTMLElement>(`[data-recording-name="${CSS.escape(last.name)}"]`);
      target?.focus();
    });
  }
});
($("recordingsSearchInput") as HTMLInputElement).addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (!recordingsSearchQuery) return;
    recordingsSearchQuery = "";
    const input = ev.currentTarget as HTMLInputElement;
    input.value = "";
    renderRecordingsList();
    if (!selectedRecordingName && recordingItems.length) {
      selectedRecordingName = recordingItems[0].name;
      void openRecording(selectedRecordingName);
    }
    return;
  }
  if (ev.key === "Enter") {
    const first = getFilteredRecordings()[0];
    if (!first) return;
    selectedRecordingName = first.name;
    void openRecording(first.name);
  }
});
$("recordingsStatsBtn").addEventListener("click", () => {
  recordingsStatsOpen = !recordingsStatsOpen;
  syncRecordingsStatsVisibility();
});
$("recordingCopyBtn").addEventListener("click", () => void copyRecordingText());
$("resultCopyBtn").addEventListener("click", () => void copyTextContent($("finalOutput").textContent || "", "resultCopyBtn"));
$("upscaleCopyBtn").addEventListener("click", () => void copyTextContent($("upscaleOutput").textContent || "", "upscaleCopyBtn"));

// Re-transcribe button: sends the saved audio to Deepgram REST API
// when streaming produced a poor result (bad connection, dropped packets).
$("retranscribeBtn").addEventListener("click", async () => {
  const btn = $("retranscribeBtn") as HTMLButtonElement;
  if (btn.disabled) return;
  const audioState = latestSavedAudioState;
  if (!audioState?.savedName) {
    $("finalOutput").textContent = "No saved audio to re-transcribe.";
    return;
  }
  // The Re-transcribe button specifically targets Deepgram REST — it exists
  // to recover a full transcript when the streaming WebSocket dropped
  // packets. Without a Deepgram key, the REST call will fail with an
  // opaque backend error; short-circuit here with a clear message so the
  // user knows exactly what to configure instead of seeing a stack-trace.
  if (!isProviderKeyConfigured("deepgram")) {
    $("finalOutput").textContent = "Re-transcribe requires a Deepgram API key. Configure it in Settings.";
    return;
  }
  btn.disabled = true;
  btn.classList.add("is-busy");
  try {
    // Prefer the in-memory blob captured during this session — it is the
    // canonical PCM we just assembled and avoids a round-trip to the
    // backend that could race with the recordings archive write. Fall
    // back to fetching the saved file if the blob is absent (viewing a
    // recording saved in a previous session, or after a page reload).
    let audioFile: File;
    if (audioState.file) {
      audioFile = audioState.file instanceof File
        ? audioState.file
        : new File([audioState.file], audioState.savedName.replace(/\.txt$/, ".wav"), { type: "audio/wav" });
    } else {
      const audioUrl = latestRecordingAudioUrl(audioState.savedName, audioState.archiveDir || "");
      const audioResp = await fetch(audioUrl, { headers: authHeaders() });
      if (!audioResp.ok) throw new Error(`Audio fetch failed: HTTP ${audioResp.status}`);
      const audioBlob = await audioResp.blob();
      audioFile = new File([audioBlob], audioState.savedName.replace(/\.txt$/, ".wav"), { type: "audio/wav" });
    }
    const result = await remoteJobSync(audioFile, {
      provider: "deepgram",
      language: (($("language") as HTMLSelectElement).value || "auto").trim(),
      diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
      openrouterModel: getRemoteModelValue("deepgram"),
    });
    const text = String(result.text || "").trim();
    if (text) {
      $("finalOutput").textContent = text;
      // Update the saved recording with the new transcript
      try {
        await saveRecordingText({
          name: audioState.savedName,
          archiveDir: audioState.archiveDir || "",
          requireExisting: true,
          title: text.split(/\s+/).slice(0, 8).join(" "),
          sourceText: text,
          transcriptText: text,
          provider: "deepgram",
          model: getRemoteModelValue("deepgram"),
          language: (($("language") as HTMLSelectElement).value || "auto").trim(),
        });
      } catch { }
      patchCurrentRecordingSummary({
        status: "Re-transcribed successfully via REST API.",
        tone: "success",
      });
    } else {
      $("finalOutput").textContent = "Re-transcribe returned empty result.";
    }
  } catch (e) {
    $("finalOutput").textContent = `Re-transcribe failed: ${(e as Error).message || e}`;
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-busy");
  }
});

// ── Delete All recordings ──
$("recordingsDeleteAllBtn").addEventListener("click", () => {
  openModal("deleteAllModal", "#deleteAllConfirmBtn");
});
$("deleteAllCancelBtn").addEventListener("click", () => {
  closeModal("deleteAllModal");
});
($("deleteAllModal") as HTMLDivElement).addEventListener("click", (e) => {
  if (e.target === $("deleteAllModal")) closeModal("deleteAllModal");
});
$("deleteAllConfirmBtn").addEventListener("click", async () => {
  try {
    const r = await fetch(`/api/recordings?token=${encodeURIComponent(apiToken())}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    setLatestSavedAudio(null);
    if (currentRecordingSummary?.savedName) {
      patchCurrentRecordingSummary({
        savedName: "",
        status: "Recording archive was cleared. Session summary is kept, but saved files were deleted.",
        tone: "warning",
      });
    }
    showRecordSessionNotice(`Deleted ${data.deleted} recording(s) from the archive.`, "warning", 7000);
    $("recordingContent").textContent = `Deleted ${data.deleted} recording(s).`;
    $("recordingMeta").textContent = "";
    await loadRecordings(true);
  } catch (e: unknown) {
    $("recordingContent").textContent = sanitizeUiErrorMessage(e, "Could not delete the archive.");
  } finally {
    closeModal("deleteAllModal");
  }
});
document.addEventListener("keydown", (ev) => {
  if (!activeModalId) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeModal(activeModalId);
    return;
  }
  if (ev.key !== "Tab") return;
  const modal = $(activeModalId);
  const focusables = modalFocusableElements(modal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
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
  if (!livePreviewToggle.checked) {
    liveInterimText = "";
  }
  syncLiveOutputFromState();
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
  scheduleLocalWarmup();
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
  const changed = panel.hidden !== next;
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

($("language") as HTMLSelectElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("model") as HTMLSelectElement).addEventListener("change", () => {
  queueUiPreferencesSave();
  scheduleLocalWarmup();
});
($("micSelect") as HTMLSelectElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});

let ws: WebSocket | null = null;
// Buffer for PCM frames that arrive while the WS is still CONNECTING.
// Flushed in FIFO order on the first ``pushCapturedFrame`` call after
// the socket transitions to OPEN. Prevents word loss at the start of
// a recording when the AudioWorklet fires frames before the WS
// handshake completes (50–300 ms window).
let wsPendingFrames: ArrayBuffer[] = [];
let ac: AudioContext | null = null;
let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let scriptSinkGain: GainNode | null = null;
let src: MediaStreamAudioSourceNode | null = null;
let timer: number | null = null;
let vuIntervalId: ReturnType<typeof setInterval> | null = null;
let startAt = 0;
/**
 * PCM capture sink for the current recording session. Lazily created
 * inside ``startLive`` once the mic has yielded its first frames,
 * consumed by ``pushCapturedFrame``, drained at ``stopLive``, and
 * destroyed in the teardown path. Replaces the old ``chunks:
 * Float32Array[]`` module-level array that grew without bound.
 */
let pcmSink: PcmSink | null = null;
let draftSaveTimer: number | null = null;
let workletLastFrameAt = 0;
let fallbackCaptureTimer: number | null = null;
let captureFrameCount = 0;
let captureRmsAccum = 0;
let capturePeakMax = 0;
let liveDraftText = "";
let liveDraftDisplayText = "";
let liveInterimText = "";
let liveTranscriptSegments: TranscriptSegment[] = [];
let liveRecordingSeq = 0;
let currentRecordingId = 0;
let stopTransitionInFlight = false;
let flushRequestSeq = 0;
const pendingWorkletFlushes = new Map<string, () => void>();
let liveWsMode: LiveWsMode = "local-assist";
/**
 * Finalize barrier for the live WebSocket.
 *
 * Each recording session has its own slot, keyed by the session UI
 * token. A second recording started before the first one has finished
 * finalizing cannot leak its envelope into the first one — when the
 * first session's ``waitForLiveFinalEnvelope(token, ms)`` resolves, it
 * reads only the slot that belongs to its own token.
 */
interface LiveFinalSlot {
  envelope: LiveFinalEnvelope | null;
  waiters: Array<(envelope: LiveFinalEnvelope | null) => void>;
}
const liveFinalSlots = new Map<string, LiveFinalSlot>();
let liveStreamError = "";

function ensureLiveFinalSlot(token: string): LiveFinalSlot {
  let slot = liveFinalSlots.get(token);
  if (!slot) {
    slot = { envelope: null, waiters: [] };
    liveFinalSlots.set(token, slot);
  }
  return slot;
}

function resolveLiveFinal(token: string, envelope: LiveFinalEnvelope): void {
  if (!token) {
    logger_warn_client("resolveLiveFinal called without session token; ignored");
    return;
  }
  const slot = ensureLiveFinalSlot(token);
  slot.envelope = envelope;
  const waiters = slot.waiters;
  slot.waiters = [];
  for (const waiter of waiters) {
    try {
      waiter(envelope);
    } catch (e) {
      console.warn("live final waiter threw", e);
    }
  }
}

function clearLiveStreamState(): void {
  // Drop stale slots whose sessions are definitely over. We keep slots
  // owned by the CURRENTLY active UI session so that a just-started
  // session doesn't lose its future envelope. Old sessions release
  // any lingering waiters with a null envelope so no promise hangs.
  const activeToken = activeUiSessionToken || "";
  for (const [token, slot] of liveFinalSlots) {
    if (token === activeToken) continue;
    const waiters = slot.waiters;
    slot.waiters = [];
    for (const waiter of waiters) {
      try {
        waiter(null);
      } catch (e) {
        console.warn("stale live final waiter threw", e);
      }
    }
    liveFinalSlots.delete(token);
  }
  liveStreamError = "";
  liveInterimText = "";
}

function waitForLiveFinalEnvelope(
  token: string,
  timeoutMs: number
): Promise<LiveFinalEnvelope | null> {
  if (!token) {
    return Promise.resolve(null);
  }
  const slot = ensureLiveFinalSlot(token);
  if (slot.envelope) {
    return Promise.resolve(slot.envelope);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: LiveFinalEnvelope | null): void => {
      if (settled) return;
      settled = true;
      slot.waiters = slot.waiters.filter((w) => w !== handler);
      resolve(value);
    };
    const handler = (envelope: LiveFinalEnvelope | null): void => done(envelope);
    slot.waiters.push(handler);
    window.setTimeout(
      () => done(slot.envelope),
      Math.max(0, timeoutMs)
    );
  });
}

// Tiny helper so the logger_warn_client reference above is not a
// dangling name during initialization.
function logger_warn_client(message: string): void {
  console.warn(message);
}

/**
 * ── Recording output SSOT ───────────────────────────────────────────────
 *
 * There are two distinct semantic channels the rest of the system reads:
 *
 *   1. ``pasteReady`` — consumed by the Electron main process through
 *      ``window.__transcriptorLastFinished*`` and
 *      ``window.__transcriptorFinishedRecords``. This tells the overlay
 *      "a transcript is ready to paste NOW".
 *
 *   2. ``uiFinal`` — consumed by the Electron main process through
 *      ``window.__transcriptorLastUiFinal*`` for overlay state machines
 *      that need to know what the UI is currently showing. This is also
 *      what drives the ``$finalOutput`` DOM element.
 *
 * Historically these lived in two separate helpers (``publishFinishedRecording``
 * and ``publishRecordingFinalSignal``) and were always called in pairs at
 * almost every site. That made it trivial to update one channel and
 * silently forget the other. ``publishRecordingOutput`` is the new SSOT:
 * one call, one atomic update of both channels plus the DOM.
 */
interface RecordingOutputSignal {
  recordingId: number;
  /** The canonical, paste-ready text (post-upscale if upscaling was used).
   *  Passing an empty string means "no paste is available". */
  pasteText?: string;
  /** The text to render in the ``$finalOutput`` DOM element. Defaults to
   *  ``pasteText`` when omitted. Pass explicit ``""`` to clear the DOM. */
  domText?: string;
  /** Classification of this event for the overlay state machine. */
  kind?: RecordingFinalSignalKind;
  sessionToken?: string;
}

function recordingOutputIsInvalidTranscript(payload: string): boolean {
  const lower = payload.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (!payload) return true;
  if (lower === "error" || lower === "[websocket error]") return true;
  if (lower.startsWith("http ")) return true;
  if (compact === "[silence]") return true;
  return false;
}

function publishRecordingOutput(signal: RecordingOutputSignal): void {
  const rid = Math.max(0, Number(signal.recordingId || 0));
  const pasteText = String(signal.pasteText || "").trim();
  const domText =
    signal.domText === undefined ? pasteText : String(signal.domText || "").trim();
  const kind: RecordingFinalSignalKind = pasteText
    ? signal.kind || "transcript"
    : signal.kind || "";
  const now = Date.now();

  // Channel 1: paste-ready history (only for valid transcripts).
  if (pasteText && !recordingOutputIsInvalidTranscript(pasteText)) {
    window.__transcriptorLastFinishedText = pasteText;
    window.__transcriptorLastFinishedAt = now;
    window.__transcriptorLastFinishedRecordingId = rid;
    if (rid > 0) {
      const list = Array.isArray(window.__transcriptorFinishedRecords)
        ? window.__transcriptorFinishedRecords.slice()
        : [];
      const next = list.filter((entry) => Number(entry?.recordingId || 0) !== rid);
      next.push({ recordingId: rid, finishedAt: now, text: pasteText });
      window.__transcriptorFinishedRecords = next.slice(-30);
    }
  }

  // Channel 2: UI-final signal (always updated so the overlay can track
  // both transcript and error/status states).
  window.__transcriptorLastUiFinalText = pasteText;
  window.__transcriptorLastUiFinalAt = pasteText ? now : 0;
  window.__transcriptorLastUiFinalRecordingId = pasteText ? rid : 0;
  window.__transcriptorLastUiFinalKind = kind;

  // Channel 3: the DOM itself. Respects the active UI session so that a
  // stale async handler from a previous recording cannot clobber the
  // current display.
  if (isCurrentUiSession(signal.sessionToken || "")) {
    $("finalOutput").textContent = domText;
    // Channel 4: when a real transcript lands in the Transcribe pane,
    // the Live Preview pane must no longer show the same text — two
    // panes with identical content is the "перекрывающиеся транскрипции"
    // bug the user reported. Clearing only happens for the
    // ``transcript`` kind so status/error messages (which are
    // intermediate) keep the live preview visible for context.
    if (kind === "transcript" && pasteText) {
      liveDraftText = "";
      liveDraftDisplayText = "";
      liveInterimText = "";
      liveTranscriptSegments = [];
      liveCommittedDisplayCache = "";
      scheduleLiveOutputRender();
    }
  }
}

/**
 * Atomic reset of EVERY window.__transcriptor* scalar the overlay
 * reads. Called when a new recording begins or when an explicit
 * ``resetOutputs()`` fires.
 *
 * The ``__transcriptorFinishedRecords`` history array is intentionally
 * NOT cleared here — it's keyed by recordingId and bounded at 30
 * entries, and the overlay uses it as a lookup table to recover the
 * text for a specific finished recordingId even after newer sessions
 * have overwritten the scalar pointers.
 *
 * Previously this function only reset Channel 2 (ui-final), leaving
 * Channel 1 (paste-ready: LastFinishedText/At/RecordingId) pointing at
 * the PREVIOUS session's transcript. During the startup window of a
 * new recording, the overlay could observe stale paste-ready state
 * and trigger an overlay transition keyed on it.
 */
function clearRecordingOutput(): void {
  // Channel 1 — paste-ready scalars.
  window.__transcriptorLastFinishedText = "";
  window.__transcriptorLastFinishedAt = 0;
  window.__transcriptorLastFinishedRecordingId = 0;
  // Channel 2 — ui-final signal.
  window.__transcriptorLastUiFinalText = "";
  window.__transcriptorLastUiFinalAt = 0;
  window.__transcriptorLastUiFinalRecordingId = 0;
  window.__transcriptorLastUiFinalKind = "";
}

/**
 * Legacy shims — kept so the existing call sites don't need to move in
 * the same patch. They route through ``publishRecordingOutput`` so all
 * three channels stay consistent.
 */
function publishFinishedRecording(recordingId: number, text: string): void {
  publishRecordingOutput({ recordingId, pasteText: text, kind: "transcript" });
}

function clearRecordingFinalSignal(): void {
  clearRecordingOutput();
}

function publishRecordingFinalSignal(opts: {
  recordingId: number;
  signalText?: string;
  domText?: string;
  kind?: RecordingFinalSignalKind;
  sessionToken?: string;
}): void {
  publishRecordingOutput({
    recordingId: opts.recordingId,
    pasteText: opts.signalText,
    domText: opts.domText,
    kind: opts.kind,
    sessionToken: opts.sessionToken,
  });
}

/**
 * Live-output render coalescing.
 *
 * Deepgram interim events can arrive at 10–20 Hz and every segment
 * commit rewrites ``$("liveOutput").textContent`` + scrolls to the
 * bottom. Naively doing that on every event produces layout thrash
 * and visible jank. We coalesce all updates into a single rAF tick so
 * no matter how many events arrive between paints, the DOM is touched
 * at most once per frame.
 */
let liveOutputRenderScheduled = false;

function scheduleLiveOutputRender(): void {
  if (liveOutputRenderScheduled) return;
  liveOutputRenderScheduled = true;
  const run = (): void => {
    liveOutputRenderScheduled = false;
    const el = $("liveOutput");
    if (!shouldLivePreview()) {
      if (el.textContent !== "") el.textContent = "";
      return;
    }
    const text = getVisibleLivePreviewText();
    if (el.textContent !== text) {
      el.textContent = text;
      el.scrollTop = el.scrollHeight;
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    window.setTimeout(run, 16);
  }
}

function syncLiveOutputFromState(): void {
  scheduleLiveOutputRender();
}

function resetLiveDraftState(): void {
  liveDraftText = "";
  liveDraftDisplayText = "";
  liveInterimText = "";
  liveTranscriptSegments = [];
  liveCommittedDisplayCache = "";
  syncLiveOutputFromState();
}

function setLiveDraftState(text: string, displayText = text): void {
  liveDraftText = normalizeTranscriptWhitespace(text);
  liveDraftDisplayText = String(displayText || "").trim();
  syncLiveOutputFromState();
}

function setLiveInterimText(text: string): void {
  const next = normalizeTranscriptWhitespace(text);
  if (next === liveInterimText) return;
  liveInterimText = next;
  syncLiveOutputFromState();
}

/**
 * Incremental committed-segment buffer.
 *
 * ``mergeTranscriptSegments`` is O(n log n); rebuilding the flat join
 * on every append is O(n). For a 1-hour session with ~3000 committed
 * segments that's ~4.5M string operations on every interim event.
 * Instead we maintain an append-only cache that only rebuilds when
 * the merge detected an out-of-order segment (which shouldn't happen
 * with well-behaved streaming providers but we guard for it).
 */
let liveCommittedDisplayCache = "";
// Snapshot of ``liveInterimText`` taken JUST BEFORE it is cleared by
// an incoming ``is_final`` event. When the user presses Stop while
// Deepgram is mid-utterance, the live interim may contain words that
// Deepgram's ``is_final`` hasn't covered yet. The ``is_final`` handler
// clears ``liveInterimText`` (correct for live display), but stopLive's
// ``getCanonicalLiveSourceText()`` then sees an empty interim and loses
// those trailing words.
//
// ``lastInterimSnapshot`` preserves the interim so stopLive can recover
// it. It is reset to "" at the start of every new recording (startLive)
// and updated every time ``appendLiveTranscriptSegments`` fires.
let lastInterimSnapshot = "";

function appendLiveTranscriptSegments(rawSegments: unknown[]): void {
  const nextSegments = Array.isArray(rawSegments)
    ? rawSegments
      .map((segment) => normalizeTranscriptSegment(segment))
      .filter((segment): segment is TranscriptSegment => !!segment)
    : [];
  if (!nextSegments.length) return;

  const prevLen = liveTranscriptSegments.length;
  const combined = liveTranscriptSegments.concat(nextSegments);
  const merged = mergeTranscriptSegments(combined);
  const appendOnly =
    merged.length === combined.length &&
    merged.length >= prevLen &&
    merged.slice(0, prevLen).every((seg, i) => seg === liveTranscriptSegments[i]);

  liveTranscriptSegments = merged;
  // Snapshot the interim BEFORE clearing it so stopLive can recover
  // trailing words that haven't been finalized yet.
  if (liveInterimText) {
    lastInterimSnapshot = liveInterimText;
  }
  // Committed-final text is the SSOT. Clear any lingering interim so
  // the visible preview matches the committed stream.
  liveInterimText = "";

  const separator = liveWsMode === "deepgram-stream" ? " " : "\n";
  // If diarize is on, rebuild via formatSegmentsForDisplay because the
  // speaker prefix transitions can't be incrementally appended without
  // losing the "same-speaker coalesce" behavior. For mono streams we
  // take the fast append-only path.
  const hasDiarization = liveTranscriptSegments.some((s) => s.speaker !== undefined);
  if (hasDiarization) {
    liveCommittedDisplayCache = formatSegmentsForDisplay(liveTranscriptSegments, separator);
  } else if (appendOnly) {
    // O(k) incremental append where k is the number of new segments.
    let delta = "";
    for (let i = prevLen; i < merged.length; i++) {
      const t = merged[i].text;
      if (!t) continue;
      if (delta) delta += separator;
      delta += t;
    }
    if (delta) {
      liveCommittedDisplayCache = liveCommittedDisplayCache
        ? `${liveCommittedDisplayCache}${separator}${delta}`
        : delta;
    }
  } else {
    // Segments reordered or deduped — rebuild from scratch.
    liveCommittedDisplayCache = merged
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(separator)
      .trim();
  }
  setLiveDraftState(joinTranscriptSegments(liveTranscriptSegments), liveCommittedDisplayCache);
}

function resetOutputs(): void {
  resetRecordSessionNotice();
  setCurrentRecordingSummary(null);
  resetLiveDraftState();
  publishRecordingOutput({ recordingId: 0, pasteText: "", domText: "", kind: "" });
  $("upscaleOutput").textContent = "";
  $("transcribeLatency").textContent = "--";
  $("upscaleLatency").textContent = "--";
  $("timer").textContent = "00:00";
  $("progressRow").hidden = true;
  $("downloadRow").hidden = true;
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "0%";
  // Clear stale audio from the previous recording so the user
  // never sees a 3-second "ghost" audio player while a new 52-second
  // recording is in progress. The new session's audio will be
  // rendered after stopLive persists it.
  setCurrentRecordingAudio(null);
}

// EMA (exponential moving average) smoothing factor for
// ``__transcriptorRmsLevel``. The overlay's silence detector polls
// this value every 120 ms, but the worklet posts a frame every
// ~2.67 ms (128 samples @ 48 kHz). Without smoothing, the overlay
// samples ONE instantaneous 2.67 ms window and can catch a micro-
// pause between syllables (natural in conversational speech) as
// "silence", accumulate 2 s of intermittent dips, and trigger a
// false auto-stop WHILE THE USER IS STILL SPEAKING. An EMA with
// alpha ~0.06 gives a ~45-frame smoothing window (~120 ms) that
// tracks speech energy faithfully but rides through inter-word
// gaps without dropping to zero.
let captureRmsEma = 0;
const CAPTURE_RMS_EMA_ALPHA = 0.06;

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
  // Smooth RMS via EMA so the overlay's silence detector sees the
  // energy trend over ~120 ms, not a single 2.67 ms micro-window
  // that might happen to land on an inter-syllable gap.
  captureRmsEma = CAPTURE_RMS_EMA_ALPHA * rms + (1 - CAPTURE_RMS_EMA_ALPHA) * captureRmsEma;
  // CRITICAL: set __transcriptorRmsLevel here too, not just in setVU.
  // The overlay main process reads this for silence detection.
  // setVU runs in rAF which stalls when the window is hidden.
  window.__transcriptorRmsLevel = Math.max(0, Number.isFinite(captureRmsEma) ? captureRmsEma : 0);
  window.__transcriptorVuLevel = Math.max(0, Math.min(1, rms * UI_TOKENS.capture.vuAmplify));
  if (!ac) return;
  const ds = downsample(input, ac.sampleRate, AUDIO_TOKENS.liveSampleRateHz);

  // ── Canonical-audio sink path ──────────────────────────────────────
  // Samples go into the session's ``PcmSink``. The OPFS-backed
  // variant spools them to disk as they arrive so the JS heap is
  // never holding more than a few milliseconds of pending audio.
  // The memory-backed fallback (OPFS unavailable) keeps Int16Array
  // chunks — still half the footprint of the old Float32Array
  // accumulator. Either way the old ``chunks: Float32Array[]``
  // consolidation / 2h rotating-window dance is gone — the sink is
  // bounded by definition.
  if (pcmSink) {
    pcmSink.append(ds);
  }

  // ── Live WebSocket path ───────────────────────────────────────────
  // Independent of the canonical sink: the PCM16 bytes are streamed
  // to the backend /ws/transcribe in real time regardless of whether
  // the sink succeeded or not.
  //
  // IMPORTANT: if the WS is still CONNECTING (not yet OPEN), buffer
  // the frame and flush the buffer once the socket opens. This fixes
  // word loss at the START of a recording — the AudioWorklet starts
  // producing frames immediately on mic connect, but the WS handshake
  // can take 50-300 ms. Without buffering those early frames were
  // silently dropped and Deepgram never heard the first syllables.
  const pcm = new ArrayBuffer(ds.length * 2);
  const dv = new DataView(pcm);
  for (let i = 0; i < ds.length; i++) {
    const x = Math.max(-1, Math.min(1, ds[i]));
    dv.setInt16(i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    // Flush any buffered frames first (FIFO order preserved). A
    // ``send`` throw here means the socket transitioned to CLOSING
    // mid-flush (race between readyState read and the native send
    // call). We log the reason once per recording so the tail-cut
    // debugger knows why some frames never reached Deepgram, and
    // stop flushing the rest — the REST-fallback in stopLive will
    // recover any audio from the canonical PCM sink.
    while (wsPendingFrames.length > 0) {
      const queued = wsPendingFrames.shift()!;
      try {
        ws.send(queued);
      } catch (e) {
        console.debug("live ws flush interrupted", e);
        break;
      }
    }
    try {
      ws.send(pcm);
    } catch (e) {
      console.debug("live ws send skipped", e);
    }
  } else if (ws.readyState === WebSocket.CONNECTING) {
    // Buffer up to 2 seconds of audio (~62 frames @ 128 samples/frame
    // at 16 kHz after downsampling). Beyond that the WS is likely
    // stuck and we should not accumulate memory indefinitely.
    if (wsPendingFrames.length < 500) {
      wsPendingFrames.push(pcm);
    }
  }
  // CLOSING / CLOSED → silently drop (recording is ending).
}

async function flushWorkletPort(timeoutMs = 350): Promise<void> {
  const node = workletNode;
  if (!node) return;
  const token = `flush-${Date.now()}-${++flushRequestSeq}`;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timerId: number | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      pendingWorkletFlushes.delete(token);
      resolve();
    };
    pendingWorkletFlushes.set(token, finish);
    timerId = window.setTimeout(finish, timeoutMs);
    try {
      node.port.postMessage({ type: "flush", token });
    } catch (e) {
      console.debug("flushWorkletPort: postMessage failed", e);
      finish();
    }
  });
}

function micErrorTag(e: unknown): string {
  const err = e as { name?: unknown; message?: unknown };
  const name = String(err?.name || "").trim();
  const msg = String(err?.message || "").trim();
  return [name, msg].filter(Boolean).join(": ");
}

async function startLive(): Promise<void> {
  if (isBusy || stopTransitionInFlight) return;
  let sessionArchiveDir = "";
  try {
    sessionArchiveDir = await ensureRecordingsArchiveReady();
  } catch (e) {
    const message = (e as Error).message || "Recordings archive is not ready yet.";
    publishRecordingOutput({
      recordingId: 0,
      pasteText: "",
      domText: message,
      kind: "error",
    });
    patchCurrentRecordingSummary({ status: message, tone: "error" });
    return;
  }
  liveStartAbortReason = "";
  const sessionUiToken = createClientSessionId();
  activeUiSessionToken = sessionUiToken;
  activeLiveSessionId = sessionUiToken;
  activeLiveArchiveDir = sessionArchiveDir;
  resetOutputs();
  const selectedProvider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const selectedEffectiveProvider = resolveEffectiveProvider(selectedProvider);
  const sessionLocalModels = resolveSessionLocalModels(selectedProvider);
  const selectedModel =
    selectedEffectiveProvider === "local"
      ? sessionLocalModels.finalLocalModel
      : getRemoteModelValue(selectedEffectiveProvider);
  const selectedLanguage = (($("language") as HTMLSelectElement).value || "auto").trim();
  const sessionTitle = "Recording " + new Date().toLocaleString();
  activeLiveSessionSnapshot = {
    provider: selectedProvider,
    effectiveProvider: selectedEffectiveProvider,
    model: selectedModel,
    language: selectedLanguage,
    assistLocalModel: sessionLocalModels.assistLocalModel,
    finalLocalModel: sessionLocalModels.finalLocalModel,
  };
  setCurrentRecordingSummary({
    title: sessionTitle,
    status: "Preparing microphone capture and session buffers.",
    tone: "info",
  }, sessionUiToken);
  // Tear down any previous sink BEFORE allocating the new one. If
  // startLive was called twice without a clean stopLive in between
  // (e.g. after a start-path error), the old sink is destroyed here.
  if (pcmSink) {
    const prior = pcmSink;
    pcmSink = null;
    void prior.destroy();
  }
  // Await the sink so it is ready BEFORE the first audio frame. The
  // old fire-and-forget path dropped frames that arrived before the
  // async OPFS init resolved (~50 ms, but up to 500 ms on slow devices).
  pcmSink = await createPcmSink(sessionUiToken);
  workletLastFrameAt = 0;
  silenceStartedAtMs = 0;
  autoStopTriggered = false;
  captureFrameCount = 0;
  captureRmsAccum = 0;
  capturePeakMax = 0;
  captureRmsEma = 0;
  lastInterimSnapshot = "";
  wsPendingFrames = [];
  resetLiveDraftState();
  clearLiveStreamState();
  liveWsMode = resolveLiveWsMode(activeLiveSessionSnapshot);
  setBusy(true, sessionUiToken);
  isRecording = true;
  currentRecordingId = ++liveRecordingSeq;
  // Recording started — transcription happens on stop via single sync call.
  window.__transcriptorIsRecording = true;
  window.__transcriptorLastFrameAt = Date.now();
  // Atomically clear every overlay-observable global BEFORE setting
  // the new currentRecordingId, so the overlay can never observe
  // "new currentRecordingId + old paste-ready text" in a transient
  // race during startLive.
  clearRecordingFinalSignal();
  window.__transcriptorCurrentRecordingId = currentRecordingId;
  setRecordButton(true);
  // Keep single mic button interactive while recording.
  ($("btnStart") as HTMLButtonElement).disabled = false;
  (document.getElementById("btnStop") as HTMLButtonElement).disabled = false;
  setStatusScoped(sessionUiToken, "Starting");
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
    const durationSec = (Date.now() - startAt) / 1000;
    if (isCurrentUiSession(sessionUiToken)) {
      $("timer").textContent = fmtTime(durationSec);
    }
  }, UI_TOKENS.timer.tickMs);

  const enableVisibleLivePreview = shouldLivePreview();
  const wsQuery = new URLSearchParams({
    provider: liveWsMode === "deepgram-stream" ? "deepgram" : "local",
    language: activeLiveSessionSnapshot.language,
    session_id: activeLiveSessionId,
    archive_dir: activeLiveArchiveDir,
    token: apiToken(),
    diarize: (($("diarizeCheck") as HTMLInputElement).checked ? "true" : "false"),
  });
  if (liveWsMode === "deepgram-stream") {
    wsQuery.set("model", activeLiveSessionSnapshot.model || getRemoteModelValue("deepgram"));
  } else {
    wsQuery.set("model", activeLiveSessionSnapshot.assistLocalModel);
  }
  ws = new WebSocket(wsBase() + "/ws/transcribe?" + wsQuery.toString());
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    const statusMsg =
      liveWsMode === "deepgram-stream"
        ? enableVisibleLivePreview
          ? "Recording. Deepgram live streaming is active."
          : "Recording. Deepgram live stream is committing segments in the background."
        : enableVisibleLivePreview
          ? selectedEffectiveProvider === "local"
            ? "Recording with live preview enabled."
            : "Recording with live preview enabled. Local assist is canonical for fast stop."
          : "Recording. Background local assist is active for fast stop finalization.";
    patchCurrentRecordingSummary({ status: statusMsg, tone: "info" }, sessionUiToken);
  };
  ws.onerror = (ev) => {
    // Scope the log to this session token so a stale socket from a
    // prior recording can't confuse the developer into thinking the
    // current session is broken. No state mutation — actual error
    // surfacing happens through the higher-level 'error' message
    // path from the backend or the onclose handler below.
    console.warn(`live ws transport error [session=${sessionUiToken.slice(0, 8)}]`, ev);
  };
  ws.onclose = (ev) => {
    // A clean close (1000/1005) after finalize is expected. An unclean
    // close before finalize means the stream died; release any pending
    // waiters for THIS session with a synthetic error envelope so
    // stopLive doesn't hang on waitForLiveFinalEnvelope.
    const slot = liveFinalSlots.get(sessionUiToken);
    if (!slot) return;
    if (slot.envelope) return;
    if (slot.waiters.length === 0) return;
    if (ev.wasClean && (ev.code === 1000 || ev.code === 1005)) return;
    console.warn(`live ws unexpectedly closed (code=${ev.code}, reason=${ev.reason || "?"})`);
    resolveLiveFinal(sessionUiToken, {
      text: "",
      segments: [],
      durationSec: 0,
      source: liveWsMode,
      error: `live stream closed unexpectedly (code=${ev.code})`,
    });
  };
  ws.onmessage = (ev: MessageEvent<string>) => {
    const msg = parseLiveWsMessage(ev.data);
    if (!msg) return;
    switch (msg.type) {
      case "error": {
        liveStreamError = msg.error;
        console.warn(`live ws error event (fatal=${msg.fatal}):`, msg.error);
        // Only surface truly fatal errors to the user. Non-fatal
        // stream drops (when we already have committed segments) are
        // logged to the console but invisible in the pill — the
        // recording keeps going, just not streaming to Deepgram
        // anymore. stopLive picks up the committed text as the
        // transcript so the user experience is seamless.
        if (msg.fatal) {
          patchCurrentRecordingSummary(
            {
              status: `Live stream error: ${msg.error}`,
              tone: "error",
            },
            sessionUiToken
          );
          if (shouldLivePreview()) {
            setLiveInterimText(`[${msg.error}]`);
          }
        }
        return;
      }
      case "segments": {
        appendLiveTranscriptSegments(msg.segments);
        if (liveDraftText) {
          persistLiveDraft(true);
        }
        return;
      }
      case "interim": {
        setLiveInterimText(msg.segment.text);
        return;
      }
      case "final": {
        const envelope: LiveFinalEnvelope = {
          text: normalizeTranscriptWhitespace(msg.text),
          segments: msg.segments,
          durationSec: msg.durationSec,
          source: msg.source || liveWsMode,
        };
        if (msg.error) envelope.error = msg.error;
        resolveLiveFinal(sessionUiToken, envelope);
        return;
      }
    }
  };

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
    // Device disconnect mid-recording: when AirPods/USB mic disconnect,
    // the audio track fires ``ended`` but nothing in the old code
    // listened for it. The recording would continue in silence until
    // the user manually pressed Stop — and the transcript would be
    // missing everything after the disconnect. We now auto-stop on
    // track ended so the user gets a clean transcript up to the
    // disconnect point and a visible "Mic disconnected" status.
    const capturedSessionToken = sessionUiToken;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (!isRecording) return;
        if (activeUiSessionToken !== capturedSessionToken) return;
        console.warn("Audio track ended (device disconnect) — auto-stopping");
        patchCurrentRecordingSummary(
          { status: "Microphone disconnected. Saving what was captured.", tone: "warning" },
          capturedSessionToken,
        );
        void stopLive(shouldAutoTranscribe());
      }, { once: true });
    }
    ac = new AudioContext();
    if (ac.state !== "running") {
      try {
        await ac.resume();
      } catch (e) {
        console.debug("AudioContext resume rejected (non-fatal)", e);
      }
    }
    recordedWebmChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      // MediaRecorder emits one chunk per second (see ``start(1000)``
      // below). The same 2h recording-window limit applies: if a
      // session grows beyond that, rotate out the oldest chunks so
      // we never end up holding tens of thousands of Blob references.
      const WEBM_WINDOW_CHUNKS = 60 * 120; // 2 hours @ 1 chunk/s
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedWebmChunks.push(e.data);
          if (recordedWebmChunks.length > WEBM_WINDOW_CHUNKS) {
            recordedWebmChunks.splice(0, recordedWebmChunks.length - WEBM_WINDOW_CHUNKS);
          }
        }
      };
      mediaRecorder.start(1000);
    } catch (e) {
      console.warn("MediaRecorder failed, falling back to WAV encoder", e);
      // If ``.start(1000)`` threw AFTER the constructor succeeded we
      // have a half-initialised MediaRecorder sitting on the module
      // global. Null it so stopMediaRecorderAndFlush doesn't try to
      // stop an object in a bad state (which would throw again and
      // leave the recorder's state machine corrupted). The WebM path
      // simply falls back to the PCM sink for canonical audio.
      if (mediaRecorder) {
        try {
          mediaRecorder.ondataavailable = null;
        } catch { }
        mediaRecorder = null;
      }
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
    // Promoted to module scope so stopLive can clear it deterministically.
    // Previously local → leaked after stopLive because analyser null-check
    // self-cleanup was best-effort and delayed by up to one tick.
    if (vuIntervalId) { clearInterval(vuIntervalId); vuIntervalId = null; }
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
      const msg = ev.data as unknown;
      if (msg instanceof Float32Array) {
        pushCapturedFrame(msg);
        return;
      }
      if (msg && typeof msg === "object" && "type" in msg) {
        const data = msg as { type?: unknown; token?: unknown };
        if (data.type === "flush-ack") {
          const token = String(data.token || "");
          const resolve = pendingWorkletFlushes.get(token);
          if (resolve) resolve();
        }
      }
    };

    src.connect(workletNode);

    // Enterprise fallback: if AudioWorklet path is silent/stalled on this host,
    // switch to ScriptProcessor capture so recording still works.
    if (fallbackCaptureTimer) {
      clearTimeout(fallbackCaptureTimer);
      fallbackCaptureTimer = null;
    }
    fallbackCaptureTimer = window.setTimeout(() => {
      // Capture mutable globals into locals so the compiler (and the
      // reader) can be sure nothing reassigns them between the null
      // guard and the dereference. Previously this callback read ``ac``
      // and ``src`` directly; they are module-level ``let`` variables
      // that stopLive() nulls out during cleanup, so in principle a
      // race could crash with a null-dereference. In practice it was
      // safe because everything below runs synchronously, but making
      // the snapshot explicit eliminates the class of bug entirely.
      const localAc = ac;
      const localSrc = src;
      if (!localAc || !localSrc || !isRecording) return;
      const noFrames = captureFrameCount < 3;
      if (!noFrames) return;
      try {
        scriptNode = localAc.createScriptProcessor(4096, 1, 1);
        scriptSinkGain = localAc.createGain();
        scriptSinkGain.gain.value = 0;
        scriptNode.onaudioprocess = (ev: AudioProcessingEvent) => {
          const ch = ev.inputBuffer.getChannelData(0);
          if (!ch || !ch.length) return;
          pushCapturedFrame(new Float32Array(ch));
        };
        localSrc.connect(scriptNode);
        scriptNode.connect(scriptSinkGain);
        scriptSinkGain.connect(localAc.destination);
        if (shouldLivePreview()) {
          const cur = liveDraftDisplayText || "";
          if (!cur.includes("[Mic fallback engaged]")) {
            setLiveDraftState(liveDraftText, (cur ? `${cur}\n` : "") + "[Mic fallback engaged]");
          }
        }
      } catch (e) {
        console.warn("ScriptProcessor fallback init failed", e);
      }
    }, UI_TOKENS.capture.fallbackInitDelayMs);

  } catch (e) {
    liveStartAbortReason = micErrorTag(e) || (e as Error).message || "Unable to start recording.";
    if (shouldLivePreview()) {
      setLiveDraftState("", liveStartAbortReason);
    }
    patchCurrentRecordingSummary({
      status: liveStartAbortReason,
      tone: "error",
    }, sessionUiToken);
    await stopLive(false);
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
  if (stopTransitionInFlight) return;
  if (!isRecording) return;
  stopTransitionInFlight = true;
  // Wrap the entire body in try/finally so the in-flight guard is ALWAYS
  // cleared, even if a pre-main-try await (flushWorkletPort / waitForWorklet
  // Drain / stopMediaRecorderAndFlush / pcmSink.finalize / selectCanonical
  // CapturedAudio) throws an uncaught exception before reaching the
  // existing try at the "Assemble the authoritative transcript" block.
  // Without this wrapper, any such throw would leave stopTransitionInFlight
  // = true forever, permanently blocking all future stopLive calls.
  try {
  const recordingId = currentRecordingId;
  const liveSessionId = activeLiveSessionId;
  const sessionUiToken = liveSessionId;
  const recordedMs = startAt > 0 ? Math.max(0, Date.now() - startAt) : 0;
  const recordedSec = recordedMs / 1000;
  let title = "Recording " + new Date().toLocaleString();
  const _smartTitle = (text: string): string => {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) return title;
    const preview = words.slice(0, 8).join(" ");
    return preview.length > 80 ? preview.slice(0, 77) + "..." : preview;
  };
  const liveSnapshot = activeLiveSessionSnapshot || {
    provider: (($("providerSelect") as HTMLSelectElement).value || "local") as Provider,
    effectiveProvider: resolveEffectiveProvider((($("providerSelect") as HTMLSelectElement).value || "local") as Provider),
    model: resolveSessionLocalModels((($("providerSelect") as HTMLSelectElement).value || "local") as Provider).finalLocalModel,
    language: (($("language") as HTMLSelectElement).value || "auto").trim(),
    assistLocalModel: resolveSessionLocalModels((($("providerSelect") as HTMLSelectElement).value || "local") as Provider).assistLocalModel,
    finalLocalModel: resolveSessionLocalModels((($("providerSelect") as HTMLSelectElement).value || "local") as Provider).finalLocalModel,
  };
  const providerValue = liveSnapshot.provider;
  const languageValue = liveSnapshot.language;
  const effectiveProvider = liveSnapshot.effectiveProvider;
  const modelValue = liveSnapshot.model;
  const sourceLiveText = getCanonicalLiveSourceText();
  const avgCaptureRms = captureFrameCount > 0 ? captureRmsAccum / captureFrameCount : 0;
  const noLiveText = !sourceLiveText;
  const hardSilence = avgCaptureRms < 0.0009 && capturePeakMax < 0.012;
  const likelySilenceWithoutPreview = noLiveText && avgCaptureRms < 0.003 && capturePeakMax < 0.045;
  const tooShortToTrust = recordedSec < 1.25;
  const silentCapture =
    (tooShortToTrust && hardSilence) ||
    (tooShortToTrust && likelySilenceWithoutPreview);
  const provider = effectiveProvider;
  let remoteApiPromise: Promise<{ text: string; provider: string; model?: string }> | null = null;
  let savedAudioFile: File | null = null;
  let transcribeInputFile: File | null = null;
  const sessionArchiveDir = String(activeLiveArchiveDir || currentArchiveDirSnapshot()).trim();
  const startupAbortReason = liveStartAbortReason;
  liveStartAbortReason = "";

  // Timing instrumentation — each phase stamps a timestamp so we can
  // see exactly where stopLive spends its milliseconds. Inspect via
  // ``window.__transcriptorStopTimings`` in devtools after a stop.
  const stopTimings: Array<[string, number]> = [];
  const stopT0 = performance.now();
  const mark = (label: string): void => {
    stopTimings.push([label, performance.now() - stopT0]);
  };

  setCurrentRecordingSummary({
    title: _smartTitle(sourceLiveText),
    status: "Finalizing recording and assembling the canonical audio file.",
    tone: "info",
  }, sessionUiToken);

  // ── Tail-preserving stop sequence ───────────────────────────────────
  //
  // We want EVERY sample captured up to the instant the user pressed
  // Stop to land in both the canonical WAV and the Deepgram transcript.
  // Any reordering here directly translates into "last few seconds
  // chopped off" reports.
  //
  // The enforced ordering is:
  //
  //   1. Stop the MediaStream tracks. This synchronously freezes the
  //      microphone — no new AudioWorklet render quanta will ever be
  //      produced after this returns.
  //
  //   2. flushWorkletPort + waitForWorkletDrain. The worklet has a
  //      MessagePort queue; anything posted BEFORE step 1 returned is
  //      still in flight. We barrier on it so every ``pushCapturedFrame``
  //      callback that the worklet already scheduled runs before we
  //      move on — this is the ONLY way to guarantee that the last
  //      PCM sample is handed to pcmSink.append AND to ws.send.
  //
  //   3. Stop MediaRecorder and flush WebM chunks. Runs after the
  //      mic is dead so we don't generate more audio while we're
  //      waiting on the stop event.
  //
  //   4. pcmSink.finalize. After step 2 we know every captured frame
  //      has been handed to sink.append — finalize just drains the
  //      already-queued chunks.
  //
  //   5. Send {type:"finalize"} to backend. At this point ws has no
  //      more PCM to send (mic is dead, worklet drained), so the
  //      backend receiver sees the finalize message AFTER every byte
  //      we intended to send. This is what tells Deepgram to close
  //      its stream and return the final envelope covering ALL
  //      audio — including the trailing clause the user was still
  //      speaking.
  //
  // The old order was: flushWorkletPort → waitForWorkletDrain →
  // stopMediaRecorderAndFlush (up to 3s!) → stream.stop() → finalize.
  // That left the mic live for up to 3 seconds while MediaRecorder was
  // being flushed, and those trailing frames could arrive at Deepgram
  // AFTER CloseStream and get dropped. Reordering stream.stop() to
  // step 1 fixes this at the root.
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.debug("MediaStream stop failed (non-fatal)", e);
  }
  mark("stream.getTracks.stop");

  await flushWorkletPort();
  mark("flushWorkletPort");
  await waitForWorkletDrain();
  mark("waitForWorkletDrain");
  await stopMediaRecorderAndFlush();
  mark("stopMediaRecorderAndFlush");

  // Tell the backend to finalize the upstream provider (Deepgram or local)
  // BEFORE we close the socket. The backend will send a {type:"final", ...}
  // envelope that we await below. This is what eliminates the double
  // re-upload path — no need to re-submit the full audio because Deepgram
  // has already finalized the stream. The awaited promise is keyed by
  // session token so that if the user starts a new recording before this
  // one finishes finalizing, we cannot accidentally read the new
  // session's envelope.
  //
  // We snapshot ``liveStreamError`` only — the committed segments
  // snapshot is NOT taken here. Instead we read the LIVE
  // ``liveTranscriptSegments`` after awaiting ``liveFinalPromise`` so
  // interim segments that arrive while the envelope is in flight
  // (very common: Deepgram streams one more ``is_final`` message
  // covering the tail of the utterance AFTER CloseStream) still make
  // it into the transcript. The old code snapshotted BEFORE the wait
  // and lost those trailing segments — that was the tail-cut bug.
  const liveStreamErrorAtStop = liveStreamError;

  let liveFinalPromise: Promise<LiveFinalEnvelope | null> | null = null;
  if (ws) {
    // 2000 ms budget for the full round-trip after CloseStream.
    // Covers the 700 ms endpointing threshold + Deepgram's server-
    // side finalize (~500–1500 ms) + network RTT + backend forward.
    // The FAST PATH in the Deepgram branch below short-circuits this
    // ceiling entirely when committed segments already cover the
    // recording tail — so this value is only a safety floor for
    // pathologically slow finalizes, not the normal stop latency.
    const finalizeWaitMs = 2000;
    liveFinalPromise = waitForLiveFinalEnvelope(sessionUiToken, finalizeWaitMs);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "finalize" }));
      } catch (e) {
        console.warn("live ws finalize send failed", e);
      }
    }
  }

  // Drain the PCM sink. For OPFS-backed sinks this is ~O(disk IO
  // for the final small chunk) — the bulk of the audio is already
  // on disk. For memory-backed sinks it's O(n) but still fast
  // because Int16 is half the Float32 footprint the old path used.
  let pcmCanonicalFile: File | null = null;
  let pcmCanonicalSampleCount = 0;
  if (pcmSink) {
    try {
      pcmCanonicalSampleCount = pcmSink.totalSamples;
      pcmCanonicalFile = await pcmSink.finalize(AUDIO_TOKENS.liveSampleRateHz);
    } catch (e) {
      console.warn("pcmSink.finalize failed; canonical audio will come from WebM fallback", e);
    }
  }
  mark("pcmSink.finalize");
  const canonicalCapture = await selectCanonicalCapturedAudio({
    pcmFile: pcmCanonicalFile,
    pcmSampleCount: pcmCanonicalSampleCount,
    pcmSampleRate: AUDIO_TOKENS.liveSampleRateHz,
    recordedChunks: recordedWebmChunks,
    expectedDurationSec: recordedSec,
  });
  mark("selectCanonicalCapturedAudio");
  if (canonicalCapture.file) {
    savedAudioFile = canonicalCapture.file;
    transcribeInputFile = canonicalCapture.file;
  }

  // Only OpenRouter needs a stop-time REST re-upload — it has no streaming
  // API. Deepgram's final envelope is authoritative and already contains
  // the complete transcript by the time it arrives. For Deepgram we only
  // fall back to REST if the live stream failed outright (see below).
  if (
    provider === "openrouter" &&
    enhance &&
    transcribeInputFile &&
    isProviderKeyConfigured(provider)
  ) {
    remoteApiPromise = remoteJobSync(transcribeInputFile, {
      provider,
      language: languageValue,
      diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
      openrouterModel: modelValue,
    });
  }

  // ── Cleanup (runs while provider is finalizing) ─────────────────────────
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (vuIntervalId) {
    clearInterval(vuIntervalId);
    vuIntervalId = null;
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
  // Web Audio node teardown. These ``disconnect()`` / ``close()`` calls
  // throw InvalidStateError when a node was already disconnected in a
  // previous error path. That is the only exception class expected here
  // so silent catches are the correct semantics; anything else would be
  // a programmer bug we want surfaced via an uncaught rejection instead.
  const tearDown = (step: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (e instanceof DOMException) return;
      console.warn(`live teardown step failed: ${step}`, e);
    }
  };
  tearDown("workletNode.disconnect", () => {
    if (workletNode) {
      workletNode.disconnect();
      workletNode.port.onmessage = null;
    }
  });
  tearDown("scriptNode.disconnect", () => {
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode.onaudioprocess = null;
    }
  });
  tearDown("scriptSinkGain.disconnect", () => {
    if (scriptSinkGain) scriptSinkGain.disconnect();
  });
  tearDown("analyser.disconnect", () => {
    if (analyser) analyser.disconnect();
  });
  tearDown("src.disconnect", () => {
    if (src) src.disconnect();
  });
  tearDown("stream.getTracks.stop", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });
  stream = null;
  tearDown("ac.close", () => {
    if (ac) {
      ac.close().catch((e) => {
        console.debug("AudioContext close rejected (harmless)", e);
      });
    }
  });
  ac = null;
  workletNode = null;
  scriptNode = null;
  scriptSinkGain = null;
  src = null;
  analyser = null;
  tearDown("ws.close", () => {
    if (ws) ws.close();
  });
  ws = null;
  wsPendingFrames = [];
  mediaRecorder = null;
  recordedWebmChunks = [];
  // Release the PCM sink reference so a subsequent startLive can
  // allocate a new sink concurrently, but DO NOT destroy (delete the
  // OPFS spool file) yet — the File blob from finalize() may still
  // reference it. Destruction is deferred to after saveRecordingText
  // serializes the blob into the FormData upload.
  const deferredSinkDestroy = pcmSink;
  pcmSink = null;
  activeLiveSessionId = "";
  activeLiveArchiveDir = "";
  activeLiveSessionSnapshot = null;
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

  if (savedAudioFile) {
    setCurrentRecordingAudio(savedAudioFile, "", sessionArchiveDir, sessionUiToken);
  }

  let persistedRecordingName = "";
  let persistedRecordingArchiveDir = "";
  const provisionalTitle = _smartTitle(sourceLiveText);
  if (savedAudioFile) {
    // Two-attempt save: first with the configured archive dir, then
    // with the DEFAULT dir. The most common cause of "initial save
    // failed" is a stale custom recordings_dir that became unwritable
    // (rename, permissions, external drive ejected). Retrying into the
    // default dir salvages the audio instead of silently losing it.
    let saveDone = false;
    // Build unique attempt list — if sessionArchiveDir is already ""
    // the fallback would be identical, so skip the duplicate.
    const saveDirs = sessionArchiveDir ? [sessionArchiveDir, ""] : [""];
    for (const tryArchiveDir of saveDirs) {
      if (saveDone) break;
      try {
        const persisted = await saveRecordingText({
          archiveDir: tryArchiveDir,
          title: provisionalTitle,
          sourceText: sourceLiveText,
          transcriptText: "",
          provider: providerValue || "local",
          model: modelValue,
          language: languageValue,
          audioFile: savedAudioFile,
          refreshList: false,
        });
        persistedRecordingName = persisted.name;
        persistedRecordingArchiveDir = persisted.archiveDir;
        setCurrentRecordingAudio(savedAudioFile, persistedRecordingName, persistedRecordingArchiveDir, sessionUiToken);
        await discardLiveRecovery(liveSessionId);
        const fallbackNote = tryArchiveDir !== sessionArchiveDir && sessionArchiveDir
          ? " (saved to default folder — configured archive was unavailable)"
          : "";
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: (enhance && transcribeInputFile ? "Audio saved locally. Starting final transcription." : "Audio saved locally.") + fallbackNote,
          tone: "success",
          savedName: persistedRecordingName,
        }, sessionUiToken);
        showRecordSessionNotice("Recording audio is saved and available immediately.", "success", 6000, sessionUiToken);
        saveDone = true;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e || "");
        console.warn(`Audio persistence attempt failed (archiveDir="${tryArchiveDir}", fileSize=${savedAudioFile?.size || 0}, fileName=${savedAudioFile?.name || "?"})`, e);
        if (tryArchiveDir === "" || saveDirs.length === 1) {
          // Both attempts failed — truly broken.
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: "Audio capture finished, but save failed. Check Recordings folder permissions.",
            tone: "error",
          }, sessionUiToken);
        }
      }
    }
  }
  // NOW safe to destroy the OPFS spool file — saveRecordingText above
  // has already serialized the File blob into the FormData upload.
  if (deferredSinkDestroy) {
    void deferredSinkDestroy.destroy();
  }

  if (startupAbortReason && !savedAudioFile && !transcribeInputFile && captureFrameCount === 0) {
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: startupAbortReason,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    clearLiveDraft();
    setBusy(false, sessionUiToken);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatusScoped(sessionUiToken, "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: startupAbortReason,
      tone: "error",
    }, sessionUiToken);
    return;
  }

  if (silentCapture) {
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: "[ Silence ]",
      kind: "status",
      sessionToken: sessionUiToken,
    });
    setStatusScoped(sessionUiToken, "Done");
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: _smartTitle(sourceLiveText),
        sourceText: sourceLiveText,
        transcriptText: "[ Silence ]",
        provider: providerValue,
        model: modelValue,
        language: languageValue,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Silence was detected, but the original archive changed before the session could be finalized. The entry was not recreated elsewhere.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    clearLiveDraft();
    setBusy(false, sessionUiToken);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: "Silence detected. Audio remains available for review.",
      tone: "success",
    }, sessionUiToken);
    return;
  }

  if (!enhance || !transcribeInputFile) {
    const skippedBySetting = !enhance;
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: skippedBySetting
        ? "Auto transcribe is off. Audio was saved locally and is ready to review."
        : "Audio was saved locally, but the canonical transcription input is unavailable for this session.",
      kind: skippedBySetting ? "status" : "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: _smartTitle(sourceLiveText),
        sourceText: sourceLiveText,
        transcriptText: "",
        provider: providerValue,
        model: modelValue,
        language: languageValue,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Audio is available, but the original archive changed before the session metadata could be finalized.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    clearLiveDraft();
    setBusy(false, sessionUiToken);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatusScoped(sessionUiToken, skippedBySetting ? "Idle" : "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: skippedBySetting
        ? "Audio saved. Final transcription was skipped for this session."
        : "Audio saved, but the canonical transcription input is unavailable for this session.",
      tone: skippedBySetting ? "success" : "warning",
    }, sessionUiToken);
    return;
  }

  if (!provider) {
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: "No transcription provider is selected. Audio was saved locally.",
      kind: "status",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: _smartTitle(sourceLiveText),
        sourceText: sourceLiveText,
        transcriptText: "",
        provider: "local",
        model: modelValue,
        language: languageValue,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "No provider is selected, and the original archive changed before the session metadata could be finalized.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    clearLiveDraft();
    setBusy(false, sessionUiToken);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatusScoped(sessionUiToken, "Idle");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: "Audio saved. No transcription provider is selected.",
      tone: "warning",
    }, sessionUiToken);
    return;
  }

  if (providerValue !== effectiveProvider) {
    setStatusScoped(sessionUiToken, "Processing (Offline Local)");
  } else {
    setStatusScoped(sessionUiToken, "Processing");
  }
  if (provider !== "local" && !isProviderKeyConfigured(provider)) {
    const msg = providerKeyErrorMessage(provider);
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: msg,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    setStatusScoped(sessionUiToken, "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: `${msg} Audio is still saved locally.`,
      tone: "error",
    }, sessionUiToken);
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: _smartTitle(sourceLiveText),
        sourceText: sourceLiveText,
        transcriptText: "",
        provider,
        model: modelValue,
        language: languageValue,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: `${msg} The original archive changed before the session metadata could be finalized.`,
          tone: "warning",
        }, sessionUiToken);
      }
    }
    clearLiveDraft();
    setBusy(false, sessionUiToken);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    return;
  }
  const transcribeStartedAt = performance.now();
  if (isCurrentUiSession(sessionUiToken)) {
    $("progressRow").hidden = false;
  }
  patchCurrentRecordingSummary({
    title: provisionalTitle,
    status:
      providerValue !== effectiveProvider
        ? "Internet is unavailable. Transcribing locally from the saved audio."
        : `Transcribing with ${providerLabel(provider)}.`,
    tone: "info",
  }, sessionUiToken);
  // Allow next hotkey/session to start while this recording is transcribing.
  setBusy(false, sessionUiToken);
  try {
    const runLocalFinalPass = async (): Promise<LocalTranscriptionResult> => {
      if (!transcribeInputFile) {
        throw new Error("Canonical audio file is unavailable for final local transcription.");
      }
      return transcribeCanonicalAudioLocally(transcribeInputFile, languageValue, liveSnapshot.finalLocalModel);
    };
    let transcriptRaw = "";
    let transcriptForPaste = "";
    let finalSaveConflict = false;

    if (provider === "local") {
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "35%";
        $("progressText").textContent = "35%";
      }
      const syncOut = await runLocalFinalPass();
      transcriptRaw = String(syncOut.text || "").trim();
    } else if (provider === "deepgram") {
      // Deepgram already streamed the transcript in real time. We
      // wait up to 4000 ms for the final envelope after CloseStream
      // because Nova-3 can take 1.8–2.5 s to emit the last is_final
      // message for a long utterance's trailing clause. If the
      // stream errored mid-way, we STILL use whatever committed
      // segments we have without waiting at all.
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "85%";
        $("progressText").textContent = "85%";
      }
      setStatusScoped(sessionUiToken, "Finalizing");

      // Fast path: the live stream already errored before stop. Skip
      // the finalize wait entirely and go straight to what we have.
      if (liveStreamErrorAtStop) {
        transcriptRaw =
          liveCommittedDisplayCache || joinTranscriptSegments(liveTranscriptSegments);
      } else {
        // ── Instant transcript from committed + interim ───────────
        //
        // The user reported 2–8 second delays on short recordings.
        // Waiting for the Deepgram envelope (up to 2000 ms ceiling)
        // is unnecessary when the streaming path has already delivered
        // committed (is_final) segments plus the current interim word
        // to the frontend. ``getCanonicalLiveSourceText()`` returns
        // committed + interim — that IS the full transcript. Using it
        // immediately gives an effective 0 ms transcription latency.
        //
        // The envelope is fired-and-forgotten in the background. If
        // it arrives later with a LONGER or better-quality text (e.g.
        // Deepgram's CloseStream finalize corrected a word), a future
        // enhancement could update the saved recording. For now, the
        // committed + interim path is the SSOT and matches exactly
        // what the Live Preview pane showed the user during recording.
        const instantTranscript = getCanonicalLiveSourceText();
        if (instantTranscript) {
          transcriptRaw = instantTranscript;

          // ── Auto REST re-transcribe on suspiciously short streaming result ──
          //
          // If the streaming transcript is much shorter than expected for
          // the recording duration, the Deepgram WebSocket likely dropped
          // packets due to a bad connection. The canonical audio file is
          // ALWAYS complete (captured locally via PCM sink), so we can
          // re-transcribe it via Deepgram's REST batch API to recover the
          // full text. This is the "50 sec recording but only 10 words"
          // scenario the user reported.
          //
          // Heuristic: expect ~2.5 words per second of speech. If the
          // streaming result has less than 30% of the expected word count,
          // trigger an automatic REST re-transcribe.
          const wordCount = transcriptRaw.split(/\s+/).filter(Boolean).length;
          const expectedWords = recordedSec * 2.5;
          const isSuspiciouslyShort = recordedSec > 5 && wordCount < expectedWords * 0.3;
          if (isSuspiciouslyShort && transcribeInputFile && isProviderKeyConfigured("deepgram")) {
            patchCurrentRecordingSummary({
              title: provisionalTitle,
              status: `Streaming captured only ${wordCount} words for ${Math.round(recordedSec)}s. Re-transcribing via REST...`,
              tone: "warning",
            }, sessionUiToken);
            try {
              const restResult = await remoteJobSync(transcribeInputFile, {
                provider: "deepgram",
                language: languageValue,
                diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
                openrouterModel: getRemoteModelValue("deepgram"),
              });
              const restText = String(restResult.text || "").trim();
              if (restText && restText.split(/\s+/).length > wordCount) {
                transcriptRaw = restText;
                patchCurrentRecordingSummary({
                  title: provisionalTitle,
                  status: "REST re-transcribe recovered full text.",
                  tone: "success",
                }, sessionUiToken);
              }
            } catch (restErr) {
              console.warn("Auto REST re-transcribe failed, keeping streaming result", restErr);
            }
          }
        } else {
          // No committed segments at all (very short recording, or
          // Deepgram hadn't returned any is_final yet). Fall back to
          // the envelope await.
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: "Sealing Deepgram stream…",
            tone: "info",
          }, sessionUiToken);
          const envelope = liveFinalPromise ? await liveFinalPromise : null;
          const envelopeError = envelope?.error || liveStreamError || "";
          if (envelope && envelope.text && !envelopeError) {
            transcriptRaw = envelope.text.trim();
          } else if (envelope && envelope.segments.length && !envelopeError) {
            transcriptRaw = joinTranscriptSegments(envelope.segments);
          } else if (envelopeError) {
          // Nothing committed, nothing final, only an error — try
          // Deepgram REST on the saved audio as a last resort.
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: `Live stream issue (${envelopeError}). Falling back to Deepgram REST.`,
            tone: "warning",
          }, sessionUiToken);
          if (transcribeInputFile && isProviderKeyConfigured("deepgram")) {
            try {
              const fallback = await remoteJobSync(transcribeInputFile, {
                provider: "deepgram",
                language: languageValue,
                diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
                openrouterModel: getRemoteModelValue("deepgram"),
              });
              transcriptRaw = String(fallback.text || "").trim();
            } catch (e) {
              console.warn("Deepgram REST fallback failed; using local full-audio pass", e);
              try {
                const fallbackOut = await runLocalFinalPass();
                transcriptRaw = String(fallbackOut.text || "").trim();
              } catch (localError) {
                console.error("Local fallback also failed", localError);
              }
            }
          }
        }
        } // close ``else`` (no instantTranscript — envelope fallback)
      }

      // Very last resort: whatever the live source text captured.
      if (!transcriptRaw) {
        const committed = getCanonicalLiveSourceText();
        if (committed) transcriptRaw = committed;
      }
    } else {
      // OpenRouter (or any future non-streaming remote): the REST promise
      // started during the cleanup phase is the authoritative path.
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "50%";
        $("progressText").textContent = "50%";
      }
      const previewDraft = liveDraftDisplayText.trim() || sourceLiveText;
      if (previewDraft) {
        setStatusScoped(sessionUiToken, "Transcribing");
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Live preview stays visible while the full-audio transcript is being finalized.",
          tone: "info",
        }, sessionUiToken);
      }
      if (remoteApiPromise) {
        try {
          const syncOut = await remoteApiPromise;
          transcriptRaw = String(syncOut.text || "").trim();
        } catch (e) {
          console.warn("Remote final transcription failed, falling back to local full-audio pass:", e);
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: "Remote full-audio pass failed. Falling back to local transcription from the saved audio.",
            tone: "warning",
          }, sessionUiToken);
          const fallbackOut = await runLocalFinalPass();
          transcriptRaw = String(fallbackOut.text || "").trim();
        }
      }
      if (!transcriptRaw && (previewDraft || sourceLiveText)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: "Remote final transcript was empty. Falling back to local transcription from the saved audio.",
          tone: "warning",
        }, sessionUiToken);
        const fallbackOut = await runLocalFinalPass();
        transcriptRaw = String(fallbackOut.text || "").trim();
      }
      if (!transcriptRaw && previewDraft) {
        transcriptRaw = previewDraft;
      }
    }

    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: transcriptRaw,
      kind: "status",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressFill").style.width = "100%";
      $("progressText").textContent = "100%";
      $("progressRow").hidden = true;
    }
    setStatusScoped(sessionUiToken, "Done");
    let pasteReadyText = "";
    if (transcriptRaw) {
      transcriptForPaste = await runUpscaleIfEnabled(transcriptRaw, sessionUiToken);
      pasteReadyText = transcriptForPaste || transcriptRaw;
      publishFinishedRecording(recordingId, pasteReadyText);
      publishRecordingFinalSignal({
        recordingId,
        signalText: pasteReadyText,
        domText: transcriptRaw,
        kind: "transcript",
        sessionToken: sessionUiToken,
      });
    }
    // saveRecordingText is non-blocking for recordings list reload.
    try {
      title = _smartTitle(transcriptRaw);
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title,
        sourceText: sourceLiveText,
        transcriptText: transcriptRaw,
        provider,
        model: modelValue,
        language: languageValue,
      });
    } catch (e) {
      if (isArchiveMutationConflict(e)) {
        finalSaveConflict = true;
        patchCurrentRecordingSummary({
          title,
          status: "Transcript finished, but the original archive changed before final save. The session was not recreated in a different archive.",
          tone: "warning",
        }, sessionUiToken);
      }
    }
    const latencyMs = performance.now() - transcribeStartedAt;
    patchCurrentRecordingSummary({
      title,
      status: finalSaveConflict
        ? "Transcript is ready in memory, but the original archive changed before the final save completed."
        : transcriptRaw
          ? "Final transcript is ready. Audio and transcript are both available."
          : "Transcription completed, but no spoken words were detected.",
      tone: finalSaveConflict ? "warning" : "success",
      transcribeLatencyMs: latencyMs,
      ...(persistedRecordingName && !finalSaveConflict ? { savedName: persistedRecordingName } : { savedName: "" }),
    }, sessionUiToken);
  } catch (e) {
    console.error("Live transcription finalization failed", e);
    const safeMessage = sanitizeUiErrorMessage(e, "Transcription failed. Audio is still saved.");
    publishRecordingFinalSignal({
      recordingId,
      signalText: "",
      domText: safeMessage,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    setStatusScoped(sessionUiToken, "Error");
    let fallbackSaveConflict = false;
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: _smartTitle(sourceLiveText),
        sourceText: sourceLiveText,
        transcriptText: "",
        provider,
        model: modelValue,
        language: languageValue,
      });
    } catch (saveError) {
      if (isArchiveMutationConflict(saveError)) {
        fallbackSaveConflict = true;
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: `${safeMessage} The original archive changed before fallback save completed.`,
          tone: "warning",
          transcribeLatencyMs: performance.now() - transcribeStartedAt,
        }, sessionUiToken);
      }
    }
    const latencyMs = performance.now() - transcribeStartedAt;
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: fallbackSaveConflict
        ? `${safeMessage} The original archive changed before fallback save completed.`
        : `${safeMessage} Audio is still available.`,
      tone: fallbackSaveConflict ? "warning" : "error",
      transcribeLatencyMs: latencyMs,
      ...(persistedRecordingName && !fallbackSaveConflict ? { savedName: persistedRecordingName } : { savedName: "" }),
    }, sessionUiToken);
  } finally {
    clearLiveDraft();
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    mark("stopLive:done");
    const totalMs = performance.now() - stopT0;
    const labels = stopTimings
      .map(([label, t], i) => {
        const prev = i > 0 ? stopTimings[i - 1][1] : 0;
        return `${label}: ${(t - prev).toFixed(0)}ms`;
      })
      .join(" → ");
    console.info(`[stopLive] total=${totalMs.toFixed(0)}ms | ${labels}`);
    (window as unknown as { __transcriptorStopTimings?: unknown }).__transcriptorStopTimings = {
      totalMs,
      phases: stopTimings,
    };
  }
  } finally {
    // Cleared at the very END of stopLive so a new startLive → stopLive
    // cannot race with in-flight save/transcribe/upscale work and corrupt
    // module-level state. The outer try/finally guarantees the flag is
    // cleared on EVERY exit path — including uncaught throws from the
    // pre-main-try awaits — so a single crash never permanently bricks
    // the stop state machine.
    stopTransitionInFlight = false;
  }
}

function reportFileSelectionError(message: string): void {
  selectedFile = null;
  $("fileName").textContent = "No file selected";
  publishRecordingOutput({
    recordingId: 0,
    pasteText: "",
    domText: message,
    kind: "error",
  });
  patchCurrentRecordingSummary({ status: message, tone: "error" });
}

function setSelectedFile(file: File | null): void {
  if (file && file.size > MAX_FILE_BYTES) {
    reportFileSelectionError(
      `File is too large. Max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`
    );
    return;
  }
  if (file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mimeOk = !file.type || ALLOWED_AUDIO_MIME.has(file.type);
    const extOk = !!ext && ALLOWED_AUDIO_EXT.has(ext);
    if (!mimeOk && !extOk) {
      reportFileSelectionError(
        "Unsupported audio format. Allowed: WAV, MP3, M4A, FLAC, OGG, AAC, MP4, WEBM."
      );
      return;
    }
  }
  selectedFile = file;
  $("fileName").textContent = file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "No file selected";
}

async function transcribeSelectedFile(): Promise<void> {
  if (isBusy) return;
  if (!selectedFile) {
    publishRecordingOutput({
      recordingId: 0,
      pasteText: "",
      domText: "Please choose an audio file first.",
      kind: "error",
    });
    patchCurrentRecordingSummary({ status: "Please choose an audio file first.", tone: "error" });
    return;
  }

  const sessionUiToken = createClientSessionId();
  activeUiSessionToken = sessionUiToken;
  resetOutputs();
  setBusy(true, sessionUiToken);
  const selectedProvider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const provider = resolveEffectiveProvider(selectedProvider);
  const modelValue = provider === "local" ? (($("model") as HTMLSelectElement).value || "small") : getRemoteModelValue(provider);
  setCurrentRecordingSummary({
    title: selectedFile.name || "Selected audio file",
    status: "Preparing file transcription.",
    tone: "info",
  }, sessionUiToken);
  if (selectedProvider !== provider) {
    setStatusScoped(sessionUiToken, "Processing (Offline Local)");
  } else {
    setStatusScoped(sessionUiToken, "Processing");
  }
  if (provider !== "local" && !isProviderKeyConfigured(provider)) {
    const msg = providerKeyErrorMessage(provider);
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    publishRecordingOutput({
      recordingId: 0,
      pasteText: "",
      domText: msg,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    patchCurrentRecordingSummary({
      status: msg,
      tone: "error",
    }, sessionUiToken);
    setBusy(false, sessionUiToken);
    return;
  }
  const transcribeStartedAt = performance.now();
  if (isCurrentUiSession(sessionUiToken)) {
    $("progressRow").hidden = false;
  }
  patchCurrentRecordingSummary({
    status:
      selectedProvider !== provider
        ? "Internet is unavailable. Transcribing the selected file locally."
        : `Transcribing file with ${providerLabel(provider)}.`,
    tone: "info",
  }, sessionUiToken);

  try {
    pollAbortController?.abort();
    pollAbortController = new AbortController();
    if (provider === "local") {
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "35%";
        $("progressText").textContent = "35%";
      }
      const syncOut = await localJobSync(selectedFile, {
        language: resolveFastLocalLanguage(($("language") as HTMLSelectElement).value),
        model: ($("model") as HTMLSelectElement).value,
        splitStereo: ($("splitStereoCheck") as HTMLInputElement).checked,
        wordTimestamps: ($("wordTsCheck") as HTMLInputElement).checked,
      });
      const transcriptRaw = String(syncOut.text || "").trim();
      publishRecordingFinalSignal({
        recordingId: 0,
        signalText: "",
        domText: transcriptRaw,
        kind: "status",
        sessionToken: sessionUiToken,
      });
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "100%";
        $("progressText").textContent = "100%";
        $("progressRow").hidden = true;
      }
      setStatusScoped(sessionUiToken, "Done");
      if (transcriptRaw) {
        const pasteReadyText = await runUpscaleIfEnabled(transcriptRaw, sessionUiToken);
        publishFinishedRecording(0, pasteReadyText || transcriptRaw);
        publishRecordingFinalSignal({
          recordingId: 0,
          signalText: pasteReadyText || transcriptRaw,
          domText: transcriptRaw,
          kind: "transcript",
          sessionToken: sessionUiToken,
        });
      }
      const latencyMs = performance.now() - transcribeStartedAt;
      patchCurrentRecordingSummary({
        status: transcriptRaw ? "File transcript is ready." : "Transcription completed, but no spoken words were detected.",
        tone: "success",
        transcribeLatencyMs: latencyMs,
      }, sessionUiToken);
      return;
    } else {
      const syncOut = await remoteJobSync(selectedFile, {
        provider,
        language: ($("language") as HTMLSelectElement).value,
        diarize: ($("diarizeCheck") as HTMLInputElement).checked,
        openrouterModel: getRemoteModelValue(provider),
      });
      const transcriptRaw = String(syncOut.text || "").trim();
      publishRecordingFinalSignal({
        recordingId: 0,
        signalText: "",
        domText: transcriptRaw,
        kind: "status",
        sessionToken: sessionUiToken,
      });
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "100%";
        $("progressText").textContent = "100%";
        $("progressRow").hidden = true;
      }
      setStatusScoped(sessionUiToken, "Done");
      if (transcriptRaw) {
        const pasteReadyText = await runUpscaleIfEnabled(transcriptRaw, sessionUiToken);
        publishFinishedRecording(0, pasteReadyText || transcriptRaw);
        publishRecordingFinalSignal({
          recordingId: 0,
          signalText: pasteReadyText || transcriptRaw,
          domText: transcriptRaw,
          kind: "transcript",
          sessionToken: sessionUiToken,
        });
      }
      const latencyMs = performance.now() - transcribeStartedAt;
      patchCurrentRecordingSummary({
        status: transcriptRaw ? "File transcript is ready." : "Transcription completed, but no spoken words were detected.",
        tone: "success",
        transcribeLatencyMs: latencyMs,
      }, sessionUiToken);
      return;
    }
  } catch (e) {
    console.error("File transcription failed", e);
    const safeMessage = sanitizeUiErrorMessage(e, "File transcription failed.");
    publishRecordingFinalSignal({
      recordingId: 0,
      signalText: "",
      domText: safeMessage,
      kind: "error",
      sessionToken: sessionUiToken,
    });
    if (isCurrentUiSession(sessionUiToken)) {
      $("progressRow").hidden = true;
    }
    setStatusScoped(sessionUiToken, "Error");
    patchCurrentRecordingSummary({
      status: safeMessage,
      tone: "error",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
  } finally {
    pollAbortController = null;
    setBusy(false, sessionUiToken);
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

/**
 * Keyword-cluster layout using a deterministic Fibonacci-spiral
 * (Vogel / sunflower) placement.
 *
 * Previously the layout used an Archimedean spiral with
 * ``spiralR += spacing / (2π)`` which meant each cluster sat only
 * ~13 px further out than the previous one, causing heavy cluster
 * overlap on the canvas. This version:
 *
 *   1. Computes a bounding radius per cluster (proportional to node
 *      count so dense clusters get more room).
 *   2. Places each cluster on a Fibonacci spiral at a distance
 *      proportional to ``sqrt(k)``, which is the correct spacing for
 *      equal-area placement and guarantees non-overlap when combined
 *      with a pad term.
 *   3. Within each cluster, positions nodes deterministically on a
 *      concentric ring (no ``Math.random()`` so the layout is stable
 *      across re-renders).
 */
function gClusterLayout(): void {
  const clusters: Map<string, number[]> = new Map();
  gNodes.forEach((n, i) => {
    const key = n.keywords.length > 0 ? n.keywords[0] : "__none__";
    let arr = clusters.get(key);
    if (!arr) { arr = []; clusters.set(key, arr); }
    arr.push(i);
  });

  const clusterList = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);

  // Average node radius feeds the per-cluster size computation so the
  // spacing scales with actual node visual footprint.
  const avgNodeR =
    gNodes.reduce((acc, n) => acc + n.r, 0) / Math.max(1, gNodes.length);

  const clusterRadii = clusterList.map(([, indices]) => {
    // A cluster of N nodes needs radius ~ sqrt(N) × node footprint
    // with a minimum of 24 px so single-node clusters still reserve
    // space.
    return Math.max(24, Math.sqrt(indices.length) * (avgNodeR * 2.6 + 6));
  });

  // Fibonacci / Vogel spiral: golden-angle placement of successive
  // clusters. ``c`` is the linear distance per step — we size it so
  // the maximum-radius cluster never overlaps a neighbour.
  const maxClusterR = clusterRadii.reduce((a, b) => Math.max(a, b), 0);
  const step = Math.max(80, maxClusterR * 2 + 24);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  clusterList.forEach(([, indices], ci) => {
    let cx: number;
    let cy: number;
    if (ci === 0) {
      cx = 0;
      cy = 0;
    } else {
      const angle = ci * goldenAngle;
      const radius = step * Math.sqrt(ci) * 0.55;
      cx = Math.cos(angle) * radius;
      cy = Math.sin(angle) * radius;
    }

    const n = indices.length;
    const clusterR = clusterRadii[ci];
    if (n === 1) {
      gNodes[indices[0]].x = cx;
      gNodes[indices[0]].y = cy;
      return;
    }
    // Place nodes on a single ring. The ring radius is slightly
    // smaller than the cluster radius so the nodes don't touch the
    // bounding circle and neighbouring clusters stay visually
    // separated.
    const ringR = clusterR * 0.62;
    indices.forEach((nodeIdx, j) => {
      const a2 = (2 * Math.PI * j) / n - Math.PI / 2;
      gNodes[nodeIdx].x = cx + Math.cos(a2) * ringR;
      gNodes[nodeIdx].y = cy + Math.sin(a2) * ringR;
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

/**
 * Post-layout relaxation pass — nudges overlapping nodes apart.
 *
 * Even with the deterministic Fibonacci cluster layout, nodes from
 * adjacent clusters (or from same-keyword clusters with many members)
 * can end up within each other's radius. Rather than grow the
 * cluster spacing (which leaves big gaps), we run ~12 iterations of
 * simple pairwise repulsion using a spatial hash to keep the pass
 * O(N) on average instead of O(N²). Two circles overlap iff the
 * distance between their centres is less than the sum of their
 * radii — we split the overlap 50/50 and push them apart along the
 * separating axis.
 */
function gRelaxCollisions(iterations = 12, padding = 4): void {
  if (gNodes.length < 2) return;
  const cellSize = 64;
  for (let iter = 0; iter < iterations; iter++) {
    const grid: Map<string, number[]> = new Map();
    for (let i = 0; i < gNodes.length; i++) {
      const n = gNodes[i];
      const gx = Math.floor(n.x / cellSize);
      const gy = Math.floor(n.y / cellSize);
      const key = `${gx},${gy}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }
    let anyMove = false;
    for (let i = 0; i < gNodes.length; i++) {
      const a = gNodes[i];
      const gx = Math.floor(a.x / cellSize);
      const gy = Math.floor(a.y / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = gNodes[j];
            const ddx = b.x - a.x;
            const ddy = b.y - a.y;
            const minDist = a.r + b.r + padding;
            const distSq = ddx * ddx + ddy * ddy;
            if (distSq >= minDist * minDist) continue;
            const dist = Math.sqrt(distSq) || 0.0001;
            const overlap = (minDist - dist) / 2;
            const ux = ddx / dist;
            const uy = ddy / dist;
            a.x -= ux * overlap;
            a.y -= uy * overlap;
            b.x += ux * overlap;
            b.y += uy * overlap;
            anyMove = true;
          }
        }
      }
    }
    if (!anyMove) break;
  }
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
    $("graphContainer").setAttribute("aria-busy", "true");
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
      // Larger baseline radius so clusters feel substantial. The
      // log scale lets a "3-keyword" node and a "12-keyword" node
      // differ visibly without the big one blotting out neighbours.
      r: Math.max(5, Math.min(14, 5 + Math.log2(Math.max((it.keywords || []).length, 1) + 1) * 3)),
    }));
    $("graphInfoText").textContent = `${gNodes.length} recording${gNodes.length === 1 ? "" : "s"}`;
    if (gNodes.length === 0) { gRender(); return; }

    gClusterLayout();
    gRelaxCollisions();
    gComputeEdges();
    gCenterView();
    gRender();
  } catch (e) {
    $("graphInfoText").textContent = "Error: " + (e as Error).message;
    gNodes = [];
  } finally {
    $("graphContainer").setAttribute("aria-busy", "false");
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
  //
  // The legend is drawn in the OUTER (un-panned, un-zoomed) coordinate
  // space so it stays pinned to the top-right corner. Previously the
  // coloured dots and text rendered directly on top of whatever nodes
  // happened to land in that corner of the viewport — the user's
  // "в графе все друг на друга наезжает" report. We paint a rounded
  // backdrop rectangle first so the legend becomes a visually-isolated
  // island instead of an invisible overlay.
  const providers = [...new Set(gNodes.map((n) => n.provider))];
  if (providers.length > 0) {
    const legendLineH = 16;
    const legendPadX = 10;
    const legendPadY = 8;
    const legendW = 90;
    const legendH = providers.length * legendLineH + legendPadY * 2 - 4;
    const legendX = W - legendW - 10;
    const legendY = 10;
    // Rounded-rect backdrop. ``roundRect`` is a Canvas 2D method that
    // shipped in Chromium 99+ — Electron (which we target) always
    // has a newer rendering core, so this path is safe. A manual
    // arc fallback exists below for paranoia.
    c.beginPath();
    if (typeof (c as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect === "function") {
      (c as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(legendX, legendY, legendW, legendH, 8);
    } else {
      const r = 8;
      c.moveTo(legendX + r, legendY);
      c.arcTo(legendX + legendW, legendY, legendX + legendW, legendY + legendH, r);
      c.arcTo(legendX + legendW, legendY + legendH, legendX, legendY + legendH, r);
      c.arcTo(legendX, legendY + legendH, legendX, legendY, r);
      c.arcTo(legendX, legendY, legendX + legendW, legendY, r);
    }
    c.fillStyle = "rgba(18, 18, 18, 0.82)";
    c.fill();
    c.strokeStyle = "rgba(255, 255, 255, 0.08)";
    c.lineWidth = 1;
    c.stroke();

    // Legend items
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.font = "9px 'SF Pro Text', -apple-system, sans-serif";
    let ly = legendY + legendPadY + 4;
    for (const p of providers) {
      const col = gColor(p);
      const dotX = legendX + legendPadX;
      c.beginPath();
      c.arc(dotX, ly, 4, 0, Math.PI * 2);
      c.fillStyle = col;
      c.fill();
      c.fillStyle = "#c0c0c0";
      c.fillText(GRAPH_PROVIDER_LABELS[p] || p, dotX + 10, ly);
      ly += legendLineH;
    }
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
  // Measure the tooltip's real size after it is visible. The old
  // code assumed fixed 280×80 dimensions, which broke whenever CSS
  // changed the tooltip padding, font, or line wrapping — the
  // tooltip either clipped off-canvas or left a gap near the edge.
  // Measuring gives us an exact clamp envelope regardless of styling.
  tt.hidden = false;
  const rect = $("graphContainer").getBoundingClientRect();
  const ttRect = tt.getBoundingClientRect();
  const ttW = Math.max(1, Math.round(ttRect.width));
  const ttH = Math.max(1, Math.round(ttRect.height));
  const margin = 6;

  // Prefer right-of-cursor; fall back to left-of-cursor if the
  // right side would overflow. Final clamp guarantees the tooltip
  // stays inside [margin, containerSize - ttSize - margin].
  let left = mx + 16;
  if (left + ttW + margin > rect.width) {
    left = mx - ttW - 16;
  }
  if (left + ttW + margin > rect.width) {
    left = rect.width - ttW - margin;
  }
  if (left < margin) left = margin;

  let top = my - 10;
  if (top + ttH + margin > rect.height) {
    top = rect.height - ttH - margin;
  }
  if (top < margin) top = margin;

  tt.style.left = left + "px";
  tt.style.top = top + "px";
}

function gHideTooltip(): void {
  $("graphTooltip").hidden = true;
  gHovered = null;
}

function gNavToRecording(node: GraphNode): void {
  recordingsSearchQuery = "";
  ($("recordingsSearchInput") as HTMLInputElement).value = "";
  selectedRecordingName = node.name;
  switchView("recordings");
}

async function initRecordingsBootstrap(): Promise<void> {
  recordingsBootstrapReady = false;
  try {
    await loadRecordings(false);
  } catch (e) {
    console.warn("Initial recordings load failed", e);
  }
  try {
    await recoverBackendAudioSessions();
  } catch (e) {
    console.warn("Recovery import failed", e);
  }
  try {
    await recoverLiveDraftIfAny();
  } catch (e) {
    console.warn("Draft recovery failed", e);
  }
  recordingsBootstrapReady = !!currentArchiveDirSnapshot();
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
    // Early exit when graph tab is hidden — avoids gHitTest loop +
    // getBoundingClientRect on every mouse move in the entire app.
    if (!!ct.closest("[hidden]") && !gDragging) return;
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
  $("graphRefreshBtn").addEventListener("click", () => void loadGraphData());
  $("graphOpenRecordingsBtn").addEventListener("click", () => switchView("recordings"));

  new ResizeObserver(() => {
    if (!ct.closest("[hidden]")) gRender();
  }).observe(ct);
})();

void loadCfg()
  .then(async () => {
    await loadMics(false);
    scheduleLocalWarmup();
  })
  .catch(() => { });
initQuickControls();
syncRemoteModelOptions();
populateUpscaleModelOptions();
// Seed the preset dropdown synchronously with the 4 built-in presets
// so the upscale pane is never empty between module init and the
// async ``loadUpscalePresets`` call inside ``loadCfg``.
populateBuiltinUpscalePresetOptions();
(document.getElementById("upscaleModelSelect") as HTMLSelectElement | null)?.addEventListener(
  "change",
  () => {
    queueUiPreferencesSave();
  }
);
// Sweep any orphan ``.pcm16`` spool files left from a crashed
// previous session. Fire-and-forget; failures are logged inside
// the helper and never block app startup.
void cleanupOrphanPcmSpool();
void refreshNetworkState();
window.setInterval(() => void refreshNetworkState(), UI_TOKENS.network.refreshIntervalMs);
window.addEventListener("online", () => void refreshNetworkState());
window.addEventListener("offline", () => void refreshNetworkState());
recordingsBootstrapPromise = initRecordingsBootstrap().finally(() => {
  recordingsBootstrapPromise = null;
});
draw();
syncMode();
setStatus("Idle");
setRecordButton(false);
setCurrentRecordingSummary(null);
resetRecordingViewer();
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
