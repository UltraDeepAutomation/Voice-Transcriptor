const $ = (id) => document.getElementById(id);
const fmtTime = (s) => {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
};
const wsBase = () => (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;

let isBusy = false;
let isRecording = false;
let selectedFile = null;

function setBusy(nextBusy) {
  isBusy = !!nextBusy;
  ["btnStart", "btnStop", "btnTranscribeFile", "pickFileBtn", "mode", "providerSelect"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = isBusy;
  });
}

function setStatus(st) {
  $("statusText").textContent = st;
  const dot = $("statusDot");
  dot.className =
    "status-dot" + (st === "Recording" ? " rec" : st === "Processing" ? " process" : st === "Done" ? " done" : "");
}

async function parseError(r) {
  let details = `${r.status}`;
  try {
    const j = await r.json();
    details = j?.detail || JSON.stringify(j);
  } catch {
    try {
      details = await r.text();
    } catch {}
  }
  return details || `HTTP ${r.status}`;
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

function downsample(buf, inRate, outRate) {
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

function encodeWav(float32, sr) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const s = (o, str) => {
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

async function remoteJob(file, opts) {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("provider", opts.provider || "fal");
  fd.set("language", opts.language || "auto");
  fd.set("diarize", String(!!opts.diarize));
  if (opts.numSpeakers) fd.set("num_speakers", String(opts.numSpeakers));
  const r = await fetch("/api/remote/jobs", { method: "POST", body: fd });
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

async function localJob(file, opts) {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.set("language", opts.language || "auto");
  fd.set("model", opts.model || "small");
  fd.set("split_stereo", String(!!opts.splitStereo));
  fd.set("word_timestamps", String(!!opts.wordTimestamps));
  const r = await fetch("/api/jobs", { method: "POST", body: fd });
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

async function pollJob(jobId, cb) {
  while (true) {
    const j = await apiGet("/api/jobs/" + jobId);
    cb && cb(j);
    if (j.status === "done" || j.status === "error") return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function syncMode() {
  const mode = $("mode").value;
  const live = mode === "live";
  $("modeHint").textContent = live
    ? "Live mode: fast local stream from microphone."
    : "Remote mode: upload file and transcribe with selected provider.";

  $("livePane").hidden = !live;
  $("splitGap").hidden = !live;
  $("waveCanvas").closest(".wave-row").hidden = !live;
  $("uploadPanel").hidden = live;

  $("btnStart").style.display = live ? "inline-flex" : "none";
  $("btnStop").style.display = live ? "inline-flex" : "none";

  if (!live && isRecording) {
    stopLive(false);
  }
}

document.querySelectorAll(".sb-item").forEach((e) => {
  e.onclick = () => {
    const v = e.dataset.view;
    document.querySelectorAll(".view").forEach((el) => (el.hidden = el.dataset.view !== v));
    document.querySelectorAll(".sb-item").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  };
});

$("mode").onchange = syncMode;

async function loadMics(forceReload = false) {
  try {
    if (forceReload) {
      $("micSelect").innerHTML = '<option value="">Loading...</option>';
    }
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    const sel = $("micSelect");
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
    if (curVal) sel.value = curVal;
  } catch (e) {
    console.error("Error loading microphones:", e);
    $("micSelect").innerHTML = '<option value="">Permission denied</option>';
  }
}

$("micSelect").onclick = () => loadMics(true);

const canvas = $("waveCanvas");
const ctx = canvas.getContext("2d");
let waveData = [];
let maxSamples = 0;
let waveAnimId = null;

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;
  maxSamples = Math.round(r.width * 1.5);
  draw();
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

function draw() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const mid = H / 2;
  if (waveData.length < 2) {
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
    return;
  }
  const step = waveData.length / W;
  const amp = mid * 0.7;
  ctx.strokeStyle = "#aaa";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const idx = Math.min(Math.floor(x * step), waveData.length - 1);
    const s = waveData[waveData.length - 1 - idx];
    const y = mid + s * amp;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

let vu = 0;
function setVU(rms) {
  vu = vu * 0.7 + rms * 0.3;
  const pct = Math.min(100, vu * 400);
  $("vuFill").style.width = pct + "%";
  $("vuFill").style.background = pct < 40 ? "#aaa" : pct < 70 ? "#888" : "#666";
}
function resetVU() {
  vu = 0;
  setVU(0);
}

async function loadCfg() {
  try {
    const cfg = await apiGet("/api/config");
    const falK = ((cfg.providers || {}).fal || {}).key;
    const orK = ((cfg.providers || {}).openrouter || {}).key;
    $("falKey").placeholder = falK ? "(saved)" : "FAL_KEY";
    $("orKey").placeholder = orK ? "(saved)" : "OPENROUTER_API_KEY";
    $("falKey").value = "";
    $("orKey").value = "";
    $("orModel").value = (cfg.preferences || {}).openrouter?.model || "google/gemini-2.5-flash";
    $("diarizeDefault").checked = (cfg.preferences || {}).fal?.diarize !== false;
    $("chunkSelect").value = (cfg.preferences || {}).fal?.chunk_level || "segment";
    $("cfgMsg").textContent = "Loaded";
  } catch {
    $("cfgMsg").textContent = "Error loading config";
  }
}

async function saveCfg() {
  $("cfgMsg").textContent = "Saving...";
  const cfg = {
    providers: { fal: { key: $("falKey").value.trim() }, openrouter: { key: $("orKey").value.trim() } },
    preferences: {
      fal: { diarize: $("diarizeDefault").checked, chunk_level: $("chunkSelect").value },
      openrouter: { model: $("orModel").value.trim() },
    },
  };
  await apiPost("/api/config", cfg);
  $("falKey").value = "";
  $("orKey").value = "";
  await loadCfg();
  $("cfgMsg").textContent = "Saved";
}

$("saveBtn").onclick = () => saveCfg().catch((e) => ($("cfgMsg").textContent = e.message));
$("reloadBtn").onclick = () => loadCfg().catch((e) => ($("cfgMsg").textContent = e.message));

let ws = null;
let ac = null;
let stream = null;
let analyser = null;
let proc = null;
let src = null;
let gain = null;
let timer = null;
let startAt = 0;
let chunks = [];

function resetOutputs() {
  $("liveOutput").textContent = "";
  $("finalOutput").textContent = "";
  $("timer").textContent = "00:00";
  $("progressRow").hidden = true;
  $("downloadRow").hidden = true;
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "0%";
}

function applyJobResult(j) {
  $("progressRow").hidden = true;
  if (j.status === "done" && j.result && j.result.text) {
    $("finalOutput").textContent = j.result.text;
    $("downloadRow").hidden = false;
    $("dlTxt").href = "/api/jobs/" + j.job_id + "/download/txt";
    $("dlJson").href = "/api/jobs/" + j.job_id + "/download/json";
    setStatus("Done");
  } else if (j.status === "error") {
    $("finalOutput").textContent = j.error || "Error";
    setStatus("Error");
  } else {
    $("finalOutput").textContent = "Empty result";
    setStatus("Error");
  }
}

async function startLive() {
  if (isBusy) return;
  resetOutputs();
  chunks = [];
  setBusy(true);
  isRecording = true;
  $("btnStop").disabled = false;
  setStatus("Starting");

  startAt = Date.now();
  timer = setInterval(() => {
    $("timer").textContent = fmtTime((Date.now() - startAt) / 1000);
  }, 200);

  ws = new WebSocket(wsBase() + "/ws/transcribe?" + new URLSearchParams({ model: $("model").value, language: $("language").value }));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setStatus("Recording");
  ws.onerror = () => {
    $("liveOutput").textContent += "\n[WebSocket error]";
    setStatus("Error");
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "error") {
      $("liveOutput").textContent += "\n[" + m.error + "]";
      setStatus("Error");
    }
    if (m.type === "segments" && Array.isArray(m.segments)) {
      const lines = m.segments.map((s) => (s.text || "").trim()).filter(Boolean);
      if (lines.length) {
        const cur = $("liveOutput").textContent;
        $("liveOutput").textContent = cur + (cur ? "\n" : "") + lines.join("\n");
        $("liveOutput").scrollTop = $("liveOutput").scrollHeight;
      }
    }
  };

  try {
    await loadMics(true);
    const devId = $("micSelect").value;
    stream = await navigator.mediaDevices.getUserMedia(devId ? { audio: { deviceId: { exact: devId } } } : { audio: true });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    src = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    proc = ac.createScriptProcessor(4096, 1, 1);
    gain = ac.createGain();
    gain.gain.value = 0;

    const buf = new Float32Array(analyser.fftSize);
    function tick() {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      setVU(Math.sqrt(sum / buf.length));
      waveData = waveData.concat(Array.from(buf));
      if (waveData.length > maxSamples) waveData = waveData.slice(-maxSamples);
      draw();
      waveAnimId = requestAnimationFrame(tick);
    }
    tick();

    proc.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
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

    src.connect(proc);
    proc.connect(gain);
    gain.connect(ac.destination);
  } catch (e) {
    $("liveOutput").textContent = e.message;
    await stopLive(false);
    setStatus("Error");
  }
}

async function stopLive(enhance) {
  clearInterval(timer);
  if (waveAnimId) {
    cancelAnimationFrame(waveAnimId);
    waveAnimId = null;
  }
  try {
    if (proc) {
      proc.disconnect();
      proc.onaudioprocess = null;
    }
  } catch {}
  try {
    if (analyser) analyser.disconnect();
  } catch {}
  try {
    if (src) src.disconnect();
  } catch {}
  try {
    if (gain) gain.disconnect();
  } catch {}
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch {}
  stream = null;
  try {
    if (ac) ac.close();
  } catch {}
  ac = proc = src = gain = analyser = null;
  try {
    if (ws) ws.close();
  } catch {}
  ws = null;
  isRecording = false;
  waveData = [];
  draw();
  resetVU();

  if (!enhance || chunks.length === 0) {
    setBusy(false);
    $("btnStop").disabled = true;
    setStatus("Idle");
    return;
  }

  const provider = $("providerSelect").value;
  if (!provider || provider === "local") {
    setBusy(false);
    $("btnStop").disabled = true;
    setStatus("Idle");
    return;
  }

  setStatus("Processing");
  $("progressRow").hidden = false;
  try {
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    chunks.forEach((c) => {
      merged.set(c, off);
      off += c.length;
    });
    const wav = encodeWav(merged, 16000);
    const file = new File([wav], "live-" + Date.now() + ".wav", { type: "audio/wav" });
    const { job_id } = await remoteJob(file, {
      provider,
      language: $("language").value,
      diarize: $("diarizeCheck").checked,
    });
    const j = await pollJob(job_id, (job) => {
      $("progressFill").style.width = Math.round((job.progress || 0) * 100) + "%";
      $("progressText").textContent = Math.round((job.progress || 0) * 100) + "%";
    });
    applyJobResult(j);
  } catch (e) {
    $("progressRow").hidden = true;
    $("finalOutput").textContent = e.message;
    setStatus("Error");
  } finally {
    setBusy(false);
    $("btnStop").disabled = true;
  }
}

function setSelectedFile(file) {
  selectedFile = file || null;
  $("fileName").textContent = selectedFile ? `${selectedFile.name} (${Math.round(selectedFile.size / 1024)} KB)` : "No file selected";
}

async function transcribeSelectedFile() {
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
    const provider = $("providerSelect").value || "local";
    let create;
    if (provider === "local") {
      create = await localJob(selectedFile, {
        language: $("language").value,
        model: $("model").value,
        splitStereo: $("splitStereoCheck").checked,
        wordTimestamps: $("wordTsCheck").checked,
      });
    } else {
      create = await remoteJob(selectedFile, {
        provider,
        language: $("language").value,
        diarize: $("diarizeCheck").checked,
      });
    }

    const j = await pollJob(create.job_id, (job) => {
      $("progressFill").style.width = Math.round((job.progress || 0) * 100) + "%";
      $("progressText").textContent = Math.round((job.progress || 0) * 100) + "%";
    });
    applyJobResult(j);
  } catch (e) {
    $("progressRow").hidden = true;
    $("finalOutput").textContent = e.message;
    setStatus("Error");
  } finally {
    setBusy(false);
  }
}

const drop = $("uploadDrop");
const fileInput = $("fileInput");

$("pickFileBtn").onclick = () => fileInput.click();
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
drop.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  setSelectedFile(files[0]);
});

$("btnTranscribeFile").onclick = () => transcribeSelectedFile();
$("btnStart").onclick = () => startLive();
$("btnStop").onclick = () => {
  const provider = $("providerSelect").value;
  const shouldEnhance = $("mode").value === "live" && provider !== "" && provider !== "local";
  stopLive(shouldEnhance);
};

loadCfg();
loadMics();
draw();
syncMode();
setStatus("Idle");
