import json
import os
import asyncio
import uuid
import re
import secrets
import threading
import time
import subprocess
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import (
    Body,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.audio import AudioError, ensure_wav_16k, split_channels
from backend.config import APP_ROOT, DATA_DIR, load_config, redact_config, save_config
from backend.live import LiveSession
from backend.jobs import JobStore
from backend.remote_fal import RemoteError as FalRemoteError
from backend.remote_fal import fal_whisper_transcribe
from backend.remote_openrouter import RemoteError as OrRemoteError
from backend.remote_openrouter import openrouter_transcribe
from backend.transcribe import merge_channel_transcripts, transcribe_file


UPLOADS_DIR = DATA_DIR / "uploads"
RESULTS_DIR = DATA_DIR / "results"
LIVE_RECOVERY_DIR = DATA_DIR / "live_recovery"
for d in (UPLOADS_DIR, RESULTS_DIR, LIVE_RECOVERY_DIR):
    d.mkdir(parents=True, exist_ok=True)


app = FastAPI(title="Call Transcriptor")
jobs = JobStore(max_workers=2)

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
RATE_LIMIT_PER_MIN = 120
WS_CONNECT_LIMIT_PER_MIN = 20
RESULT_RETENTION_SEC = int(os.environ.get("TRANSCRIPTOR_RESULT_RETENTION_SEC", "86400"))
LIVE_RECOVERY_RETENTION_SEC = int(os.environ.get("TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC", "86400"))
ALLOWED_LOCAL_MODELS = {"tiny", "base", "small", "medium", "large-v3"}
ALLOWED_REMOTE_PROVIDERS = {"fal", "openrouter"}
ALLOWED_AUDIO_EXTS = {
    ".wav",
    ".mp3",
    ".m4a",
    ".flac",
    ".ogg",
    ".aac",
    ".mp4",
    ".webm",
}

COMMON_STOPWORDS = {
    "и", "в", "на", "что", "как", "это", "я", "ты", "мы", "вы", "он", "она", "оно", "они",
    "а", "но", "же", "ли", "не", "да", "нет", "к", "у", "по", "с", "со", "из", "от", "за",
    "to", "the", "a", "an", "and", "or", "for", "of", "in", "on", "is", "it", "that", "this",
    "i", "you", "we", "they", "he", "she", "be", "are", "was", "were", "do", "does", "did",
}


frontend_dir = APP_ROOT / "frontend"
frontend_dist_dir_candidate = frontend_dir / "dist"
if (frontend_dist_dir_candidate / "index.html").exists():
    frontend_dist_dir = frontend_dist_dir_candidate
elif (frontend_dir / "index.html").exists():
    # Desktop packaged layout: resources/frontend/{index.html,assets/...}
    frontend_dist_dir = frontend_dir
else:
    # Default dev layout; index handler will return a clear error if still missing.
    frontend_dist_dir = frontend_dist_dir_candidate

frontend_assets_dir = frontend_dist_dir / "assets"
API_TOKEN_PATH = DATA_DIR / "api_token.txt"
_rate_lock = threading.Lock()
_request_windows: dict[str, deque[float]] = defaultdict(deque)
_ws_windows: dict[str, deque[float]] = defaultdict(deque)


def _load_or_create_api_token() -> str:
    env_token = os.environ.get("TRANSCRIPTOR_API_TOKEN", "").strip()
    if env_token:
        return env_token
    if API_TOKEN_PATH.exists():
        token = API_TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    API_TOKEN_PATH.write_text(token, encoding="utf-8")
    try:
        os.chmod(API_TOKEN_PATH, 0o600)
    except Exception:
        pass
    return token


API_TOKEN = _load_or_create_api_token()


def _origin_allowed(origin: str, request: Request) -> bool:
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"}:
        return False
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        return False
    req_port = request.url.port
    if req_port is None:
        req_port = 443 if request.url.scheme == "https" else 80
    origin_port = parsed.port
    if origin_port is None:
        origin_port = 443 if parsed.scheme == "https" else 80
    return origin_port == req_port


def _touch_rate_limit(bucket: dict[str, deque[float]], key: str, limit_per_min: int) -> bool:
    now = time.time()
    cutoff = now - 60.0
    with _rate_lock:
        q = bucket[key]
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit_per_min:
            return False
        q.append(now)
        return True


def _cleanup_expired_files() -> None:
    if RESULT_RETENTION_SEC <= 0:
        return
    now = time.time()
    cutoff = now - RESULT_RETENTION_SEC
    for base in (RESULTS_DIR, UPLOADS_DIR):
        for p in base.glob("*"):
            try:
                if not p.is_file():
                    continue
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
            except Exception:
                pass


def _cleanup_live_recovery_files() -> None:
    if LIVE_RECOVERY_RETENTION_SEC <= 0:
        return
    cutoff = time.time() - LIVE_RECOVERY_RETENTION_SEC
    for p in LIVE_RECOVERY_DIR.glob("*"):
        try:
            if not p.is_file():
                continue
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except Exception:
            pass


async def _require_api_auth(request: Request) -> None:
    if request.url.path == "/api/health":
        return
    provided = (request.headers.get("x-api-token") or "").strip()
    if not provided or provided != API_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin and not _origin_allowed(origin, request):
            raise HTTPException(status_code=403, detail="forbidden origin")
    client_key = request.client.host if request.client else "unknown"
    if not _touch_rate_limit(_request_windows, client_key, RATE_LIMIT_PER_MIN):
        raise HTTPException(status_code=429, detail="rate limit exceeded")


if frontend_assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(frontend_assets_dir)), name="assets")


