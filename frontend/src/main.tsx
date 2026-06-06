import "./styles.css";

type Provider = "local" | "openrouter" | "deepgram" | "";
type RemoteProvider = "openrouter" | "deepgram";
type KeyProvider = "openrouter" | "deepgram";
type ViewName = "upload" | "record" | "recordings" | "settings" | "graph";
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
      // Upload tab persistent state — provider/language/diarize were
      // previously DOM-only and reset to defaults on every app launch.
      // Mirrored into the same ``preferences.ui`` namespace as the
      // Live tab keys (``provider``, ``language``) — separate keys so
      // the two tabs don't fight over the same value.
      upload_provider?: string;
      upload_language?: string;
      upload_diarize?: boolean;
    };
  };
}

interface RecordingItem {
  name: string;
  display_name: string;
  source_file?: string;
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

interface RemoteTranscriptionResult {
  text: string;
  provider: string;
  model?: string;
}

interface BackendJobState<T> {
  job_id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  error?: string | null;
  result?: T | null;
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

// Compile-time injected by vite.config.ts from frontend/package.json's
// ``version`` field. SSOT for the version label rendered in the
// Settings tab — previously hardcoded ``1.1.1`` in index.html and
// drifted across every release.
declare const __APP_VERSION__: string;

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
    /**
     * Open the OS file manager (Finder / Explorer / Files) at the
     * transcript file matching the given recording. Implemented by setting
     * ``document.title`` to a known prefix; the Electron main process
     * intercepts via ``page-title-updated`` and calls
     * ``shell.showItemInFolder``. No-op in plain-browser dev preview.
     */
    __transcriptorRevealRecording?: (name: string, archiveDir: string) => void;
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
// SSOT: backend defines MAX_UPLOAD_BYTES in backend/main.py and surfaces
// it in /api/health under "max_upload_bytes". The constant below is the
// fallback that applies BEFORE the first /api/health response lands (cold
// boot, /api/health timeout in dev, mock backend without the field). It
// is never the source of truth — refreshNetworkState() rewrites this
// value from every successful health probe so the cap can never drift
// from what the backend will actually accept on POST.
let MAX_FILE_BYTES = 500 * 1024 * 1024;
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
// SSOT for the file extensions BOTH the Live-tab file-picker
// validator and the Upload-tab drag-drop validator accept. Mirrors
// backend/main.py:ALLOWED_AUDIO_EXTS: every extension the backend's
// ffmpeg path can demux (audio + video + Opus/Ogg-Audio variants).
//
// Previously the file held TWO divergent sets: ``ALLOWED_AUDIO_EXT``
// (8 audio-only entries) used for setSelectedFile, and
// ``UPLOAD_ALLOWED_EXTS`` (17 audio+video entries) used for
// enqueueUploadFile. The Upload set itself was missing ``oga`` that
// the backend WOULD accept — silent rejection at the client for a
// file the server would have transcribed. Consolidated here so a
// future ext addition (.flv, .ts, .wmv, ...) is a one-line change.
const ACCEPTED_AUDIO_VIDEO_EXTS = new Set([
  // Audio containers — natively understood by Deepgram REST and the
  // OpenRouter audio-input pipeline. Mirrors backend/main.py:296.
  "wav", "mp3", "m4a", "flac", "ogg", "oga", "opus", "aac", "webm", "wma",
  // Video containers — backend extracts audio via ffmpeg before
  // forwarding to remote providers. Mirrors backend/main.py:307.
  "mp4", "m4v", "mov", "mkv", "avi", "mpg", "mpeg", "3gp",
]);
const LIVE_DRAFT_KEY = "transcriptor.liveDraft.v1";
const UPLOAD_QUEUE_STORAGE_KEY = "transcriptor.uploadQueue.v1";
const UPLOAD_QUEUE_MAX_PERSISTED_ITEMS = 200;
const UPLOAD_QUEUE_MAX_PARALLEL = 2;
const OPENROUTER_AUDIO_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-lite",
  "openai/gpt-4o-audio-preview",
];
// 1.1.25 SSOT: every cold-start fallback to the OpenRouter default
// model previously inlined ``DEFAULT_OPENROUTER_AUDIO_MODEL`` at 7+
// sites (cfg load, autosave, getter, re-render, etc.). Adding a
// new default required hunting all sites; missing one produced
// drift between the cold-boot model and what the user actually
// saw selected. Single named constant eliminates the hazard.
const DEFAULT_OPENROUTER_AUDIO_MODEL = OPENROUTER_AUDIO_MODELS[0];
const DEEPGRAM_AUDIO_MODELS = ["nova-3"];
const DEFAULT_DEEPGRAM_AUDIO_MODEL = DEEPGRAM_AUDIO_MODELS[0];

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
  openrouter: DEFAULT_OPENROUTER_AUDIO_MODEL,
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

// MIME → canonical extension mapping. Used when the backend's
// ``Content-Disposition`` header is absent or unparseable and we have
// to synthesize a filename from the saved-name stem. The backend's
// ``ALLOWED_AUDIO_MIME`` set is the SSOT for which MIME types we may
// receive; this map is its inverse for the (rare) header-missing path.
const MIME_TO_AUDIO_EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/opus": "opus",
};

// RFC 6266 Content-Disposition filename parser.
// Handles:
//   - filename="audio.webm"
//   - filename=audio.webm
//   - filename*=UTF-8''audio.webm  (RFC 5987 percent-encoded)
// Returns "" when the header is absent, malformed, or contains a path
// separator (defensive against backend bugs that could let a server
// dictate where the upload will be persisted client-side).
function parseContentDispositionFilename(header: string): string {
  if (!header) return "";
  // RFC 5987 / 6266 ext-value (UTF-8'') takes precedence over the plain form.
  const extMatch = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extMatch) {
    try {
      const decoded = decodeURIComponent(extMatch[2].trim());
      if (decoded && !/[\\/]/.test(decoded)) return decoded;
    } catch {
      // Fall through to plain parser.
    }
  }
  const plainMatch = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
  if (plainMatch) {
    const raw = (plainMatch[2] ?? plainMatch[3] ?? "").trim();
    if (raw && !/[\\/]/.test(raw)) return raw;
  }
  return "";
}

// Fetch the saved audio file from the backend with HONEST extension
// and MIME — both derived from the backend's response headers, which
// are the single source of truth for the on-disk file's actual
// container.
//
// ROOT CAUSE this replaces (Re-transcribe failure on packaged builds):
//   The previous Re-transcribe path did:
//     audioFile = new File([blob], savedName.replace(/\.txt$/, ".wav"),
//                            { type: "audio/wav" });
//   But the on-disk audio is usually ``.webm`` (live recordings) —
//   ``selectCanonicalCapturedAudio`` writes ``live-<ts>.webm`` for
//   the streaming path. Forcing ``.wav`` + ``audio/wav`` on a WebM
//   payload breaks BOTH provider paths:
//     - Deepgram REST: routes via Content-Type → mismatch → HTTP 400
//       "invalid audio data".
//     - Local Whisper: backend's ``ensure_wav_16k`` fast-path tries
//       ``soundfile.info`` on the ``.wav``-named bytes; fails; falls
//       through to ffmpeg, which sniffs WebM correctly when ffmpeg
//       is bundled but raises a generic exception (NOT AudioError)
//       when ffmpeg degrades silently — uncaught by the AudioError
//       handler at main.py:2823 → HTTP 500.
//   Both fail simultaneously on a valid 1.3 MB recording — exactly
//   the user-reported symptom.
//
// ROOT CAUSE this also replaces (OPFS-dangling blob on Re-transcribe):
//   The same handler also had a "prefer in-memory ``audioState.file``
//   over backend GET" branch that broke after pcmSink.destroy() ran:
//   the lazy ``Blob([header, opfsSpool])`` composite reads as zero
//   bytes once OPFS reaps the spool. Same class as the e2a39c8
//   playback bug; the playback path was already migrated to backend-
//   served URL but Re-transcribe was missed.
//
// Strategy: ALWAYS go through the backend HTTP endpoint. The disk
// file is the canonical source. Round-trip cost is loopback (<10ms
// for typical 1-2 MB recordings) — negligible compared to the
// transcription job that follows.
async function fetchSavedAudioFromBackend(
  savedName: string,
  archiveDir: string,
): Promise<File> {
  const tFetch = performance.now();
  const audioUrl = latestRecordingAudioUrl(savedName, archiveDir);
  if (!audioUrl) throw new Error("Saved recording name is missing.");
  const audioResp = await fetch(audioUrl, { headers: authHeaders() });
  if (!audioResp.ok) {
    console.log(`[trace fetchAudio] FAIL savedName="${savedName}" archiveDir="${archiveDir}" status=${audioResp.status} statusText="${audioResp.statusText}" durMs=${(performance.now() - tFetch).toFixed(0)}`);
    throw new Error(`Audio fetch failed: HTTP ${audioResp.status} ${audioResp.statusText}`.trim());
  }
  const audioBlob = await audioResp.blob();
  if (audioBlob.size === 0) {
    console.log(`[trace fetchAudio] FAIL empty body savedName="${savedName}" archiveDir="${archiveDir}" durMs=${(performance.now() - tFetch).toFixed(0)}`);
    // Defensive: a 200 OK with an empty body would otherwise look
    // healthy at the upload boundary and only fail downstream inside
    // ffmpeg/libsndfile with a vague "invalid data" error. Surface
    // the truncation here so the user-facing message is precise.
    throw new Error("Audio fetch returned an empty file.");
  }
  // Backend's Content-Type header IS the SSOT — never override it
  // with a local guess. A missing/blank header is the only case we
  // synthesize a fallback for.
  const headerType = (audioResp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const mimeType = headerType || audioBlob.type || "application/octet-stream";
  // Filename: prefer backend's Content-Disposition (the on-disk file
  // name verbatim), then fall back to the savedName stem with the
  // canonical extension for the MIME type, then the savedName stem
  // with .bin (very last resort — should never trigger in practice).
  const dispositionFilename = parseContentDispositionFilename(
    audioResp.headers.get("content-disposition") || "",
  );
  const filename = dispositionFilename
    || (savedName.endsWith(".txt")
      ? savedName.replace(/\.txt$/, "." + (MIME_TO_AUDIO_EXT[mimeType] || "bin"))
      : savedName);
  console.log(`[trace fetchAudio] OK savedName="${savedName}" filename="${filename}" mime="${mimeType}" sizeBytes=${audioBlob.size} durMs=${(performance.now() - tFetch).toFixed(0)}`);
  return new File([audioBlob], filename, { type: mimeType });
}

function renderLatestSavedAudio(): void {
  const row = $("currentRecordingAudioRow");
  const audioEl = $("currentRecordingAudio") as HTMLAudioElement;
  const metaEl = $("currentRecordingAudioMeta");

  // Compute the new playback URL FIRST. If the desired URL equals the
  // currently-playing one, do nothing — previously we unconditionally
  // `pause() + removeAttribute("src") + load()` on every refresh,
  // which reset playback to position 0 even when called from a
  // routine `loadRecordings(true)` triggered by an unrelated save.
  // Real-world symptom: user starts playing back audio via the
  // native <audio controls>, a concurrent save refresh fires this
  // function, and playback jumps to the start mid-listen.
  const desiredBackendUrl = latestSavedAudioState
    ? latestRecordingAudioUrl(
        latestSavedAudioState.savedName || "",
        latestSavedAudioState.archiveDir || ""
      )
    : "";
  // If the audio source isn't changing AND we already have a src
  // attribute, skip the disruptive reset. We only need to ensure
  // the row is shown and meta is up to date.
  //
  // Updated for the backend-URL-prefer fix: with savedName set we
  // play from the backend URL even when ``file`` is also present.
  // The skip-rerender guard now applies whenever the CURRENTLY-
  // ATTACHED src matches the desired backend URL — regardless of
  // whether ``file`` exists. Without this update, the second
  // setCurrentRecordingAudio call (post-save, with savedName) was
  // forced through a full re-render, revoking + re-creating an
  // unused ObjectURL on every save tick.
  if (
    latestSavedAudioState
    && latestSavedAudioState.savedName
    && desiredBackendUrl
    && audioEl.getAttribute("src") === desiredBackendUrl
  ) {
    row.hidden = false;
    metaEl.textContent = latestSavedAudioState.sizeBytes
      ? fmtBytes(latestSavedAudioState.sizeBytes)
      : latestSavedAudioState.title;
    const retranscribeBtn = document.getElementById("retranscribeBtn");
    if (retranscribeBtn) {
      retranscribeBtn.hidden = !latestSavedAudioState.savedName;
    }
    return;
  }

  audioEl.pause();
  revokeCurrentRecordingAudioUrl();

  if (!latestSavedAudioState) {
    row.hidden = true;
    audioEl.removeAttribute("src");
    audioEl.load();
    metaEl.textContent = "";
    return;
  }

  // Source preference order:
  //   1. Backend URL when savedName is known — DURABLE: the backend
  //      wrote the file to disk via atomic_write_bytes, the audio
  //      element can re-fetch any time, survives OPFS sink destroy,
  //      survives renderer reloads.
  //   2. In-memory blob URL when the file is fresh from MediaRecorder /
  //      PcmSink and not yet uploaded to backend (the recording-just-
  //      stopped window before save completes — typically <500 ms).
  //
  // ROOT CAUSE for "audio doesn't play on Windows" (user report):
  //   OpfsPcmSink.finalize() returns a ``File`` whose Blob references
  //   the OPFS-backed spool lazily — ``new Blob([header, spool])``.
  //   When deferredSinkDestroy.destroy() removes the OPFS file (right
  //   after the upload completes), the lazy blob composite is
  //   effectively a dangling pointer. Chromium on macOS happens to
  //   cache blob bytes more aggressively in this scenario, so the
  //   <audio> element kept playing. Chromium on Windows reads blob
  //   bytes lazily on play, hits the deleted OPFS handle, and the
  //   media element fires a silent error code=4 (src-not-supported).
  //
  //   Switching to the backend URL once savedName is set bypasses
  //   the OPFS lifecycle entirely — same URL, same bytes, durable.
  //   The blob URL stays as the first-render fallback for the brief
  //   pre-save window.
  const playbackUrl = (latestSavedAudioState.savedName && desiredBackendUrl)
    ? desiredBackendUrl
    : latestSavedAudioState.file
      ? URL.createObjectURL(latestSavedAudioState.file)
      : "";
  if (!playbackUrl) {
    row.hidden = true;
    audioEl.removeAttribute("src");
    audioEl.load();
    metaEl.textContent = "";
    return;
  }
  // Track ObjectURL ownership so revokeCurrentRecordingAudioUrl can
  // free it later. Backend URLs are not ObjectURLs — nothing to revoke.
  const isObjectUrl = playbackUrl.startsWith("blob:");
  currentRecordingAudioObjectUrl = isObjectUrl ? playbackUrl : "";
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

function setCurrentRecordingAudio(file: File | null, savedName = "", archiveDir = "", sessionToken = ""): void {
  if (sessionToken && !isCurrentUiSession(sessionToken)) return;
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

// Wire the explicit Download button (added in index.html because the
// native <audio controls> three-dot "Download" entry doesn't reliably
// appear in Electron on Windows for blob: URLs).
//
// We re-derive the URL on click rather than caching it so the button
// always points at the freshest source — when the user re-transcribes
// the same audio, the in-memory File is replaced and the cached URL
// would otherwise download the previous take.
(() => {
  const btn = document.getElementById("currentRecordingDownloadBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!latestSavedAudioState) return;
    const file = latestSavedAudioState.file;
    const fileName = latestSavedAudioState.downloadName
      || latestSavedAudioState.savedName
      || "recording.wav";
    // Mirror the playback source-preference order from
    // renderLatestSavedAudio: prefer the backend URL once savedName
    // is set (durable, OPFS-independent), fall back to the in-memory
    // File blob only during the brief pre-save window.
    let url = "";
    let revokeAfter = false;
    if (latestSavedAudioState.savedName) {
      url = latestRecordingAudioUrl(
        latestSavedAudioState.savedName,
        latestSavedAudioState.archiveDir || "",
      );
    } else if (file) {
      url = URL.createObjectURL(file);
      revokeAfter = true;
    }
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revokeAfter) {
      // Defer revoke so the browser's download stream finishes reading
      // the blob first. 30 s is generous for a multi-MB recording.
      window.setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* idempotent */ }
      }, 30_000);
    }
  });
})();

