import "./styles.css";

type Provider = "local" | "fal" | "openrouter";
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

interface AppConfig {
  providers?: {
    fal?: { key?: string };
    openrouter?: { key?: string };
  };
  preferences?: {
    remote_provider?: string;
    recordings_dir?: string;
    fal?: { diarize?: boolean; num_speakers?: number | null; chunk_level?: string; task?: string };
    openrouter?: { model?: string };
  };
}

interface RecordingItem {
  name: string;
  display_name: string;
  modified_at: string;
  size_bytes: number;
}

declare global {
  interface Window {
    __TRANSCRIPTOR_API_TOKEN?: string;
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

const wsBase = (): string => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_JOB_WAIT_MS = 45 * 60 * 1000;
const MIC_STORAGE_KEY = "transcriptor.selectedMicId";
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

let isBusy = false;
let isRecording = false;
let selectedFile: File | null = null;
let pollAbortController: AbortController | null = null;

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
  ["btnStart", "btnStop", "btnTranscribeFile", "pickFileBtn", "mode", "providerSelect"].forEach((id) => {
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

async function parseError(r: Response): Promise<string> {
  let details = `${r.status}`;
  try {
    const j: unknown = await r.json();
    if (typeof j === "object" && j && "detail" in j) {
      const detail = (j as { detail?: unknown }).detail;
      details = typeof detail === "string" ? detail : JSON.stringify(j);
    } else {
      details = JSON.stringify(j);
    }
  } catch {
    try {
      details = await r.text();
    } catch {}
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

async function remoteJob(file: File, opts: { provider: Provider; language: string; diarize: boolean }): Promise<{ job_id: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "fal");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  const r = await fetch("/api/remote/jobs", { method: "POST", body: fd, headers: authHeaders() });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as { job_id: string };
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

async function pollJob(jobId: string, signal: AbortSignal, cb?: (j: JobResponse) => void): Promise<JobResponse> {
  const started = Date.now();
  let waitMs = 1000;
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
    waitMs = Math.min(8000, Math.round(waitMs * 1.4));
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
    const savedVal = localStorage.getItem(MIC_STORAGE_KEY) || "";
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
    const nextVal = curVal || savedVal;
    if (nextVal && Array.from(sel.options).some((o) => o.value === nextVal)) {
      sel.value = nextVal;
    } else if (savedVal) {
      localStorage.removeItem(MIC_STORAGE_KEY);
    }
  } catch (e) {
    console.error("Error loading microphones:", e);
    ($("micSelect") as HTMLSelectElement).innerHTML = '<option value="">Permission denied</option>';
  }
}

($("micSelect") as HTMLSelectElement).onclick = () => void loadMics(true);
($("micSelect") as HTMLSelectElement).addEventListener("change", () => {
  const v = ($("micSelect") as HTMLSelectElement).value || "";
  if (v) localStorage.setItem(MIC_STORAGE_KEY, v);
  else localStorage.removeItem(MIC_STORAGE_KEY);
});

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
  vu = vu * 0.7 + rms * 0.3;
  const pct = Math.min(100, vu * 400);
  $("vuFill").style.width = pct + "%";
  $("vuFill").style.background = pct < 40 ? "#aaa" : pct < 70 ? "#888" : "#666";
}

function resetVU(): void {
  vu = 0;
  setVU(0);
}

async function loadCfg(): Promise<void> {
  try {
    const cfg = await apiGet<AppConfig>("/api/config");
    const falK = ((cfg.providers || {}).fal || {}).key;
    const orK = ((cfg.providers || {}).openrouter || {}).key;
    ($("falKey") as HTMLInputElement).placeholder = falK ? "(saved)" : "FAL_KEY";
    ($("orKey") as HTMLInputElement).placeholder = orK ? "(saved)" : "OPENROUTER_API_KEY";
    ($("falKey") as HTMLInputElement).value = "";
    ($("orKey") as HTMLInputElement).value = "";
    ($("orModel") as HTMLInputElement).value = (cfg.preferences || {}).openrouter?.model || "google/gemini-2.5-flash";
    ($("recordingsDirInput") as HTMLInputElement).value = (cfg.preferences || {}).recordings_dir || "";
    ($("diarizeDefault") as HTMLInputElement).checked = (cfg.preferences || {}).fal?.diarize !== false;
    ($("chunkSelect") as HTMLSelectElement).value = (cfg.preferences || {}).fal?.chunk_level || "segment";
    $("cfgMsg").textContent = "Loaded";
  } catch {
    $("cfgMsg").textContent = "Error loading config";
  }
}

async function saveCfg(): Promise<void> {
  $("cfgMsg").textContent = "Saving...";
  const cfg = {
    providers: {
      fal: { key: ($("falKey") as HTMLInputElement).value.trim() },
      openrouter: { key: ($("orKey") as HTMLInputElement).value.trim() },
    },
    preferences: {
      recordings_dir: ($("recordingsDirInput") as HTMLInputElement).value.trim(),
      fal: { diarize: ($("diarizeDefault") as HTMLInputElement).checked, chunk_level: ($("chunkSelect") as HTMLSelectElement).value },
      openrouter: { model: ($("orModel") as HTMLInputElement).value.trim() },
    },
  };
  await apiPost<{ ok: boolean }>("/api/config", cfg);
  ($("falKey") as HTMLInputElement).value = "";
  ($("orKey") as HTMLInputElement).value = "";
  await loadCfg();
  $("cfgMsg").textContent = "Saved";
}

$("saveBtn").addEventListener("click", () => void saveCfg().catch((e: Error) => ($("cfgMsg").textContent = e.message)));
$("reloadBtn").addEventListener("click", () => void loadCfg().catch((e: Error) => ($("cfgMsg").textContent = e.message)));
$("pickRecordingsDirBtn").addEventListener("click", () =>
  void apiPost<{ path: string }>("/api/recordings/pick-folder", {})
    .then((r) => {
      ($("recordingsDirInput") as HTMLInputElement).value = r.path || "";
    })
    .catch((e: Error) => {
      $("cfgMsg").textContent = e.message;
    })
);

let recordingItems: RecordingItem[] = [];
let selectedRecordingName = "";

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
  if (!keepSelection || !recordingItems.some((x) => x.name === selectedRecordingName)) {
    selectedRecordingName = recordingItems[0]?.name || "";
  }
  renderRecordingsList();
  if (selectedRecordingName) {
    await openRecording(selectedRecordingName);
  } else {
    $("recordingTitle").textContent = "Select recording";
    $("recordingMeta").textContent = "";
    $("recordingContent").textContent = "";
    updateRecordingCopyState();
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
  await loadRecordings(true);
}

$("recordingsRefreshBtn").addEventListener("click", () =>
  void loadRecordings(true).catch((e: Error) => {
    $("recordingContent").textContent = e.message;
    updateRecordingCopyState();
  })
);
$("recordingCopyBtn").addEventListener("click", () => void copyRecordingText());

const autoToggle = $("autoTranscribeToggle") as HTMLInputElement;
autoToggle.checked = localStorage.getItem("transcriptor.autoTranscribe") !== "0";
autoToggle.addEventListener("change", () => {
  localStorage.setItem("transcriptor.autoTranscribe", autoToggle.checked ? "1" : "0");
});

function shouldAutoTranscribe(): boolean {
  return autoToggle.checked && ($("mode") as HTMLSelectElement).value === "live";
}

let ws: WebSocket | null = null;
let ac: AudioContext | null = null;
let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let src: MediaStreamAudioSourceNode | null = null;
let timer: number | null = null;
let startAt = 0;
let chunks: Float32Array[] = [];

function resetOutputs(): void {
  $("liveOutput").textContent = "";
  $("finalOutput").textContent = "";
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

async function startLive(): Promise<void> {
  if (isBusy) return;
  resetOutputs();
  chunks = [];
  setBusy(true);
  isRecording = true;
  setRecordButton(true);
  // Keep single mic button interactive while recording.
  ($("btnStart") as HTMLButtonElement).disabled = false;
  (document.getElementById("btnStop") as HTMLButtonElement).disabled = false;
  setStatus("Starting");

  startAt = Date.now();
  timer = window.setInterval(() => {
    $("timer").textContent = fmtTime((Date.now() - startAt) / 1000);
  }, 200);

  ws = new WebSocket(
    wsBase() +
      "/ws/transcribe?" +
      new URLSearchParams({
        model: ($("model") as HTMLSelectElement).value,
        language: ($("language") as HTMLSelectElement).value,
        token: apiToken(),
      })
  );
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setStatus("Recording");
  ws.onerror = () => {
    $("liveOutput").textContent += "\n[WebSocket error]";
    setStatus("Error");
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
      setStatus("Error");
      return;
    }
    if (msg.type === "segments" && Array.isArray(msg.segments)) {
      const lines = msg.segments
        .map((s) => (typeof s === "object" && s && "text" in s ? String((s as { text?: unknown }).text ?? "").trim() : ""))
        .filter(Boolean);
      if (lines.length) {
        const cur = $("liveOutput").textContent || "";
        $("liveOutput").textContent = cur + (cur ? "\n" : "") + lines.join("\n");
        $("liveOutput").scrollTop = $("liveOutput").scrollHeight;
      }
    }
  };

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    await loadMics(true);
    const devId = ($("micSelect") as HTMLSelectElement).value;
    stream = await navigator.mediaDevices.getUserMedia(devId ? { audio: { deviceId: { exact: devId } } } : { audio: true });
    ac = new AudioContext();
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

      waveFrameCount += 1;
      if (waveFrameCount % WAVE_PUSH_EVERY_FRAMES === 0) {
        const level = Math.min(1, rms * 6.6 + peak * 0.45);
        waveBars.push(level);
        if (waveBars.length > maxBars) waveBars = waveBars.slice(-maxBars);
      }
      draw();
      waveAnimId = requestAnimationFrame(tick);
    };
    tick();

    workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !ac) return;
      const input = ev.data;
      if (!(input instanceof Float32Array)) return;
      const ds = downsample(input, ac.sampleRate, 16000);
      chunks.push(new Float32Array(ds));
      const pcm = new ArrayBuffer(ds.length * 2);
      const dv = new DataView(pcm);
      for (let i = 0; i < ds.length; i++) {
        const x = Math.max(-1, Math.min(1, ds[i]));
        dv.setInt16(i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      }
      try {
        ws.send(pcm);
      } catch {}
    };

    src.connect(workletNode);
  } catch (e) {
    $("liveOutput").textContent = (e as Error).message;
    await stopLive(false);
    setStatus("Error");
  }
}

async function stopLive(enhance: boolean): Promise<void> {
  const sourceLiveText = ($("liveOutput").textContent || "").trim();
  const title = "Recording " + new Date().toLocaleString();
  const providerValue = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
  const languageValue = ($("language") as HTMLSelectElement).value;
  const modelValue = ($("model") as HTMLSelectElement).value;

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (waveAnimId) {
    cancelAnimationFrame(waveAnimId);
    waveAnimId = 0;
  }
  try {
    if (workletNode) {
      workletNode.disconnect();
      workletNode.port.onmessage = null;
    }
  } catch {}
  try {
    if (analyser) analyser.disconnect();
  } catch {}
  try {
    if (src) src.disconnect();
  } catch {}
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch {}
  stream = null;
  try {
    if (ac) await ac.close();
  } catch {}
  ac = null;
  workletNode = null;
  src = null;
  analyser = null;
  try {
    if (ws) ws.close();
  } catch {}
  ws = null;
  isRecording = false;
  setRecordButton(false);
  waveFrameCount = 0;
  waveBars = [];
  draw();
  resetVU();

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
    } catch {}
    setBusy(false);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatus("Idle");
    return;
  }

  const provider = providerValue;
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
    } catch {}
    setBusy(false);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
    setStatus("Idle");
    return;
  }

  setStatus("Processing");
  $("progressRow").hidden = false;
  try {
    pollAbortController?.abort();
    pollAbortController = new AbortController();
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    chunks.forEach((c) => {
      merged.set(c, off);
      off += c.length;
    });
    const wav = encodeWav(merged, 16000);
    const file = new File([wav], `live-${Date.now()}.wav`, { type: "audio/wav" });
    const create =
      provider === "local"
        ? await localJob(file, {
            language: ($("language") as HTMLSelectElement).value,
            model: ($("model") as HTMLSelectElement).value,
            splitStereo: false,
            wordTimestamps: ($("wordTsCheck") as HTMLInputElement).checked,
          })
        : await remoteJob(file, {
            provider,
            language: ($("language") as HTMLSelectElement).value,
            diarize: ($("diarizeCheck") as HTMLInputElement).checked,
          });

    const { job_id } = create;
    const j = await pollJob(job_id, pollAbortController.signal, (job) => {
      $("progressFill").style.width = Math.round((job.progress || 0) * 100) + "%";
      $("progressText").textContent = Math.round((job.progress || 0) * 100) + "%";
    });
    applyJobResult(j);
    try {
      await saveRecordingText({
        title,
        sourceText: sourceLiveText,
        transcriptText: typeof j.result?.text === "string" ? j.result.text : "",
        provider,
        model: modelValue,
        language: languageValue,
      });
    } catch {}
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
    } catch {}
  } finally {
    pollAbortController = null;
    setBusy(false);
    (document.getElementById("btnStop") as HTMLButtonElement).disabled = true;
  }
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
  setStatus("Processing");
  $("progressRow").hidden = false;

  try {
    pollAbortController?.abort();
    pollAbortController = new AbortController();
    const provider = (($("providerSelect") as HTMLSelectElement).value || "local") as Provider;
    let create: { job_id: string };
    if (provider === "local") {
      create = await localJob(selectedFile, {
        language: ($("language") as HTMLSelectElement).value,
        model: ($("model") as HTMLSelectElement).value,
        splitStereo: ($("splitStereoCheck") as HTMLInputElement).checked,
        wordTimestamps: ($("wordTsCheck") as HTMLInputElement).checked,
      });
    } else {
      create = await remoteJob(selectedFile, {
        provider,
        language: ($("language") as HTMLSelectElement).value,
        diarize: ($("diarizeCheck") as HTMLInputElement).checked,
      });
    }

    const j = await pollJob(create.job_id, pollAbortController.signal, (job) => {
      $("progressFill").style.width = Math.round((job.progress || 0) * 100) + "%";
      $("progressText").textContent = Math.round((job.progress || 0) * 100) + "%";
    });
    applyJobResult(j);
  } catch (e) {
    $("progressRow").hidden = true;
    $("finalOutput").textContent = (e as Error).message;
    setStatus("Error");
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

void loadCfg();
void loadMics(false);
void loadRecordings(false).catch(() => {});
draw();
syncMode();
setStatus("Idle");
setRecordButton(false);
updateRecordingCopyState();