@app.get("/", response_class=HTMLResponse)
def index():
    index_path = frontend_dist_dir / "index.html"
    if not index_path.exists():
        return "frontend/dist/index.html not found. Run `npm --prefix frontend run build`."
    html = index_path.read_text(encoding="utf-8")
    injected = (
        "<script>"
        f'window.__TRANSCRIPTOR_API_TOKEN={json.dumps(API_TOKEN)};'
        "</script>"
    )
    if "</body>" in html:
        return html.replace("</body>", injected + "</body>")
    return html + injected


@app.get("/api/health")
def health():
    return {"ok": True}


async def _save_upload_file(upload: UploadFile, target: Path) -> int:
    total = 0
    with target.open("wb") as f:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
                )
            f.write(chunk)
    return total


def _normalize_filename(name: str) -> str:
    base = os.path.basename(name or "audio")
    # Keep alnum, dot, dash, underscore only to avoid strange filenames.
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return cleaned or "audio.wav"


def _validate_audio_filename(name: str) -> None:
    ext = Path(name).suffix.lower()
    if ext and ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=400, detail="unsupported audio file extension")


def _normalize_language(value: str) -> Optional[str]:
    language = (value or "auto").strip()
    if language.lower() in {"", "auto"}:
        return None
    # ISO-like tags (en, ru, pt-BR, etc.)
    if not re.fullmatch(r"[A-Za-z]{2,8}(-[A-Za-z]{2,8}){0,2}", language):
        raise HTTPException(status_code=400, detail="invalid language code")
    return language


def _is_broken_pipe_error(exc: Exception) -> bool:
    msg = str(exc or "").lower()
    if isinstance(exc, BrokenPipeError):
        return True
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 32:
        return True
    return "broken pipe" in msg or "errno 32" in msg


def _transcribe_with_retry(
    audio_path: str,
    model: str,
    *,
    language: Optional[str],
    word_timestamps: bool,
    retries: int = 1,
):
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            return transcribe_file(
                audio_path,
                model,
                language=language,
                word_timestamps=word_timestamps,
            )
        except Exception as e:
            last_exc = e
            if not _is_broken_pipe_error(e) or attempt >= retries:
                raise
            # Short backoff before retrying transient pipe failures.
            print(f"[transcribe retry] broken pipe on attempt {attempt + 1}, retrying...")
            time.sleep(0.35)
    if last_exc:
        raise last_exc
    raise RuntimeError("transcribe_with_retry failed without exception")