// Audio element error handler — Windows users reported playback fails
// on the just-recorded clip. Without this hook the failure was silent;
// now any media-element error is logged so we can diagnose codec /
// MIME / blob-revocation issues from the support bundle.
(() => {
  const audioEl = document.getElementById("currentRecordingAudio") as HTMLAudioElement | null;
  if (!audioEl) return;
  audioEl.addEventListener("error", () => {
    const err = audioEl.error;
    const code = err ? err.code : -1;
    const msg = err ? (err.message || "") : "";
    const src = audioEl.currentSrc || audioEl.src || "";
    const fileType = latestSavedAudioState?.file?.type || "";
    console.warn(`[currentRecordingAudio] media error code=${code} msg=${msg} mime=${fileType} src=${src.slice(0, 120)}`);
  });
})();

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
  // Promote raw network failures (TypeError "Failed to fetch",
  // NetworkError, ECONNREFUSED) into the human-readable offline /
  // VPN-needed message BEFORE the sanitize pass would filter them
  // as generic "TypeError".
  const lowRaw = raw.toLowerCase();
  // "Load failed" is Safari/WebKit's generic message for an aborted
  // or CORS-blocked fetch — but it ALSO appears inside legitimate
  // backend errors like "failed to load model 'large-v3': file not
  // found". Substring-matching the phrase wrongly redirected a model-
  // missing error into the "offline, try VPN" explainer. Gate it on
  // a full-string match instead so only the real generic WebKit
  // network failure gets promoted.
  const isGenericNetworkFail =
    lowRaw === "failed to fetch" ||
    lowRaw === "load failed" ||
    lowRaw === "networkerror when attempting to fetch resource.";
  if (
    isGenericNetworkFail ||
    lowRaw.includes("typeerror: failed to fetch") ||
    lowRaw.includes("err_internet_disconnected") ||
    lowRaw.includes("err_name_not_resolved") ||
    lowRaw.includes("err_connection_refused") ||
    lowRaw.includes("err_connection_reset") ||
    // Any Deepgram-shaped backend error — file-transcription path
    // (via sanitizeUiErrorMessage) must get the same VPN/region
    // guidance as the live-stream path. Without this, Deepgram
    // REST errors leak raw into the file-transcribe UI.
    lowRaw.startsWith("deepgram ")
  ) {
    return explainNetworkError(error);
  }
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
  // Length cap raised from 160 → 800 chars. The 160 cap was a defensive
  // filter against raw stack traces leaking into the UI, but it ALSO
  // truncated legitimate actionable error messages from
  // ``request_with_retry`` that include both the underlying network
  // error AND a one-liner hint ("upload timed out — file too large
  // for current upload speed; try smaller file or switch to local").
  // Such hints run ~200-280 chars and were silently dropped to the
  // fallback "Transcription failed." — the screenshot the user showed
  // had exactly this symptom: bare fallback with no detail. 800 chars
  // is plenty for any actionable backend message; raw stack traces
  // are filtered by the regex tests above (which trigger the fallback
  // before we ever reach the length comparison).
  return cleaned.length > 800 ? fallback : cleaned;
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
  // Speaker-aware equality. Both undefined ↔ both undefined (mono
  // stream); a numbered speaker on one side and undefined on the
  // other counts as DIFFERENT (don't conflate diarized into mono).
  // Two distinct speaker indices are ALWAYS different — even when
  // the text and timing happen to match, they're genuinely two
  // utterances and must both be kept. Without this gate, a
  // call-recording with cross-talk where speaker 0 and speaker 1
  // utter "yeah" within the same epsilon window had ONE of them
  // silently dropped from the transcript and the auto-paste was
  // missing a turn. Subtle data-loss bug visible only with
  // diarize=on.
  const sameSpeaker = (a: TranscriptSegment, b: TranscriptSegment): boolean =>
    a.speaker === b.speaker;
  // Sort by start asc, then end DESC, then speaker asc. The
  // longer / later-ending segment for the same (start, speaker)
  // lands FIRST in the merged list, so the shorter overlapping
  // interim that follows is dropped by the is-prefix-of-prev test
  // below. Without the descending end-tie-break the shorter
  // interim arrived first and the longer final was kept,
  // leaving both in the transcript and producing visible
  // duplication — exactly the user-reported "Просто расскажу," +
  // "Просто расскажу кратко. И ты тоже" pattern within a single
  // recording. The speaker tertiary keeps diarized output
  // deterministic when two speakers share a start tick.
  const ordered = [...segments].sort(
    (a, b) =>
      (a.start - b.start) ||
      (b.end - a.end) ||
      ((a.speaker ?? -1) - (b.speaker ?? -1)),
  );
  const merged: TranscriptSegment[] = [];
  for (const segment of ordered) {
    const prev = merged[merged.length - 1];
    // 1. Exact duplicate (same speaker, same timing, same text): drop.
    if (
      prev &&
      sameSpeaker(prev, segment) &&
      Math.abs(prev.start - segment.start) <= epsilon &&
      Math.abs(prev.end - segment.end) <= epsilon &&
      prev.text === segment.text
    ) {
      continue;
    }
    // 2. Prefix-overlap dedup: when a later interim emission shares
    //    the same start AND speaker as a kept segment AND its text
    //    is a strict prefix of the kept segment's text (within
    //    whitespace normalisation), drop the shorter interim.
    //    Deepgram streaming emits this pattern: an interim
    //    "Сергей привет" is followed by the final "Сергей привет,
    //    как дела" — both arrive with identical start times. The
    //    previous merge only dropped EXACT duplicates so both ended
    //    up in the transcript, the user saw their utterance twice
    //    in the paste, and the auto-paste delivered both halves
    //    back-to-back. Comparing on whitespace-normalised lowercase
    //    guards against trailing-comma / spacing differences
    //    between the two emissions ("hello world," vs "hello world
    //    , "). Speaker-aware: cross-talk between two speakers at
    //    the same start is preserved.
    if (
      prev &&
      sameSpeaker(prev, segment) &&
      Math.abs(prev.start - segment.start) <= epsilon
    ) {
      const prevNorm = prev.text.replace(/\s+/g, " ").trim().toLowerCase();
      const curNorm = segment.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (prevNorm.startsWith(curNorm)) {
        // Current segment's text is wholly contained in prev (which
        // ended later thanks to the descending end-tie-break) → drop.
        continue;
      }
      if (curNorm.startsWith(prevNorm)) {
        // Reverse case — shouldn't happen with the desc-end sort
        // but defensive: replace prev with the longer segment.
        merged[merged.length - 1] = segment;
        continue;
      }
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
  const text = String(message || "").trim();
  if (!text) {
    resetRecordSessionNotice();
    return;
  }
  // Show ALL tones (info, success, warning, error) — previously info/success
  // would silently call resetRecordSessionNotice() and return without showing
  // the message, which also dismissed any active warning banner. Now every
  // tone with a non-empty message is surfaced; warnings/errors stay until
  // their timer fires rather than being killed by a subsequent success event.
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
    // Also clear the DOM pill — previously only internal state was reset,
    // leaving the previous session's status text (e.g. "Done", "Upscaling")
    // visible in the header after recording ended.
    // ``"idle"`` (not the formerly-passed ``"neutral"``) is the
    // ``StatusKind`` enum value matching the visual neutral grey dot.
    // ``"neutral"`` was a TS2345 error caught by tsc but tolerated
    // because Vite skips type-checks. Now the type contract holds.
    setStatus("", "idle");
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

/**
 * Translate a raw fetch/network error into a user-actionable message.
 *
 * The native "Failed to fetch" / "NetworkError when attempting to
 * fetch" / "ECONNREFUSED" strings are developer jargon. End users need
 * to know: (1) is the internet down, (2) is the provider blocked, or
 * (3) is our local backend dead. This helper inspects the error and
 * surfaces one of those three actionable diagnoses.
 */
function explainNetworkError(err: unknown, context = ""): string {
  const raw = String((err as Error)?.message || err || "").trim();
  const low = raw.toLowerCase();
  // Provider-specific branches before the generic fetch-fail catch.
  // Catch ANY message whose payload starts with "Deepgram " — the
  // backend emits ~8 different RemoteError shapes from
  // remote_deepgram_live.py and remote_deepgram.py, not just the
  // three from the pass-13 fix. Branch on HTTP sub-status first
  // so each failure mode gets its most actionable message; fall
  // through to the generic region-block hint for everything else.
  if (low.startsWith("deepgram ")) {
    const base = context ? `${context}: ` : "";
    // Missing API key takes precedence over all HTTP / network
    // branches. Backend emits "Deepgram API key is not configured"
    // (from remote_deepgram.py + main.py) or "Deepgram API key is
    // required" (from remote_deepgram_live.py). These are
    // configuration problems, not network/region problems — a VPN
    // would NOT help. The user needs to open Settings → API Keys.
    if (low.includes("api key is not configured") ||
        low.includes("api key is required") ||
        low.includes("api key is missing")) {
      return `${base}Deepgram API key is not configured. Open Settings → API Keys → Deepgram and paste your key, or switch Provider to "local" in Settings.`;
    }
    if (/\bhttp\s*40[12]\b/.test(low) || low.includes("rejected the api key")) {
      return `${base}Deepgram rejected the API key. Open Settings → API Keys → Deepgram and verify your key.`;
    }
    if (/\bhttp\s*429\b/.test(low) || low.includes("rate limit")) {
      return `${base}Deepgram rate limit exceeded. Wait a moment and try again, or switch Provider to "local".`;
    }
    if (/\bhttp\s*402\b/.test(low) || low.includes("insufficient credits") || low.includes("out of credits")) {
      return `${base}Deepgram account is out of credits. Top up, or switch Provider to "local".`;
    }
    if (/\bhttp\s*5\d{2}\b/.test(low)) {
      return `${base}Deepgram is temporarily unavailable (provider-side error). Try again in a minute, or switch Provider to "local".`;
    }
    // Generic: unreachable / timeout / handshake / upstream-closed —
    // most likely a regional block. Point to VPN or local fallback.
    return `${base}Deepgram is unreachable. It may be blocked in your region — try a VPN, or switch Provider to "local" in Settings.`;
  }
  const isFetchFail =
    low === "failed to fetch" ||
    low.includes("networkerror") ||
    low.includes("typeerror: fetch") ||
    // "Load failed" is WebKit's generic fetch-failure message. Match
    // it ONLY as a whole message or paired with TypeError — as a
    // substring it wrongly catches backend errors like "failed to
    // load model 'large-v3'" and tells the user to turn on a VPN.
    // Must stay in lockstep with sanitizeUiErrorMessage above.
    low === "load failed" ||
    low === "typeerror: load failed" ||
    low.includes("err_internet_disconnected") ||
    low.includes("err_name_not_resolved") ||
    low.includes("err_connection_refused") ||
    low.includes("err_connection_reset");
  if (!isFetchFail) return raw;
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  if (!online) {
    return context
      ? `${context}: the computer appears to be offline. Check your internet connection and try again.`
      : "The computer appears to be offline. Check your internet connection and try again.";
  }
  // Online but request failed — could be our backend, or the provider
  // (Deepgram/OpenRouter). Give the user the most likely fix.
  return context
    ? `${context}: the network request failed. If this is a remote provider (Deepgram/OpenRouter), it may be unreachable from your region — try a VPN, or switch Provider to "local" in Settings.`
    : "Network request failed. If this is a remote provider, it may be unreachable from your region — try a VPN, or switch Provider to \"local\" in Settings.";
}

async function parseError(r: Response): Promise<string> {
  // 1.1.25 fix: previously called ``await r.json()`` then on failure
  // ``await r.text()``. ``Response`` body is a one-shot stream — once
  // ``json()`` consumes it (even on a malformed-JSON failure path),
  // ``text()`` always rejects with "body stream already read". Every
  // non-JSON error response was reduced to the bare ``HTTP <status>``
  // line, dropping the actual server error message. Fix: read once
  // as text, then attempt JSON parsing on the buffered string.
  const status = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`;
  let raw = "";
  try {
    raw = await r.text();
  } catch (textError) {
    console.debug("parseError: response body unavailable", textError);
    return status;
  }
  const trimmed = raw.trim();
  if (!trimmed) return status;
  try {
    const j: unknown = JSON.parse(trimmed);
    if (typeof j === "object" && j && "detail" in j) {
      const detail = (j as { detail?: unknown }).detail;
      const detailRaw = typeof detail === "string" ? detail : JSON.stringify(j);
      return `${status}: ${detailRaw}`;
    }
    return `${status}: ${JSON.stringify(j)}`;
  } catch {
    // Body wasn't JSON — surface the raw text payload (e.g., a plain
    // HTTP 500 traceback or proxy error page).
    return `${status}: ${trimmed}`;
  }
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
    // Explicit Math.round — setInt16 truncates toward zero on a raw
    // float multiply, introducing a systematic ~0.5-LSB negative bias
    // on positive samples. floatSamplesToInt16LE already rounds; this
    // path must match to produce bit-identical output for the same
    // input samples.
    v.setInt16(off, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
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
/** All `.pcm16` file names that are currently being written to by an
 *  active recording session. `cleanupOrphanPcmSpool` skips these so
 *  it never deletes a spool file that is still in use. */
const _activePcmSpoolNames = new Set<string>();

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
        // Skip any file that belongs to an active recording session.
        if (_activePcmSpoolNames.has(entry.name)) continue;
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
  /** Awaitable handle for the currently-running flush; resolves when done. */
  private flushDone: Promise<void> = Promise.resolve();
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
      // Register BEFORE creating the file handle so the cleanup scan
      // never races with the file's existence on disk.
      _activePcmSpoolNames.add(name);
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
    // Record a promise that outer callers (finalize) can await instead
    // of polling flushInProgress with a bounded busy-wait.
    let _resolveDone!: () => void;
    this.flushDone = new Promise<void>((r) => { _resolveDone = r; });
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
      _resolveDone();
      this.flushDone = Promise.resolve();
      if (this.pendingChunks.length && !this.lastWriteError) {
        this.scheduleFlush();
      }
    }
  }

  async finalize(sampleRate: number, name = `live-${Date.now()}.wav`): Promise<File> {
    // Drain any pending chunks first.
    await this.flushPending();
    // If a flush was already in-progress when we called flushPending()
    // (it returned early because flushInProgress was true), wait for
    // the live flush Promise to settle — no busy-wait, no timeout.
    await this.flushDone;
    // One more drain for anything that arrived during the wait.
    await this.flushPending();
    // Final barrier: wait for that drain to settle too.
    await this.flushDone;

    if (this.writable) {
      try {
        await this.writable.close();
      } catch (e) {
        console.debug("OpfsPcmSink: close failed", e);
      }
      this.writable = null;
    }
    // Spool file is no longer being written; remove from the active set
    // so a subsequent cleanupOrphanPcmSpool call can delete it.
    _activePcmSpoolNames.delete(this.fileHandle.name);

    if (this.lastWriteError) {
      // 1.1.25 fix: previously returned an empty WAV here even though
      // ``flushPending``'s catch branch (line ~1789) deliberately
      // re-enqueues failed chunks into ``pendingChunks`` so finalize
      // can salvage them from RAM. Returning empty discarded the bytes
      // and forced the lower-fidelity WebM fallback for what was
      // typically a transient disk hiccup. Now we splice the in-memory
      // chunks together with whatever DID land on the OPFS spool: the
      // spool prefix + the unwritten tail = a complete WAV.
      try {
        const spoolFile = await this.fileHandle.getFile();
        const spoolBytes = spoolFile.size;
        const tailChunks = this.pendingChunks;
        const tailBytes = tailChunks.reduce((a, c) => a + c.byteLength, 0);
        const totalDataBytes = spoolBytes + tailBytes;
        if (totalDataBytes === 0) {
          return new File([new Blob([], { type: "audio/wav" })], name, { type: "audio/wav" });
        }
        const tailMerged = new Uint8Array(tailBytes);
        let off = 0;
        for (const c of tailChunks) {
          tailMerged.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), off);
          off += c.byteLength;
        }
        const header = buildWavHeader(sampleRate, totalDataBytes);
        const blob = new Blob([header, spoolFile, tailMerged], { type: "audio/wav" });
        return new File([blob], name, { type: "audio/wav" });
      } catch (salvageErr) {
        // Spool file was already lost too — last-resort empty WAV.
        console.warn("OpfsPcmSink.finalize: salvage failed after lastWriteError", salvageErr);
        return new File([new Blob([], { type: "audio/wav" })], name, { type: "audio/wav" });
      }
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
    _activePcmSpoolNames.delete(this.fileHandle.name);
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
    return v || DEFAULT_OPENROUTER_AUDIO_MODEL;
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
  const preferred = (remoteModelByProvider.openrouter || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
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
  opts: { provider: Provider; language: string; diarize: boolean; openrouterModel?: string; signal?: AbortSignal }
): Promise<{ job_id: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "openrouter");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  if (opts.provider === "openrouter" || opts.provider === "deepgram") {
    fd.set("openrouter_model", (opts.openrouterModel || "").trim());
  }
  const r = await fetch("/api/remote/jobs", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as { job_id: string };
}

async function localJob(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<{ job_id: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || "small");
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/jobs", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as { job_id: string };
}

async function cancelBackendJob(jobId: string): Promise<void> {
  try {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch (e) {
    console.debug("backend job cancel failed", e);
  }
}

async function waitForBackendJob<T>(
  jobId: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (job: BackendJobState<T>) => void;
  } = {},
): Promise<T> {
  const startedAt = performance.now();
  while (true) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(),
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(await parseError(r));
    const job = (await r.json()) as BackendJobState<T>;
    opts.onProgress?.(job);
    if (job.status === "done") {
      if (!job.result) throw new Error("Job finished without a result.");
      return job.result;
    }
    if (job.status === "error") {
      throw new Error(String(job.error || "Transcription failed."));
    }
    if (job.status === "cancelled") {
      throw new DOMException("Aborted", "AbortError");
    }
    const pollMs = performance.now() - startedAt > 30_000 ? 3_000 : 900;
    await new Promise<void>((resolve, reject) => {
      const signal = opts.signal;
      let timer = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      timer = window.setTimeout(() => {
        cleanup();
        resolve();
      }, pollMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function remoteJobQueued(
  file: File,
  opts: {
    provider: Provider;
    language: string;
    diarize: boolean;
    openrouterModel?: string;
    signal?: AbortSignal;
    onProcessingProgress?: (fraction: number) => void;
  },
): Promise<RemoteTranscriptionResult> {
  const created = await remoteJob(file, opts);
  const onAbort = () => { void cancelBackendJob(created.job_id); };
  if (opts.signal?.aborted) {
    await cancelBackendJob(created.job_id);
    throw new DOMException("Aborted", "AbortError");
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let result: RemoteTranscriptionResult;
  try {
    result = await waitForBackendJob<RemoteTranscriptionResult>(created.job_id, {
      signal: opts.signal,
      onProgress: (job) => {
        opts.onProcessingProgress?.(Math.max(0, Math.min(1, Number(job.progress || 0))));
      },
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return {
    text: String(result?.text || "").trim(),
    provider: String(result?.provider || opts.provider || ""),
    model: String(result?.model || "").trim() || undefined,
  };
}

function normalizeLocalTranscriptionResult(raw: { text?: string; duration?: number; segments?: Array<{ start?: number; end?: number; text?: string }> } | null | undefined): LocalTranscriptionResult {
  const rawSegments = Array.isArray(raw?.segments) ? raw?.segments || [] : [];
  const segments = rawSegments
    .map((segment) => normalizeTranscriptSegment(segment))
    .filter((segment): segment is TranscriptSegment => !!segment);
  return {
    text: normalizeTranscriptWhitespace(String(raw?.text || "")),
    segments,
    durationSec: Math.max(0, Number(raw?.duration || 0)),
  };
}

async function localJobQueued(
  file: File,
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal },
): Promise<LocalTranscriptionResult> {
  const created = await localJob(file, opts);
  const onAbort = () => { void cancelBackendJob(created.job_id); };
  if (opts.signal?.aborted) {
    await cancelBackendJob(created.job_id);
    throw new DOMException("Aborted", "AbortError");
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let result: { text?: string; duration?: number; segments?: Array<{ start?: number; end?: number; text?: string }> };
  try {
    result = await waitForBackendJob(created.job_id, { signal: opts.signal });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return normalizeLocalTranscriptionResult(result);
}

async function remoteJobSync(
  file: File,
  opts: {
    provider: Provider;
    language: string;
    diarize: boolean;
    openrouterModel?: string;
    signal?: AbortSignal;
  }
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
  opts: { language: string; model: string; splitStereo: boolean; wordTimestamps: boolean; signal?: AbortSignal }
): Promise<LocalTranscriptionResult> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || "small");
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/transcribe-sync", {
    method: "POST",
    body: fd,
    headers: authHeaders(),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  const js = (await r.json()) as {
    ok?: boolean;
    result?: {
      text?: string;
      duration?: number;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };
  };
  return normalizeLocalTranscriptionResult(js?.result);
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
  // Include committed segments plus every useful interim candidate so
  // the tail of the utterance is never lost.
  //
  // Why ``lastInterimSnapshot``: when Deepgram sends an ``is_final``
  // event, the session buffer commit projection clears ``liveInterimText``
  // (correct for live display — the interim is replaced by the final).
  // But if Deepgram finalized only PART of what was in the interim
  // (e.g. "последние" out of "последние слова"), the cleared interim
  // loses "слова" and the committed cache only has "последние". By
  // the time stopLive reads this function, the tail word is gone.
  //
  // ``lastInterimSnapshot`` preserves the interim text from just
  // before the last clear. We merge BOTH:
  //   1. Current ``liveInterimText`` (if Deepgram sent a fresh interim
  //      after the last is_final)
  //   2. ``lastInterimSnapshot`` (the interim just before the last
  //      is_final wiped it)
  //
  // Deduplication: if an interim is already represented in committed
  // text, skip it; if it overlaps at the boundary, append only the new
  // tail words.
  return composeCanonicalLiveSourceText(
    liveDraftText,
    liveInterimText,
    lastInterimSnapshot,
  );
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

// Formerly toggled between "live recording" and "file upload" modes
// based on a switch that no longer exists — live mode is the only
// supported surface. Keep the DOM-visibility side effects so existing
// callers don't need to change; the dead upload-mode branches are
// removed.
function syncMode(): void {
  $("livePane").hidden = false;
  $("splitGap").hidden = false;
  $("waveCanvas").hidden = false;
  $("uploadPanel").hidden = true;
  $("btnStart").style.display = "inline-flex";
  // Removed: setSelectedFile(null). The Live tab no longer surfaces a
  // file picker — the Upload tab fully owns batch transcription. The
  // call here was a vestige of the pre-Upload-tab era; resetting
  // ``selectedFile`` on every loadCfg / view change clobbered any
  // value still in flight from the now-removed Live-tab file flow,
  // and on every config refresh wrote to ``#fileName`` for nothing.
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
    view === "upload" ? "Upload"
      : view === "settings" ? "Settings"
      : view === "recordings" ? "History"
      : view === "graph" ? "Graph"
      : "Live";
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
    // SSOT for the upload cap: backend's /api/health surfaces
    // ``max_upload_bytes`` (= MAX_UPLOAD_BYTES in backend/main.py).
    // We refresh our cached cap from every successful health probe
    // so the frontend never silently allows more bytes than the
    // backend will accept (would 413 mid-upload after the user
    // already waited for it). Defensive Number/Finite check tolerates
    // an old backend without the field — falls back to current value.
    try {
      const healthJson = (await health.clone().json()) as { max_upload_bytes?: unknown };
      const candidate = Number(healthJson?.max_upload_bytes);
      if (Number.isFinite(candidate) && candidate > 0) {
        MAX_FILE_BYTES = Math.trunc(candidate);
      }
    } catch (e) {
      // Non-JSON or shape mismatch — keep prior MAX_FILE_BYTES.
      console.debug("health body parse skipped", e);
    }
    // First successful /api/health means the Python backend is up and
    // serving — drop the boot overlay. hideBootOverlayOnce is idempotent
    // so later refreshes don't re-trigger work after the first success.
    hideBootOverlayOnce();
    // /api/network is public for UI indicator; token issues should not force Offline.
    const netResp = await fetch("/api/network");
    if (!netResp.ok) {
      setNetworkState(true, null);
      return;
    }
    const s = (await netResp.json()) as NetworkStatusResponse;
    // Honor the backend's ``online`` field instead of forcing true.
    // The old hardcoded ``true`` ignored the backend's connectivity
    // probe entirely — even when /api/network reported the network
    // unreachable, ``resolveEffectiveProvider`` kept routing to remote
    // providers, which then timed out with a confusing "remote
    // provider unreachable" error instead of falling back to local
    // Whisper as the offline indicator was supposed to enforce.
    setNetworkState(s.online !== false, s.latency_ms ?? null);
  } catch {
    setNetworkState(false, null);
  }
}

// Idempotent boot-overlay-hide hook. Called from ``refreshNetworkState``
// on first successful /api/health. Defined as function declaration so it
// hoists above refreshNetworkState's invocations.
let _bootOverlayHidden = false;
function hideBootOverlayOnce(): void {
  if (_bootOverlayHidden) return;
  _bootOverlayHidden = true;
  const overlay = document.getElementById("bootOverlay");
  if (!overlay) return;
  overlay.dataset.state = "success";
  const statusEl = document.getElementById("bootOverlayStatus");
  if (statusEl) statusEl.textContent = "Ready";
  // 1.1.25 fix: previously set ``overlay.hidden = true`` immediately,
  // which removes the element from layout INSTANTLY — no CSS
  // transition can run on a hidden element. The comment claimed
  // "fade out then fully hide" but the code did a hard cut. Now the
  // dataset.state="success" change drives the CSS opacity transition
  // (~300 ms in styles.css), and we wait for it to finish before
  // marking ``hidden`` so pointer-events stop intercepting clicks.
  window.setTimeout(() => { overlay.hidden = true; }, 320);
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
    // Classify DOMException.name so the user sees actionable copy
    // instead of a single misleading "Permission denied" catch-all.
    // NotAllowed → user action (grant permission); NotFound → hardware
    // problem (plug in a mic, pick another audio device in OS); the
    // rest → transient / environment issues that need a different
    // remediation path.
    const name = (e && typeof e === "object" && "name" in (e as object))
      ? String((e as { name?: string }).name || "")
      : "";
    let label: string;
    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        label = "Permission denied";
        break;
      case "NotFoundError":
      case "DevicesNotFoundError":
        label = "No microphone detected";
        break;
      case "NotReadableError":
      case "TrackStartError":
        label = "Microphone in use by another app";
        break;
      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        label = "Requested microphone unavailable";
        break;
      case "SecurityError":
        label = "Microphone blocked (insecure context)";
        break;
      case "AbortError":
        label = "Microphone request was cancelled";
        break;
      default:
        label = "Microphone unavailable";
    }
    // Always rewrite — the prior condition guarded behind a dead
    // `/loading/i.test(sel.value)` regex (`sel.value` is an attribute
    // value, never the display text, so the check never fired).
    sel.innerHTML = `<option value="">${label}</option>`;
    // Tooltip carries the technical name for bug reports without
    // polluting the select's rendered text.
    sel.title = name ? `${label} (${name})` : label;
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
      session_id: activeLiveSessionId || activeUiSessionToken || "",
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

function clearLiveDraft(sessionToken = ""): void {
  try {
    if (sessionToken) {
      const raw = localStorage.getItem(LIVE_DRAFT_KEY) || "";
      if (raw) {
        const parsed = JSON.parse(raw) as { session_id?: unknown };
        const owner = String(parsed.session_id || "").trim();
        if (owner && owner !== sessionToken) return;
      }
    }
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
    remote_model_openrouter: (remoteModelByProvider.openrouter || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL,
    remote_model_deepgram: (remoteModelByProvider.deepgram || "").trim() || DEEPGRAM_AUDIO_MODELS[0],
    shortcut_record: currentShortcuts.record,
    shortcut_paste: currentShortcuts.paste,
    // Upload tab — mirrors current DOM values. Optional-chained because
    // setupUploadView may not have run yet on a page that loaded
    // without the Upload section (defensive against future view splits).
    upload_provider: ((document.getElementById("uploadProvider") as HTMLSelectElement | null)?.value || "deepgram").trim(),
    upload_language: ((document.getElementById("uploadLanguage") as HTMLSelectElement | null)?.value || "auto").trim(),
    upload_diarize: !!(document.getElementById("uploadDiarize") as HTMLInputElement | null)?.checked,
  };
}

// ── Keyboard Shortcut Picker ────────────────────────────────────────────────

// Cross-platform safe defaults. Function keys F9/F10 have no built-in
// binding in Chrome/Firefox/Safari, macOS Mission Control, or Windows
// Explorer — unlike Alt+Left (browser "Back") and Alt+Shift+N (Windows
// input-language switcher, also impossible to press on US keyboards
// because Shift+digit produces punctuation). Users can still rebind
// via Settings → Shortcuts.
// Platform-specific defaults — kept in lockstep with desktop/main.js
// `readShortcutsFromConfig`. F-keys conflict with macOS media-key
// mode (F9=Mission Control, F10=Notification Center), so Mac gets
// Option-based combos. Win/Linux F-keys are clean and avoid Alt+Left
// = browser-back / Alt+Shift+letter = Windows input-language switch.
const _platformDefaultShortcuts: Record<string, { record: string; paste: string }> = {
  // navigator.platform is the only reliable in-renderer probe; we
  // can't import process.platform here.
  darwin: { record: "Alt+Left", paste: "Alt+Shift+V" },
  default: { record: "F9", paste: "F10" },
};
const _isMacRenderer = (() => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.platform || "")
        || /Mac OS X/.test(navigator.userAgent || "");
  } catch { return false; }
})();
const DEFAULT_SHORTCUTS = _isMacRenderer ? _platformDefaultShortcuts.darwin : _platformDefaultShortcuts.default;
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
  // Ignore standalone modifier keys (still being held down).
  if (["Alt", "Control", "Meta", "Shift"].includes(e.key)) return null;
  // Standalone (no-modifier) keys are allowed when the key is a
  // function-row key (F1–F12), an arrow / nav key, or another
  // dedicated control key. These are safe to bind alone because
  // they don't conflict with normal text input. Letter / digit /
  // punctuation standalone bindings would steal user typing in
  // the renderer, so those still REQUIRE at least one modifier.
  // Without this gate the Settings → Shortcuts capture refused
  // every press of F9/F10/Arrow/etc. and silently never bound.
  const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  const code = String(e.code || "").trim();
  const key = String(e.key || "").trim();
  const isFunctionKey = /^F\d{1,2}$/.test(key) || /^F\d{1,2}$/.test(code);
  const isStandaloneAllowed = (
    isFunctionKey
    || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
    || code === "ArrowLeft" || code === "ArrowRight" || code === "ArrowUp" || code === "ArrowDown"
    || key === "Home" || key === "End" || key === "PageUp" || key === "PageDown"
    || key === "Insert" || key === "Delete"
    || code === "Home" || code === "End" || code === "PageUp" || code === "PageDown"
    || code === "Insert" || code === "Delete"
  );
  if (!hasModifier && !isStandaloneAllowed) return null;

  const parts: string[] = [];
  // Separate Control (Ctrl) from Command (Meta/Cmd) unless BOTH are
  // held (extremely rare; fall back to the generic CommandOrControl).
  // The old `ctrlKey || metaKey → CommandOrControl` collapse silently
  // hijacked Cmd+X bindings on macOS users who meant Ctrl+X, and vice
  // versa. Electron accepts all three forms; this produces the most
  // precise binding the user actually pressed.
  if (e.ctrlKey && e.metaKey) parts.push("CommandOrControl");
  else if (e.metaKey) parts.push("Command");
  else if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Prefer KeyboardEvent.code for layout-stable keys so the shortcut
  // survives non-Latin keyboard layouts and remains consistent across
  // macOS / Windows / Linux. For punctuation we still accept the
  // actual emitted ASCII symbol first because Electron accelerators
  // are defined in terms of symbols, not DOM code names.
  // (`code` and `key` already declared above for the standalone-allowed
  // gate; reuse those values here.)
  let mapped: string | null = null;
  if (/^Key[A-Z]$/.test(code)) mapped = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) mapped = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) mapped = `num${code.slice(6)}`;
  else if (code === "NumpadDecimal") mapped = "numdec";
  else if (code === "NumpadAdd") mapped = "numadd";
  else if (code === "NumpadSubtract") mapped = "numsub";
  else if (code === "NumpadMultiply") mapped = "nummult";
  else if (code === "NumpadDivide") mapped = "numdiv";
  else if (key === "ArrowLeft" || code === "ArrowLeft") mapped = "Left";
  else if (key === "ArrowRight" || code === "ArrowRight") mapped = "Right";
  else if (key === "ArrowUp" || code === "ArrowUp") mapped = "Up";
  else if (key === "ArrowDown" || code === "ArrowDown") mapped = "Down";
  else if (key === " " || code === "Space") mapped = "Space";
  else if (key === "Enter" || code === "Enter" || code === "NumpadEnter") mapped = "Enter";
  else if (key === "Backspace" || code === "Backspace") mapped = "Backspace";
  else if (key === "Delete" || code === "Delete") mapped = "Delete";
  else if (key === "Insert" || code === "Insert") mapped = "Insert";
  else if (key === "Home" || code === "Home") mapped = "Home";
  else if (key === "End" || code === "End") mapped = "End";
  else if (key === "PageUp" || code === "PageUp") mapped = "PageUp";
  else if (key === "PageDown" || code === "PageDown") mapped = "PageDown";
  else if (key === "Tab" || code === "Tab") mapped = "Tab";
  else if (key === "Escape" || code === "Escape") mapped = "Escape";
  else if (/^F\d{1,2}$/.test(key)) mapped = key.toUpperCase();
  else if (key.length === 1 && /^[!@#$%^&*()_+\-=\[\]{}\\|;:'",.<>/?`~]$/.test(key)) mapped = key;
  else if (code === "Backquote") mapped = "`";
  else if (code === "Minus") mapped = "-";
  else if (code === "Equal") mapped = "=";
  else if (code === "BracketLeft") mapped = "[";
  else if (code === "BracketRight") mapped = "]";
  else if (code === "Backslash") mapped = "\\";
  else if (code === "Semicolon") mapped = ";";
  else if (code === "Quote") mapped = "'";
  else if (code === "Comma") mapped = ",";
  else if (code === "Period") mapped = ".";
  else if (code === "Slash") mapped = "/";
  if (!mapped) return null;
  parts.push(mapped);

  return parts.join("+");
}

function updateShortcutDisplay(btnId: string, accelerator: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return;
  const keysSpan = btn.querySelector(".shortcut-keys");
  if (keysSpan) keysSpan.textContent = acceleratorToDisplay(accelerator);
}

/**
 * Poll `window.__transcriptorShortcutStatus` (published by Electron main
 * after every globalShortcut.register) and toggle a conflict class on
 * the shortcut buttons. Without this, a shortcut that the OS refused
 * (already bound by another app) looks "saved" in Settings but does
 * nothing at all — the user has no way to know.
 */
function refreshShortcutConflictState(): void {
  const status = (window as unknown as {
    __transcriptorShortcutStatus?: {
      record?: { active?: string; desired?: string; error?: string };
      paste?: { active?: string; desired?: string; error?: string };
      macFnState?: boolean | null;
      platform?: string;
    };
  }).__transcriptorShortcutStatus;
  if (!status) return;
  // On macOS, detect the "F-keys as media keys" mode. When fnState is
  // explicitly false AND the user kept an F-key accelerator, the OS
  // silently eats the press as Mission Control / Exposé — register
  // succeeds but the handler never fires. Badge the affected shortcut
  // button with a hint so the user can diagnose.
  const isMacFnCollision = status.platform === "darwin" && status.macFnState === false;
  const isFKeyAccel = (accel: string | undefined): boolean => !!accel && /^F([1-9]|1[0-2])$/.test(accel);
  for (const id of ["record", "paste"] as const) {
    const entry = status[id];
    if (!entry) continue;
    const btn = document.getElementById(`shortcut${id[0].toUpperCase()}${id.slice(1)}`) as HTMLButtonElement | null;
    if (!btn) continue;
    const active = !!entry.active;
    const desired = entry.desired || "";
    // A shortcut is "conflicted" if (a) registration failed OR (b)
    // registration succeeded but macOS is going to intercept it as a
    // media key. Case (b) is invisible without this extra check.
    const macBlocked = isMacFnCollision && isFKeyAccel(desired);
    const hasConflict = !active || macBlocked;
    btn.classList.toggle("shortcut-conflict", hasConflict);
    if (!active) {
      btn.title = `Not registered: ${entry.error || "unknown reason"}`;
    } else if (macBlocked) {
      btn.title = (
        `macOS is intercepting ${desired} as a media key. ` +
        `Either enable System Settings → Keyboard → Keyboard Shortcuts → Function Keys → "Use F1, F2 as standard function keys", ` +
        `or hold Fn while pressing ${desired}, ` +
        `or pick a non-F-key accelerator here.`
      );
    } else {
      btn.title = "";
    }
  }
}
// 2s polling for the conflict-state badge on Settings → Shortcuts.
// Capture the handle so a future code path (e.g. shutdown hook,
// pre-quit IPC) can clear it. Gate the body on document visibility
// so the poll doesn't waste CPU when the renderer window is hidden
// (e.g. user dragged the recording overlay to focus while the
// Settings tab is invisible behind it).
const _shortcutConflictPollHandle = window.setInterval(() => {
  if (document.visibilityState === "hidden") return;
  refreshShortcutConflictState();
}, 2000);
// Symmetric cleanup: a ``pagehide`` event fires before any teardown
// (Electron renderer reload, dev hot-reload, real navigation away),
// so clearing here prevents a stale handle from leaking across hot
// reloads in development.
window.addEventListener("pagehide", () => {
  try { window.clearInterval(_shortcutConflictPollHandle); } catch { /* idempotent */ }
}, { once: true });

