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
from typing import Any, Optional
from urllib.parse import urlparse
from urllib.request import urlopen

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
from backend.config import APP_ROOT, CONFIG_PATH, DATA_DIR, load_config, redact_config, save_config
from backend.live import LiveSession
from backend.jobs import JobStore
from backend.remote_openrouter import RemoteError as OrRemoteError
from backend.remote_openrouter import openrouter_transcribe, openrouter_upscale_text
from backend.remote_deepgram import RemoteError as DgRemoteError
from backend.remote_deepgram import deepgram_transcribe
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
ALLOWED_REMOTE_PROVIDERS = {"openrouter", "deepgram"}
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
    "вот", "то", "все", "меня", "там", "есть", "так", "ну", "нас", "чтобы", "когда", "сейчас",
    "очень", "нужно", "сделать", "почему", "если", "еще", "вообще", "просто", "быть", "давай",
    "какой", "грамотно", "только", "тебе", "типа", "нормально", "или", "для", "до", "уже",
    "потому", "потом", "значит", "короче", "прям", "тут", "мне", "его", "ее", "их", "вас",
    "вам", "нам", "там", "здесь", "где", "куда", "откуда", "зачем", "почему", "поэтому",
    "чтоб", "будет", "был", "была", "были", "тоже", "может", "надо", "один", "два", "три",
    "to", "the", "a", "an", "and", "or", "for", "of", "in", "on", "is", "it", "that", "this",
    "i", "you", "we", "they", "he", "she", "be", "are", "was", "were", "do", "does", "did",
}

UPSCALE_PRESETS = {"clean", "business", "ai_code"}
UPSCALE_PRESETS_DIR = DATA_DIR / "upscale_presets"
UPSCALE_MAX_CUSTOM_PRESETS = 3
UPSCALE_PRESET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