def _validate_config_payload(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid config")
    providers = payload.get("providers")
    if providers is not None and not isinstance(providers, dict):
        raise HTTPException(status_code=400, detail="providers must be an object")
    preferences = payload.get("preferences")
    if preferences is not None and not isinstance(preferences, dict):
        raise HTTPException(status_code=400, detail="preferences must be an object")
    if isinstance(preferences, dict):
        rec_dir = preferences.get("recordings_dir")
        if rec_dir is not None and not isinstance(rec_dir, str):
            raise HTTPException(status_code=400, detail="recordings_dir must be a string")


def _resolve_recordings_dir(cfg: Optional[dict] = None) -> Path:
    cfg = cfg or load_config()
    prefs = cfg.get("preferences") or {}
    custom = (prefs.get("recordings_dir") or "").strip()
    default_dir = DATA_DIR / "recordings"
    default_dir.mkdir(parents=True, exist_ok=True)
    if custom:
        p = Path(custom).expanduser()
        if not p.is_absolute():
            p = (DATA_DIR / p).resolve()
        else:
            p = p.resolve()

        # Prevent storing recordings inside app bundle resources.
        volatile_app_path = False
        try:
            p.relative_to(APP_ROOT.resolve())
            volatile_app_path = True
        except Exception:
            volatile_app_path = False

        if volatile_app_path:
            try:
                if p.exists() and p.is_dir():
                    for txt in p.glob("*.txt"):
                        dst = default_dir / txt.name
                        if not dst.exists():
                            dst.write_bytes(txt.read_bytes())
            except Exception:
                pass
            try:
                prefs["recordings_dir"] = ""
                cfg["preferences"] = prefs
                save_config(cfg)
            except Exception:
                pass
            return default_dir

        p.mkdir(parents=True, exist_ok=True)
        return p
    return default_dir


def _sanitize_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", (value or "").strip())
    return cleaned[:80].strip(" ._-") or "recording"


def _recording_filename(title: str) -> str:
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return f"{ts}__{_sanitize_name(title)}.txt"


def _recording_path_or_404(name: str) -> Path:
    safe = os.path.basename(name or "")
    if not safe.endswith(".txt") or safe in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="invalid recording name")
    p = _resolve_recordings_dir() / safe
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="recording not found")
    return p


def _extract_stats_text(content: str) -> str:
    text = (content or "").strip()
    if not text:
        return ""
    m = re.search(r"(?:Original:|Transcription:)\s*(.*)", text, flags=re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return text


def _tokenize_words(text: str) -> list[str]:
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]{2,}", (text or "").lower())
    return [w for w in words if w not in COMMON_STOPWORDS]


def _extract_meta_field(content: str, field: str) -> str:
    pattern = rf"^{re.escape(field)}:\s*(.+)$"
    m = re.search(pattern, content or "", flags=re.IGNORECASE | re.MULTILINE)
    return (m.group(1).strip() if m else "")