function startShortcutRecording(btn: HTMLButtonElement): void {
  // Cancel any existing recording
  stopShortcutRecording(false);
  activeShortcutBtn = btn;
  btn.classList.add("recording");
  const keysSpan = btn.querySelector(".shortcut-keys");
  if (keysSpan) keysSpan.textContent = "Press keys...";
  // Add global keydown listener
  document.addEventListener("keydown", handleShortcutKeydown, true);
  // Outside-click cancel: without this, clicking ANYWHERE other than
  // a shortcut row left capture mode active. The keydown listener
  // stayed attached to ``document`` and any subsequent keypress
  // (typing in another field, pressing arrow keys to scroll, etc.)
  // silently rebound the user's shortcut. The visible ``.recording``
  // class on the button was the only cue that capture was still
  // active, and a user who navigated to another tab couldn't even
  // see it. Capture phase so we beat per-element click handlers.
  document.addEventListener("mousedown", handleShortcutOutsideMousedown, true);
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
  document.removeEventListener("mousedown", handleShortcutOutsideMousedown, true);
  activeShortcutBtn = null;
}

/**
 * Outside-click cancel for the shortcut-recording mode. Fires before
 * any element-level click handler (capture phase) so we can revert
 * display + detach the keydown listener BEFORE a click on the OTHER
 * shortcut row's button triggers its own ``startShortcutRecording``
 * (which itself calls ``stopShortcutRecording(false)`` for a clean
 * hand-off, but there's no harm in our cancelling first).
 *
 * Containment check uses ``Node.contains`` so clicks on the keys-span
 * inside the active button (e.g. the user double-clicks the visible
 * accelerator text) are treated as clicks ON the button — recording
 * stays active so the user can press fresh keys.
 */