BUILTIN_UPSCALE_PRESETS: dict[str, dict[str, str]] = {
    "clean": {
        "name": "Clean",
        "instruction": (
            "Improve transcript readability: fix punctuation and grammar, remove fillers and stutters, "
            "preserve full meaning. Keep output in the same language as input. "
            "Return only final improved transcript text. No quotes, no comments, no markdown."
        ),
    },
    "business": {
        "name": "Business",
        "instruction": (
            "Rewrite transcript into clear business style: concise, professional, structured, grammar-correct. "
            "Keep all essential facts. Keep output in the same language as input. "
            "Return only final improved transcript text. No quotes, no comments, no markdown."
        ),
    },
    "ai_code": {
        "name": "AI & Code",
        "instruction": (
            "Improve transcript quality for software engineering context. Remove filler words, stutters, interjections, "
            "and speech noise. Preserve all technical terms exactly: frameworks, libraries, APIs, SDKs, model names, "
            "product names, file paths, commands, code tokens, identifiers, acronyms, and versions. "
            "Do not simplify, replace, or transliterate programming terminology. Do not translate code, commands, "
            "or proper technical names. Keep variable/function/class names exactly as spoken if recognizable. "
            "Preserve keywords like Upscale/Upskill exactly as spoken. Keep full meaning and original sequence. "
            "Structure output into readable short paragraphs and clean sentence boundaries without adding new facts. "
            "Keep output in the same language as input. "
            "Return only final improved transcript text. No quotes, no comments, no markdown."
        ),
    },
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


_last_cleanup_expired_at = 0.0
_last_cleanup_recovery_at = 0.0
_CLEANUP_DEBOUNCE_SEC = 60.0


def _cleanup_expired_files() -> None:
    global _last_cleanup_expired_at
    if RESULT_RETENTION_SEC <= 0:
        return
    now = time.time()
    if now - _last_cleanup_expired_at < _CLEANUP_DEBOUNCE_SEC:
        return
    _last_cleanup_expired_at = now
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
    global _last_cleanup_recovery_at
    if LIVE_RECOVERY_RETENTION_SEC <= 0:
        return
    now = time.time()
    if now - _last_cleanup_recovery_at < _CLEANUP_DEBOUNCE_SEC:
        return
    _last_cleanup_recovery_at = now
    cutoff = now - LIVE_RECOVERY_RETENTION_SEC
    for p in LIVE_RECOVERY_DIR.glob("*"):
        try:
            if not p.is_file():
                continue
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except Exception:
            pass


async def _require_api_auth(request: Request) -> None:
    if request.url.path in {"/api/health", "/api/network"}:
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


@app.get("/api/network")
def network_status(_auth: None = Depends(_require_api_auth)):
    probes = (
        "https://openrouter.ai",
        "https://www.google.com/generate_204",
        "https://www.cloudflare.com/cdn-cgi/trace",
    )
    best_latency_ms: Optional[int] = None
    online = False
    for url in probes:
        started = time.perf_counter()
        try:
            with urlopen(url, timeout=2.5) as resp:
                code = getattr(resp, "status", 200) or 200
                ok = int(code) < 500
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            if ok:
                online = True
                if best_latency_ms is None or elapsed_ms < best_latency_ms:
                    best_latency_ms = elapsed_ms
        except Exception:
            continue
    return {"online": online, "latency_ms": best_latency_ms if online else None}


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
    if "broken pipe" in msg or "errno 32" in msg:
        return True
    # Harmless race on websocket shutdown: sender tries to push after close.
    if "unexpected asgi message 'websocket.send'" in msg:
        return True
    if "after sending 'websocket.close'" in msg:
        return True
    return False


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


_rec_dir_cache: Optional[Path] = None
_rec_dir_cache_at = 0.0
_REC_DIR_CACHE_TTL = 10.0


def _resolve_recordings_dir(cfg: Optional[dict] = None) -> Path:
    global _rec_dir_cache, _rec_dir_cache_at
    now = time.time()
    if _rec_dir_cache is not None and (now - _rec_dir_cache_at) < _REC_DIR_CACHE_TTL and cfg is None:
        return _rec_dir_cache

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
            _rec_dir_cache = default_dir
            _rec_dir_cache_at = now
            return default_dir

        p.mkdir(parents=True, exist_ok=True)
        _rec_dir_cache = p
        _rec_dir_cache_at = now
        return p
    _rec_dir_cache = default_dir
    _rec_dir_cache_at = now
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


def _upscale_instruction(preset: str) -> str:
    p = (preset or "clean").strip().lower()
    if p == "business":
        return (
            "Rewrite transcript into clear business style. Keep key facts, remove filler words, "
            "fix grammar and punctuation."
        )
    if p == "concise":
        return (
            "Rewrite transcript into concise compact style. Keep only important points, "
            "remove repetitions and fillers."
        )
    if p == "formal":
        return (
            "Rewrite transcript into formal polished style. Keep structure and meaning, "
            "fix grammar and punctuation."
        )
    if p in {"ai_code", "code", "programming"}:
        return (
            "Improve transcript for software engineering context. Preserve technical terms, commands, "
            "identifiers, and model/tool names exactly; fix punctuation and grammar."
        )
    return (
        "Clean transcript text: fix punctuation and grammar, remove stutters/fillers, "
        "keep original meaning and language."
    )


def _upscale_preset_path(preset_id: str) -> Path:
    raw = (preset_id or "").strip()
    if not UPSCALE_PRESET_ID_RE.fullmatch(raw):
        raise HTTPException(status_code=400, detail="invalid preset id")
    return UPSCALE_PRESETS_DIR / f"{raw}.json"


def _write_upscale_preset(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _ensure_builtin_upscale_presets() -> None:
    UPSCALE_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    # Remove deprecated builtin presets that are no longer supported.
    for p in UPSCALE_PRESETS_DIR.glob("builtin_*.json"):
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            pid = str(raw.get("id") or p.stem).strip()
            if not pid.startswith("builtin_"):
                continue
            short = pid.removeprefix("builtin_")
            if short not in BUILTIN_UPSCALE_PRESETS:
                p.unlink(missing_ok=True)
        except Exception:
            # Keep file if unreadable; it will be ignored later.
            pass
    for pid, meta in BUILTIN_UPSCALE_PRESETS.items():
        path = UPSCALE_PRESETS_DIR / f"builtin_{pid}.json"
        payload = {
            "id": f"builtin_{pid}",
            "name": meta["name"],
            "instruction": meta["instruction"],
            "default_instruction": meta["instruction"],
            "builtin": True,
        }
        if not path.exists():
            _write_upscale_preset(path, payload)
            continue
        try:
            cur = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(cur, dict):
                _write_upscale_preset(path, payload)
                continue
            current_instruction = str(cur.get("instruction") or "").strip() or payload["instruction"]
            next_payload = {
                "id": payload["id"],
                "name": payload["name"],
                "instruction": current_instruction,
                "default_instruction": payload["default_instruction"],
                "builtin": True,
            }
            if (
                str(cur.get("id") or "").strip() != next_payload["id"]
                or str(cur.get("name") or "").strip() != next_payload["name"]
                or str(cur.get("instruction") or "").strip() != next_payload["instruction"]
                or str(cur.get("default_instruction") or "").strip() != next_payload["default_instruction"]
                or bool(cur.get("builtin")) is not True
            ):
                _write_upscale_preset(path, next_payload)
        except Exception:
            _write_upscale_preset(path, payload)


def _load_upscale_preset(path: Path) -> Optional[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        pid = str(raw.get("id") or "").strip()
        name = str(raw.get("name") or "").strip()
        instruction = str(raw.get("instruction") or "").strip()
        if not pid or not name or not instruction:
            return None
        default_instruction = str(raw.get("default_instruction") or "").strip() or instruction
        return {
            "id": pid,
            "name": name,
            "instruction": instruction,
            "default_instruction": default_instruction,
            "builtin": bool(raw.get("builtin")),
        }
    except Exception:
        return None


def _list_upscale_presets() -> list[dict[str, Any]]:
    _ensure_builtin_upscale_presets()
    items: list[dict[str, Any]] = []
    for p in sorted(UPSCALE_PRESETS_DIR.glob("*.json")):
        item = _load_upscale_preset(p)
        if not item:
            continue
        items.append(item)
    builtins = [x for x in items if x.get("builtin")]
    customs = [x for x in items if not x.get("builtin")]
    builtins.sort(key=lambda x: str(x.get("name") or "").lower())
    customs.sort(key=lambda x: str(x.get("name") or "").lower())
    return builtins + customs


def _resolve_upscale_preset(preset_id: str) -> dict[str, Any]:
    pid = (preset_id or "").strip()
    path = _upscale_preset_path(pid)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="upscale preset not found")
    item = _load_upscale_preset(path)
    if not item:
        raise HTTPException(status_code=500, detail="invalid upscale preset file")
    return item


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
            if _is_broken_pipe_error(e):
                print(f"[ws receiver] transient broken pipe: {e}")
                stop.set()
                return
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
            if _is_broken_pipe_error(e):
                print(f"[ws transcriber] transient broken pipe: {e}")
                stop.set()
                return
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
        if _is_broken_pipe_error(e):
            print(f"[ws] transient broken pipe: {e}")
            had_error = False
            stop.set()
        else:
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
            if split_stereo:
                # Split flow: decode once to stereo, then run per-channel transcription.
                wav_path = str(RESULTS_DIR / f"{job_id}.16k.wav")
                temp_paths.append(wav_path)
                ensure_wav_16k(str(upload_path), wav_path, channels=2)
                jobs.set_progress(job_id, 0.15)
                ch1, ch2 = split_channels(wav_path)
            else:
                ch1, ch2 = (None, None)
                jobs.set_progress(job_id, 0.15)

            if ch1 and ch2:
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
                # Fast path: single mono conversion for default/local live flow.
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


def _run_remote_transcribe_once(
    *,
    provider_norm: str,
    upload_path: Optional[Path] = None,
    audio_bytes: Optional[bytes] = None,
    orig_name: str,
    language: Optional[str],
    diarize: bool,
    num_speakers: str,
    openrouter_model: str,
    cfg: Optional[dict] = None,
) -> dict[str, Any]:
    if cfg is None:
        cfg = load_config()
    prov = (
        provider_norm
        or cfg.get("preferences", {}).get("remote_provider")
        or "openrouter"
    ).strip()

    if audio_bytes is None and upload_path is not None:
        audio_bytes = upload_path.read_bytes()
    if prov == "openrouter":
        or_key = ((cfg.get("providers") or {}).get("openrouter") or {}).get("key") or ""
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
        return {
            "provider": "openrouter",
            "model": model,
            "text": (out.get("text") or "").strip(),
            "raw": out.get("raw"),
        }

    if prov == "deepgram":
        dg_key = ((cfg.get("providers") or {}).get("deepgram") or {}).get("key") or ""
        model = (openrouter_model or "nova-3").strip()
        out = deepgram_transcribe(
            api_key=dg_key,
            audio_bytes=audio_bytes,
            filename=orig_name,
            model=model,
            language=language,
        )
        return {
            "provider": "deepgram",
            "model": model,
            "text": (out.get("text") or "").strip(),
            "raw": out.get("raw"),
        }

    raise Exception(f"Unknown provider: {prov}")


@app.post("/api/remote/jobs")
async def create_remote_job(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    provider: str = Form(""),
    language: str = Form("auto"),
    diarize: bool = Form(False),
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
            jobs.set_progress(job_id, 0.15)
            result = _run_remote_transcribe_once(
                provider_norm=provider_norm,
                upload_path=upload_path,
                orig_name=orig_name,
                language=lang_opt,
                diarize=diarize,
                num_speakers=num_speakers,
                openrouter_model=openrouter_model,
            )

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
        except (OrRemoteError, DgRemoteError) as e:
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


@app.post("/api/remote/transcribe-sync")
async def remote_transcribe_sync(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    provider: str = Form(""),
    language: str = Form("auto"),
    diarize: bool = Form(False),
    num_speakers: str = Form(""),
    openrouter_model: str = Form(""),
):
    provider_norm = (provider or "").strip()
    if provider_norm and provider_norm not in ALLOWED_REMOTE_PROVIDERS:
        raise HTTPException(status_code=400, detail="unsupported provider")

    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    # Read audio bytes directly into memory — skip disk I/O for speed.
    audio_bytes = await file.read()
    lang_opt = _normalize_language(language)
    cfg = load_config()
    try:
        result = _run_remote_transcribe_once(
            provider_norm=provider_norm,
            audio_bytes=audio_bytes,
            orig_name=orig_name,
            language=lang_opt,
            diarize=diarize,
            num_speakers=num_speakers,
            openrouter_model=openrouter_model,
            cfg=cfg,
        )
        return {"ok": True, "result": result}
    except (OrRemoteError, DgRemoteError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Remote transcription failed: {e}")


@app.post("/api/upscale")
async def upscale_text(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if len(text) > 120_000:
        raise HTTPException(status_code=400, detail="text is too long")
    _ensure_builtin_upscale_presets()
    preset_id = str(payload.get("preset_id") or "").strip()
    if not preset_id:
        legacy = str(payload.get("preset") or "clean").strip().lower()
        if legacy not in UPSCALE_PRESETS:
            raise HTTPException(status_code=400, detail="unsupported upscale preset")
        preset_id = f"builtin_{legacy}"
    preset = _resolve_upscale_preset(preset_id)

    cfg = load_config()
    providers = cfg.get("providers") or {}
    prefs = cfg.get("preferences") or {}
    key = ((providers.get("openrouter") or {}).get("key") or "").strip()
    model = str((payload.get("model") or (prefs.get("openrouter") or {}).get("model") or "google/gemini-2.5-flash")).strip()
    if not key:
        raise HTTPException(status_code=400, detail="OpenRouter key is not configured")
    instruction = str(preset.get("instruction") or "").strip()
    candidates: list[str] = []
    for m in [
        model,
        str((prefs.get("openrouter") or {}).get("model") or "").strip(),
        "google/gemini-2.5-flash",
        "openai/gpt-4o-mini",
    ]:
        mm = str(m or "").strip()
        if mm and mm not in candidates:
            candidates.append(mm)
    used_model = candidates[0] if candidates else model
    out: Optional[dict[str, Any]] = None
    last_err: Optional[Exception] = None
    loop = asyncio.get_event_loop()
    try:
        for cand in candidates:
            used_model = cand
            try:
                out = await loop.run_in_executor(
                    None,
                    lambda c=cand: openrouter_upscale_text(
                        api_key=key,
                        model=c,
                        text=text,
                        instruction=instruction,
                    ),
                )
                break
            except OrRemoteError as e:
                last_err = e
                msg = str(e)
                # Retry with fallback models only for invalid/non-existing model issues.
                if ("HTTP 404" in msg) or ("not found" in msg.lower()):
                    continue
                raise
        if out is None:
            raise last_err or RuntimeError("upscale failed")
    except OrRemoteError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {
        "ok": True,
        "preset_id": preset.get("id"),
        "preset_name": preset.get("name"),
        "model": used_model,
        "text": (out.get("text") or "").strip(),
    }


@app.get("/api/upscale/presets")
def list_upscale_presets(_auth: None = Depends(_require_api_auth)):
    items = _list_upscale_presets()
    return {
        "items": [
            {
                "id": x["id"],
                "name": x["name"],
                "builtin": bool(x["builtin"]),
                "instruction": str(x.get("instruction") or ""),
                "default_instruction": str(x.get("default_instruction") or x.get("instruction") or ""),
            }
            for x in items
        ]
    }


@app.post("/api/upscale/presets")
def create_upscale_preset(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    name = str(payload.get("name") or "").strip()
    instruction = str(payload.get("instruction") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="preset name is required")
    if not instruction:
        raise HTTPException(status_code=400, detail="preset instruction is required")

    custom_count = 0
    for item in _list_upscale_presets():
        if not bool(item.get("builtin")):
            custom_count += 1
    if custom_count >= UPSCALE_MAX_CUSTOM_PRESETS:
        raise HTTPException(status_code=400, detail=f"maximum {UPSCALE_MAX_CUSTOM_PRESETS} custom presets")

    base_slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not base_slug:
        base_slug = "custom"
    preset_id = f"custom_{base_slug}"
    suffix = 2
    while (_upscale_preset_path(preset_id)).exists():
        preset_id = f"custom_{base_slug}_{suffix}"
        suffix += 1

    payload_out = {
        "id": preset_id,
        "name": name[:60],
        "instruction": instruction,
        "default_instruction": instruction,
        "builtin": False,
    }
    _write_upscale_preset(_upscale_preset_path(preset_id), payload_out)
    return {
        "ok": True,
        "item": {
            "id": payload_out["id"],
            "name": payload_out["name"],
            "builtin": False,
            "instruction": payload_out["instruction"],
            "default_instruction": payload_out["default_instruction"],
        },
    }


@app.put("/api/upscale/presets/{preset_id}")
def update_upscale_preset(preset_id: str, payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    item = _resolve_upscale_preset(preset_id)
    instruction = str(payload.get("instruction") or "").strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="preset instruction is required")
    next_payload = {
        "id": item["id"],
        "name": str(item.get("name") or "").strip()[:60],
        "instruction": instruction,
        "default_instruction": str(item.get("default_instruction") or item.get("instruction") or instruction).strip() or instruction,
        "builtin": bool(item.get("builtin")),
    }
    _write_upscale_preset(_upscale_preset_path(item["id"]), next_payload)
    return {"ok": True, "item": next_payload}


@app.post("/api/upscale/presets/{preset_id}/reset-default")
def reset_upscale_preset_default(preset_id: str, _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    item = _resolve_upscale_preset(preset_id)
    default_instruction = str(item.get("default_instruction") or item.get("instruction") or "").strip()
    if not default_instruction:
        raise HTTPException(status_code=500, detail="preset default instruction is empty")
    next_payload = {
        "id": item["id"],
        "name": str(item.get("name") or "").strip()[:60],
        "instruction": default_instruction,
        "default_instruction": default_instruction,
        "builtin": bool(item.get("builtin")),
    }
    _write_upscale_preset(_upscale_preset_path(item["id"]), next_payload)
    return {"ok": True, "item": next_payload}


@app.delete("/api/upscale/presets/{preset_id}")
def delete_upscale_preset(preset_id: str, _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    item = _resolve_upscale_preset(preset_id)
    if bool(item.get("builtin")):
        raise HTTPException(status_code=400, detail="built-in presets cannot be deleted")
    p = _upscale_preset_path(preset_id)
    p.unlink(missing_ok=True)
    return {"ok": True}


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
    cfg = redact_config(load_config())
    cfg["_meta"] = {"config_path": str(CONFIG_PATH)}
    return cfg


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


@app.post("/api/recordings/open-folder")
def open_recordings_folder(payload: dict = Body(default_factory=dict), _auth: None = Depends(_require_api_auth)):
    requested = str((payload or {}).get("path") or "").strip()
    if requested:
        d = Path(requested).expanduser()
        if not d.is_absolute():
            d = (_resolve_recordings_dir() / d).resolve()
        d.mkdir(parents=True, exist_ok=True)
    else:
        d = _resolve_recordings_dir()
    if os.name != "posix":
        raise HTTPException(status_code=400, detail="open folder is supported on macOS only")
    try:
        subprocess.run(["open", str(d)], check=True, capture_output=True, text=True, timeout=15)
        return {"ok": True, "path": str(d)}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="open folder timed out")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        raise HTTPException(status_code=500, detail=f"open folder failed: {stderr or 'unknown error'}")


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


@app.delete("/api/recordings")
def delete_all_recordings(_auth: None = Depends(_require_api_auth)):
    d = _resolve_recordings_dir()
    deleted = 0
    failed = 0
    for p in list(d.glob("*.txt")):
        try:
            p.unlink()
            deleted += 1
        except Exception:
            failed += 1
    return {"deleted": deleted, "failed": failed}


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


_stats_cache: Optional[dict] = None
_stats_cache_at = 0.0
_stats_cache_key: Optional[tuple] = None
_STATS_CACHE_TTL = 30.0


@app.get("/api/recordings/stats/summary")
def get_recordings_stats(_auth: None = Depends(_require_api_auth)):
    global _stats_cache, _stats_cache_at, _stats_cache_key
    d = _resolve_recordings_dir()
    now = time.time()

    # Build a lightweight cache key: dir mtime + file count
    try:
        dir_mtime = d.stat().st_mtime
        file_count = sum(1 for _ in d.glob("*.txt"))
    except Exception:
        dir_mtime = 0.0
        file_count = -1
    cache_key = (str(d), dir_mtime, file_count)

    if (
        _stats_cache is not None
        and _stats_cache_key == cache_key
        and (now - _stats_cache_at) < _STATS_CACHE_TTL
    ):
        return _stats_cache

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

    result = {
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
    _stats_cache = result
    _stats_cache_at = now
    _stats_cache_key = cache_key
    return result


@app.post("/api/recordings/save")
def save_recording(
    payload: dict = Body(...),
    _auth: None = Depends(_require_api_auth),
):
    existing_name = os.path.basename(str(payload.get("name") or "").strip())
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
    if existing_name:
        if existing_name in {"", ".", ".."} or not existing_name.endswith(".txt"):
            raise HTTPException(status_code=400, detail="invalid recording name")
        out = target_dir / existing_name
    else:
        out = target_dir / _recording_filename(title)
    out.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    return {"ok": True, "name": out.name, "path": str(out)}