@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    _cleanup_live_recovery_files()
    token = (websocket.query_params.get("token") or "").strip()
    if token != API_TOKEN:
        await websocket.close(code=4401, reason="unauthorized")
        return
    client_key = websocket.client.host if websocket.client else "unknown"
    if not _touch_rate_limit(_ws_windows, client_key, WS_CONNECT_LIMIT_PER_MIN):
        await websocket.close(code=4429, reason="rate limit exceeded")
        return
    await websocket.accept()

    qp = websocket.query_params
    model = (qp.get("model") or "small").strip() or "small"
    language = (qp.get("language") or "auto").strip()
    lang_opt: Optional[str] = None if language in ("", "auto", "Auto") else language

    session = LiveSession(model_name=model, language=lang_opt)
    stop = asyncio.Event()
    started_at = datetime.now()
    session_id = str(uuid.uuid4())
    recovery_pcm_path = LIVE_RECOVERY_DIR / f"{started_at.strftime('%Y%m%d_%H%M%S')}_{session_id}.pcm16"
    recovery_meta_path = LIVE_RECOVERY_DIR / f"{started_at.strftime('%Y%m%d_%H%M%S')}_{session_id}.json"
    recovery_file = recovery_pcm_path.open("wb")

    chunk_count = 0
    byte_count = 0
    had_error = False

    async def receiver():
        nonlocal chunk_count, byte_count
        try:
            while not stop.is_set():
                data = await websocket.receive_bytes()
                chunk_count += 1
                byte_count += len(data)
                recovery_file.write(data)
                await session.append_pcm16le(data)
        except WebSocketDisconnect:
            stop.set()
        except Exception as e:
            nonlocal had_error
            had_error = True
            print(f"[ws receiver] error: {e}")
            stop.set()

    async def transcriber():
        try:
            while not stop.is_set():
                out = await session.maybe_transcribe()
                if out:
                    await websocket.send_text(json.dumps(out, ensure_ascii=False))
                await asyncio.sleep(0.2)
        except Exception as e:
            nonlocal had_error
            had_error = True
            print(f"[ws transcriber] error: {e}")
            stop.set()

    rx = asyncio.create_task(receiver())
    tx = asyncio.create_task(transcriber())
    try:
        done, pending = await asyncio.wait(
            {rx, tx}, return_when=asyncio.FIRST_EXCEPTION
        )
        for t in done:
            exc = t.exception()
            if exc:
                raise exc
    except WebSocketDisconnect:
        stop.set()
    except Exception as e:
        had_error = True
        stop.set()
        try:
            await websocket.send_text(
                json.dumps({"type": "error", "error": str(e)}, ensure_ascii=False)
            )
        except Exception:
            pass
    finally:
        stop.set()
        for t in (rx, tx):
            if not t.done():
                t.cancel()
        try:
            recovery_file.flush()
            recovery_file.close()
        except Exception:
            pass
        # Keep only meaningful captures; remove tiny accidental openings.
        try:
            if byte_count < 32000:  # ~1s at 16kHz mono pcm16
                recovery_pcm_path.unlink(missing_ok=True)
                recovery_meta_path.unlink(missing_ok=True)
            elif not had_error:
                # Normal/healthy session: no need to keep raw audio.
                recovery_pcm_path.unlink(missing_ok=True)
                recovery_meta_path.unlink(missing_ok=True)
            else:
                recovery_meta_path.write_text(
                    json.dumps(
                        {
                            "session_id": session_id,
                            "started_at": started_at.isoformat(),
                            "finished_at": datetime.now().isoformat(),
                            "sample_rate": 16000,
                            "format": "pcm16le_mono",
                            "bytes": byte_count,
                            "chunks": chunk_count,
                            "model": model,
                            "language": lang_opt or "auto",
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
        except Exception:
            pass


@app.post("/api/jobs")
async def create_job(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model: str = Form("small"),
    split_stereo: bool = Form(True),
    word_timestamps: bool = Form(False),
):
    _cleanup_expired_files()
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")

    job_id = str(uuid.uuid4())
    jobs.create(job_id)

    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    upload_path = UPLOADS_DIR / f"{job_id}.{orig_name}"
    await _save_upload_file(file, upload_path)

    lang_opt = _normalize_language(language)

    def run():
        temp_paths = []
        try:
            jobs.set_running(job_id)
            # Convert to 16k wav; prefer stereo so we can split for calls.
            wav_path = str(RESULTS_DIR / f"{job_id}.16k.wav")
            temp_paths.append(wav_path)
            ensure_wav_16k(
                str(upload_path), wav_path, channels=2 if split_stereo else 1
            )
            jobs.set_progress(job_id, 0.15)

            ch1, ch2 = split_channels(wav_path) if split_stereo else (None, None)
            if split_stereo and ch1 and ch2:
                temp_paths.extend([ch1, ch2])
                jobs.set_progress(job_id, 0.2)
                t1 = _transcribe_with_retry(
                    ch1, model, language=lang_opt, word_timestamps=word_timestamps
                )
                jobs.set_progress(job_id, 0.6)
                t2 = _transcribe_with_retry(
                    ch2, model, language=lang_opt, word_timestamps=word_timestamps
                )
                jobs.set_progress(job_id, 0.9)
                result = merge_channel_transcripts(t1, t2)
            else:
                jobs.set_progress(job_id, 0.25)
                mono_wav = str(RESULTS_DIR / f"{job_id}.mono16k.wav")
                temp_paths.append(mono_wav)
                ensure_wav_16k(str(upload_path), mono_wav, channels=1)
                result = _transcribe_with_retry(
                    mono_wav, model, language=lang_opt, word_timestamps=word_timestamps
                )

            result_json_path = RESULTS_DIR / f"{job_id}.json"
            result_txt_path = RESULTS_DIR / f"{job_id}.txt"
            result_json_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            result_txt_path.write_text(result.get("text", ""), encoding="utf-8")
            jobs.set_done(
                job_id,
                result,
                {
                    "json": str(result_json_path),
                    "txt": str(result_txt_path),
                },
            )
        except AudioError as e:
            jobs.set_error(job_id, str(e))
        except Exception as e:
            jobs.set_error(job_id, f"Transcription failed: {e}")
        finally:
            for p in temp_paths:
                try:
                    os.remove(p)
                except Exception:
                    pass
            try:
                os.remove(upload_path)
            except Exception:
                pass

    jobs.submit(run)
    return {"job_id": job_id}


def _format_fal_transcript(result: dict) -> str:
    chunks = result.get("chunks") or []
    if not isinstance(chunks, list) or not chunks:
        return (result.get("text") or "").strip()

    lines = []
    last_speaker = None
    last_text = ""
    for c in chunks:
        if not isinstance(c, dict):
            continue
        text = (c.get("text") or "").strip()
        if not text:
            continue
        speaker = c.get("speaker")
        speaker_id = "Speaker" if speaker is None else str(speaker)
        if speaker_id == last_speaker:
            last_text = (last_text + " " + text).strip()
            if lines:
                lines[-1] = f"{last_speaker}: {last_text}"
        else:
            last_speaker = speaker_id
            last_text = text
            lines.append(f"{speaker_id}: {text}")
    return "\n".join(lines).strip() or (result.get("text") or "").strip()


@app.post("/api/remote/jobs")
async def create_remote_job(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    provider: str = Form(""),
    language: str = Form("auto"),
    diarize: bool = Form(True),
    num_speakers: str = Form(""),
    openrouter_model: str = Form(""),
):
    _cleanup_expired_files()
    provider_norm = (provider or "").strip()
    if provider_norm and provider_norm not in ALLOWED_REMOTE_PROVIDERS:
        raise HTTPException(status_code=400, detail="unsupported provider")

    job_id = str(uuid.uuid4())
    jobs.create(job_id)

    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    upload_path = UPLOADS_DIR / f"{job_id}.{orig_name}"
    await _save_upload_file(file, upload_path)

    lang_opt = _normalize_language(language)

    def run():
        try:
            jobs.set_running(job_id)
            jobs.set_progress(job_id, 0.05)

            cfg = load_config()
            prov = (
                provider_norm
                or cfg.get("preferences", {}).get("remote_provider")
                or "fal"
            ).strip()

            audio_bytes = upload_path.read_bytes()
            jobs.set_progress(job_id, 0.15)
            if prov == "fal":
                fal_key = ((cfg.get("providers") or {}).get("fal") or {}).get(
                    "key"
                ) or ""
                pref = (cfg.get("preferences") or {}).get("fal") or {}
                ns = None
                if num_speakers.strip():
                    try:
                        ns = int(num_speakers.strip())
                    except Exception:
                        ns = None
                if ns is None:
                    ns = pref.get("num_speakers")

                out = fal_whisper_transcribe(
                    fal_key=fal_key,
                    audio_bytes=audio_bytes,
                    filename=orig_name,
                    task=pref.get("task") or "transcribe",
                    language=lang_opt,
                    diarize=bool(diarize)
                    if diarize is not None
                    else bool(pref.get("diarize", True)),
                    num_speakers=ns,
                    chunk_level=pref.get("chunk_level") or "segment",
                    timeout_sec=600,
                )
                text = _format_fal_transcript(out)
                result = {
                    "provider": "fal",
                    "text": text,
                    "raw": out,
                }
            elif prov == "openrouter":
                or_key = ((cfg.get("providers") or {}).get("openrouter") or {}).get(
                    "key"
                ) or ""
                pref = (cfg.get("preferences") or {}).get("openrouter") or {}
                model = (
                    openrouter_model or pref.get("model") or "google/gemini-2.5-flash"
                ).strip()
                out = openrouter_transcribe(
                    api_key=or_key,
                    model=model,
                    audio_bytes=audio_bytes,
                    filename=orig_name,
                )
                result = {
                    "provider": "openrouter",
                    "model": model,
                    "text": (out.get("text") or "").strip(),
                    "raw": out.get("raw"),
                }
            else:
                raise Exception(f"Unknown provider: {prov}")

            jobs.set_progress(job_id, 0.95)
            result_json_path = RESULTS_DIR / f"{job_id}.remote.json"
            result_txt_path = RESULTS_DIR / f"{job_id}.remote.txt"
            result_json_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            result_txt_path.write_text(result.get("text", ""), encoding="utf-8")
            jobs.set_done(
                job_id,
                result,
                {
                    "json": str(result_json_path),
                    "txt": str(result_txt_path),
                },
            )
        except (FalRemoteError, OrRemoteError) as e:
            jobs.set_error(job_id, str(e))
        except Exception as e:
            jobs.set_error(job_id, f"Remote transcription failed: {e}")
        finally:
            try:
                os.remove(upload_path)
            except Exception:
                pass

    jobs.submit(run)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, _auth: None = Depends(_require_api_auth)):
    _cleanup_expired_files()
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "result": job.result if job.status == "done" else None,
        "result_files": job.result_files if job.status == "done" else None,
    }


@app.get("/api/jobs/{job_id}/download/{kind}")
def download(job_id: str, kind: str, _auth: None = Depends(_require_api_auth)):
    if kind not in {"txt", "json"}:
        raise HTTPException(status_code=400, detail="unsupported file kind")
    job = jobs.get(job_id)
    if not job or job.status != "done":
        raise HTTPException(status_code=404, detail="job not found")
    path = job.result_files.get(kind)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="file not found")
    media_type = "application/json" if kind == "json" else "text/plain"
    filename = f"{job_id}.{kind}"
    return FileResponse(path, media_type=media_type, filename=filename)