function handleShortcutOutsideMousedown(e: MouseEvent): void {
  if (!activeShortcutBtn) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (activeShortcutBtn.contains(target)) return;
  stopShortcutRecording(true);
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
  const otherId = id === "record" ? "paste" : "record";
  // Reject duplicates: if the user rebinds one action to the SAME
  // accelerator as the other, only one globalShortcut.register call
  // succeeds (the second overwrites/fails), leaving the first action
  // silently broken. Surface the conflict and revert instead.
  if (accelerator === currentShortcuts[otherId as "record" | "paste"]) {
    showRecordSessionNotice(
      `That shortcut is already bound to "${otherId === "record" ? "Record" : "Paste"}". Pick a different combination.`,
      "warning",
      6000,
    );
    stopShortcutRecording(true);
    return;
  }
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
  (window as unknown as { __transcriptorPendingShortcuts?: unknown }).__transcriptorPendingShortcuts = {
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
  // The model select is a sibling of the preset-wrap, not inside it,
  // so it must be toggled separately. Previously this was omitted —
  // the model dropdown stayed fully interactive even when the entire
  // upscale toolbar was at 0.5 opacity, confusing users into thinking
  // they could configure upscale while it was disabled.
  const modelSel = document.getElementById("upscaleModelSelect") as HTMLSelectElement | null;
  if (modelSel) modelSel.disabled = !upscaleEnabled;
  // Visual dimming for the entire toolbar when upscale is OFF.
  // pointer-events: none prevents cursor/hover artefacts on the
  // dimmed row; individual disabled attributes still block keyboard.
  // The copy-paste bug (both branches were "") is fixed here.
  const toolbar = wrap.closest(".pane-toolbar-actions-upscale") as HTMLElement | null;
  if (toolbar) {
    toolbar.style.opacity = upscaleEnabled ? "1" : "0.5";
    toolbar.style.pointerEvents = upscaleEnabled ? "" : "none";
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

let upscalePromptSaveCloseTimer: number | null = null;

function closeUpscalePromptModal(): void {
  if (upscalePromptSaveCloseTimer !== null) {
    clearTimeout(upscalePromptSaveCloseTimer);
    upscalePromptSaveCloseTimer = null;
  }
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

async function runUpscaleIfEnabled(
  text: string,
  sessionToken = "",
  opts: { setDoneStatus?: boolean } = {},
): Promise<string> {
  const input = String(text || "").trim();
  if (!input) return "";
  const setDoneStatus = opts.setDoneStatus !== false;
  if (!shouldUpscale()) {
    if (isCurrentUiSession(sessionToken)) {
      $("upscaleOutput").textContent = "";
      $("upscaleLatency").textContent = "--";
    }
    return input;
  }
  // When caller omits sessionToken, two concurrent file-transcription
  // paths would share the placeholder key and the second call would
  // receive the FIRST call's upscaled text — writing the wrong result
  // into the second session's DOM. Make the placeholder unique per
  // invocation so coalescing only happens for a genuine same-session
  // duplicate (which always carries an explicit token).
  const inflightKey = sessionToken || `__no_session__:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const existing = upscaleInFlightBySession.get(inflightKey);
  if (existing) {
    return existing;
  }
  // Per-invocation nonce for the DOM's placeholder ownership.
  // Passed alongside the "Upscaling..." write via dataset so a late
  // completing session can check "is the DOM still showing MY
  // placeholder, or did someone else write something since?". Text-
  // equality to "Upscaling..." is too weak — pass-14 used it and
  // collided because two sessions write the identical literal.
  const placeholderNonce = `${inflightKey}:${Math.random().toString(36).slice(2, 10)}`;
  const upscaleOutputEl = $("upscaleOutput") as HTMLElement;
  const promise = (async (): Promise<string> => {
    setStatusScoped(sessionToken, "Upscaling");
    if (isCurrentUiSession(sessionToken)) {
      upscaleOutputEl.textContent = "Upscaling...";
      upscaleOutputEl.dataset.upscaleNonce = placeholderNonce;
    }
    const t0 = performance.now();
    const upscaleModel = getUpscaleModelValue();
    // Backend rejects upscale requests with text > 120 000 chars
    // (`/api/upscale` HTTP 400). Cap client-side and surface a
    // friendly notice so the user understands WHY the upscale was
    // skipped instead of seeing an opaque server error. We trim
    // from the start so the trailing summary (often the most
    // useful part for AI rewrite) is preserved.
    const MAX_UPSCALE_INPUT_CHARS = 120_000;
    let payloadText = input;
    if (payloadText.length > MAX_UPSCALE_INPUT_CHARS) {
      const overflow = payloadText.length - MAX_UPSCALE_INPUT_CHARS;
      payloadText = payloadText.slice(overflow);
      console.warn(`Upscale: trimmed ${overflow} leading chars to fit ${MAX_UPSCALE_INPUT_CHARS} cap`);
      setStatusScoped(sessionToken, `Upscaling (trimmed first ${overflow.toLocaleString()} chars)`, "warning");
    }
    try {
      const r = await apiPost<{ ok: boolean; text: string; preset_id: string; model: string }>("/api/upscale", {
        text: payloadText,
        preset_id: upscalePresetId(),
        model: upscaleModel || undefined,
      });
      const out = String(r.text || "").trim();
      if (!out) throw new Error("Upscale returned empty text");
      // Session-aware success write. We write if EITHER:
      //   (a) this session is still the current UI session, OR
      //   (b) the DOM is still showing OUR specific placeholder
      //       (dataset.upscaleNonce === placeholderNonce). This
      //       covers the pass-12 stuck-on-placeholder case without
      //       letting session A clobber session B's IDENTICAL
      //       "Upscaling..." string (pass-14's text-equality sentinel
      //       collided because both sessions wrote the same literal).
      const isStillOurPlaceholder =
        upscaleOutputEl.dataset.upscaleNonce === placeholderNonce;
      if (isCurrentUiSession(sessionToken) || isStillOurPlaceholder) {
        upscaleOutputEl.textContent = out;
        upscaleOutputEl.dataset.upscaleNonce = "";
        $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
      }
      if (setDoneStatus) setStatusScoped(sessionToken, "Done");
      return out;
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e || "Unknown upscale error");
      // Surface actionable guidance for the most common failure modes
      // instead of raw backend text. Users who see "HTTP 400
      // OpenRouter key is not configured" don't know that they need
      // to open Settings → API Keys → OpenRouter and paste a key.
      let friendly: string;
      const low = rawMsg.toLowerCase();
      // Match HTTP status tokens only as standalone words, not bare
      // substrings — a request id, timestamp, or unrelated payload
      // could contain "401" / "429" as four digits and wrongly map
      // to the wrong branch. Backend emits "HTTP 4XX" shape tokens.
      if (
        low.includes("openrouter key is not configured") ||
        /\bhttp\s*401\b/.test(low) ||
        /\b401\s+(unauthorized|forbidden)\b/.test(low)
      ) {
        friendly = "Upscale needs an OpenRouter API key.\n\nOpen Settings → API Keys → OpenRouter and paste your key, then try again.";
      } else if (/\bhttp\s*429\b/.test(low) || low.includes("rate limit")) {
        friendly = "Upscale hit the OpenRouter rate limit.\n\nWait a moment and try again, or pick a less-busy model in Settings → Upscale.\n\nUsing original transcript.";
      } else if (/\bhttp\s*402\b/.test(low) || low.includes("insufficient credit") || low.includes("out of credit") || low.includes("quota exceeded")) {
        friendly = "OpenRouter account is out of credits.\n\nTop up at openrouter.ai/credits or switch the upscale model to a free-tier option in Settings → Upscale.\n\nUsing original transcript.";
      } else if (/\bhttp\s*404\b/.test(low) || low.includes("model not found") || low.includes("no endpoints found for")) {
        friendly = "Upscale model is unavailable.\n\nYou may have picked a paid-tier model without a paid OpenRouter account. Open Settings → Upscale and pick a different model.\n\nUsing original transcript.";
      } else if (/\bhttp\s*5\d{2}\b/.test(low) || low.includes("service unavailable") || low.includes("bad gateway")) {
        friendly = "OpenRouter is temporarily unavailable (provider-side error).\n\nTry again in a minute, or switch upscale model in Settings → Upscale.\n\nUsing original transcript.";
      } else if (low.includes("content filter") || low.includes("content policy") || low.includes("refused to")) {
        friendly = "Upscale model refused to process this text (content filter).\n\nThe original transcript is used as-is.";
      } else if (low.includes("failed to fetch") || low.includes("networkerror") || low === "load failed") {
        friendly = "Upscale request failed: the OpenRouter API is unreachable.\n\nCheck your internet connection or try a VPN. OpenRouter is sometimes blocked in certain regions.\n\nUsing original transcript.";
      } else if (low.includes("unsupported upscale preset")) {
        friendly = "Upscale preset is missing.\n\nOpen Settings → Upscale and re-select a preset.";
      } else {
        friendly = `Upscale failed: ${rawMsg}\n\nUsing original transcript.`;
      }
      // Error-path write: same nonce-gated logic as success. If the
      // DOM still shows OUR placeholder (no newer session has
      // overwritten), render the friendly error so the user sees
      // feedback — even for a session that has moved on. Otherwise
      // skip silently (don't clobber a newer session's result).
      const isStillOurPlaceholderErr =
        upscaleOutputEl.dataset.upscaleNonce === placeholderNonce;
      if (isCurrentUiSession(sessionToken) || isStillOurPlaceholderErr) {
        upscaleOutputEl.textContent = friendly;
        upscaleOutputEl.dataset.upscaleNonce = "";
        $("upscaleLatency").textContent = fmtMs(performance.now() - t0);
      }
      if (setDoneStatus) setStatusScoped(sessionToken, "Done");
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
    const openrouterModel = (remoteModelByProvider.openrouter || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
    const nextRecordingsDir = ($("recordingsDirInput") as HTMLInputElement).value.trim();
    const shouldRefreshRecordingsArchive = nextRecordingsDir !== configuredRecordingsDir;
    ($("orModel") as HTMLInputElement).value = openrouterModel;
    const payload = {
      preferences: {
        recordings_dir: nextRecordingsDir,
        remote_provider: remoteProvider,
        // SSOT: derive default from OPENROUTER_AUDIO_MODELS so a future
        // version bump (e.g. gemini-2.6-flash) flows through; the prior
        // hardcoded literal would silently keep stuck on 2.5-flash.
        openrouter: { model: openrouterModel || DEFAULT_OPENROUTER_AUDIO_MODEL },
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
    // SSOT default mirrors DEFAULT_OPENROUTER_AUDIO_MODEL. Same SSOT
    // rationale as the autosave path above.
    const cfgOpenrouterModel = (cfg.preferences || {}).openrouter?.model || DEFAULT_OPENROUTER_AUDIO_MODEL;
    ($("orModel") as HTMLInputElement).value = cfgOpenrouterModel;
    configuredRecordingsDir = (cfg.preferences || {}).recordings_dir || "";
    ($("recordingsDirInput") as HTMLInputElement).value = configuredRecordingsDir;
    const ui = (cfg.preferences || {}).ui || {};
    remoteModelByProvider.openrouter = String(ui.remote_model_openrouter || cfgOpenrouterModel || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
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

    // Upload tab — restore persisted provider/language/diarize. Each
    // input is guarded so a config carried over from a build without
    // the Upload tab (or with a different option set) gracefully falls
    // through to the HTML default instead of crashing on missing DOM.
    const uploadProviderEl = document.getElementById("uploadProvider") as HTMLSelectElement | null;
    if (uploadProviderEl && ui.upload_provider) {
      const wanted = String(ui.upload_provider).trim();
      if (Array.from(uploadProviderEl.options).some((o) => o.value === wanted)) {
        uploadProviderEl.value = wanted;
      }
    }
    const uploadLanguageEl = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
    if (uploadLanguageEl && ui.upload_language) {
      const wanted = String(ui.upload_language).trim();
      if (Array.from(uploadLanguageEl.options).some((o) => o.value === wanted)) {
        uploadLanguageEl.value = wanted;
      }
    }
    const uploadDiarizeEl = document.getElementById("uploadDiarize") as HTMLInputElement | null;
    if (uploadDiarizeEl && typeof ui.upload_diarize === "boolean") {
      uploadDiarizeEl.checked = ui.upload_diarize;
    }

    // Load keyboard shortcuts. Defaults are platform-specific
    // (DEFAULT_SHORTCUTS at module scope) — Mac=Option+Left/Shift+V,
    // Win/Linux=F9/F10.
    //
    // One-time migration paths for users carrying forward stale
    // values from earlier builds:
    //   1. `Alt+Shift+7` (any platform) → platform default's paste.
    //      Literally unpressable on US/UK layouts (Shift+7=`&`)
    //      and collides with Win Alt+Shift = input-language switch.
    //   2. `F9` / `F10` ON MACOS → Mac default Alt+Left / Alt+Shift+V.
    //      Pass-15 set F9/F10 as the cross-platform default; on Mac
    //      F9 is Mission Control and F10 is Notification Center, so
    //      a Mac user saved an effectively non-functional shortcut
    //      via the default. We rewrite ONLY the exact F9/F10 pair —
    //      a Mac user who DELIBERATELY chose F11 / Cmd+Shift+T / etc.
    //      is left untouched.
    let rawRecord = String(ui.shortcut_record || "").trim();
    let rawPaste = String(ui.shortcut_paste || "").trim();
    let didMigrate = false;
    // Migration 1: broken paste shortcut.
    if (rawPaste === "Alt+Shift+7") {
      rawPaste = DEFAULT_SHORTCUTS.paste;
      didMigrate = true;
    }
    // Migration 2: Mac users with the stale F9/F10 cross-platform
    // pair. Both must match exactly; partial matches mean the user
    // customised one half and we leave both alone.
    if (_isMacRenderer && rawRecord === "F9" && rawPaste === "F10") {
      rawRecord = DEFAULT_SHORTCUTS.record;  // Alt+Left
      rawPaste = DEFAULT_SHORTCUTS.paste;    // Alt+Shift+V
      didMigrate = true;
    }
    if (rawRecord) currentShortcuts.record = rawRecord;
    if (rawPaste) currentShortcuts.paste = rawPaste;
    updateShortcutDisplay("shortcutRecord", currentShortcuts.record);
    updateShortcutDisplay("shortcutPaste", currentShortcuts.paste);
    if (didMigrate) {
      // Persist + signal Electron to re-register globalShortcut
      // with the new accelerators on the next 2 s poll tick.
      (window as unknown as { __transcriptorPendingShortcuts?: unknown }).__transcriptorPendingShortcuts = {
        record: currentShortcuts.record,
        paste: currentShortcuts.paste,
      };
      queueUiPreferencesSave();
    }
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

/**
 * Light client-side validation before POSTing a provider key.
 *
 * Catches the obvious user mistakes (empty, pasted with surrounding
 * quotes / whitespace, "Bearer " prefix, way too short) with a clear
 * inline error instead of letting the wrong value hit the provider
 * later and surface as a confusing HTTP 401 during transcription. We
 * deliberately do NOT enforce provider-specific regex shapes beyond
 * this — providers rotate their key formats (Deepgram already moved
 * from hex-only to JWT-style in 2024) and a too-strict frontend
 * rejects legitimate new-format keys.
 */
function validateProviderKey(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  let v = (raw || "").trim();
  // Strip common paste-from-email artefacts.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // Strip an accidental "Bearer " prefix that users copy from API docs.
  if (/^bearer\s+/i.test(v)) {
    v = v.replace(/^bearer\s+/i, "").trim();
  }
  if (!v) return { ok: false, error: "Key is empty. Paste your API key and try again." };
  if (v.includes(" ") || v.includes("\t") || v.includes("\n")) {
    return { ok: false, error: "Key contains whitespace. API keys should be a single token with no spaces." };
  }
  if (v.length < 16) {
    return { ok: false, error: "Key looks too short. Make sure you copied the full key from the provider dashboard." };
  }
  return { ok: true, value: v };
}

async function saveProviderKey(provider: KeyProvider): Promise<void> {
  const input = keyInput(provider);
  const raw = isMaskedKeyInput(input) ? "" : input.value;
  if (!raw && isMaskedKeyInput(input)) {
    // Masked placeholder state — nothing to save, stay silent (user
    // opened Settings but didn't edit). Same behaviour as before the
    // validation hook.
    return;
  }
  const v = validateProviderKey(raw);
  if (!v.ok) {
    throw new Error(v.error);
  }
  // Reflect the sanitized value back into the input so the user sees
  // exactly what we saved (e.g., if we stripped surrounding quotes).
  input.value = v.value;
  await apiPost<{ ok: boolean }>("/api/config", {
    providers: {
      [provider]: { key: v.value },
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
($("autoStopSilenceEnabled") as HTMLInputElement).addEventListener("change", () => {
  queueUiPreferencesSave();
});
($("autoStopSilenceSeconds") as HTMLInputElement).addEventListener("change", () => {
  // Reflect the clamped value back into the DOM. `getAutoStopSilenceConfig`
  // already clamps via `clampNumber(..., 1, 120)`, but the input element
  // itself kept the raw user-typed value. Result was a UI/state mismatch:
  // user typed `999` and saw `999` while the persisted config held `120`.
  // Now the displayed value matches the saved value at all times.
  const inp = $("autoStopSilenceSeconds") as HTMLInputElement;
  const cfg = getAutoStopSilenceConfig();
  if (String(cfg.seconds) !== inp.value) inp.value = String(cfg.seconds);
  queueUiPreferencesSave();
});
($("autoStopSilenceDb") as HTMLInputElement).addEventListener("change", () => {
  // Same UI/state-mismatch fix as above for the silence threshold.
  const inp = $("autoStopSilenceDb") as HTMLInputElement;
  const cfg = getAutoStopSilenceConfig();
  if (String(cfg.thresholdDb) !== inp.value) inp.value = String(cfg.thresholdDb);
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
      // Surface failures to the user. Pre-fix, a bad key / network
      // error was logged to the devtools console only — the Save
      // button would silently revert and the user had no idea why
      // transcription still complained about "key not configured".
      console.error(e?.message || e);
      const providerLabel = provider === "openrouter" ? "OpenRouter" : "Deepgram";
      const detail = sanitizeUiErrorMessage(e, "Could not save the key.");
      setStatus(`Could not save ${providerLabel} key: ${detail}`, "error");
      // Visual marker on the input so the user sees where the
      // problem is, even if they've scrolled away from the status
      // pill. Cleared automatically on the next focus/input event.
      const inputEl = keyInput(provider);
      inputEl.setAttribute("aria-invalid", "true");
      inputEl.classList.add("has-error");
      const clearError = () => {
        inputEl.removeAttribute("aria-invalid");
        inputEl.classList.remove("has-error");
        inputEl.removeEventListener("focus", clearError);
        inputEl.removeEventListener("input", clearError);
      };
      inputEl.addEventListener("focus", clearError);
      inputEl.addEventListener("input", clearError);
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
      // Cancellable — closeUpscalePromptModal clears this handle if the
      // user dismisses the modal manually (Esc, click-outside) before
      // the 220ms elapses, preventing the timer from firing on an
      // already-closed or freshly-reopened modal.
      if (upscalePromptSaveCloseTimer !== null) clearTimeout(upscalePromptSaveCloseTimer);
      upscalePromptSaveCloseTimer = window.setTimeout(() => {
        upscalePromptSaveCloseTimer = null;
        closeUpscalePromptModal();
      }, 220);
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
  // Confirm before destructive action. Custom upscale presets can
  // hold dozens of lines of carefully-tuned prompt instructions —
  // a single accidental click previously dropped them with no undo.
  // The delete-all-recordings flow has a modal for the same reason;
  // mirror that severity floor here. ``window.confirm`` is the
  // simplest blocking primitive that respects keyboard navigation
  // and matches the platform's native dialog style.
  const presetLabel = String(cur.name || cur.id || "this preset").trim();
  const confirmed = window.confirm(
    `Delete the upscale preset “${presetLabel}”?\n\nThis cannot be undone.`,
  );
  if (!confirmed) return;
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
  remoteModelByProvider.openrouter = (($("orModel") as HTMLInputElement).value || "").trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
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
    const haystack = [item.display_name, item.source_file || "", item.name, item.provider, item.language].join(" ").toLowerCase();
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
  btn.classList.remove("is-copy-ok", "is-copy-failed");
  btn.classList.add(copiedLabel === "Copied" ? "is-copy-ok" : "is-copy-failed");
  btn.setAttribute("aria-label", copiedLabel);
  btn.title = copiedLabel;
  window.setTimeout(() => {
    btn.classList.remove("is-copy-ok", "is-copy-failed");
    btn.setAttribute("aria-label", prevAria);
    btn.title = prevTitle;
  }, 900);
}

async function writeTextToClipboard(text: string): Promise<boolean> {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) {
    console.debug("navigator.clipboard.writeText failed; trying fallback", e);
  }

  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand("copy") === true;
  } catch (e) {
    console.warn("execCommand copy fallback failed", e);
    return false;
  } finally {
    ta.remove();
  }
}

async function copyRecordingText(): Promise<void> {
  const text = ($("recordingContent").textContent || "").trim();
  if (!text) return;
  const btn = $("recordingCopyBtn") as HTMLButtonElement;
  const ok = await writeTextToClipboard(text);
  flashButtonFeedback(btn, ok ? "Copied" : "Copy failed", "Copy recording text");
}

async function copyTextContent(text: string, btnId = ""): Promise<void> {
  const value = String(text || "").trim();
  if (!value) return;
  const ok = await writeTextToClipboard(value);
  if (btnId) {
    const btn = $(btnId) as HTMLButtonElement;
    flashButtonFeedback(btn, ok ? "Copied" : "Copy failed", btnId === "resultCopyBtn" ? "Copy result text" : "Copy upscale text");
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
  let s: RecordingsStats;
  try {
    s = await apiGet<RecordingsStats>("/api/recordings/stats/summary");
  } catch (e) {
    // Stats are decorative — a backend error must not abort the caller
    // (loadRecordings) or leave the panel in a permanent loading state.
    console.warn("loadRecordingsStats: stats fetch failed (non-fatal)", e);
    return;
  }
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
      source_file?: string;
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
    // Reveal-in-Finder button — surfaced when running inside Electron
    // (``__transcriptorRevealRecording`` injected by main.tsx and
    // dispatched by main.js via the page-title-updated channel).
    // Hidden in plain-browser dev preview where the helper is undefined.
    const revealBtn = document.getElementById("recordingRevealBtn") as HTMLButtonElement | null;
    if (revealBtn) {
      const hasReveal = typeof window.__transcriptorRevealRecording === "function";
      revealBtn.hidden = !hasReveal;
      revealBtn.onclick = () => {
        const fn = window.__transcriptorRevealRecording;
        if (fn) fn(name, currentArchiveDirSnapshot());
      };
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
    const revealBtn = document.getElementById("recordingRevealBtn") as HTMLButtonElement | null;
    if (revealBtn) revealBtn.hidden = true;
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
  /** When set, the backend atomically discards the live-recovery spool
   *  for this session ID immediately after the audio is persisted —
   *  closing the race window between a successful save and the
   *  separate discardLiveRecovery() call in the frontend. */
  liveSessionId?: string;
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
    if (opts.liveSessionId) fd.set("live_session_id", opts.liveSessionId);
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
  return {
    name: savedName,
    archiveDir: savedArchiveDir,
  };
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

// Re-transcribe button: re-runs transcription on the saved audio file.
// Prefers Deepgram REST when a key is configured (best quality for
// recordings that had a bad streaming connection). Falls back to local
// Whisper automatically — no key needed, always available.
$("retranscribeBtn").addEventListener("click", async () => {
  const btn = $("retranscribeBtn") as HTMLButtonElement;
  if (btn.disabled) return;
  const audioState = latestSavedAudioState;
  if (!audioState?.savedName) {
    $("finalOutput").textContent = "No saved audio to re-transcribe.";
    return;
  }
  // Capture the UI session token at the START of the retranscribe job.
  // If the user presses F9 mid-retranscribe, `activeUiSessionToken`
  // advances and all our DOM writes after that point must be gated by
  // `isCurrentUiSession(capturedToken)` — otherwise the stale retranscribe
  // clobbers the fresh live session's final output / upscale placeholder.
  //
  // If no live session has ever started, `activeUiSessionToken` is "" —
  // but `isCurrentUiSession("")` has a legacy short-circuit that returns
  // TRUE unconditionally (line ~457, treating empty as "no scope, always
  // current"). That short-circuit makes our gate INERT in the most common
  // retranscribe path (cold open → import recording → retranscribe → F9).
  // Generate a dedicated retranscribe token so the gate always evaluates
  // real equality and the fix actually prevents stale writes.
  const capturedToken = activeUiSessionToken || createClientSessionId();
  // Adopt the token as the current UI session for retranscribe's
  // duration. Without this, `isCurrentUiSession(capturedToken)` would
  // be false from the start (capturedToken vs the still-empty
  // `activeUiSessionToken`), and EVERY write during retranscribe would
  // be silently dropped. Adoption is idempotent — if a prior live
  // session already set `activeUiSessionToken`, this is a no-op; if
  // a new live session starts mid-retranscribe, it overwrites
  // `activeUiSessionToken` and our guard starts blocking stale writes
  // (which is exactly the data-loss case we care about).
  //
  // 1.1.25 fix: track whether WE adopted the token. The cleanup at
  // function end releases ours-only — never a token a real live
  // session put in place — so a phantom token doesn't survive after
  // re-transcribe and cause future deferred writes to incorrectly
  // pass `isCurrentUiSession` when no real session is active.
  const adoptedToken = !activeUiSessionToken;
  if (adoptedToken) activeUiSessionToken = capturedToken;
  btn.disabled = true;
  btn.classList.add("is-busy");
  // Visible-progress writer. The user reported the re-transcribe job
  // is invisible — the button's ``is-busy`` class is far from the eye
  // and finalOutput shows the OLD transcript (or whatever was there
  // before) until success or failure. Mirroring every state transition
  // into finalOutput is the simplest way to make the running job
  // unambiguous, AND it doubles as the "what stage are we in" hint
  // when the eventual error message is shown (the last status the
  // user saw is now the most recent provider that was tried).
  //
  // Every write through this helper goes through the same
  // ``isCurrentUiSession`` gate that ``$("finalOutput").textContent``
  // assignments below already use, so a fresh live session that
  // started DURING re-transcribe never gets stomped by a stale status.
  const setRetranscribeStatus = (text: string): void => {
    if (isCurrentUiSession(capturedToken)) {
      $("finalOutput").textContent = text;
    }
  };
  // Track which providers were actually attempted so the final error
  // message tells the user precisely what was tried — "switch to local
  // in Settings" was misleading when the code had already fallen
  // through to local under the hood and local ALSO failed. The hint
  // surface is rebuilt below from this list, not hardcoded.
  const triedProviders: string[] = [];
  // Lifted out of the inner ``try`` so the outer ``catch`` can include
  // the FIRST upstream error (typically the Deepgram failure) in the
  // user-visible error message. Previously the Deepgram error was
  // captured only inside the inner try, so by the time we reached the
  // outer catch the variable was out of scope and only the LAST
  // (local Whisper) error was displayed.
  let lastProviderError: unknown = null;
  try {
    setRetranscribeStatus("Preparing audio…");
    // ALWAYS fetch from the backend — never trust the in-memory blob.
    //
    // The previous "prefer in-memory ``audioState.file`` over backend
    // GET" optimization saved one loopback round-trip but had two
    // catastrophic failure modes that hit the user simultaneously:
    //
    //  1. ``audioState.file`` is the lazy OPFS-backed ``Blob([header,
    //     spool])`` from ``OpfsPcmSink.finalize()``. After
    //     ``deferredSinkDestroy.destroy()`` runs (right after the
    //     initial save completes, in stopLive's tail), the spool is
    //     gone and the Blob reads as zero bytes. The same lifecycle
    //     bug already broke playback on Windows and was fixed in
    //     ``renderLatestSavedAudio`` (line 601-605) by routing through
    //     the backend URL — Re-transcribe was missed.
    //  2. The construction also FORCED ``.wav`` extension and
    //     ``audio/wav`` MIME on a payload that is usually WebM-Opus
    //     for live recordings (see selectCanonicalCapturedAudio at
    //     line 1841: ``live-<ts>.webm``). That lie breaks Deepgram
    //     REST (Content-Type-driven container detection) and breaks
    //     local Whisper (ensure_wav_16k's ``.wav``-fast-path probes
    //     soundfile.info → fails → falls through to ffmpeg which
    //     sometimes succeeds via content-sniffing, sometimes raises
    //     a generic non-AudioError exception that the backend's
    //     ``except AudioError`` handler at main.py:2823 lets escape
    //     as HTTP 500). User-visible: BOTH providers fail on the
    //     same valid 1.3 MB / 41-second recording.
    //
    // ``fetchSavedAudioFromBackend`` derives BOTH the filename and
    // the MIME from the backend's response headers — the on-disk
    // file is the canonical source.
    const audioFile = await fetchSavedAudioFromBackend(audioState.savedName, audioState.archiveDir || "");
    const lang = (($("language") as HTMLSelectElement).value || "auto").trim();
    let text = "";
    let usedProvider: Provider = "local";

    // 1. Try Deepgram REST — higher accuracy than local Whisper for most
    //    languages. Only attempted when the user has a key configured.
    if (isProviderKeyConfigured("deepgram")) {
      const dgModel = getRemoteModelValue("deepgram") || "nova-3";
      triedProviders.push(`Deepgram ${dgModel}`);
      setRetranscribeStatus(`Re-transcribing via Deepgram (${dgModel})…`);
      try {
        const result = await remoteJobSync(audioFile, {
          provider: "deepgram",
          language: lang,
          diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
          openrouterModel: dgModel,
        });
        text = String(result.text || "").trim();
        usedProvider = "deepgram";
      } catch (deepgramErr) {
        // Network timeout, rate-limit, bad key — log and fall through to
        // local Whisper so the user still gets a usable transcript.
        lastProviderError = deepgramErr;
        console.warn("Re-transcribe: Deepgram REST failed, trying local Whisper:", deepgramErr);
      }
    }

    // 2. Local Whisper fallback — always available, no API key required.
    if (!text) {
      const model = ($("model") as HTMLSelectElement).value || "small";
      triedProviders.push(`local Whisper ${model}`);
      // Two-line message captures both the fallback context AND the
      // current step: the user sees Deepgram-failed reason without
      // losing the "we are still working" signal.
      const fallbackHint = lastProviderError
        ? `Deepgram failed — trying local Whisper (${model})…`
        : `Re-transcribing via local Whisper (${model})…`;
      setRetranscribeStatus(fallbackHint);
      const localResult = await transcribeCanonicalAudioLocally(audioFile, lang, model);
      text = localResult.text.trim();
      usedProvider = "local";
    }

    if (text) {
      // Session-gated writes: if the user started a new live recording
      // while we were transcribing, the new session owns `finalOutput`
      // and we must NOT overwrite it.
      if (isCurrentUiSession(capturedToken)) {
        $("finalOutput").textContent = text;
      }
      // Persist the new transcript over the previous save so the
      // Recordings view reflects the improved result. This is safe to
      // do regardless of session state — it's archive-side state, not
      // live UI state.
      try {
        await saveRecordingText({
          name: audioState.savedName,
          archiveDir: audioState.archiveDir || "",
          requireExisting: true,
          title: text.split(/\s+/).slice(0, 8).join(" "),
          sourceText: text,
          transcriptText: text,
          provider: usedProvider,
          model: usedProvider === "deepgram"
            ? getRemoteModelValue("deepgram")
            : (($("model") as HTMLSelectElement).value || "small"),
          language: lang,
        });
      } catch { }
      if (isCurrentUiSession(capturedToken)) {
        patchCurrentRecordingSummary({
          status: usedProvider === "deepgram"
            ? "Re-transcribed via Deepgram REST."
            : "Re-transcribed via local Whisper.",
          tone: "success",
        }, capturedToken);
      }
      // AI Upscale: if the user has upscale enabled, the re-transcript
      // should get the same rewrite treatment as a fresh live session.
      // Without this, re-transcribe produces a raw transcript that
      // visibly differs from what live recording produces for the same
      // audio — surprising inconsistency. `runUpscaleIfEnabled` is a
      // no-op when the toggle is off, and already session-guards its
      // own DOM writes via the placeholderNonce pattern.
      try {
        await runUpscaleIfEnabled(text, capturedToken);
      } catch (upscaleErr) {
        // runUpscaleIfEnabled handles its own UI error states;
        // swallow here so retranscribe's overall success status is
        // preserved for the user.
        console.warn("Re-transcribe: upscale step failed:", upscaleErr);
      }
    } else {
      if (isCurrentUiSession(capturedToken)) {
        const tried = triedProviders.length ? ` (tried: ${triedProviders.join(", ")})` : "";
        $("finalOutput").textContent = `Re-transcribe returned empty result${tried}.`;
      }
    }
  } catch (e) {
    if (isCurrentUiSession(capturedToken)) {
      // Build a precise error message that names what was tried.
      // The default ``explainNetworkError`` hint suggested "switch
      // Provider to local in Settings" — misleading here because the
      // code ALREADY fell through to local under the hood (and local
      // is what just failed). Append the tried-providers tail so the
      // user understands the local fallback ran and also failed; the
      // suggestion to "switch to local" is suppressed when local is
      // in the tried list.
      let msg = explainNetworkError(e, "Re-transcribe failed");
      if (triedProviders.some((p) => p.startsWith("local"))) {
        // Strip the "switch Provider to local" tail — local already
        // failed, so the suggestion is actively unhelpful.
        msg = msg.replace(/, or switch Provider to "local" in Settings\.?$/i, ".");
        msg = msg.replace(/ or switch Provider to "local" in Settings\.?$/i, ".");
      }
      const triedSuffix = triedProviders.length ? ` Tried: ${triedProviders.join(", ")}.` : "";
      // Surface the FIRST upstream error (typically the Deepgram
      // failure) when both providers were attempted. Previously the
      // Deepgram error was logged only via console.warn — invisible
      // to a packaged-build user — and the toast showed only the
      // local Whisper failure. With both errors visible, the user can
      // distinguish "Deepgram returned 401 → expected, local picked
      // it up but failed for unrelated reason" from "both failed for
      // the SAME reason (e.g., upload bytes corrupt)".
      let firstProviderTail = "";
      if (lastProviderError && triedProviders.length > 1) {
        const firstMsg = lastProviderError instanceof Error
          ? lastProviderError.message
          : String(lastProviderError || "");
        const firstShort = firstMsg.split("\n")[0].slice(0, 200).trim();
        if (firstShort) {
          firstProviderTail = ` First: ${firstShort}.`;
        }
      }
      $("finalOutput").textContent = `${msg}${triedSuffix}${firstProviderTail}`;
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-busy");
    // 1.1.25 fix: release the token only if WE adopted it AND no
    // real live session has taken over. This is the symmetric
    // counterpart of the adoption above; without it, the phantom
    // capturedToken kept ``activeUiSessionToken`` non-empty after
    // re-transcribe, and any deferred async write keyed on the
    // captured token would pass ``isCurrentUiSession(capturedToken)``
    // forever — silent data corruption hazard.
    if (adoptedToken && activeUiSessionToken === capturedToken) {
      activeUiSessionToken = "";
    }
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
    // Use Authorization header instead of ?token= query param: query
    // params are logged by uvicorn's access log at INFO level, which
    // leaks the API token into plaintext logs on every delete.
    const r = await fetch("/api/recordings", { method: "DELETE", headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { deleted?: unknown; failed?: unknown };
    setLatestSavedAudio(null);
    if (currentRecordingSummary?.savedName) {
      patchCurrentRecordingSummary({
        savedName: "",
        status: "Recording archive was cleared. Session summary is kept, but saved files were deleted.",
        tone: "warning",
      });
    }
    // Coerce to non-negative integer so a backend shape drift (`null`,
    // missing key, truncated JSON, middleware-injected body) renders
    // "Deleted 0 recording(s)" instead of "Deleted undefined...". Also
    // surface partial failures — the backend may skip files it cannot
    // unlink (permission-denied, file in use on Windows) and previously
    // the user was told "success" while N files silently survived.
    const deletedCount = Math.max(0, Number.isFinite(Number(data?.deleted)) ? Number(data.deleted) : 0);
    const failedCount = Math.max(0, Number.isFinite(Number(data?.failed)) ? Number(data.failed) : 0);
    const tone = failedCount > 0 ? "error" : "warning";
    const summary = failedCount > 0
      ? `Deleted ${deletedCount} recording(s) — ${failedCount} failed (see main.log).`
      : `Deleted ${deletedCount} recording(s).`;
    showRecordSessionNotice(summary, tone, 7000);
    $("recordingContent").textContent = summary;
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
// Running sum of squared per-frame RMS. Average RMS over a session is
// the square root of the mean of the SQUARED sample-level RMS — not the
// mean of the per-frame RMS (which systematically underestimates energy
// in dynamic audio and inflates false-silence classification).
let captureRmsSqAccum = 0;
let capturePeakMax = 0;
let capturePcmSampleCount = 0;
let captureLastActivePcmSample = 0;
let liveDraftText = "";
let liveDraftDisplayText = "";
let liveInterimText = "";
let liveTranscriptSegments: TranscriptSegment[] = [];
let liveRecordingSeq = 0;
let currentRecordingId = 0;
let stopTransitionInFlight = false;
let stopTransitionOwnerToken = "";
// Synchronous guard set at the top of startLive BEFORE any await.  This
// prevents a second startLive call from racing through the same
// `if (isBusy)` check while the first call is still awaiting the
// archive-ready promise.  Without this, two concurrent starts would
// allocate two PcmSinks / WebSockets / MediaRecorders and the second's
// globals would silently leak the first.
let startLiveInFlight = false;
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

interface LiveTranscriptBuffer {
  segments: TranscriptSegment[];
  committedText: string;
  committedDisplayText: string;
  interimText: string;
  interimSegment: TranscriptSegment | null;
  lastInterimText: string;
  lastInterimSegment: TranscriptSegment | null;
  committedDisplayCache: string;
  wsMode: LiveWsMode;
}

const liveFinalSlots = new Map<string, LiveFinalSlot>();
const liveTranscriptBuffers = new Map<string, LiveTranscriptBuffer>();
// Session-scoped live-stream error map. Was previously a single
// global ``let liveStreamError = ""``; that allowed an OLD session's
// error event (fired through a buffered ws.onmessage tick) to bleed
// into a fresh session's ``liveStreamErrorAtStop`` snapshot at
// stopLive time, causing the new session's fast-path to short-
// circuit on a phantom error from the previous recording. Keying
// on ``sessionUiToken`` makes each session's error scope-pure.
const liveStreamErrors = new Map<string, string>();
function getLiveStreamError(token: string): string {
  if (!token) return "";
  return liveStreamErrors.get(token) || "";
}
function setLiveStreamError(token: string, err: string): void {
  if (!token) return;
  if (err) liveStreamErrors.set(token, err);
  else liveStreamErrors.delete(token);
}

function createLiveTranscriptBuffer(wsMode: LiveWsMode): LiveTranscriptBuffer {
  return {
    segments: [],
    committedText: "",
    committedDisplayText: "",
    interimText: "",
    interimSegment: null,
    lastInterimText: "",
    lastInterimSegment: null,
    committedDisplayCache: "",
    wsMode,
  };
}

function getLiveTranscriptBuffer(token: string): LiveTranscriptBuffer | null {
  if (!token) return null;
  return liveTranscriptBuffers.get(token) || null;
}

function ensureLiveTranscriptBuffer(token: string, wsMode: LiveWsMode): LiveTranscriptBuffer {
  const existing = getLiveTranscriptBuffer(token);
  if (existing) return existing;
  const buffer = createLiveTranscriptBuffer(wsMode);
  liveTranscriptBuffers.set(token, buffer);
  return buffer;
}

function composeCanonicalLiveSourceText(
  committedRaw: string,
  currentInterimRaw: string,
  snapshotInterimRaw: string,
): string {
  const committed = normalizeTranscriptWhitespace(committedRaw);
  const currentInterim = normalizeTranscriptWhitespace(currentInterimRaw);
  const snapshotInterim = normalizeTranscriptWhitespace(snapshotInterimRaw);

  const pickRicher = (a: string, b: string): string => {
    const left = normalizeTranscriptWhitespace(a);
    const right = normalizeTranscriptWhitespace(b);
    if (!left) return right;
    if (!right) return left;
    const leftWords = countWords(left);
    const rightWords = countWords(right);
    if (rightWords > leftWords) return right;
    if (rightWords === leftWords && right.length > left.length) return right;
    return left;
  };

  const normalizeWords = (s: string): string[] =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const normalizeComparable = (s: string): string =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

  const mergeInterim = (baseRaw: string, interimRaw: string): string => {
    const base = normalizeTranscriptWhitespace(baseRaw);
    const interim = normalizeTranscriptWhitespace(interimRaw);
    if (!interim) return base;
    if (!base) return interim;
    if (base.endsWith(interim)) return base;
    const interimWords = normalizeWords(interim);
    if (interimWords.length === 0) return base;
    const baseComparable = normalizeComparable(base);
    const interimComparable = normalizeComparable(interim);
    if (interimComparable && baseComparable.includes(interimComparable)) {
      return base;
    }
    const lastBaseWords = base.split(/\s+/).slice(-Math.max(10, interimWords.length + 2)).join(" ");
    const lastBaseNorm = normalizeWords(lastBaseWords).join(" ");
    const interimNorm = interimWords.join(" ");
    if (lastBaseNorm.endsWith(interimNorm)) return base;

    // Interim hypotheses can overlap committed text with a shifted
    // boundary, e.g. committed="... сказал больше" and interim="больше
    // завершил". Merge the longest normalized suffix/prefix overlap so
    // the fast stop path keeps the tail without duplicating the overlap.
    const baseNormWords = normalizeWords(base);
    const interimRawWords = interim.split(/\s+/).filter(Boolean);
    const maxOverlap = Math.min(baseNormWords.length, interimWords.length);
    for (let n = maxOverlap; n > 0; n--) {
      const baseSuffix = baseNormWords.slice(-n).join(" ");
      const interimPrefix = interimWords.slice(0, n).join(" ");
      if (baseSuffix !== interimPrefix) continue;
      const remainder = interimRawWords.slice(n).join(" ").trim();
      return remainder ? `${base} ${remainder}` : base;
    }
    return `${base} ${interim}`;
  };

  const withSnapshot = mergeInterim(committed, snapshotInterim);
  const withCurrent = mergeInterim(committed, currentInterim);
  const snapshotThenCurrent = mergeInterim(withSnapshot, currentInterim);
  return [committed, withSnapshot, withCurrent, snapshotThenCurrent]
    .reduce((best, candidate) => pickRicher(best, candidate), "");
}

function canonicalTextFromBuffer(buffer: LiveTranscriptBuffer): string {
  return composeCanonicalLiveSourceText(
    buffer.committedText,
    buffer.interimText,
    buffer.lastInterimText,
  );
}

function getSessionCanonicalLiveSourceText(token: string): string {
  const buffer = getLiveTranscriptBuffer(token);
  return buffer ? canonicalTextFromBuffer(buffer) : getCanonicalLiveSourceText();
}

function appendSegmentsToBuffer(
  buffer: LiveTranscriptBuffer,
  rawSegments: unknown[],
): void {
  const nextSegments = Array.isArray(rawSegments)
    ? rawSegments
      .map((segment) => normalizeTranscriptSegment(segment))
      .filter((segment): segment is TranscriptSegment => !!segment)
    : [];
  if (!nextSegments.length) return;

  const prevLen = buffer.segments.length;
  const combined = buffer.segments.concat(nextSegments);
  const merged = mergeTranscriptSegments(combined);
  const appendOnly =
    merged.length === combined.length &&
    merged.length >= prevLen &&
    merged.slice(0, prevLen).every((seg, i) => seg === buffer.segments[i]);

  buffer.segments = merged;
  if (buffer.interimText) {
    buffer.lastInterimText = buffer.interimText;
  }
  if (buffer.interimSegment) {
    buffer.lastInterimSegment = buffer.interimSegment;
  }
  buffer.interimText = "";
  buffer.interimSegment = null;

  const separator = buffer.wsMode === "deepgram-stream" ? " " : "\n";
  const hasDiarization = buffer.segments.some((s) => s.speaker !== undefined);
  if (hasDiarization) {
    buffer.committedDisplayCache = formatSegmentsForDisplay(buffer.segments, separator);
  } else if (appendOnly) {
    let delta = "";
    for (let i = prevLen; i < merged.length; i++) {
      const t = merged[i].text;
      if (!t) continue;
      if (delta) delta += separator;
      delta += t;
    }
    if (delta) {
      buffer.committedDisplayCache = buffer.committedDisplayCache
        ? `${buffer.committedDisplayCache}${separator}${delta}`
        : delta;
    }
  } else {
    buffer.committedDisplayCache = merged
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(separator)
      .trim();
  }
  buffer.committedText = joinTranscriptSegments(buffer.segments);
  buffer.committedDisplayText = buffer.committedDisplayCache || buffer.committedText;
}

function maxSegmentEnd(segments: TranscriptSegment[]): number {
  return segments.reduce((max, seg) => (seg.end > max ? seg.end : max), 0);
}

function maxLiveBufferSpeechEnd(buffer: LiveTranscriptBuffer | null): number {
  if (!buffer) return 0;
  return Math.max(
    maxSegmentEnd(buffer.segments),
    buffer.interimSegment?.end || 0,
    buffer.lastInterimSegment?.end || 0,
  );
}

function textFromLiveFinalEnvelope(envelope: LiveFinalEnvelope | null | undefined): string {
  if (!envelope) return "";
  const text = normalizeTranscriptWhitespace(envelope.text || "");
  const segmentsText = joinTranscriptSegments(envelope.segments || []);
  return countWords(text) >= countWords(segmentsText) ? text : segmentsText;
}

function richerTranscript(currentText: string, candidateText: string): string {
  const current = normalizeTranscriptWhitespace(currentText);
  const candidate = normalizeTranscriptWhitespace(candidateText);
  if (!candidate) return current;
  if (!current) return candidate;
  const currentWords = countWords(current);
  const candidateWords = countWords(candidate);
  if (candidateWords > currentWords) return candidate;
  if (candidateWords === currentWords && candidate.length > current.length) {
    const normalizeComparable = (s: string): string =>
      s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    const currentNorm = normalizeComparable(current);
    const candidateNorm = normalizeComparable(candidate);
    if (candidateNorm.startsWith(currentNorm) || candidateNorm.endsWith(currentNorm)) {
      return candidate;
    }
  }
  return current;
}

function candidateConfirmsTranscriptCoverage(currentText: string, candidateText: string): boolean {
  const current = normalizeTranscriptWhitespace(currentText);
  const candidate = normalizeTranscriptWhitespace(candidateText);
  if (!current || !candidate) return false;
  const currentWords = countWords(current);
  const candidateWords = countWords(candidate);
  if (currentWords <= 0 || candidateWords <= 0) return false;
  if (candidateWords >= currentWords) return true;
  if (candidateWords < Math.max(1, Math.floor(currentWords * 0.9))) return false;

  const normalizeWords = (s: string): string[] =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const currentSet = new Set(normalizeWords(current));
  const candidateNormWords = normalizeWords(candidate);
  if (!candidateNormWords.length) return false;
  const overlap = candidateNormWords.filter((word) => currentSet.has(word)).length;
  return overlap / candidateNormWords.length >= 0.85;
}

function hasStreamingActivity(buffer: LiveTranscriptBuffer | null): boolean {
  if (!buffer) return false;
  return (
    buffer.segments.length > 0 ||
    !!buffer.committedText.trim() ||
    !!buffer.interimText.trim() ||
    !!buffer.lastInterimText.trim()
  );
}

function projectLiveTranscriptBufferToActiveState(buffer: LiveTranscriptBuffer): void {
  liveTranscriptSegments = buffer.segments;
  liveInterimText = buffer.interimText;
  lastInterimSnapshot = buffer.lastInterimText;
  liveCommittedDisplayCache = buffer.committedDisplayCache;
  setLiveDraftState(buffer.committedText, buffer.committedDisplayText);
}

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
  // Drop only stale slots that have no waiters. A previous stopLive may
  // still be awaiting its final envelope while a new recording starts;
  // forcing those waiters to null here breaks recording/transcription
  // parallelism and discards the post-CloseStream tail.
  const activeToken = activeUiSessionToken || "";
  for (const [token, slot] of liveFinalSlots) {
    if (token === activeToken) continue;
    if (slot.waiters.length === 0) liveFinalSlots.delete(token);
  }
  // Session-scoped error map: drop entries for stale sessions only.
  // The active session's error (if any) is preserved so that a tail-
  // running stopLive can still see it.
  for (const token of [...liveStreamErrors.keys()]) {
    if (token !== activeToken && !liveFinalSlots.has(token)) liveStreamErrors.delete(token);
  }
  for (const token of [...liveTranscriptBuffers.keys()]) {
    if (token !== activeToken && !liveFinalSlots.has(token)) {
      liveTranscriptBuffers.delete(token);
    }
  }
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
 * All callers go through ``publishRecordingFinalSignal`` (which passes a
 * session token) or ``publishRecordingOutput`` directly. One call = one
 * atomic update of both channels plus the DOM.
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
  const uiFinalText = domText;
  const hasUiFinal = !!kind && !!uiFinalText;

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
  window.__transcriptorLastUiFinalText = hasUiFinal ? uiFinalText : "";
  window.__transcriptorLastUiFinalAt = hasUiFinal ? now : 0;
  window.__transcriptorLastUiFinalRecordingId = hasUiFinal ? rid : 0;
  window.__transcriptorLastUiFinalKind = hasUiFinal ? kind : "";

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

/**
 * Active live-preview projection cache.
 *
 * The authoritative committed/interim state lives in LiveTranscriptBuffer
 * per session. These globals are only the currently active UI projection,
 * kept for the existing renderer/overlay read paths.
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
// and updated when committed segments are projected from that session's
// LiveTranscriptBuffer into the active preview state.
let lastInterimSnapshot = "";

function resetOutputs(): void {
  resetRecordSessionNotice();
  setCurrentRecordingSummary(null);
  resetLiveDraftState();
  publishRecordingOutput({ recordingId: 0, pasteText: "", domText: "", kind: "" });
  $("upscaleOutput").textContent = "";
  // Reset the placeholder-ownership nonce so any still-in-flight
  // upscale from a prior session sees "not my placeholder anymore"
  // and declines to clobber the freshly-cleared DOM.
  ($("upscaleOutput") as HTMLElement).dataset.upscaleNonce = "";
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
const CAPTURE_TAIL_ACTIVITY_RMS = 0.003;
const CAPTURE_TAIL_ACTIVITY_PEAK = 0.045;

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
  captureRmsSqAccum += rms * rms;
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
  const frameStartSample = capturePcmSampleCount;
  capturePcmSampleCount += ds.length;
  if (rms >= CAPTURE_TAIL_ACTIVITY_RMS || peak >= CAPTURE_TAIL_ACTIVITY_PEAK) {
    captureLastActivePcmSample = frameStartSample + ds.length;
  }

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
    // Math.round: setInt16 truncates toward zero on a raw float
    // multiply, producing a ~0.5 LSB systematic negative bias on
    // positive samples. Must match encodeWav and floatSamplesToInt16LE
    // so the live-WS PCM stream and the canonical WAV written at
    // stop contain bit-identical samples for the same input.
    dv.setInt16(i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
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
    // Buffer up to 4 seconds of audio (500 frames × 128 samples/frame
    // at 16 kHz after downsampling = 64 000 samples). Beyond that the
    // WS is likely stuck and we should not accumulate indefinitely.
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
  // Single-flight guard. isBusy is only set AFTER the first await below
  // (ensureRecordingsArchiveReady), which means two concurrent startLive
  // calls — e.g. rapid hotkey double-press, hotkey + button click — could
  // both pass the isBusy check and race to allocate two PcmSinks, two
  // WebSockets, and two MediaRecorders. The second start would overwrite
  // the first pcmSink without destroying it, leaking the OPFS file handle
  // and leaving the old sink orphaned in the OPFS quota.
  // Set the in-flight flag synchronously BEFORE any await.
  if (isBusy || stopTransitionInFlight || startLiveInFlight) return;
  startLiveInFlight = true;
  try {
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
  captureRmsSqAccum = 0;
  capturePeakMax = 0;
  capturePcmSampleCount = 0;
  captureLastActivePcmSample = 0;
  captureRmsEma = 0;
  lastInterimSnapshot = "";
  wsPendingFrames = [];
  resetLiveDraftState();
  clearLiveStreamState();
  liveWsMode = resolveLiveWsMode(activeLiveSessionSnapshot);
  const sessionWsMode = liveWsMode;
  liveTranscriptBuffers.set(sessionUiToken, createLiveTranscriptBuffer(sessionWsMode));
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
    provider: sessionWsMode === "deepgram-stream" ? "deepgram" : "local",
    language: activeLiveSessionSnapshot.language,
    session_id: activeLiveSessionId,
    archive_dir: activeLiveArchiveDir,
    token: apiToken(),
    diarize: (($("diarizeCheck") as HTMLInputElement).checked ? "true" : "false"),
  });
  if (sessionWsMode === "deepgram-stream") {
    wsQuery.set("model", activeLiveSessionSnapshot.model || getRemoteModelValue("deepgram"));
  } else {
    wsQuery.set("model", activeLiveSessionSnapshot.assistLocalModel);
  }
  ws = new WebSocket(wsBase() + "/ws/transcribe?" + wsQuery.toString());
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    const statusMsg =
      sessionWsMode === "deepgram-stream"
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
    console.log(`[trace ws-close] code=${ev.code} reason="${ev.reason || ""}" wasClean=${ev.wasClean} hadEnvelope=${!!slot.envelope} waiters=${slot.waiters.length}`);
    if (ev.wasClean && (ev.code === 1000 || ev.code === 1005)) return;
    console.warn(`live ws unexpectedly closed (code=${ev.code}, reason=${ev.reason || "?"})`);
    resolveLiveFinal(sessionUiToken, {
      text: "",
      segments: [],
      durationSec: 0,
      source: sessionWsMode,
      error: `live stream closed unexpectedly (code=${ev.code})`,
    });
  };
  ws.onmessage = (ev: MessageEvent<string>) => {
    const msg = parseLiveWsMessage(ev.data);
    if (!msg) return;
    const isActiveSession = activeUiSessionToken === sessionUiToken;
    const sessionBuffer = ensureLiveTranscriptBuffer(sessionUiToken, sessionWsMode);
    switch (msg.type) {
      case "error": {
        setLiveStreamError(sessionUiToken, msg.error);
        console.warn(`live ws error event (fatal=${msg.fatal}):`, msg.error);
        // Only surface truly fatal errors to the user. Non-fatal
        // stream drops (when we already have committed segments) are
        // logged to the console but invisible in the pill — the
        // recording keeps going, just not streaming to Deepgram
        // anymore. stopLive picks up the committed text as the
        // transcript so the user experience is seamless.
        if (isActiveSession && msg.fatal) {
          patchCurrentRecordingSummary(
            {
              status: `Live stream error: ${explainNetworkError(new Error(msg.error))}`,
              tone: "error",
            },
            sessionUiToken
          );
          // DO NOT pipe the error message through setLiveInterimText:
          // that path feeds into `sourceLiveText` at stopLive time,
          // which then becomes the saved transcript + the clipboard-
          // paste content. A user in a region that blocks Deepgram
          // would otherwise see a raw "[Deepgram connect failed: did
          // not receive a valid HTTP response]" pasted into Slack /
          // Telegram / wherever. The status pill carries the error;
          // transcript stays empty so the paste code path treats it
          // as "nothing to paste".
        }
        return;
      }
      case "segments": {
        const lastNew = msg.segments.length > 0 ? msg.segments[msg.segments.length - 1] : null;
        console.log(`[trace ws-segments] session=${sessionUiToken.slice(0, 8)} active=${isActiveSession} count=${msg.segments.length} ${lastNew ? `lastEnd=${lastNew.end.toFixed(2)} lastText="${lastNew.text.slice(-50)}"` : "(empty)"}`);
        appendSegmentsToBuffer(sessionBuffer, msg.segments);
        if (isActiveSession) {
          projectLiveTranscriptBufferToActiveState(sessionBuffer);
          if (liveDraftText) {
            persistLiveDraft(true);
          }
        }
        return;
      }
      case "interim": {
        sessionBuffer.interimText = normalizeTranscriptWhitespace(msg.segment.text);
        sessionBuffer.interimSegment = msg.segment;
        if (isActiveSession) {
          projectLiveTranscriptBufferToActiveState(sessionBuffer);
        }
        return;
      }
      case "final": {
        const lastSeg = msg.segments.length > 0 ? msg.segments[msg.segments.length - 1] : null;
        console.log(`[trace ws-final] session=${sessionUiToken.slice(0, 8)} active=${isActiveSession} textLen=${msg.text.length} segCount=${msg.segments.length} ${lastSeg ? `lastEnd=${lastSeg.end.toFixed(2)} lastText="${lastSeg.text.slice(-50)}"` : "(empty)"} durationSec=${msg.durationSec.toFixed(2)} error="${msg.error || ""}"`);
        appendSegmentsToBuffer(sessionBuffer, msg.segments);
        if (isActiveSession) {
          projectLiveTranscriptBufferToActiveState(sessionBuffer);
        }
        const envelope: LiveFinalEnvelope = {
          text: normalizeTranscriptWhitespace(msg.text),
          segments: msg.segments,
          durationSec: msg.durationSec,
          source: msg.source || sessionWsMode,
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
      let webmTruncationWarned = false;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedWebmChunks.push(e.data);
          if (recordedWebmChunks.length > WEBM_WINDOW_CHUNKS) {
            recordedWebmChunks.splice(0, recordedWebmChunks.length - WEBM_WINDOW_CHUNKS);
            if (!webmTruncationWarned) {
              webmTruncationWarned = true;
              // Surface ONCE per session — subsequent truncations are
              // expected and don't need to spam the user. PCM canonical
              // audio (the OPFS spool) is unaffected; only the WebM
              // fallback container is rolling-windowed.
              showRecordSessionNotice(
                "Recording exceeds 2 hours — the WebM fallback keeps only the last 2 h. Canonical PCM audio is unaffected.",
                "warning",
                9000
              );
            }
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
  } finally {
    startLiveInFlight = false;
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
  const stopTransitionToken = createClientSessionId();
  stopTransitionInFlight = true;
  stopTransitionOwnerToken = stopTransitionToken;
  // ``_wsToCloseAtEnd`` is hoisted to function scope so the outer
  // ``finally`` block can close the WS AFTER the entire transcribe
  // phase finishes (envelope wait, recovery race, save). The
  // teardown chain in the inner try-block assigns this variable
  // instead of calling ws.close() inline, which would race the
  // backend's post-CloseStream is_final emission and truncate the
  // tail.
  let _wsToCloseAtEnd: WebSocket | null = null;
  let stopTransitionReleased = false;
  let stoppedRecordingId = 0;
  let stoppedSessionToken = "";
  // Wrap the entire body in try/finally so the in-flight guard is ALWAYS
  // cleared, even if a pre-main-try await (flushWorkletPort / waitForWorklet
  // Drain / stopMediaRecorderAndFlush / pcmSink.finalize / selectCanonical
  // CapturedAudio) throws an uncaught exception before reaching the
  // existing try at the "Assemble the authoritative transcript" block.
  // Without this wrapper, any such throw would leave stopTransitionInFlight
  // = true forever, permanently blocking all future stopLive calls.
  try {
  const recordingId = currentRecordingId;
  stoppedRecordingId = recordingId;
  const liveSessionId = activeLiveSessionId;
  const sessionUiToken = liveSessionId;
  stoppedSessionToken = sessionUiToken;
  const disableStopButtonForSession = (): void => {
    if (!isCurrentUiSession(sessionUiToken)) return;
    const stopBtn = document.getElementById("btnStop") as HTMLButtonElement | null;
    if (stopBtn) stopBtn.disabled = true;
  };
  const releaseStopTransitionForNextRecording = (): void => {
    if (stopTransitionReleased) return;
    stopTransitionReleased = true;
    if (stopTransitionOwnerToken === stopTransitionToken) {
      stopTransitionInFlight = false;
      stopTransitionOwnerToken = "";
    }
    setBusy(false, sessionUiToken);
    disableStopButtonForSession();
  };
  const recordedMs = startAt > 0 ? Math.max(0, Date.now() - startAt) : 0;
  const recordedSec = recordedMs / 1000;
  // ── transcription-latency timer ───────────────────────────────────
  //
  // Captured at the TOP of stopLive — i.e. the moment after the user
  // pressed Stop / hotkey-toggle. This is the user-perceived
  // "transcription latency" surface in the Settings → Recordings
  // metric pane. Previously this timestamp was set far below (around
  // line 7122, inside the post-pipeline branch) AFTER the full stop
  // sequence had already run: stream.getTracks().stop, worklet drain,
  // MediaRecorder flush, OPFS finalize, ws.send(finalize),
  // waitForLiveFinalEnvelope Promise creation. On the FAST PATH where
  // streaming had already produced a full transcript, the only awaits
  // between that timestamp and the latency computation were
  // saveRecordingText (loopback, ms) — yielding metrics like
  // "TRANSCRIBE 3 ms" that meant "we did basically nothing here"
  // instead of the ~real round-trip (which is hundreds of ms to
  // multiple seconds depending on path).
  //
  // Moving the start to the top of stopLive fixes the metric for ALL
  // exit paths — fast (instant transcript), slow (envelope wait),
  // recovery (Deepgram REST fallback), local (Whisper full-audio
  // pass), and every short-circuit return below.
  const transcribeStartedAt = performance.now();
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
  const sourceLiveText = getSessionCanonicalLiveSourceText(sessionUiToken);
  // The stop entry snapshot is intentionally not the SSOT: final/interim
  // events can still arrive while the socket drains and the audio is saved.
  let latestSourceLiveText = sourceLiveText;
  const latestSourceForSave = (): string => {
    const refreshed = getSessionCanonicalLiveSourceText(sessionUiToken);
    if (refreshed) {
      latestSourceLiveText = refreshed;
    }
    return latestSourceLiveText;
  };
  const latestSourceTitle = (): string => _smartTitle(latestSourceForSave());
  const captureSilenceSnapshot = (liveText: string): {
    hardSilence: boolean;
    likelySilenceWithoutPreview: boolean;
    silentCapture: boolean;
  } => {
    // True session-level RMS is sqrt(mean of per-frame squared RMS),
    // not mean of per-frame RMS. Compute this only at decision time:
    // stopLive drains the worklet after entry, so an early snapshot can
    // miss the final frames and misclassify a short spoken clip as silence.
    const avgCaptureRms = captureFrameCount > 0
      ? Math.sqrt(captureRmsSqAccum / captureFrameCount)
      : 0;
    const noLiveText = !String(liveText || "").trim();
    const hardSilence = avgCaptureRms < 0.0009 && capturePeakMax < 0.012;
    const likelySilenceWithoutPreview = noLiveText && avgCaptureRms < 0.003 && capturePeakMax < 0.045;
    const tooShortToTrust = recordedSec < 1.25;
    return {
      hardSilence,
      likelySilenceWithoutPreview,
      silentCapture:
        (tooShortToTrust && hardSilence) ||
        (tooShortToTrust && likelySilenceWithoutPreview),
    };
  };
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
  const stopEntryBuffer = getLiveTranscriptBuffer(sessionUiToken);
  console.log(`[trace stopLive] enter recordedSec=${recordedSec.toFixed(2)} sessionToken=${sessionUiToken.slice(0, 8)} provider=${provider} wsState=${ws ? ws.readyState : "null"} wsPendingFrames=${wsPendingFrames.length} segmentCount=${stopEntryBuffer?.segments.length ?? liveTranscriptSegments.length} liveDraftLen=${stopEntryBuffer?.committedText.length ?? liveDraftText.length} liveInterimLen=${stopEntryBuffer?.interimText.length ?? liveInterimText.length} lastInterimSnapshotLen=${stopEntryBuffer?.lastInterimText.length ?? lastInterimSnapshot.length}`);
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.debug("MediaStream stop failed (non-fatal)", e);
  }
  mark("stream.getTracks.stop");

  const t0Drain = performance.now();
  await flushWorkletPort();
  mark("flushWorkletPort");
  const flushDur = performance.now() - t0Drain;
  await waitForWorkletDrain();
  mark("waitForWorkletDrain");
  const drainDur = performance.now() - t0Drain - flushDur;
  await stopMediaRecorderAndFlush();
  mark("stopMediaRecorderAndFlush");
  const recorderDur = performance.now() - t0Drain - flushDur - drainDur;
  console.log(`[trace stopLive] drained flush=${flushDur.toFixed(0)}ms drain=${drainDur.toFixed(0)}ms recorder=${recorderDur.toFixed(0)}ms wsPendingFrames=${wsPendingFrames.length} segmentCount=${getLiveTranscriptBuffer(sessionUiToken)?.segments.length ?? liveTranscriptSegments.length}`);

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
  const liveStreamErrorAtStop = getLiveStreamError(sessionUiToken);

  let liveFinalPromise: Promise<LiveFinalEnvelope | null> | null = null;
  if (ws) {
    // 4000 ms budget for the full round-trip after CloseStream.
    // Covers the 700 ms endpointing threshold + Deepgram's server-
    // side finalize (~500–1500 ms) + network RTT + backend forward.
    //
    // Bumped 2000 → 4000 ms (1.1.13) after user reports of TAIL
    // TRUNCATION on slow / cross-region networks (RU → us-east
    // Deepgram). With 2000 ms, a 500 ms-pause-at-end + 700 ms
    // endpointing + 1500 ms server-finalize + 600 ms RTT = 3300 ms
    // round-trip that BARELY beat the timeout — the very last
    // utterance landed AFTER the deadline and was dropped. The
    // visible symptom: the user's last words missing from the
    // committed transcript and from the auto-paste output.
    //
    // The FAST PATH in the Deepgram branch below still short-
    // circuits this ceiling when committed segments already cover
    // the recording tail, so the new ceiling only matters on the
    // genuinely-slow path it was always there for.
    const finalizeWaitMs = 4000;
    liveFinalPromise = waitForLiveFinalEnvelope(sessionUiToken, finalizeWaitMs);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "finalize" }));
        console.log(`[trace stopLive] finalize sent to ws (state=OPEN, pendingFrames=${wsPendingFrames.length})`);
      } catch (e) {
        console.warn(`[trace stopLive] finalize send threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log(`[trace stopLive] finalize NOT sent — ws.readyState=${ws.readyState} (0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED)`);
    }
  } else {
    console.log(`[trace stopLive] no ws — finalize skipped`);
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
  // ── 1.1.22: defer ws.close until envelope arrived ──
  //
  // The previous version closed the WebSocket and nulled its
  // handlers HERE in the teardown chain — i.e. only ~10 ms after
  // ``ws.send({type: "finalize"})`` was issued just above. That
  // race truncates the entire post-stop tail:
  //
  //   1. Frontend: send finalize → close WS in 10 ms.
  //   2. Backend's ``ws-dg-rx`` task receives finalize, drains
  //      250 ms, then calls ``session.finalize()`` which sends
  //      ``Finalize`` and ``CloseStream`` to Deepgram.
  //   3. Deepgram processes the trailing audio, emits the post-
  ///     CloseStream is_final at ~T+800 ms (timestamp 11:43:11.888
  //      in the user's main.log).
  //   4. Backend's forwarder task tries to send that segment to
  //      the frontend WS — but the WS was closed at step 1, the
  //      send fails silently. Same fate for the final envelope.
  //
  // Net result: the trailing is_final ``"восемь, девять, десять"``
  // existed at the backend (proven by the 1.1.21 log line
  // ``finalize EXIT … segments_final=9 (delta from ENTER)``) but
  // never reached the frontend. ``getCanonicalLiveSourceText``
  // committed text stopped at ``"семь"`` and recovery had to do
  // the work — costing ~3 s and sometimes producing a worse
  // result.
  //
  // Fix: just hold the reference. The WS stays open through the
  // transcribe-phase await chain (envelope wait, recovery race),
  // ``ws.onmessage`` continues to deliver post-CloseStream
  // segments and the final envelope, and the WS is closed once
  // at the very end of stopLive (outer finally). Nulling the
  // socket-level handlers happens at that same final close so
  // we still prevent leaked closures.
  _wsToCloseAtEnd = ws;
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
  // currentRecordingId / window.__transcriptorCurrentRecordingId are also
  // cleared in the outer finally below so they are guaranteed to reset on
  // every exit path — including uncaught throws before this point.
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
  releaseStopTransitionForNextRecording();

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
          sourceText: latestSourceForSave(),
          transcriptText: "",
          provider: providerValue || "local",
          model: modelValue,
          language: languageValue,
          audioFile: savedAudioFile,
          liveSessionId: liveSessionId,
          refreshList: false,
        });
        persistedRecordingName = persisted.name;
        persistedRecordingArchiveDir = persisted.archiveDir;
        setCurrentRecordingAudio(savedAudioFile, persistedRecordingName, persistedRecordingArchiveDir, sessionUiToken);
        // 1.1.25: best-effort recovery discard. The save above ALREADY
        // succeeded; a 5xx from /api/live-recovery/discard does not
        // invalidate the persisted recording. Previous code let that
        // exception escape into the outer ``catch (e)`` at the bottom
        // of the for-loop, which then reported the recording as a save
        // failure and left the live-recovery snapshot for the next
        // boot to "recover" — producing a duplicate of a recording
        // that was already saved correctly.
        try {
          await discardLiveRecovery(liveSessionId);
        } catch (e) {
          console.warn("discardLiveRecovery failed (non-fatal); recovery will be re-promoted on next start", e);
        }
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
          // Both attempts failed — truly broken. Surface the ACTUAL
          // backend error message instead of a generic "check folder
          // permissions" hint that masks the real cause. The previous
          // text said the same thing for a Windows path-too-long, an
          // antivirus block, a 413 oversize, a 5xx backend crash, or a
          // genuine permission denial — all five looked identical to
          // the user. Now we name the underlying error verbatim and
          // append the permission hint as a fallback when the message
          // is empty (rare; only fires on `String(e)` of a bare object).
          const detail = errMsg.trim()
            || "unknown error — check the Recordings folder permissions";
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: `Audio capture finished, but save failed: ${detail}`,
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
    clearLiveDraft(sessionUiToken);
    setBusy(false, sessionUiToken);
    disableStopButtonForSession();
    setStatusScoped(sessionUiToken, "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: startupAbortReason,
      tone: "error",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    return;
  }

  const drainedSourceLiveText = latestSourceForSave();
  const drainedSilence = captureSilenceSnapshot(drainedSourceLiveText);
  if (drainedSilence.silentCapture) {
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
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
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
    clearLiveDraft(sessionUiToken);
    setBusy(false, sessionUiToken);
    disableStopButtonForSession();
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: "Silence detected. Audio remains available for review.",
      tone: "success",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
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
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
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
    clearLiveDraft(sessionUiToken);
    setBusy(false, sessionUiToken);
    disableStopButtonForSession();
    setStatusScoped(sessionUiToken, skippedBySetting ? "Idle" : "Error");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: skippedBySetting
        ? "Audio saved. Final transcription was skipped for this session."
        : "Audio saved, but the canonical transcription input is unavailable for this session.",
      tone: skippedBySetting ? "success" : "warning",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
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
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
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
    clearLiveDraft(sessionUiToken);
    setBusy(false, sessionUiToken);
    disableStopButtonForSession();
    setStatusScoped(sessionUiToken, "Idle");
    patchCurrentRecordingSummary({
      title: provisionalTitle,
      status: "Audio saved. No transcription provider is selected.",
      tone: "warning",
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
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
      transcribeLatencyMs: performance.now() - transcribeStartedAt,
    }, sessionUiToken);
    try {
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
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
          transcribeLatencyMs: performance.now() - transcribeStartedAt,
        }, sessionUiToken);
      }
    }
    clearLiveDraft(sessionUiToken);
    setBusy(false, sessionUiToken);
    disableStopButtonForSession();
    return;
  }
  // (transcribeStartedAt is captured at the top of stopLive — line ~6510)
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
    // ── Recovery-audio resolver ────────────────────────────────────
    //
    // Single source of truth for the audio bytes used by EVERY post-
    // stop recovery path (final-local-pass, REST recovery, empty-
    // result fallback, suspiciously-short re-transcribe).
    //
    // PREFERS the backend re-fetch over the in-memory ``transcribe
    // InputFile``. The in-memory file is the lazy ``Blob([header,
    // OPFS-spool])`` from ``OpfsPcmSink.finalize()``; once
    // ``deferredSinkDestroy.destroy()`` runs (which already happened
    // earlier in this function, around line 6754), the spool is gone
    // and the lazy blob reads as zero bytes — uploads succeed with a
    // 200 status but the backend gets an empty payload, ffmpeg
    // raises "invalid data", and BOTH provider paths fail
    // simultaneously. This is the same OPFS-dangling lifecycle bug
    // that broke playback on Windows (commit e2a39c8) and that the
    // 1.1.13 empty-fallback inadvertently re-introduced for the
    // upload path.
    //
    // The backend re-fetch hits ``/api/recordings/<name>/audio`` —
    // a loopback FileResponse over the durable on-disk file. It
    // returns honest ``Content-Type`` + ``Content-Disposition``
    // headers so we never lie about the container.
    //
    // Falls through to the in-memory file ONLY when the recording
    // was never persisted (extremely rare — stopLive's two-attempt
    // save with default-dir fallback covers nearly every failure).
    const fetchRecoveryAudioFile = async (): Promise<File | null> => {
      if (persistedRecordingName) {
        try {
          return await fetchSavedAudioFromBackend(
            persistedRecordingName,
            persistedRecordingArchiveDir,
          );
        } catch (e) {
          console.warn("Recovery audio backend fetch failed; trying in-memory file", e);
        }
      }
      return transcribeInputFile;
    };
    const runLocalFinalPass = async (): Promise<LocalTranscriptionResult> => {
      const audioFile = await fetchRecoveryAudioFile();
      if (!audioFile) {
        throw new Error("Canonical audio file is unavailable for final local transcription.");
      }
      return transcribeCanonicalAudioLocally(audioFile, languageValue, liveSnapshot.finalLocalModel);
    };
    // Unified empty-transcript recovery: tries Deepgram REST
    // (when a key is configured) THEN local Whisper, in that order,
    // against the durably-stored audio. Returns "" when nothing
    // recovered. All progress UI writes are session-gated so a
    // fresh recording started during recovery doesn't get clobbered.
    //
    // Replaces three previously-divergent fallback paths that each
    // did a different subset of the chain:
    //   - liveStreamErrorAtStop fast path: cached only, NO REST
    //     recovery (worst-case: lower-quality cache wins over the
    //     full Deepgram REST result).
    //   - envelope-error branch: REST → local. The reference impl.
    //   - 1.1.13 bottom safety net: local only, NO REST (worse than
    //     manual Re-transcribe which the user clearly preferred).
    // Centralizing them ensures every path tries the highest-
    // quality available transcription before giving up.
    // Deepgram REST against an already-saved recording — skips the
    // ``GET /api/recordings/<name>/audio`` + ``POST /api/remote/
    // transcribe-sync`` round-trip by hitting the in-place
    // ``transcribe-on-disk`` endpoint added in 1.1.18. Saves
    // 500 ms-1 s of loopback overhead on every recovery call when
    // the recording was successfully persisted (the common case).
    const deepgramRestOnDisk = async (): Promise<string | null> => {
      if (!persistedRecordingName) return null;
      const params = new URLSearchParams({ token: apiToken() });
      const url = `/api/recordings/${encodeURIComponent(persistedRecordingName)}/transcribe-on-disk?${params.toString()}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "deepgram",
          language: languageValue,
          diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
          openrouter_model: getRemoteModelValue("deepgram"),
          archive_dir: persistedRecordingArchiveDir || "",
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
      }
      const data = await resp.json();
      return String(data?.result?.text || "").trim();
    };
    // Hard time-bound on recovery so a stalled provider doesn't
    // block the entire stopLive flow indefinitely. 20 s is generous
    // for the typical chain (on-disk REST 1-2 s + local Whisper
    // fallback 5-15 s on a 30 s recording) and still bounds the
    // user-visible "stop button is hung" experience.
    const RECOVERY_HARD_TIMEOUT_MS = 20000;
    const recoverFromEmptyTranscriptInner = async (reason: string): Promise<string> => {
      console.log(`[trace recover] enter reason="${reason}" persistedRecordingName="${persistedRecordingName}" hasInMemoryFile=${!!transcribeInputFile}`);
      if (isProviderKeyConfigured("deepgram")) {
        if (isCurrentUiSession(sessionUiToken)) {
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: `${reason} Recovering via Deepgram REST.`,
            tone: "warning",
          }, sessionUiToken);
        }
        const tDg = performance.now();
        // FAST PATH: backend transcribes the on-disk file directly
        // (no upload). Falls through to upload-based path only when
        // the recording wasn't persisted (extremely rare — stopLive's
        // two-attempt save handles every common failure).
        try {
          const onDisk = await deepgramRestOnDisk();
          if (onDisk !== null) {
            console.log(`[trace recover] deepgram REST on-disk durMs=${(performance.now() - tDg).toFixed(0)} textLen=${onDisk.length} wordCount=${onDisk.split(/\s+/).filter(Boolean).length}`);
            if (onDisk) return onDisk;
          } else {
            console.log(`[trace recover] no persistedRecordingName — falling back to upload-based REST`);
          }
        } catch (e) {
          console.log(`[trace recover] deepgram REST on-disk FAIL durMs=${(performance.now() - tDg).toFixed(0)} err="${e instanceof Error ? e.message : String(e)}" — falling back to upload-based REST`);
        }
        // SLOW PATH (kept as fallback when on-disk endpoint is
        // unavailable, e.g., older backend, or when the recording
        // wasn't persisted): fetch audio + upload via FormData.
        const audioFile = await fetchRecoveryAudioFile();
        if (audioFile) {
          const tDg2 = performance.now();
          try {
            const result = await remoteJobSync(audioFile, {
              provider: "deepgram",
              language: languageValue,
              diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
              openrouterModel: getRemoteModelValue("deepgram"),
            });
            const text = String(result.text || "").trim();
            console.log(`[trace recover] deepgram REST upload durMs=${(performance.now() - tDg2).toFixed(0)} textLen=${text.length} wordCount=${text.split(/\s+/).filter(Boolean).length}`);
            if (text) return text;
          } catch (e) {
            console.log(`[trace recover] deepgram REST upload FAIL durMs=${(performance.now() - tDg2).toFixed(0)} err="${e instanceof Error ? e.message : String(e)}"`);
          }
        }
      } else {
        console.log(`[trace recover] deepgram skipped — no API key configured`);
      }
      // Local Whisper — last resort. Always uses the in-memory /
      // backend-fetched file path (no in-place equivalent because
      // local pass already runs server-side and there's no upload
      // boundary worth saving).
      const audioFile = await fetchRecoveryAudioFile();
      if (!audioFile) {
        console.log(`[trace recover] no audio file for local whisper — abort`);
        return "";
      }
      if (isCurrentUiSession(sessionUiToken)) {
        patchCurrentRecordingSummary({
          title: provisionalTitle,
          status: `${reason} Recovering via local Whisper.`,
          tone: "warning",
        }, sessionUiToken);
      }
      const tLocal = performance.now();
      try {
        const local = await transcribeCanonicalAudioLocally(
          audioFile,
          languageValue,
          liveSnapshot.finalLocalModel,
        );
        const text = String(local.text || "").trim();
        console.log(`[trace recover] local whisper OK durMs=${(performance.now() - tLocal).toFixed(0)} model="${liveSnapshot.finalLocalModel}" textLen=${text.length} wordCount=${text.split(/\s+/).filter(Boolean).length}`);
        return text;
      } catch (e) {
        console.log(`[trace recover] local whisper FAIL durMs=${(performance.now() - tLocal).toFixed(0)} err="${e instanceof Error ? e.message : String(e)}"`);
        return "";
      }
    };
    // Public helper: wraps the inner chain in a hard timeout so a
    // stalled provider can't hang the stopLive flow forever. The
    // inner chain races against a sentinel that resolves with "" at
    // the deadline. The inner work keeps running in the background
    // (its promises don't get cancelled — the caller just stops
    // waiting), so a delayed result still gets logged; we just don't
    // block the UI on it.
    const recoverFromEmptyTranscript = async (reason: string): Promise<string> => {
      const tStart = performance.now();
      // ``timeoutHandle`` is captured so the inner-resolves-first path
      // can clearTimeout and avoid the misleading "HARD TIMEOUT" log
      // that would otherwise fire 20 s after the function already
      // returned (cosmetic noise the user noticed in main.log).
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const innerPromise = recoverFromEmptyTranscriptInner(reason).finally(() => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      });
      const timeoutPromise = new Promise<string>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.log(`[trace recover] HARD TIMEOUT after ${RECOVERY_HARD_TIMEOUT_MS}ms — abandoning recovery`);
          resolve("");
        }, RECOVERY_HARD_TIMEOUT_MS);
      });
      const result = await Promise.race([innerPromise, timeoutPromise]);
      console.log(`[trace recover] outer durMs=${(performance.now() - tStart).toFixed(0)} resultLen=${result.length}`);
      return result;
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
      // the finalize wait entirely and use whatever committed
      // segments we have. If those are empty AND the canonical audio
      // file is on disk, recover via Deepgram REST → local Whisper —
      // the streaming WS error doesn't taint the saved audio, so we
      // shouldn't drop the recording silently when a higher-quality
      // recovery is available.
      if (liveStreamErrorAtStop) {
        const errorBuffer = getLiveTranscriptBuffer(sessionUiToken);
        transcriptRaw =
          errorBuffer?.committedDisplayText ||
          errorBuffer?.committedText ||
          (errorBuffer ? joinTranscriptSegments(errorBuffer.segments) : latestSourceForSave());
        if (!transcriptRaw) {
          transcriptRaw = await recoverFromEmptyTranscript(
            `Live stream errored mid-recording (${liveStreamErrorAtStop}).`,
          );
        }
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
        const instantBuffer = getLiveTranscriptBuffer(sessionUiToken);
        const instantTranscript = getSessionCanonicalLiveSourceText(sessionUiToken);
        const instantSegments = instantBuffer?.segments || [];
        console.log(`[trace stopLive] fast-path enter committedLen=${instantBuffer?.committedText.length ?? 0} interimLen=${instantBuffer?.interimText.length ?? 0} lastInterimSnapshotLen=${instantBuffer?.lastInterimText.length ?? 0} instantTranscriptLen=${instantTranscript.length} instantWordCount=${instantTranscript.split(/\s+/).filter(Boolean).length} instantTail="${instantTranscript.slice(-60).replace(/\n/g, "\\n")}"`);
        if (instantTranscript) {
          transcriptRaw = instantTranscript;

          // ── Tail-gap detection (Stop-pressed-mid-utterance fix) ───
          //
          // Each committed segment has a Deepgram-provided ``end``
          // timestamp (seconds since stream start). If the last
          // committed segment ends well before the recording's total
          // duration, there is audio AT THE TAIL that wasn't yet
          // finalized when ``getCanonicalLiveSourceText()`` was
          // called. This is exactly what the user reports as
          // "сразу нажимаю на" — they spoke the last word, hit Stop
          // immediately, and the last word's audio either:
          //   1. hadn't been processed by Deepgram yet (in flight),
          //   2. had been processed but only emitted as INTERIM, with
          //      the ``is_final`` for it still in upstream queue, or
          //   3. arrived at Deepgram AFTER CloseStream and Deepgram
          //      emits the trailing ``is_final`` post-CloseStream
          //      (which the envelope captures, but the fast path
          //      previously fired-and-forgot).
          //
          // Threshold: 0.6 s. Less than Deepgram's 0.7 s endpointing
          // window — anything under is normal latency for the last
          // word, anything over is a real tail-cut.
          //
          // Recovery escalation:
          //   1. Wait for ``liveFinalPromise`` (already in flight,
          //      4000 ms ceiling). Its envelope contains the post-
          //      CloseStream ``is_final`` segments. If those extend
          //      beyond ``instantTranscript`` (more words / later
          //      end-time), use them.
          //   2. If the envelope ALSO doesn't fill the gap, escalate
          //      to ``recoverFromEmptyTranscript`` which runs a full
          //      pass over the on-disk audio (Deepgram REST → local
          //      Whisper). The on-disk audio is captured locally via
          //      PCM sink and is ALWAYS complete — it predates any
          //      WebSocket dropout.
          // 1.1.25: SSOT — use ``countWords`` (the module-level
          // helper at line ~862) instead of an inline lambda. Keeps
          // word-counting semantics consistent across the codebase
          // (Unicode handling, whitespace normalisation), and avoids
          // the maintenance hazard of two divergent definitions.
          const wordCountOf = countWords;
          const alreadyResolvedEnvelope = liveFinalSlots.get(sessionUiToken)?.envelope || null;
          const opportunisticEnvelopeText = textFromLiveFinalEnvelope(alreadyResolvedEnvelope);
          const opportunisticTranscript = richerTranscript(transcriptRaw, opportunisticEnvelopeText);
          if (opportunisticTranscript !== transcriptRaw) {
            transcriptRaw = opportunisticTranscript;
            console.log(`[trace stopLive] opportunistic-envelope used words=${wordCountOf(transcriptRaw)} tail="${transcriptRaw.slice(-60).replace(/\n/g, "\\n")}"`);
          }

          // Tail coverage is committed + current interim + the last
          // interim snapshot. Using committed segments only made every
          // stop-with-interim look truncated, so the slow REST recovery
          // path ran even when the visible live preview already had the
          // full utterance tail.
          const lastSpeechEnd = maxLiveBufferSpeechEnd(instantBuffer);
          const lastCapturedActivitySec = captureLastActivePcmSample / AUDIO_TOKENS.liveSampleRateHz;
          const tailGapSec = recordedSec - lastSpeechEnd;
          const tailActivityGapSec = lastCapturedActivitySec - lastSpeechEnd;
          const hasTimestampedLiveCoverage = lastSpeechEnd > 0;
          const tailHasCapturedActivity = tailActivityGapSec > 0.2;
          // Skip the check on very short recordings (< 1 s) where the
          // gap arithmetic isn't meaningful. Skip when the user had
          // streaming-error already (handled by the dedicated branch).
          // Also skip when the only gap is trailing silence; otherwise
          // a normal pause before Stop looks like missing speech and
          // starts the expensive REST recovery path.
          const tailLikelyMissing =
            recordedSec > 1.0 &&
            hasTimestampedLiveCoverage &&
            tailGapSec > 0.6 &&
            tailHasCapturedActivity &&
            !liveStreamErrorAtStop;
          console.log(`[trace tail-gap] recordedSec=${recordedSec.toFixed(2)} lastSpeechEnd=${lastSpeechEnd.toFixed(2)} lastCapturedActivitySec=${lastCapturedActivitySec.toFixed(2)} tailGapSec=${tailGapSec.toFixed(2)} tailActivityGapSec=${tailActivityGapSec.toFixed(2)} liveStreamErrorAtStop="${liveStreamErrorAtStop}" decision=${tailLikelyMissing ? "RECOVER" : "skip"}`);
          if (tailLikelyMissing) {
            // ── Parallel race: envelope + REST recovery ─────────────
            //
            // Previous (1.1.15-1.1.16) implementation was SEQUENTIAL:
            //   1. await envelope (up to 4 s ceiling)
            //   2. if envelope didn't help, await recovery (~3 s)
            // → worst case 7+ s of post-Stop latency.
            //
            // The user's real-world test showed segmentCount=0 after
            // 14 s of audio (Deepgram WS was streaming interim but
            // never finalizing into is_final). The envelope was
            // GUARANTEED empty in that case — we waited 3.7 s for a
            // result we knew wouldn't come, then started recovery
            // serially. Total: 7.6 s of dead-time after Stop.
            //
            // New strategy:
            //   • Skip envelope wait only when neither finalized nor
            //     interim timestamps exist. If the stream has interim
            //     coverage, CloseStream can still promote it to final.
            //   • Otherwise launch envelope + recovery IN PARALLEL,
            //     await both via Promise.all, then pick whichever
            //     candidate (instant / envelope / recovery) has the
            //     most words. Cost is max(env, recovery) instead of
            //     env + recovery.
            //
            // Net for the user's case: 7.6 s → ~3 s.
            const skipEnvelope = instantSegments.length === 0 && lastSpeechEnd <= 0;
            patchCurrentRecordingSummary({
              title: provisionalTitle,
              status: skipEnvelope
                ? "Live stream had no finalized segments — recovering full transcript from saved audio…"
                : `Recovering tail (${Math.round(tailGapSec * 1000)}ms gap)…`,
              tone: "info",
            }, sessionUiToken);
            console.log(`[trace tail-gap] strategy=${skipEnvelope ? "RECOVERY-ONLY (no timestamped live coverage)" : "PARALLEL (envelope + recovery)"}`);

            const tRace = performance.now();
            const envelopePromise: Promise<LiveFinalEnvelope | null> = skipEnvelope
              ? Promise.resolve(null)
              : (liveFinalPromise || Promise.resolve(null));
            const recoveryPromise = recoverFromEmptyTranscript(
              `Live tail truncated (${Math.round(tailGapSec * 1000)}ms gap${skipEnvelope ? ", Deepgram WS silent" : ""}).`,
            );
            // ── 1.1.19: smart race instead of Promise.all ─────────────
            //
            // Promise.all blocked until BOTH promises resolved. The
            // user's logs revealed that on long recordings the
            // post-CloseStream envelope often resolves with empty text
            // at the 4 s ceiling (Deepgram regional issue) while
            // recovery resolves at 2-3 s with a strict improvement.
            // Promise.all then waited an additional 1-2 s for the
            // envelope timeout — pure waste because we already had a
            // better answer.
            //
            // New strategy:
            //   1. Race envelope vs recovery.
            //   2. If the FIRST resolved promise produces a strict
            //      word-count improvement over ``instantTranscript``,
            //      use it immediately — DO NOT wait for the second.
            //   3. If the first candidate is already within 90% of
            //      instant, keep instant immediately. Waiting for REST
            //      after an equal envelope is pure latency and caused
            //      the overlay paste task to time out.
            //   4. Only if the first candidate is clearly worse/empty,
            //      await the OTHER (it might yet recover a real stream
            //      dropout).
            //   5. If neither beat instant, keep instant.
            //
            // Saves ~1.5 s per long recording in the typical case.
            type Cand = { label: "envelope" | "recovery"; text: string; words: number };
            const baseTranscriptForRace = transcriptRaw;
            const wcInstant = wordCountOf(baseTranscriptForRace);
            const envelopeCand: Promise<Cand> = envelopePromise.then((env) => {
              const text = textFromLiveFinalEnvelope(env);
              return { label: "envelope" as const, text, words: wordCountOf(text) };
            });
            const recoveryCand: Promise<Cand> = recoveryPromise.then((text) => ({
              label: "recovery" as const, text, words: wordCountOf(text),
            }));
            const first = await Promise.race([envelopeCand, recoveryCand]);
            const firstMs = performance.now() - tRace;
            console.log(`[trace tail-gap] race-first ${first.label} ms=${firstMs.toFixed(0)} words=${first.words} instantWords=${wcInstant} tail="${first.text.slice(-60).replace(/\n/g, "\\n")}"`);
            let improvedText = richerTranscript(baseTranscriptForRace, first.text);
            let chose: Cand | null = improvedText !== baseTranscriptForRace
              ? { ...first, text: improvedText, words: wordCountOf(improvedText) }
              : null;
            const firstConfirmsInstant = candidateConfirmsTranscriptCoverage(
              baseTranscriptForRace,
              first.text,
            );
            if (!chose && firstConfirmsInstant) {
              console.log(`[trace tail-gap] decision=KEEP_INSTANT_EARLY first=${first.label} totalMs=${(performance.now() - tRace).toFixed(0)} words=${wcInstant}`);
            }
            if (!chose && !firstConfirmsInstant) {
              // First didn't improve — wait for the OTHER.
              const other = first.label === "envelope" ? await recoveryCand : await envelopeCand;
              const otherMs = performance.now() - tRace;
              console.log(`[trace tail-gap] race-second ${other.label} ms=${otherMs.toFixed(0)} words=${other.words} tail="${other.text.slice(-60).replace(/\n/g, "\\n")}"`);
              improvedText = richerTranscript(baseTranscriptForRace, other.text);
              if (improvedText !== baseTranscriptForRace) {
                chose = { ...other, text: improvedText, words: wordCountOf(improvedText) };
              }
            }
            const totalRaceMs = performance.now() - tRace;
            if (chose) {
              transcriptRaw = chose.text;
              console.log(`[trace tail-gap] decision=USE_${chose.label.toUpperCase()} (+${chose.words - wcInstant} words) totalMs=${totalRaceMs.toFixed(0)}`);
              if (chose.label === "recovery") {
                patchCurrentRecordingSummary({
                  title: provisionalTitle,
                  status: "Recovered full transcript from saved audio.",
                  tone: "success",
                }, sessionUiToken);
              }
            } else if (!firstConfirmsInstant) {
              console.log(`[trace tail-gap] decision=KEEP_INSTANT (no improvement) totalMs=${totalRaceMs.toFixed(0)}`);
            }
          }

          // ── Auto REST re-transcribe on suspiciously short streaming result ──
          //
          // Catches the catastrophic case (>70% of expected words
          // missing — usually a streaming dropout, not just a tail
          // cut). Still relies on the on-disk audio being present
          // and a Deepgram key being configured. The tail-gap
          // recovery above is the more precise fix; this stays as a
          // safety net for the broader "streaming captured almost
          // nothing" scenario.
          //
          // Heuristic: expect ~2.5 words per second of speech. If the
          // streaming result has less than 30% of the expected word
          // count, trigger an automatic REST re-transcribe.
          const wordCount = wordCountOf(transcriptRaw);
          const expectedWords = recordedSec * 2.5;
          const isSuspiciouslyShort = recordedSec > 5 && wordCount < expectedWords * 0.3;
          if (isSuspiciouslyShort && isProviderKeyConfigured("deepgram")) {
            patchCurrentRecordingSummary({
              title: provisionalTitle,
              status: `Streaming captured only ${wordCount} words for ${Math.round(recordedSec)}s. Re-transcribing via REST...`,
              tone: "warning",
            }, sessionUiToken);
            const restRecoveryFile = await fetchRecoveryAudioFile();
            if (restRecoveryFile) {
              try {
                const restResult = await remoteJobSync(restRecoveryFile, {
                  provider: "deepgram",
                  language: languageValue,
                  diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
                  openrouterModel: getRemoteModelValue("deepgram"),
                });
                const restText = String(restResult.text || "").trim();
                if (restText && wordCountOf(restText) > wordCount) {
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
          const envelopeError = envelope?.error || getLiveStreamError(sessionUiToken) || "";
          const envelopeText = textFromLiveFinalEnvelope(envelope);
          if (envelopeText && !envelopeError) {
            transcriptRaw = envelopeText;
          } else if (envelopeError) {
            // Migrated to ``recoverFromEmptyTranscript`` in 1.1.17:
            // the previous bespoke chain at this branch read
            // ``transcribeInputFile`` directly, which is the OPFS-
            // dangling lazy ``Blob([header, spool])`` after
            // ``deferredSinkDestroy.destroy()`` runs upstream.
            // ``recoverFromEmptyTranscript`` resolves audio through
            // ``fetchRecoveryAudioFile`` (durable backend re-fetch
            // first, in-memory only as last resort) and runs the
            // exact same Deepgram-REST → local-Whisper chain — same
            // behaviour, no dangling-blob class of bug.
            patchCurrentRecordingSummary({
              title: provisionalTitle,
              status: `Live stream issue (${envelopeError}). Recovering from saved audio…`,
              tone: "warning",
            }, sessionUiToken);
            transcriptRaw = await recoverFromEmptyTranscript(
              `Live stream errored (${envelopeError}).`,
            );
          }
        } // close ``else`` (no instantTranscript — envelope fallback)
      }

      // Very last resort: whatever the live source text captured.
      if (!transcriptRaw) {
        const committed = getSessionCanonicalLiveSourceText(sessionUiToken);
        if (committed) transcriptRaw = committed;
      }

      // ── Final safety net: empty Deepgram-live result ──────────────
      //
      // If we get here with NO transcript, every Deepgram-streaming
      // path failed silently: streaming was empty, envelope was
      // empty (no text, no segments, no error), the REST recovery
      // arm in the envelope-error branch wasn't reached because no
      // error fired, and ``getCanonicalLiveSourceText()`` returned
      // nothing. Don't drop the recording silently — the audio file
      // is on disk and the unified recovery helper can still try
      // Deepgram REST → local Whisper against it.
      //
      // Previously this safety net called only ``runLocalFinalPass``
      // (added in 1.1.13) — but that's strictly worse than what the
      // user does manually with Re-transcribe (REST → local). The
      // unified ``recoverFromEmptyTranscript`` mirrors the manual
      // path exactly and uses the durable backend-fetched audio
      // (avoiding the OPFS-dangling-blob class of bug).
      //
      // Symptom this addresses: the screenshot showing "TRANSCRIBE
      // 3 ms" with 0 captured words on a 41 s recording — the live
      // WS returned empty (auth issue, network drop, sample-rate
      // mismatch, or server-side silent reject), no error event
      // fired, and the user had to manually press Re-transcribe.
      if (!transcriptRaw) {
        // ── 1.1.19: skip recovery on a truly silent recording ──
        //
        // If Deepgram's WebSocket emitted NOTHING during the entire
        // recording — no committed segments, no interim, no
        // ``lastInterimSnapshot`` — there is essentially nothing to
        // recover. Running the full chain (Deepgram REST + local
        // Whisper) on the silent audio file just confirms there is
        // no speech, costing ~7 seconds for an empty result. Detect
        // the "definitely silent" case and emit empty without the
        // recovery dance.
        //
        // The streaming-vs-real-silent distinction matters: a
        // streaming dropout WOULD have committed/interim residue
        // from the pre-dropout speech, so this guard correctly
        // recovers in that case (residue is non-empty → falls through
        // to the recovery branch below).
        const noStreamingActivity = !hasStreamingActivity(getLiveTranscriptBuffer(sessionUiToken));
        const finalSilence = captureSilenceSnapshot(getSessionCanonicalLiveSourceText(sessionUiToken) || transcriptRaw);
        const definitelySilent = noStreamingActivity && (
          finalSilence.hardSilence ||
          finalSilence.likelySilenceWithoutPreview
        );
        if (definitelySilent) {
          console.log(`[trace stopLive] silent recording — skipping recovery (no streaming activity at all)`);
          patchCurrentRecordingSummary({
            title: provisionalTitle,
            status: "Recording completed, no speech detected.",
            tone: "info",
          }, sessionUiToken);
        } else {
          transcriptRaw = await recoverFromEmptyTranscript(
            noStreamingActivity
              ? "Live stream returned no text, but microphone audio was captured."
              : "Live stream returned no text.",
          );
        }
      }
    } else {
      // OpenRouter (or any future non-streaming remote): the REST promise
      // started during the cleanup phase is the authoritative path.
      if (isCurrentUiSession(sessionUiToken)) {
        $("progressFill").style.width = "50%";
        $("progressText").textContent = "50%";
      }
      const previewDraft =
        (getLiveTranscriptBuffer(sessionUiToken)?.committedDisplayText || "").trim()
        || latestSourceForSave();
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
      if (!transcriptRaw && (previewDraft || latestSourceForSave())) {
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

    console.log(`[trace stopLive] FINAL transcriptRaw len=${transcriptRaw.length} wordCount=${transcriptRaw.split(/\s+/).filter(Boolean).length} tail="${transcriptRaw.slice(-80).replace(/\n/g, "\\n")}"`);

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
    let pasteReadyText = "";
    if (transcriptRaw) {
      transcriptForPaste = await runUpscaleIfEnabled(
        transcriptRaw,
        sessionUiToken,
        { setDoneStatus: false },
      );
      pasteReadyText = transcriptForPaste || transcriptRaw;
      publishRecordingFinalSignal({
        recordingId,
        signalText: pasteReadyText,
        domText: transcriptRaw,
        kind: "transcript",
        sessionToken: sessionUiToken,
      });
    }
    setStatusScoped(sessionUiToken, "Done");
    // saveRecordingText is non-blocking for recordings list reload.
    try {
      title = _smartTitle(transcriptRaw);
      await saveRecordingText({
        name: persistedRecordingName,
        archiveDir: persistedRecordingArchiveDir,
        requireExisting: !!persistedRecordingName,
        title,
        sourceText: latestSourceForSave(),
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
          : "Recording completed, no speech detected.",
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
        title: latestSourceTitle(),
        sourceText: latestSourceForSave(),
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
    clearLiveDraft(sessionUiToken);
    disableStopButtonForSession();
    mark("stopLive:done");
    const totalMs = performance.now() - stopT0;
    const labels = stopTimings
      .map(([label, t], i) => {
        const prev = i > 0 ? stopTimings[i - 1][1] : 0;
        return `${label}: ${(t - prev).toFixed(0)}ms`;
      })
      .join(" → ");
    console.log(`[trace stopLive] total=${totalMs.toFixed(0)}ms | ${labels}`);
    (window as unknown as { __transcriptorStopTimings?: unknown }).__transcriptorStopTimings = {
      totalMs,
      phases: stopTimings,
    };
  }
  } finally {
    // Usually cleared earlier once capture globals have been detached,
    // so the next recording can start while this session saves/transcribes.
    // Keep this final assignment as the crash-proof fallback for exceptions
    // before that release point.
    if (stopTransitionOwnerToken === stopTransitionToken) {
      stopTransitionInFlight = false;
      stopTransitionOwnerToken = "";
    }
    // Guarantee id is 0 even if an uncaught throw happened before the
    // in-body reset above — a stale id would confuse the overlay's
    // post-stop task guard on the next recording start.
    if (stoppedRecordingId > 0 && currentRecordingId === stoppedRecordingId) {
      currentRecordingId = 0;
      window.__transcriptorCurrentRecordingId = 0;
    }
    // ── 1.1.22: close the live WS here, AFTER the entire transcribe
    // phase finished. See comment at the deferred-close site for the
    // rationale (avoids truncating the post-CloseStream tail). Null
    // the socket-level handlers right before close() so any in-flight
    // event that lands during the close handshake doesn't reach into
    // freshly-cleaned state. ``_wsToCloseAtEnd`` survives the
    // try-block scope because it was declared on the function body.
    try {
      if (_wsToCloseAtEnd) {
        _wsToCloseAtEnd.onopen = null;
        _wsToCloseAtEnd.onclose = null;
        _wsToCloseAtEnd.onerror = null;
        _wsToCloseAtEnd.onmessage = null;
        try { _wsToCloseAtEnd.close(); } catch { /* already closed */ }
      }
    } catch { /* defensive */ }
    if (stoppedSessionToken) {
      const slot = liveFinalSlots.get(stoppedSessionToken);
      if (slot) {
        const waiters = slot.waiters.splice(0);
        for (const waiter of waiters) {
          try {
            waiter(null);
          } catch (e) {
            console.warn("live final waiter cleanup threw", e);
          }
        }
        liveFinalSlots.delete(stoppedSessionToken);
      }
      liveStreamErrors.delete(stoppedSessionToken);
      liveTranscriptBuffers.delete(stoppedSessionToken);
    }
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
  // 1.1.25 fix: previously called ``patchCurrentRecordingSummary``
  // with NO sessionToken — that wrote unconditionally and could
  // clobber the status pill of an active live recording when the
  // user dropped a bad file in the (non-active) Live tab file
  // picker mid-recording. File-selection state and live-recording
  // state are unrelated and must not share the status surface.
  // Use the non-disruptive notice instead.
  showRecordSessionNotice(message, "error", 6000);
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
    // 1.1.25 fix: previous gate was ``!file.type || ALLOWED_AUDIO_MIME.has(file.type)``
    // which treated MISSING MIME as "passes" — combined with also-missing
    // extension on a file with no dot, both checks were lenient and let
    // unidentifiable binaries through to the backend. The MIME path now
    // requires an actual MIME match; the extension path independently
    // accepts files where the MIME is empty but the extension is known.
    const mimeOk = !!file.type && ALLOWED_AUDIO_MIME.has(file.type);
    // Use the SSOT extension set that mirrors backend's
    // ALLOWED_AUDIO_EXTS. Previously rejected legitimate .opus / .oga
    // / .wma files the backend would have accepted, plus ALL video
    // containers — even though the backend's ffmpeg path can demux
    // audio out of any of them.
    const extOk = !!ext && ACCEPTED_AUDIO_VIDEO_EXTS.has(ext);
    if (!mimeOk && !extOk) {
      reportFileSelectionError(
        "Unsupported file type. Drop an audio or video file.",
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
        signal: pollAbortController.signal,
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
      if (transcriptRaw) {
        const pasteReadyText = await runUpscaleIfEnabled(
          transcriptRaw,
          sessionUiToken,
          { setDoneStatus: false },
        );
        publishRecordingFinalSignal({
          recordingId: 0,
          signalText: pasteReadyText || transcriptRaw,
          domText: transcriptRaw,
          kind: "transcript",
          sessionToken: sessionUiToken,
        });
      }
      setStatusScoped(sessionUiToken, "Done");
      const latencyMs = performance.now() - transcribeStartedAt;
      patchCurrentRecordingSummary({
        status: transcriptRaw ? "File transcript is ready." : "Recording completed, no speech detected.",
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
        signal: pollAbortController.signal,
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
      if (transcriptRaw) {
        const pasteReadyText = await runUpscaleIfEnabled(
          transcriptRaw,
          sessionUiToken,
          { setDoneStatus: false },
        );
        publishRecordingFinalSignal({
          recordingId: 0,
          signalText: pasteReadyText || transcriptRaw,
          domText: transcriptRaw,
          kind: "transcript",
          sessionToken: sessionUiToken,
        });
      }
      setStatusScoped(sessionUiToken, "Done");
      const latencyMs = performance.now() - transcribeStartedAt;
      patchCurrentRecordingSummary({
        status: transcriptRaw ? "File transcript is ready." : "Recording completed, no speech detected.",
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
    let items: Array<{ name: string; display_name: string; source_file?: string; provider: string; keywords: string[] }> = [];
    try {
      const r = await apiGet<{ nodes: Array<{ name: string; display_name: string; source_file?: string; provider: string; keywords: string[]; size_bytes: number }> }>("/api/recordings/graph");
      items = (r.nodes || []).map((it) => ({
        name: it.name, display_name: it.display_name,
        source_file: it.source_file || "",
        provider: it.provider || "unknown", keywords: it.keywords || [],
      }));
    } catch {
      const r = await apiGet<{ items: RecordingItem[] }>("/api/recordings");
      items = (r.items || []).map((it) => ({
        name: it.name, display_name: it.display_name,
        source_file: it.source_file || "",
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
  // switchView only refreshes the list when it was empty; without an
  // explicit openRecording call, the detail pane keeps showing whatever
  // was open before, so the click "navigates" but shows the wrong content.
  void openRecording(node.name);
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
    // Install drag-continuation handlers ONLY for the duration of
    // this drag. Previously they lived on `window` permanently and
    // fired `if (!gDragging) return;` on EVERY mouse move anywhere
    // in the app for the lifetime of the page — wasted hit-test
    // cost that accrues linearly with session length (100+ Hz on a
    // modern pointer × 6h = ~2M wasted no-op calls). Scope-binding
    // to the drag means zero overhead outside an active drag.
    const onDragMove = (ev: MouseEvent) => {
      const dx = ev.clientX - gDragStartX, dy = ev.clientY - gDragStartY;
      gDragDist = Math.sqrt(dx * dx + dy * dy);
      gPanX = gDragPanStartX + dx; gPanY = gDragPanStartY + dy;
      gRender();
    };
    const onDragEnd = () => {
      gDragging = false;
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
      // Defensive safety net: if some OS-level focus loss or
      // fullscreen transition swallows the mouseup event, a final
      // blur tear-down prevents the drag state from sticking.
      window.removeEventListener("blur", onDragEnd);
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    window.addEventListener("blur", onDragEnd);
  });

  // Graph-local hover mousemove. Stays container-scoped (not window)
  // so hit-test evaluation only runs when the cursor is genuinely
  // over the graph. Early-returns on active drag so the drag handler
  // owns the render path unambiguously.
  ct.addEventListener("mousemove", (e: MouseEvent) => {
    if (gDragging) return;
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

// Stamp the version badge on boot. The HTML at #appVersionNumber
// holds a build-time placeholder that vite/index.html templating
// can't reach without a separate build step; updating it from JS
// lets us keep frontend/package.json as the single SSOT for the
// version string. The vite.config.ts ``define`` block injects
// ``__APP_VERSION__`` at compile time so this read is a string
// literal in the bundle, not a runtime fetch.
(() => {
  const badge = document.getElementById("appVersionNumber");
  if (badge && typeof __APP_VERSION__ === "string" && __APP_VERSION__) {
    badge.textContent = __APP_VERSION__;
  }
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
// Network-state poll. Capture the handle so a teardown path can
// clear it. Skip the body when the renderer window is hidden — the
// /api/network probe + /api/health round-trip is wasted work when
// the user can't see the indicator anyway, and on Electron with the
// main window hidden the renderer keeps running.
const _networkPollHandle = window.setInterval(() => {
  if (document.visibilityState === "hidden") return;
  void refreshNetworkState();
}, UI_TOKENS.network.refreshIntervalMs);
window.addEventListener("online", () => void refreshNetworkState());
window.addEventListener("offline", () => void refreshNetworkState());
// Symmetric cleanup so dev hot-reloads / explicit teardown paths
// don't leave stale handles behind.
window.addEventListener("pagehide", () => {
  try { window.clearInterval(_networkPollHandle); } catch { /* idempotent */ }
}, { once: true });
// Race bootstrap against a 15-second wall-clock timeout so a stalled
// network mount or slow FS does not hang the boot overlay forever — the
// promise must settle for any caller that `await recordingsBootstrapPromise`
// to resume. On timeout the recordings list stays empty; the user can still
// record and the list reloads on the next manual refresh.
recordingsBootstrapPromise = Promise.race([
  initRecordingsBootstrap(),
  new Promise<void>((_, rej) =>
    setTimeout(() => rej(new Error("recordings bootstrap timeout (15 s)")), 15000)
  ),
])
  .catch((e) => { console.warn("[bootstrap]", e?.message ?? e); })
  .finally(() => { recordingsBootstrapPromise = null; });
// Platform marker on <body> so the stylesheet can gate macOS-specific
// chrome offsets (traffic-light padding under hiddenInset). Without
// this, Windows/Linux users see a 42px dead zone at the top of the
// sidebar reserved for a title-bar area their OS already renders.
try {
  const ua = String(navigator.userAgent || "").toLowerCase();
  const platform = ua.includes("mac os x") || ua.includes("macintosh")
    ? "darwin"
    : (ua.includes("windows") ? "win32" : "linux");
  document.body.classList.add(`platform-${platform}`);
} catch { /* non-browser contexts — harmless */ }
draw();
syncMode();
setStatus("Idle");
setRecordButton(false);
setCurrentRecordingSummary(null);
resetRecordingViewer();
updateRecordingCopyState();

// ── Backend boot status / error display ──
//
// The boot overlay (``#bootOverlay``) starts visible (HTML default) and
// is hidden by ``hideBootOverlayOnce`` on the first successful
// /api/health response inside ``refreshNetworkState``. During cold
// start (2-10 s while the Python backend spawns + Whisper models warm),
// the overlay dominates the viewport instead of leaving the user
// staring at a silently-unresponsive UI.

window.__setBackendBootStatus = (msg: string) => {
  if (!msg) return;
  const statusEl = document.getElementById("bootOverlayStatus");
  if (statusEl) statusEl.textContent = msg;
  // Mirror into the topbar status pill as a secondary signal — some
  // users keep the app on a second monitor and miss the overlay.
  setStatus(msg);
};

/**
 * Map a raw backend-startup error string to a user-actionable message.
 *
 * The backend sends us ``uvicorn`` stderr tails verbatim via
 * ``__setBackendBootError`` — those can include absolute filesystem
 * paths, Python tracebacks, or obscure OS error codes (``EADDRINUSE``,
 * ``WinError 10013``). Rendering them raw is (a) scary to non-technical
 * users, (b) info-leaky to anyone who photographs the window. We
 * classify the known families into actionable copy and keep the raw
 * text behind a "Show details" disclosure for anyone debugging.
 */
function classifyBootError(raw: string): { headline: string; detail: string } {
  const low = (raw || "").toLowerCase();
  if (!low) {
    return {
      headline: "Backend failed to start.",
      detail: "Unknown startup failure — check the main.log in the data directory.",
    };
  }
  if (low.includes("address already in use") ||
      low.includes("eaddrinuse") ||
      low.includes("winerror 10048") ||
      low.includes("only one usage of each socket address")) {
    return {
      headline: "Port 8321 is already in use.",
      detail: "Another copy of Transcriptor is still running. Close it via the tray icon (or reboot if that doesn't work) and try again.",
    };
  }
  if (low.includes("permission denied") ||
      low.includes("eacces") ||
      low.includes("winerror 5")) {
    return {
      headline: "Transcriptor couldn't access its data directory.",
      detail: "Check that Transcriptor's data directory is writable by your user account. On Windows, verify no antivirus is blocking %APPDATA%\\Transcriptor.",
    };
  }
  if (low.includes("no module named") || low.includes("modulenotfounderror")) {
    return {
      headline: "A Python dependency is missing.",
      detail: "The bundled runtime is incomplete. Reinstall Transcriptor from the same installer (.exe / .dmg / .AppImage) to restore it.",
    };
  }
  if (low.includes("python 3 interpreter was not found") ||
      low.includes("python: not found") ||
      low.includes("python was not found")) {
    return {
      headline: "Python 3 is required.",
      detail: "Install Python 3.10+ from python.org, then reopen Transcriptor. Linux users: `sudo apt install python3 python3-venv python3-pip`.",
    };
  }
  // Unknown family — generic copy + let the user open the log.
  return {
    headline: "Backend failed to start.",
    detail: "Open the log file from the support section below and share the tail with support, or reinstall from the latest installer.",
  };
}

window.__setBackendBootError = (msg: string) => {
  const raw = String(msg || "").trim();
  const { headline, detail } = classifyBootError(raw);
  const overlay = document.getElementById("bootOverlay");
  if (overlay) {
    overlay.dataset.state = "error";
    overlay.hidden = false;
  }
  const statusEl = document.getElementById("bootOverlayStatus");
  if (statusEl) statusEl.textContent = headline;
  const detailEl = document.getElementById("bootOverlayDetail");
  if (detailEl) {
    // Render the friendly detail as the primary message, and expose
    // the raw stderr via a click-to-expand disclosure so debuggers
    // still have full context without the scary default.
    detailEl.innerHTML = "";
    const friendly = document.createElement("div");
    friendly.textContent = detail;
    detailEl.appendChild(friendly);
    if (raw && raw !== detail) {
      const details = document.createElement("details");
      details.style.marginTop = "8px";
      details.style.fontSize = "12px";
      details.style.opacity = "0.75";
      const summary = document.createElement("summary");
      summary.textContent = "Show technical details";
      summary.style.cursor = "pointer";
      const pre = document.createElement("pre");
      pre.textContent = raw;
      pre.style.whiteSpace = "pre-wrap";
      pre.style.wordBreak = "break-word";
      pre.style.marginTop = "6px";
      details.appendChild(summary);
      details.appendChild(pre);
      detailEl.appendChild(details);
    }
    detailEl.hidden = false;
  }
  const retryBtn = document.getElementById("bootOverlayRetry") as HTMLButtonElement | null;
  if (retryBtn) retryBtn.hidden = false;
  setStatus("Backend Error", "error");
  ($("statusDot") as HTMLElement).className = "status-dot error";
  // Replace liveOutput with the friendly headline only — the raw
  // detail already lives in the boot overlay's disclosure. Previously
  // we wrote the raw stderr tail into the live-transcript pane which
  // leaked paths into the paste/copy buffer on the first Cmd+V.
  $("liveOutput").textContent = headline;
};

// Retry: reload the renderer; Electron's main process keeps the
// backend running (parent-death watchdog already cleaned any previous
// zombie) and the fresh render cycle will wait on /api/health again.
const _bootRetry = document.getElementById("bootOverlayRetry");
if (_bootRetry) {
  _bootRetry.addEventListener("click", () => {
    const statusEl = document.getElementById("bootOverlayStatus");
    if (statusEl) statusEl.textContent = "Reloading…";
    const overlay = document.getElementById("bootOverlay");
    if (overlay) overlay.dataset.state = "loading";
    window.location.reload();
  });
}

// ══════════════════════════════════════════════════════════════════════
// ██  Upload Tab — drag-and-drop + queued batch transcription      ██
// ══════════════════════════════════════════════════════════════════════
//
// SSOT for the upload pipeline. Reuses the existing transcription
// primitives (`localJobQueued`, `remoteJobQueued`, `saveRecordingText`)
// instead of forking a parallel implementation, so any backend-side
// behaviour change (provider, language, retention) flows through to
// the upload tab automatically.
//
// Flow per file:
//   1. enqueueUploadFile(file) — validate size + insert at the top +
//      kick the bounded parallel processor.
//   2. processUploadItem(item) — provider-aware transcribe call.
//      Auto-falls back to local when the chosen remote provider has
//      no key (rather than silently failing per-item).
//   3. saveRecordingText({audioFile: sourceFile, …}) — persist into
//      the same archive the History tab reads, so the recording
//      shows up in History without an extra round-trip.
//   4. renderUploadQueue() — re-render the right pane.
//
// Bounded processor pool — upload/transcribe work should not serialize
// behind one long video, but it also must not saturate every backend
// worker while the user is recording.

type UploadQueueStatus = "queued" | "transcribing" | "done" | "error" | "cancelled";

interface UploadQueueSnapshotItem {
  id: string;
  displayName: string;
  sizeBytes: number;
  status: UploadQueueStatus;
  text?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  completedAt?: number;
  provider?: Provider;
  model?: string;
  language?: string;
  savedName?: string;
  savedArchiveDir?: string;
}

interface UploadQueueStoragePayload {
  version: 1;
  hideFinished: boolean;
  items: UploadQueueSnapshotItem[];
}

interface UploadQueueItem {
  id: string;
  file?: File;
  displayName: string;
  sizeBytes: number;
  // ``stage`` is a finer-grained signal than ``status`` — multiple
  // stages share the same outer ``status`` of "transcribing" but
  // surface different labels in the queue UI:
  //   queued   → Queued
  //   uploading → Uploading … (file body in flight to backend)
  //   processing → Processing … (backend is decoding video / running
  //                Deepgram REST / OpenRouter audio model)
  //   none      → status's own label (done/error/cancelled)
  status: UploadQueueStatus;
  stage?: "queued" | "uploading" | "processing" | "done";
  /**
   * 0..1 fraction of known upload progress. Browser fetch does not
   * expose request-body progress, so this remains undefined for the
   * job-based Upload flow and the UI uses stage labels instead.
   */
  uploadProgress?: number;
  text?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  completedAt?: number;
  provider?: Provider;
  model?: string;
  language?: string;
  savedName?: string;
  savedArchiveDir?: string;
  abortController?: AbortController;
}

// The currently-selected queue item id — drives which transcript is
// shown in the right-hand Result pane. Defaults to the most-recently
// completed item; user click overrides.
let uploadSelectedId: string | null = null;

const uploadQueue: UploadQueueItem[] = [];
let uploadActiveProcessors = 0;
let uploadProcessorPumpScheduled = false;
let uploadHideFinished = false;
let uploadRevealReconcileInFlight: Promise<void> | null = null;
const UPLOAD_EMPTY_TRANSCRIPT_TEXT = "[No speech captured]";
// Per-file ceiling for the Upload tab. This must match MAX_FILE_BYTES,
// which mirrors backend MAX_UPLOAD_BYTES via /api/health. Even though
// the backend later demuxes audio out of video containers, it still has
// to receive and spool the original request body first; accepting a
// larger client-side cap would only defer failure to a backend 413.
function uploadFileSizeCap(): number {
  return MAX_FILE_BYTES;
}
// Accept-set mirrors the backend's allowed extensions plus video
// containers (the backend's ffmpeg path demuxes audio out of any of
// these). Drag-drop browsers don't enforce ``accept`` so we
// double-check at the JS level.
// Alias to the SSOT set defined near the top of the file. Kept
// under its old name so existing call sites (enqueueUploadFile)
// don't need editing; the underlying set is the single canonical
// list mirroring backend ALLOWED_AUDIO_EXTS — adding a new ext is
// now a one-line change in ACCEPTED_AUDIO_VIDEO_EXTS.
const UPLOAD_ALLOWED_EXTS = ACCEPTED_AUDIO_VIDEO_EXTS;

function uploadItemName(item: UploadQueueItem): string {
  return String(item.displayName || item.file?.name || "Uploaded file");
}

function uploadItemSize(item: UploadQueueItem): number {
  const size = Number(item.sizeBytes || item.file?.size || 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function uploadItemResultText(item: UploadQueueItem): string {
  return String(item.text || "").trim() || UPLOAD_EMPTY_TRANSCRIPT_TEXT;
}

function normalizeUploadTranscriptIdentity(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function uploadDisplayPreviewFromText(text: string, maxWords = 8): string {
  const cleaned = String(text || "").replace(/\[.*?\]/g, "").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  let preview = words.slice(0, maxWords).join(" ");
  if (words.length > maxWords) preview += "...";
  if (preview.length > 80) preview = preview.slice(0, 77) + "...";
  return preview;
}

function extractRecordingTranscriptForUploadMatch(content: string, displayText = ""): string {
  const raw = String(content || "").trim();
  const display = String(displayText || "").trim();
  const trans = raw.match(/(?:^|\n)Transcription:\s*([\s\S]*)$/i);
  if (trans && trans[1].trim()) return trans[1].trim();
  const orig = raw.match(/(?:^|\n)Original:\s*([\s\S]*?)(?:\n\s*Transcription:|$)/i);
  if (orig && orig[1].trim()) return orig[1].trim();
  return display || raw;
}

type UploadRevealTarget = { name: string; archiveDir: string };

function normalizeTranscriptRecordingName(name: string): string {
  const raw = String(name || "").trim();
  if (!raw || raw.includes("..") || /[\\/]/.test(raw) || !raw.toLowerCase().endsWith(".txt")) return "";
  return raw;
}

function installRevealRecordingBridge(): void {
  window.__transcriptorRevealRecording = (name: string, archiveDir: string) => {
    const safe = normalizeTranscriptRecordingName(name);
    if (!safe) return;
    const payload = encodeURIComponent(
      JSON.stringify({ name: safe, archiveDir: String(archiveDir || "") }),
    );
    const prevTitle = document.title;
    document.title = "__app_reveal_recording__" + payload;
    // main.js consumes the sentinel synchronously via page-title-updated.
    setTimeout(() => { document.title = prevTitle || "Transcriptor"; }, 0);
  };
}

function uploadRevealTarget(item: UploadQueueItem | null | undefined): UploadRevealTarget | null {
  const name = normalizeTranscriptRecordingName(String(item?.savedName || ""));
  if (!name) return null;
  return {
    name,
    archiveDir: String(item?.savedArchiveDir || currentArchiveDirSnapshot() || "").trim(),
  };
}

function revealUploadItem(item: UploadQueueItem | null | undefined): boolean {
  const target = uploadRevealTarget(item);
  if (!target || typeof window.__transcriptorRevealRecording !== "function") return false;
  window.__transcriptorRevealRecording(target.name, target.archiveDir);
  return true;
}

function createUploadRevealButton(item: UploadQueueItem): HTMLButtonElement | null {
  if (!uploadRevealTarget(item)) return null;
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost upload-queue-item-action upload-queue-item-reveal";
  btn.type = "button";
  btn.textContent = "Reveal in Finder";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    revealUploadItem(item);
  });
  return btn;
}

async function reconcileUploadQueueRevealTargetsFromArchive(): Promise<void> {
  if (uploadRevealReconcileInFlight) return uploadRevealReconcileInFlight;
  const legacyItems = uploadQueue.filter((item) =>
    item.status === "done" &&
    !uploadRevealTarget(item) &&
    !!normalizeUploadTranscriptIdentity(item.text || "")
  );
  if (!legacyItems.length) return;

  uploadRevealReconcileInFlight = (async () => {
    try {
      await ensureRecordingsArchiveReady();
      const archiveDir = currentArchiveDirSnapshot();
      if (!archiveDir || !recordingItems.length) return;

      const previews = new Set(
        legacyItems
          .map((item) => uploadDisplayPreviewFromText(item.text || ""))
          .filter(Boolean),
      );
      if (!previews.size) return;

      const candidateNames = Array.from(new Set(
        recordingItems
          .filter((recording) => previews.has(String(recording.display_name || "")))
          .map((recording) => recording.name),
      ));
      if (!candidateNames.length) return;

      const matchesByText = new Map<string, string[]>();
      for (const name of candidateNames) {
        try {
          const payload = await apiGet<{ content?: string; display_text?: string }>(
            "/api/recordings/" + encodeURIComponent(name),
          );
          const identity = normalizeUploadTranscriptIdentity(
            extractRecordingTranscriptForUploadMatch(
              String(payload.content || ""),
              String(payload.display_text || ""),
            ),
          );
          if (!identity) continue;
          const matches = matchesByText.get(identity) || [];
          matches.push(name);
          matchesByText.set(identity, matches);
        } catch (e) {
          console.warn("Upload queue reveal target reconcile skipped recording", name, e);
        }
      }

      let changed = false;
      for (const item of legacyItems) {
        const identity = normalizeUploadTranscriptIdentity(item.text || "");
        const matches = matchesByText.get(identity) || [];
        if (matches.length !== 1) continue;
        item.savedName = matches[0];
        item.savedArchiveDir = archiveDir;
        changed = true;
      }
      if (changed) {
        saveUploadQueueSnapshot();
        renderUploadQueue();
      }
    } finally {
      uploadRevealReconcileInFlight = null;
    }
  })();
  return uploadRevealReconcileInFlight;
}

function isUploadTerminalStatus(status: UploadQueueStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isUploadPastItem(item: UploadQueueItem): boolean {
  return isUploadTerminalStatus(item.status);
}

function isUploadVisibleUnderCurrentFilter(item: UploadQueueItem): boolean {
  return !uploadHideFinished || !isUploadPastItem(item);
}

function uploadQueueSnapshotItem(item: UploadQueueItem): UploadQueueSnapshotItem {
  return {
    id: item.id,
    displayName: uploadItemName(item),
    sizeBytes: uploadItemSize(item),
    status: item.status,
    text: item.text || "",
    error: item.error || "",
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    completedAt: item.completedAt,
    provider: item.provider || "",
    model: item.model || "",
    language: item.language || "",
    savedName: item.savedName || "",
    savedArchiveDir: item.savedArchiveDir || "",
  };
}

function saveUploadQueueSnapshot(): void {
  try {
    const payload: UploadQueueStoragePayload = {
      version: 1,
      hideFinished: uploadHideFinished,
      items: uploadQueue
        .slice(0, UPLOAD_QUEUE_MAX_PERSISTED_ITEMS)
        .map(uploadQueueSnapshotItem),
    };
    localStorage.setItem(UPLOAD_QUEUE_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Upload queue snapshot save failed", e);
  }
}

function restoreUploadQueueSnapshot(): void {
  let raw = "";
  try {
    raw = localStorage.getItem(UPLOAD_QUEUE_STORAGE_KEY) || "";
  } catch (e) {
    console.warn("Upload queue snapshot read failed", e);
    return;
  }
  if (!raw) return;
  try {
    const payload = JSON.parse(raw) as Partial<UploadQueueStoragePayload>;
    uploadHideFinished = payload.hideFinished === true;
    const restored = Array.isArray(payload.items) ? payload.items : [];
    uploadQueue.splice(0, uploadQueue.length);
    for (const src of restored.slice(0, UPLOAD_QUEUE_MAX_PERSISTED_ITEMS)) {
      const displayName = String(src.displayName || "").trim();
      if (!displayName) continue;
      const status = String(src.status || "error") as UploadQueueStatus;
      const interrupted = status === "queued" || status === "transcribing";
      uploadQueue.push({
        id: String(src.id || createClientSessionId()),
        displayName,
        sizeBytes: Number(src.sizeBytes || 0),
        status: interrupted ? "error" : (isUploadTerminalStatus(status) ? status : "error"),
        text: String(src.text || ""),
        error: interrupted
          ? "Interrupted by app restart before this file finished."
          : String(src.error || ""),
        startedAt: typeof src.startedAt === "number" ? src.startedAt : undefined,
        endedAt: typeof src.endedAt === "number" ? src.endedAt : undefined,
        completedAt: typeof src.completedAt === "number"
          ? src.completedAt
          : (interrupted ? Date.now() : undefined),
        provider: (src.provider || "") as Provider,
        model: String(src.model || ""),
        language: String(src.language || ""),
        savedName: String(src.savedName || ""),
        savedArchiveDir: String(src.savedArchiveDir || ""),
      });
    }
    saveUploadQueueSnapshot();
  } catch (e) {
    console.warn("Upload queue snapshot parse failed", e);
  }
}

function addUploadQueueItem(item: UploadQueueItem): void {
  uploadQueue.unshift(item);
  saveUploadQueueSnapshot();
}

function setupUploadView(): void {
  const dropZone = document.getElementById("uploadLargeDrop");
  const fileInput = document.getElementById("uploadLargeFileInput") as HTMLInputElement | null;
  const provider = document.getElementById("uploadProvider") as HTMLSelectElement | null;
  const language = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
  const diarize = document.getElementById("uploadDiarize") as HTMLInputElement | null;
  if (!dropZone || !fileInput || !provider || !language) return;
  restoreUploadQueueSnapshot();
  // Persist Upload-tab state across launches. Without this every
  // app start reset the provider to the HTML default ("Deepgram")
  // even when the user routinely worked with Local Whisper or
  // OpenRouter — silent UX regression. The autosave debouncer +
  // queueUiPreferencesSave write to /api/config in the same
  // ``preferences.ui`` payload as Live-tab settings.
  provider.addEventListener("change", () => {
    queueUiPreferencesSave();
    updateUploadProviderHint();
  });
  language.addEventListener("change", () => queueUiPreferencesSave());
  if (diarize) {
    diarize.addEventListener("change", () => queueUiPreferencesSave());
  }
  // Click anywhere on the drop zone (except interactive children) opens
  // the native file picker.
  dropZone.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a") || target.closest("input")) return;
    fileInput.click();
  });
  // Keyboard activation: drop zone has tabindex=0 + role=button.
  dropZone.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    // Allow the user to pick the SAME file twice — clearing the
    // input value re-triggers `change` on the next pick. Without
    // this, dragging the same file twice silently no-ops.
    fileInput.value = "";
    files.forEach(enqueueUploadFile);
  });
  // Drag visual states. We want the highlight on EITHER `dragenter`
  // (first time the dragged item enters us) OR `dragover` (continuous
  // while inside) — they fire enough to keep the class set. We also
  // need `preventDefault()` on `dragover` for the browser to allow
  // the eventual `drop`.
  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag");
    });
  });
  dropZone.addEventListener("drop", (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    Array.from(dt.files).forEach(enqueueUploadFile);
  });
  // Block the entire window from navigating away if a file is
  // dropped OUTSIDE the drop zone — without this, dropping a file
  // anywhere else opens it in the renderer (replacing the app).
  // Scoped to the upload view via `closest('.view[data-view="upload"]')`
  // so dropping on Record/Settings/etc. retains default browser
  // behaviour (none, since those views don't accept drops anyway).
  ["dragover", "drop"].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      const view = (document.querySelector('.view[data-view="upload"]') as HTMLElement | null);
      if (!view || view.hidden) return;
      // Inside the drop zone the per-element listeners already handle it.
      if ((e.target as HTMLElement)?.closest("#uploadLargeDrop")) return;
      e.preventDefault();
    });
  });
  const clearBtn = document.getElementById("uploadQueueClearBtn") as HTMLButtonElement | null;
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      // Drop only finished items so an in-flight transcription is
      // never aborted by an accidental Clear click.
      for (let i = uploadQueue.length - 1; i >= 0; i--) {
        const st = uploadQueue[i].status;
        if (st === "done" || st === "error" || st === "cancelled") {
          uploadQueue.splice(i, 1);
        }
      }
      saveUploadQueueSnapshot();
      renderUploadQueue();
    });
  }
  const hideBtn = document.getElementById("uploadQueueHideBtn") as HTMLButtonElement | null;
  if (hideBtn) {
    hideBtn.addEventListener("click", () => {
      uploadHideFinished = !uploadHideFinished;
      saveUploadQueueSnapshot();
      renderUploadQueue();
    });
  }
  // Browse button in pane header — alternative to clicking the
  // drop zone, useful when the queue is full and the drop zone
  // has scrolled below the fold.
  const browseBtn = document.getElementById("uploadBrowseBtn");
  if (browseBtn) {
    browseBtn.addEventListener("click", () => fileInput.click());
  }
  // (Earlier ``provider.addEventListener("change", ...)`` block already
  // wires both queueUiPreferencesSave AND updateUploadProviderHint at
  // line ~8237. A duplicate listener here was attaching ANOTHER hint
  // refresh on every change, which leaked one stale-DOM-read closure
  // into the listener list per renderer reload. Removed.)
  // Initial provider default: prefer Deepgram if the user has a key,
  // else fall back to local Whisper (offline-capable). Honors per-tab
  // independence — the Record tab's selection is unaffected.
  const initialProvider: Provider = isProviderKeyConfigured("deepgram") ? "deepgram" : "local";
  provider.value = initialProvider;
  // Mirror language preference from the global #language so users who
  // already pinned RU/EN don't have to re-pick it on every tab.
  try {
    const globalLang = (document.getElementById("language") as HTMLSelectElement | null)?.value;
    if (globalLang && ["auto", "ru", "en"].includes(globalLang)) language.value = globalLang;
  } catch { }
  updateUploadProviderHint();
  renderUploadQueue();
  void reconcileUploadQueueRevealTargetsFromArchive();
}

function updateUploadProviderHint(): void {
  const provider = (document.getElementById("uploadProvider") as HTMLSelectElement | null)?.value || "deepgram";
  const hintEl = document.getElementById("uploadProviderHint");
  if (!hintEl) return;
  if (provider === "deepgram") {
    hintEl.textContent = isProviderKeyConfigured("deepgram")
      ? "Cloud transcription via Deepgram Nova-3 — fastest, multi-language."
      : "Add a Deepgram key in Settings, or switch to Local for offline transcription.";
  } else if (provider === "openrouter") {
    hintEl.textContent = isProviderKeyConfigured("openrouter")
      ? "Audio transcription via OpenRouter."
      : "Add an OpenRouter key in Settings, or switch to Local for offline transcription.";
  } else {
    hintEl.textContent = "Offline transcription via Whisper. Slower than cloud, no API key required.";
  }
}

function enqueueUploadFile(file: File): void {
  // Size gate — backend has its own 413, but rejecting client-side
  // saves the upload time + spares the server.
  const cap = uploadFileSizeCap();
  if (file.size > cap) {
    addUploadQueueItem({
      id: createClientSessionId(),
      file,
      displayName: file.name,
      sizeBytes: file.size,
      status: "error",
      error: `File too large (${Math.round(file.size / (1024 * 1024))} MB > ${Math.round(cap / (1024 * 1024))} MB cap).`,
    });
    renderUploadQueue();
    return;
  }
  // Format gate — drag-drop browsers ignore the `accept` attribute.
  // We accept anything the backend's ffmpeg can demux, which is
  // basically all common audio + video containers.
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext && !UPLOAD_ALLOWED_EXTS.has(ext)) {
    addUploadQueueItem({
      id: createClientSessionId(),
      file,
      displayName: file.name,
      sizeBytes: file.size,
      status: "error",
      error: `Unsupported file type ".${ext}". Drop an audio or video file.`,
    });
    renderUploadQueue();
    return;
  }
  addUploadQueueItem({
    id: createClientSessionId(),
    file,
    displayName: file.name,
    sizeBytes: file.size,
    status: "queued",
  });
  renderUploadQueue();
  void runUploadProcessor();
}

function runUploadProcessor(): void {
  if (uploadProcessorPumpScheduled) return;
  uploadProcessorPumpScheduled = true;
  queueMicrotask(() => {
    uploadProcessorPumpScheduled = false;
    while (uploadActiveProcessors < UPLOAD_QUEUE_MAX_PARALLEL) {
      const next = uploadQueue.find((it) => it.status === "queued");
      if (!next) break;
      uploadActiveProcessors += 1;
      void processUploadItem(next).finally(() => {
        uploadActiveProcessors = Math.max(0, uploadActiveProcessors - 1);
        saveUploadQueueSnapshot();
        runUploadProcessor();
      });
    }
  });
}

async function processUploadItem(item: UploadQueueItem): Promise<void> {
  // Cancellation guard: if the user hit Cancel before this item
  // reached the head of the queue, it's already in cancelled
  // state — don't transition it back to transcribing.
  if (item.status === "cancelled") return;
  if (!item.file) {
    item.status = "error";
    item.error = "Source file is no longer available. Re-add the file to transcribe it again.";
    item.endedAt = performance.now();
    item.completedAt = Date.now();
    saveUploadQueueSnapshot();
    renderUploadQueue();
    return;
  }
  const sourceFile = item.file;
  item.status = "transcribing";
  item.stage = "uploading";
  item.startedAt = performance.now();
  // Per-item AbortController. Threaded through every fetch so
  // the user's Stop button can yank the in-flight request even
  // if the network is mid-stream. We attach it to the item so
  // `cancelUploadItem` can find and call abort().
  item.abortController = new AbortController();
  saveUploadQueueSnapshot();
  renderUploadQueue();
  // Heuristic stage transition: ``fetch`` doesn't expose a clean
  // "request body fully sent" event in the browser, so we mark the
  // crossover from "uploading" to "processing" after a small delay
  // proportional to the file size — at typical broadband speeds,
  // 1 MB ≈ 100ms, so a 50 MB video is ~5 s of uploading. Capped at
  // 8 s so a slow link doesn't pin "uploading" forever, and the
  // backend's actual response time then takes over the "processing"
  // perception. The crossover is replaced by the real transition
  // when the response arrives below.
  const _stageCrossoverDelay = Math.min(8000, Math.max(800, sourceFile.size / 10000));
  const _stageTimer = window.setTimeout(() => {
    if (item.status === "transcribing" && item.stage === "uploading") {
      item.stage = "processing";
      renderUploadQueue();
    }
  }, _stageCrossoverDelay);
  const providerSel = document.getElementById("uploadProvider") as HTMLSelectElement | null;
  const languageSel = document.getElementById("uploadLanguage") as HTMLSelectElement | null;
  const diarize = !!(document.getElementById("uploadDiarize") as HTMLInputElement | null)?.checked;
  const selectedProvider = (providerSel?.value || "deepgram") as Provider;
  // Honor offline mode the same way the Record tab does — fall back
  // to local when the chosen remote provider isn't available right now.
  const provider = resolveEffectiveProvider(selectedProvider);
  const language = (languageSel?.value || "auto").trim();
  item.provider = provider;
  try {
    if (provider !== "local" && !isProviderKeyConfigured(provider)) {
      throw new Error(providerKeyErrorMessage(provider));
    }
    let text = "";
    let modelLabel = "";
    if (provider === "local") {
      modelLabel = "small";
      const out = await localJobQueued(sourceFile, {
        language: resolveFastLocalLanguage(language),
        model: modelLabel,
        splitStereo: true,
        wordTimestamps: false,
        signal: item.abortController.signal,
      });
      text = String(out.text || "").trim();
    } else {
      modelLabel = getRemoteModelValue(provider) || "";
      const out = await remoteJobQueued(sourceFile, {
        provider,
        language,
        diarize,
        openrouterModel: modelLabel,
        signal: item.abortController.signal,
        // Upload-tab remote jobs must not hold one browser XHR open
        // for upload + ffmpeg + provider processing. Large videos can
        // legitimately run past the old 5-minute XHR ceiling; the
        // backend job owns the long work and this renderer only polls.
        onProcessingProgress: () => {
          if (item.status !== "transcribing") return;
          item.stage = "processing";
          item.uploadProgress = undefined;
          renderUploadQueue();
        },
      });
      text = String(out.text || "").trim();
    }
    item.text = text;
    item.status = "done";
    item.stage = "done";
    item.model = modelLabel;
    item.language = language;
    item.endedAt = performance.now();
    item.completedAt = Date.now();
    // Persist to the History tab's archive. We pass the original
    // file so the audio is saved alongside the transcript and is
    // playable from the History row. `refreshList: true` triggers a
    // single archive reload at the end of each successful save.
    try {
      const saveOut = await saveRecordingText({
        title: (sourceFile.name.replace(/\.[^.]+$/, "") || "Uploaded file").slice(0, 80),
        sourceText: text,
        transcriptText: text,
        provider,
        model: modelLabel,
        language,
        audioFile: sourceFile,
        refreshList: true,
      });
      if (saveOut && typeof saveOut === "object") {
        item.savedName = String((saveOut as { name?: string }).name || "");
        // ``saveRecordingText`` returns ``SavedRecordingRef`` whose
        // shape is ``{ name, archiveDir }`` (camelCase — see
        // SavedRecordingRef interface). The previous read used
        // ``archive_dir`` (snake_case) which is always undefined →
        // savedArchiveDir was always "" and the Upload-pane Reveal-
        // in-Finder button silently sent an empty archiveDir IPC
        // payload. The main process logged "archive_dir empty" and
        // the user saw nothing happen.
        item.savedArchiveDir = String(
          (saveOut as { archiveDir?: string }).archiveDir || "",
        );
      }
    } catch (saveErr) {
      // Persist failure is non-fatal — the transcript is still
      // shown to the user; only the History entry is missing.
      console.warn("Upload: saveRecordingText failed", saveErr);
    }
    // Auto-select the just-completed item in the result pane unless
    // the user has already clicked another item — gives a clear
    // visual confirmation of "this is your transcript" without
    // them having to hunt for it.
    if (uploadSelectedId === null) {
      uploadSelectedId = item.id;
    }
  } catch (e) {
    // Distinguish user-cancelled from genuine error so the queue UI
    // shows "Cancelled" instead of "Failed" — and so the user
    // doesn't have to read a "AbortError: ..." message that's
    // basically meaningless to them.
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    if (isAbort) {
      item.status = "cancelled";
      item.stage = undefined;
    } else {
      item.status = "error";
      item.stage = undefined;
      item.error = sanitizeUiErrorMessage(e, "Transcription failed.");
    }
    item.endedAt = performance.now();
    item.completedAt = Date.now();
  } finally {
    clearTimeout(_stageTimer);
    item.abortController = undefined;
    renderUploadQueue();
  }
}

function uploadStatusLabel(item: UploadQueueItem): string {
  switch (item.status) {
    case "queued":
      return "Queued";
    case "transcribing":
      // Three labelled phases inside the outer "transcribing" status:
      //   uploading  → request body is being handed to the backend.
      //                fetch does not expose browser upload progress,
      //                so this is a stage label unless a future transport
      //                supplies a determinate fraction.
      //   processing → backend is decoding video / running provider
      //                ("Processing…" — better than a stuck percentage).
      //   none       → fallback when neither stage was set (transient
      //                window between latch and first progress event).
      if (item.stage === "uploading") {
        const pct = typeof item.uploadProgress === "number"
          ? Math.round(item.uploadProgress * 100)
          : null;
        return pct !== null ? `Uploading · ${pct}%` : "Uploading…";
      }
      if (item.stage === "processing") return "Processing…";
      return "Transcribing…";
    case "done": {
      const ms = item.endedAt && item.startedAt ? item.endedAt - item.startedAt : 0;
      return `Done · ${(ms / 1000).toFixed(1)}s`;
    }
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatUploadFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function removeUploadItem(id: string): void {
  const idx = uploadQueue.findIndex((it) => it.id === id);
  if (idx === -1) return;
  const item = uploadQueue[idx];
  // Don't yank an item out from under the active processor —
  // user must Cancel first, then remove. (Cancel is a separate
  // button on `transcribing` items via `cancelUploadItem`.)
  if (item.status === "transcribing") return;
  uploadQueue.splice(idx, 1);
  saveUploadQueueSnapshot();
  renderUploadQueue();
}

function cancelUploadItem(id: string): void {
  const item = uploadQueue.find((it) => it.id === id);
  if (!item) return;
  if (item.status === "queued") {
    // Not started yet — just drop it.
    item.status = "cancelled";
    item.endedAt = performance.now();
    item.completedAt = Date.now();
    saveUploadQueueSnapshot();
    renderUploadQueue();
    return;
  }
  if (item.status === "transcribing") {
    // Abort the in-flight fetch. The processor's catch will
    // see DOMException name === "AbortError" and mark it
    // cancelled (NOT error) so the queue UI distinguishes
    // user-cancelled from transcription failures.
    try { item.abortController?.abort(); } catch { /* idempotent */ }
    // Status flip happens inside processUploadItem's finally;
    // no need to set it here. Re-render just to disable the
    // Stop button immediately for visual feedback.
    renderUploadQueue();
  }
}

function renderUploadQueue(): void {
  const list = document.getElementById("uploadQueueList") as HTMLUListElement | null;
  const empty = document.getElementById("uploadEmptyState");
  const clearBtn = document.getElementById("uploadQueueClearBtn") as HTMLButtonElement | null;
  const hideBtn = document.getElementById("uploadQueueHideBtn") as HTMLButtonElement | null;
  const titleEl = document.getElementById("uploadQueueTitle");
  if (!list || !empty || !clearBtn) return;
  const visibleItems = uploadHideFinished
    ? uploadQueue.filter((it) => !isUploadPastItem(it))
    : uploadQueue;
  if (uploadQueue.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    const emptyTitle = empty.querySelector(".upload-empty-state-title");
    const emptySub = empty.querySelector(".upload-empty-state-sub");
    if (emptyTitle) emptyTitle.textContent = "No files yet";
    if (emptySub) {
      emptySub.innerHTML = "Drop audio or video on the left.<br>Each completed file is saved to <b>History</b> automatically.";
    }
    clearBtn.hidden = true;
    if (hideBtn) hideBtn.hidden = true;
    if (titleEl) titleEl.textContent = "Queue";
    return;
  }
  const finished = uploadQueue.filter(
    (it) => it.status === "done" || it.status === "error" || it.status === "cancelled",
  ).length;
  clearBtn.hidden = finished === 0;
  if (hideBtn) {
    hideBtn.hidden = finished === 0;
    hideBtn.textContent = uploadHideFinished ? "Show past" : "Hide past";
    hideBtn.setAttribute("aria-pressed", uploadHideFinished ? "true" : "false");
  }
  if (titleEl) {
    const total = uploadQueue.length;
    titleEl.textContent = `Queue · ${finished}/${total} done`;
  }
  empty.hidden = visibleItems.length > 0;
  if (visibleItems.length === 0) {
    const emptyTitle = empty.querySelector(".upload-empty-state-title");
    const emptySub = empty.querySelector(".upload-empty-state-sub");
    if (emptyTitle) emptyTitle.textContent = "Past queues hidden";
    if (emptySub) emptySub.textContent = "Use Show past to reveal completed queue items.";
  }
  // Clear + rebuild. Queue length is bounded by user clicks (rarely
  // > 50); full re-render is fine and avoids stale-DOM state issues
  // (per-item refs, status class drift across status transitions).
  list.innerHTML = "";
  for (const item of visibleItems) {
    const li = document.createElement("li");
    li.className = `upload-queue-item upload-queue-item--${item.status}`;
    if (item.id === uploadSelectedId) li.classList.add("is-selected");
    // Click anywhere on the item swaps the result-pane to it. The
    // per-item Stop / × button stops propagation so they don't double-
    // trigger the selection.
    li.addEventListener("click", () => {
      uploadSelectedId = item.id;
      renderUploadQueue();
      renderUploadResultPane();
    });

    const header = document.createElement("div");
    header.className = "upload-queue-item-header";

    const dot = document.createElement("span");
    const dotKind = item.status === "cancelled" ? "error" : item.status;
    dot.className = `upload-queue-status-dot upload-queue-status-dot--${dotKind}`;
    dot.setAttribute("aria-hidden", "true");
    header.appendChild(dot);

    const meta = document.createElement("div");
    meta.className = "upload-queue-item-meta";
    const name = document.createElement("span");
    name.className = "upload-queue-item-name";
    name.textContent = uploadItemName(item);
    name.title = uploadItemName(item);
    meta.appendChild(name);
    const sizeStr = formatUploadFileSize(uploadItemSize(item));
    if (sizeStr) {
      const size = document.createElement("span");
      size.className = "upload-queue-item-size";
      size.textContent = sizeStr;
      meta.appendChild(size);
    }
    header.appendChild(meta);

    const tail = document.createElement("div");
    tail.className = "upload-queue-item-tail";
    const status = document.createElement("span");
    status.className = "upload-queue-item-status";
    status.textContent = uploadStatusLabel(item);
    tail.appendChild(status);
    // Per-item action button. While transcribing → Stop (aborts
    // in-flight fetch via the item's AbortController). Otherwise →
    // Remove (drops the item from the queue, no abort needed
    // since it's already settled).
    if (item.status === "transcribing") {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "upload-queue-item-stop";
      stopBtn.setAttribute("aria-label", "Stop transcription");
      stopBtn.title = "Stop transcription";
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        cancelUploadItem(item.id);
      });
      tail.appendChild(stopBtn);
    } else {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "upload-queue-item-remove";
      removeBtn.setAttribute("aria-label", "Remove from queue");
      removeBtn.title = "Remove from queue";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeUploadItem(item.id);
      });
      tail.appendChild(removeBtn);
    }
    header.appendChild(tail);
    li.appendChild(header);

    if (item.status === "transcribing") {
      // Determinate bar only when a transport supplied a real fraction;
      // otherwise use the indeterminate animation for both upload and
      // processing so the UI does not invent progress.
      const progress = document.createElement("div");
      progress.className = "upload-queue-item-progress";
      const bar = document.createElement("div");
      const hasPct = item.stage === "uploading"
        && typeof item.uploadProgress === "number";
      if (hasPct) {
        bar.className = "upload-queue-item-progress-bar is-determinate";
        bar.style.width = `${Math.max(2, Math.round((item.uploadProgress || 0) * 100))}%`;
      } else {
        bar.className = "upload-queue-item-progress-bar";
      }
      progress.appendChild(bar);
      li.appendChild(progress);
    }

    if (item.status === "done") {
      const body = document.createElement("div");
      body.className = "upload-queue-item-body";
      body.textContent = uploadItemResultText(item);
      li.appendChild(body);
      const actions = document.createElement("div");
      actions.className = "upload-queue-item-actions";
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost upload-queue-item-action";
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void (async () => {
          const ok = await writeTextToClipboard(uploadItemResultText(item));
          copyBtn.textContent = ok ? "Copied" : "Copy failed";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
        })();
      });
      actions.appendChild(copyBtn);
      const revealItemBtn = createUploadRevealButton(item);
      if (revealItemBtn) actions.appendChild(revealItemBtn);
      li.appendChild(actions);
    } else if (item.status === "error" && item.error) {
      const err = document.createElement("div");
      err.className = "upload-queue-item-error";
      err.textContent = item.error;
      li.appendChild(err);
    }
    list.appendChild(li);
  }
  renderUploadResultPane();
}

// ── Upload result pane (right column) ──────────────────────────────
//
// Renders the currently-selected queue item's transcript + metadata
// + a "Reveal in Finder" button that asks the Electron main process
// to open the saved transcript file in the OS file manager. Falls back
// gracefully on platforms without ``shell.showItemInFolder`` IPC.
function renderUploadResultPane(): void {
  const textEl = document.getElementById("uploadResultText");
  const metaEl = document.getElementById("uploadResultMeta");
  const titleEl = document.getElementById("uploadResultTitle");
  const copyBtn = document.getElementById("uploadResultCopyBtn") as HTMLButtonElement | null;
  const revealBtn = document.getElementById("uploadResultRevealBtn") as HTMLButtonElement | null;
  if (!textEl || !metaEl) return;
  // Resolve which item to show: explicit user selection wins; else
  // the most-recently-completed item; else nothing.
  let item: UploadQueueItem | undefined;
  if (uploadSelectedId) {
    item = uploadQueue.find((it) => it.id === uploadSelectedId);
    if (item && !isUploadVisibleUnderCurrentFilter(item)) {
      item = undefined;
    }
  }
  if (!item) {
    // Most recent done — sorted by wall-clock completion first so
    // restored queue snapshots and fresh completions share one order.
    const dones = uploadQueue.filter((it) =>
      it.status === "done" &&
      isUploadVisibleUnderCurrentFilter(it)
    );
    dones.sort((a, b) => (b.completedAt || b.endedAt || 0) - (a.completedAt || a.endedAt || 0));
    item = dones[0];
  }
  if (!item) {
    textEl.textContent = "";
    metaEl.hidden = true;
    if (titleEl) titleEl.textContent = "Result";
    if (copyBtn) copyBtn.hidden = true;
    if (revealBtn) revealBtn.hidden = true;
    return;
  }
  if (titleEl) {
    const itemName = uploadItemName(item);
    titleEl.textContent = `Result · ${itemName}`.length > 60
      ? "Result"
      : `Result · ${itemName}`;
  }
  if (item.status === "done") {
    const resultText = uploadItemResultText(item);
    textEl.textContent = resultText;
    metaEl.hidden = false;
    metaEl.innerHTML = "";
    const append = (k: string, v: string) => {
      if (!v) return;
      const span = document.createElement("span");
      span.innerHTML = `<span class="upload-result-meta-key">${k}</span>${v.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)}`;
      metaEl.appendChild(span);
    };
    append("provider", item.provider || "");
    append("model", item.model || "");
    append("language", item.language || "");
    const dur = item.endedAt && item.startedAt ? `${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : "";
    append("duration", dur);
    append("size", formatUploadFileSize(uploadItemSize(item)));
    append("words", String(((item.text || "").match(/\S+/g) || []).length));
    if (copyBtn) {
      copyBtn.hidden = false;
      copyBtn.onclick = () => {
        void (async () => {
          const ok = await writeTextToClipboard(uploadItemResultText(item!));
          flashButtonFeedback(copyBtn, ok ? "Copied" : "Copy failed", "Copy transcript");
        })();
      };
    }
    if (revealBtn) {
      const target = uploadRevealTarget(item);
      revealBtn.hidden = !target;
      revealBtn.onclick = () => {
        revealUploadItem(item);
      };
    }
  } else if (item.status === "error" && item.error) {
    textEl.textContent = item.error;
    metaEl.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (revealBtn) revealBtn.hidden = true;
  } else {
    // queued / transcribing / cancelled — show stage label as the
    // body so the right pane mirrors the queue's per-item state.
    textEl.textContent = uploadStatusLabel(item);
    metaEl.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (revealBtn) revealBtn.hidden = true;
  }
}

// Renderer-side bridge must be installed before setupUploadView(), because
// setupUploadView() immediately restores and renders persisted queue items.
installRevealRecordingBridge();
setupUploadView();