@app.get("/api/config")
def get_config(_auth: None = Depends(_require_api_auth)):
    return redact_config(load_config())


@app.post("/api/config")
def set_config(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _validate_config_payload(payload)
    save_config(payload)
    return {"ok": True}


@app.post("/api/recordings/pick-folder")
def pick_recordings_folder(_auth: None = Depends(_require_api_auth)):
    if os.name != "posix":
        raise HTTPException(status_code=400, detail="folder picker supported on macOS only")
    try:
        result = subprocess.run(
            [
                "osascript",
                "-e",
                'POSIX path of (choose folder with prompt "Select folder for recordings")',
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        selected = (result.stdout or "").strip()
        if not selected:
            raise HTTPException(status_code=400, detail="no folder selected")
        p = Path(selected).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return {"path": str(p)}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="folder picker timed out")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        if "User canceled" in stderr:
            raise HTTPException(status_code=400, detail="selection canceled")
        raise HTTPException(status_code=500, detail=f"folder picker failed: {stderr or 'unknown error'}")


@app.get("/api/recordings")
def list_recordings(_auth: None = Depends(_require_api_auth)):
    d = _resolve_recordings_dir()
    items = []
    for p in d.glob("*.txt"):
        try:
            st = p.stat()
            items.append(
                {
                    "name": p.name,
                    "display_name": p.stem,
                    "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
                    "size_bytes": st.st_size,
                }
            )
        except Exception:
            continue
    items.sort(key=lambda x: x["modified_at"], reverse=True)
    return {"items": items, "directory": str(d)}


@app.get("/api/recordings/{recording_name}")
def get_recording(recording_name: str, _auth: None = Depends(_require_api_auth)):
    p = _recording_path_or_404(recording_name)
    st = p.stat()
    return {
        "name": p.name,
        "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
        "size_bytes": st.st_size,
        "content": p.read_text(encoding="utf-8", errors="replace"),
    }


@app.get("/api/recordings/stats/summary")
def get_recordings_stats(_auth: None = Depends(_require_api_auth)):
    d = _resolve_recordings_dir()
    files = sorted(d.glob("*.txt"))
    total_recordings = len(files)
    total_words = 0
    total_chars = 0
    durations_sec: list[int] = []
    word_freq: dict[str, int] = defaultdict(int)
    providers: dict[str, int] = defaultdict(int)
    languages: dict[str, int] = defaultdict(int)

    for p in files:
        try:
            raw = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        provider = _extract_meta_field(raw, "Provider").lower() or "unknown"
        language = _extract_meta_field(raw, "Language").lower() or "auto"
        providers[provider] += 1
        languages[language] += 1
        text = _extract_stats_text(raw)
        total_chars += len(text)
        tokens = _tokenize_words(text)
        total_words += len(tokens)
        # Lightweight estimate: speech pace ~150 words/min.
        dur = int(round((len(tokens) / 150.0) * 60.0)) if tokens else 0
        durations_sec.append(dur)
        for w in tokens:
            word_freq[w] += 1

    top_words = sorted(word_freq.items(), key=lambda kv: kv[1], reverse=True)[:25]
    avg_duration_sec = int(round(sum(durations_sec) / len(durations_sec))) if durations_sec else 0
    max_duration_sec = max(durations_sec) if durations_sec else 0
    min_duration_sec = min(durations_sec) if durations_sec else 0
    avg_words_per_recording = round(total_words / total_recordings, 1) if total_recordings else 0.0
    avg_chars_per_recording = round(total_chars / total_recordings, 1) if total_recordings else 0.0

    return {
        "total_recordings": total_recordings,
        "total_words": total_words,
        "total_chars": total_chars,
        "avg_words_per_recording": avg_words_per_recording,
        "avg_chars_per_recording": avg_chars_per_recording,
        "avg_duration_sec": avg_duration_sec,
        "min_duration_sec": min_duration_sec,
        "max_duration_sec": max_duration_sec,
        "top_words": [{"word": w, "count": c} for w, c in top_words],
        "providers": [{"name": k, "count": v} for k, v in sorted(providers.items(), key=lambda kv: kv[1], reverse=True)],
        "languages": [{"name": k, "count": v} for k, v in sorted(languages.items(), key=lambda kv: kv[1], reverse=True)],
    }


@app.post("/api/recordings/save")
def save_recording(
    payload: dict = Body(...),
    _auth: None = Depends(_require_api_auth),
):
    title = _sanitize_name(str(payload.get("title") or "recording"))
    source_text = str(payload.get("source_text") or "").strip()
    transcript_text = str(payload.get("transcript_text") or "").strip()
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    language = str(payload.get("language") or "").strip()
    if not source_text and not transcript_text:
        source_text = "[No speech captured]"

    lines = [
        f"Title: {title}",
        f"Saved at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Language: {language or 'auto'}",
        f"Provider: {provider or 'local'}",
        f"Model: {model or '-'}",
        "",
    ]
    if source_text:
        lines.extend(["Original:", source_text, ""])
    if transcript_text:
        lines.extend(["Transcription:", transcript_text, ""])

    target_dir = _resolve_recordings_dir()
    out = target_dir / _recording_filename(title)
    out.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    return {"ok": True, "name": out.name, "path": str(out)}
