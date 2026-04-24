import json
import logging
import os
import sys
import asyncio
import uuid
import re
import secrets
import threading
import time
import subprocess
import mimetypes
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional
from urllib.parse import urlparse
from urllib.request import urlopen

import numpy as np
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

from backend.audio import AudioError, ensure_wav_16k, split_channels, write_wav
from backend.config import APP_ROOT, CONFIG_PATH, DATA_DIR, load_config, redact_config, save_config
from backend.live import LiveSession
from backend.jobs import JobStore
from backend.remote_openrouter import OpenRouterError, openrouter_transcribe, openrouter_upscale_text
from backend.remote_deepgram import DeepgramRemoteError, deepgram_transcribe
from backend.remote_deepgram_live import (
    DeepgramLiveConfig,
    DeepgramLiveError,
    DeepgramLiveSession,
)
from backend.transcribe import merge_channel_transcripts, transcribe_file, warm_model, warm_state


UPLOADS_DIR = DATA_DIR / "uploads"
RESULTS_DIR = DATA_DIR / "results"
LIVE_RECOVERY_DIR = DATA_DIR / "live_recovery"
for d in (UPLOADS_DIR, RESULTS_DIR, LIVE_RECOVERY_DIR):
    d.mkdir(parents=True, exist_ok=True)


logger = logging.getLogger(__name__)


# ── Parent-death watchdog ───────────────────────────────────────────────────
#
# The Electron shell is our parent. When it quits cleanly it sends SIGTERM
# (via ``backend.kill("SIGTERM")``) and we exit. But when the Electron
# process is killed with SIGKILL (``kill -9``), crashes, or the OS force-
# closes it, the ``before-quit`` handler cannot run and no signal reaches
# us — we become an orphan Python process, still bound to our TCP port,
# still holding whisper models in RAM, until the user manually tracks us
# down with ``ps``.
#
# Solution: the parent opens an inherited stdin pipe to us. As long as
# the parent is alive the pipe's write end stays open. When the parent
# process table entry is reaped (normal exit, crash, SIGKILL, laptop
# shutdown mid-session — ANY path), the kernel closes every fd it owned
# including our stdin's read end. A blocking ``os.read(0, 1)`` then
# returns 0 bytes (EOF), and we exit immediately.
#
# The watchdog lives in a daemon thread so it never blocks shutdown. It
# uses ``os._exit`` (not ``sys.exit``) because uvicorn installs its own
# signal handlers and a normal exit here would race with its shutdown
# path — ``os._exit`` bypasses atexit + cleanup and is the only way to
# GUARANTEE the orphan is reaped, which is the whole point of this
# watchdog.
#
# ``TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG=1`` opts out for users who run
# the backend standalone (``python -m uvicorn backend.main:app`` in a
# dev shell without Electron parent), since reading stdin in a dev
# shell would block on the terminal.
def _start_parent_death_watchdog() -> None:
    if os.environ.get("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG") == "1":
        return
    if not os.isatty(0):
        # Only install the watchdog when stdin is a pipe (parent-spawned).
        # An interactive terminal would have ``isatty(0) == True`` and
        # reading a byte would block forever until the user types.
        def _watch() -> None:
            try:
                while True:
                    data = os.read(0, 1)
                    if not data:
                        # EOF — parent's write end closed. Could be a
                        # graceful parent exit OR a kernel-forced close
                        # because the parent process table entry was
                        # reaped. Either way: we have no parent anymore.
                        logger.warning(
                            "parent-death-watchdog: stdin EOF, exiting immediately"
                        )
                        # Flush logging before hard exit so any pending
                        # messages reach the parent's captured stderr.
                        try:
                            logging.shutdown()
                        except Exception:
                            pass
                        os._exit(0)
            except Exception:
                # Unexpected — do NOT exit, because a read() failure on
                # stdin is not proof the parent is dead; it could be a
                # spurious EINTR or a misconfigured runtime. Just log
                # and let uvicorn keep serving.
                logger.exception("parent-death-watchdog: unexpected read error")

        threading.Thread(
            target=_watch, daemon=True, name="parent-death-watchdog"
        ).start()


_start_parent_death_watchdog()


@asynccontextmanager
async def _app_lifespan(_app: "FastAPI") -> AsyncIterator[None]:
    """FastAPI lifespan hook.

    Replaces the deprecated ``@app.on_event("startup")`` pattern
    (removed in an upcoming FastAPI release). Both startup tasks are
    best-effort and kicked off in background daemon threads so they
    cannot block the event loop from serving requests.

    ``_warm_default_local_model`` and ``_retroactive_audio_retention``
    are defined later in the module — Python resolves the names at
    call time (when this lifespan enters), by which point the whole
    module has been imported. No forward-declaration dance required.
    """
    threading.Thread(
        target=_warm_default_local_model, daemon=True, name="warm-default-model"
    ).start()

    def _run_retroactive_retention() -> None:
        try:
            _retroactive_audio_retention()
        except Exception:
            logger.exception("retroactive audio retention startup task failed")

    threading.Thread(
        target=_run_retroactive_retention,
        daemon=True,
        name="retroactive-audio-retention",
    ).start()

    def _run_tmp_sweep() -> None:
        try:
            _sweep_orphan_tmp_files()
        except Exception:
            logger.exception("tmp-file sweep startup task failed")

    threading.Thread(
        target=_run_tmp_sweep,
        daemon=True,
        name="tmp-sweep",
    ).start()

    yield
    # shutdown: nothing to actively release; daemon threads exit with the
    # process and the rate-limit prune task is torn down via the global
    # ``asyncio.get_event_loop()`` cancellation FastAPI handles for us.


app = FastAPI(title="Call Transcriptor", lifespan=_app_lifespan)
jobs = JobStore(max_workers=2)


# Paths we consider "sensitive" — present in raw exception text from
# OSError/FileNotFoundError/ffmpeg stderr and get echoed back to the
# client if we include `str(e)` verbatim in HTTP response bodies or
# persisted job errors. The redact happens BEFORE the string is handed
# to anything external; full exceptions are still written to main.log
# via `logger.exception` for operator debugging.
_ERROR_PATH_REDACT_RE = re.compile(
    r"(?:"
    # POSIX user/system paths — Macs, Linux, WSL. Capture up to the next
    # whitespace / quote / colon so we strip the whole filename.
    r"/(?:Users|home|root|var|tmp|private|opt|Applications|System)/[^\s\"'`]*"
    r"|"
    # Windows user/system paths — both `\` and forward-slashed variants.
    r"[A-Za-z]:\\(?:Users|Windows|Temp|ProgramData|Program Files)\\[^\s\"'`]*"
    r")",
    re.IGNORECASE,
)
# Crude API-key shapes that should never end up in an error body. We
# don't need to match every provider — just the ones we use.
_ERROR_TOKEN_REDACT_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{20,}|[a-f0-9]{40,})\b",
    re.IGNORECASE,
)


def _safe_error_text(exc: object, *, max_len: int = 200) -> str:
    """Render an exception (or arbitrary string) safely for external reporting.

    Redacts absolute filesystem paths and obvious token shapes, then
    truncates. The full, unredacted exception should be logged
    separately via ``logger.exception`` so operators retain the detail
    needed for debugging; only what this function returns should appear
    in HTTP response bodies or stored job errors.
    """
    text = str(exc) if not isinstance(exc, str) else exc
    if not text:
        return exc.__class__.__name__ if isinstance(exc, BaseException) else "error"
    text = _ERROR_PATH_REDACT_RE.sub("<path>", text)
    text = _ERROR_TOKEN_REDACT_RE.sub("<token>", text)
    if len(text) > max_len:
        text = text[:max_len].rstrip() + "…"
    return text

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
# Hard ceiling on recovery-promote PCM reads. A 10-hour 16 kHz/16-bit PCM
# spool is 1.15 GB; loading it into a numpy float32 array allocates ~4.6 GB
# on top of the raw bytes, which OOM-kills the backend on 8-16 GB hosts.
# Any recovery file larger than this is rejected with 413 and left on disk
# so the user can retrieve it manually from LIVE_RECOVERY_DIR.
MAX_RECOVERY_PROMOTE_BYTES = 500 * 1024 * 1024
# Hard ceiling on the live-recovery SPOOL (distinct from the promote
# ceiling above). 16 kHz mono PCM16 = 32 KB/s, so 1 GB ≈ 8.7 h of
# continuous audio — longer than any realistic dictation session.
# Without this cap, a user who leaves a tab open and crashes Electron
# while still recording can write the spool indefinitely and fill a
# small SSD. When crossed we stop writing further chunks (logged once)
# but keep the WebSocket session alive so live transcription continues;
# recovery is best-effort, the finalized transcript is already persisted
# via the streaming path.
MAX_LIVE_RECOVERY_BYTES = 2 * MAX_UPLOAD_BYTES
RATE_LIMIT_PER_MIN = 120
WS_CONNECT_LIMIT_PER_MIN = 20
def _env_int(name: str, default: int) -> int:
    """Parse an integer env var with graceful fallback.

    A non-numeric value (e.g., ``TRANSCRIPTOR_RESULT_RETENTION_SEC=1h``)
    would otherwise crash module import with ValueError before FastAPI
    ever starts, and Electron would see the backend child die
    repeatedly with no diagnostic. Degrade to the documented default
    with a warning so the backend boots and the misconfiguration is
    visible in the log.
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("invalid integer env %s=%r; using default=%d", name, raw, default)
        return default


RESULT_RETENTION_SEC = _env_int("TRANSCRIPTOR_RESULT_RETENTION_SEC", 86400)
LIVE_RECOVERY_RETENTION_SEC = _env_int("TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC", 86400)
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
LIVE_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

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

UPSCALE_PRESETS = {"clean", "business", "ai_code", "refine"}
UPSCALE_PRESETS_DIR = DATA_DIR / "upscale_presets"
UPSCALE_MAX_CUSTOM_PRESETS = 3

# Persistent registry of every archive directory ever used for an
# audio-bearing save.  Written atomically each time a new custom dir
# is first encountered so ``_retroactive_audio_retention`` can clean
# up *all* archives on the next startup, not just the current default.
_ARCHIVE_DIR_REGISTRY_PATH = DATA_DIR / "known_archive_dirs.json"
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
    "refine": {
        "name": "Refine",
        "instruction": (
            "Refine transcript readability without rewriting the content. Preserve the original language, meaning, order, "
            "facts, and important wording. Do not summarize, shorten, paraphrase, or add new information. "
            "Fix obvious punctuation and grammar issues only when needed for readability. "
            "Split the text into natural, readable paragraphs at topic or sentence-group boundaries. "
            "Return only final refined transcript text. No quotes, no comments, no markdown."
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
_archive_dir_registry_lock = threading.Lock()
_ws_windows: dict[str, deque[float]] = defaultdict(deque)

# Per-session recovery promotion serialization + idempotency cache.
# Promotion reads the PCM, writes a WAV+text pair, then deletes the
# PCM. A retry (double-click, UI refresh, transient 502) can land
# while the first call is still running — without a lock both calls
# race on the same WAV/text paths and pruning; without a cache the
# retry returns 404 because the PCM has been deleted. The cache keeps
# the successful result for ``_LIVE_PROMOTE_CACHE_TTL_SEC`` so retries
# observe the same response.
_live_promote_lock = threading.Lock()
_live_promote_session_locks: dict[str, threading.Lock] = {}
_live_promote_cache: dict[str, tuple[float, dict]] = {}
_LIVE_PROMOTE_CACHE_TTL_SEC = 60.0


def _load_or_create_api_token() -> str:
    env_token = os.environ.get("TRANSCRIPTOR_API_TOKEN", "").strip()
    if env_token:
        return env_token
    # The token path lives under DATA_DIR; if the user has permission or
    # filesystem issues (read-only mount, sandbox denial, anti-virus
    # lock), a bare read/write would raise OSError at module import
    # time and the backend would never start. Guard each FS op so we
    # degrade to an in-memory-only token for this session — recordings
    # still work, only the persistence of the token across restarts is
    # lost until the filesystem recovers.
    if API_TOKEN_PATH.exists():
        try:
            token = API_TOKEN_PATH.read_text(encoding="utf-8").strip()
        except OSError as e:
            logger.warning(
                "api token unreadable at %s: %s — regenerating",
                API_TOKEN_PATH, e,
            )
            token = ""
        if token:
            return token
    token = secrets.token_urlsafe(32)
    try:
        API_TOKEN_PATH.write_text(token, encoding="utf-8")
    except OSError as e:
        logger.error(
            "api token persist failed at %s: %s — using in-memory token "
            "for this session only (will re-generate on restart)",
            API_TOKEN_PATH, e,
        )
        return token
    try:
        os.chmod(API_TOKEN_PATH, 0o600)
    except OSError as e:
        # Non-POSIX filesystems (Windows) or read-only mounts: the token
        # file will still exist with default permissions.
        logger.debug("api token chmod skipped: %s", e)
    return token


API_TOKEN = _load_or_create_api_token()


# Match tmp files produced by every atomic writer in this module:
#
#   _atomic_write_text     → "recording.txt.tmp-<hex>"
#   _atomic_temp_path      → "recording.tmp-<hex>.wav" / ".txt" / ".m4a"
#   _write_upscale_preset  → "builtin_clean.tmp-<hex>.json"
#   save_recording_with_audio → same shape as _atomic_temp_path
#
# The hex portion is always 32 chars (uuid4().hex) — require at least 6
# so a real file named e.g. "backup.tmp-x.wav" never accidentally matches.
# The optional trailing ``.<ext>`` catches the in-middle tmp pattern.
# Anchored to ``$`` so a user file legitimately containing ".tmp-" in
# the middle (unusual but legal) is not matched.
_TMP_ORPHAN_RE = re.compile(
    r"\.tmp-[0-9a-f]{6,}(?:\.[A-Za-z0-9]+)?$", re.IGNORECASE
)


def _sweep_orphan_tmp_files() -> None:
    """Delete orphan ``*.tmp-*`` files from DATA_DIR and every archive dir.

    Runs once at backend startup. Tmp files from the current process
    (still being written) have not yet been renamed into place, so their
    mtime is very recent — we skip anything modified in the last 60 s
    to avoid racing with a concurrent write from a parallel worker.
    """
    cutoff = time.time() - 60.0
    targets: list[Path] = [DATA_DIR, UPSCALE_PRESETS_DIR]
    try:
        targets.extend(_get_known_archive_dirs())
    except Exception:
        pass
    removed = 0
    for root in targets:
        try:
            if not root.exists() or not root.is_dir():
                continue
            for p in root.iterdir():
                if not p.is_file():
                    continue
                if not _TMP_ORPHAN_RE.search(p.name):
                    continue
                try:
                    if p.stat().st_mtime > cutoff:
                        continue
                    p.unlink()
                    removed += 1
                except OSError:
                    continue
        except OSError:
            continue
    if removed > 0:
        logger.info("tmp-sweep: removed %d orphan *.tmp-* files", removed)


def _warm_default_local_model() -> None:
    try:
        started = time.perf_counter()
        state = warm_model("small", probe=True)
        logger.info(
            "default local model warmed: model=small load_ms=%d probe_ms=%d total_ms=%d",
            int(state.get("loaded_ms", 0)),
            int(state.get("probe_ms", 0)),
            int((time.perf_counter() - started) * 1000),
        )
    except Exception:
        logger.exception("default local model warmup failed")


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


_RATE_BUCKET_MAX_KEYS = 2048
_rate_prune_watermark: dict[int, float] = {}


def _prune_rate_bucket(bucket: dict[str, deque[float]], cutoff: float) -> None:
    """Garbage-collect a rate-limit bucket.

    Called under ``_rate_lock``. Walks every key and drops entries
    whose deque is empty after the cutoff prune. Bounded work —
    runs at most once per 30s per bucket, or immediately if the
    bucket exceeds the hard-cap size.

    Root cause for the previous leak: ``defaultdict(deque)`` created
    a new entry for every unique IP address, but empty deques were
    never removed. Over a long-running server, this grew unboundedly
    (slow memory leak, DoS vector via flood of unique clients).
    """
    stale_keys: list[str] = []
    for k, q in bucket.items():
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            stale_keys.append(k)
    for k in stale_keys:
        bucket.pop(k, None)

    # If after pruning we're still over the hard cap, evict the
    # oldest-touched keys. This bounds peak memory even under a burst
    # of unique clients that haven't timed out yet.
    if len(bucket) > _RATE_BUCKET_MAX_KEYS:
        # Sort by most-recent timestamp ascending; drop the oldest
        # until we're back under the cap.
        ordered = sorted(
            bucket.items(),
            key=lambda kv: kv[1][-1] if kv[1] else 0.0,
        )
        excess = len(bucket) - _RATE_BUCKET_MAX_KEYS
        for k, _ in ordered[:excess]:
            bucket.pop(k, None)


def _touch_rate_limit(bucket: dict[str, deque[float]], key: str, limit_per_min: int) -> bool:
    # Use monotonic() — rate limiting is an internal-only TTL check,
    # and ``time.time()`` can jump backward on NTP correction or DST
    # transitions, making a recent hit look "old" and briefly
    # disabling the limiter. monotonic() is guaranteed to increase.
    now = time.monotonic()
    cutoff = now - 60.0
    with _rate_lock:
        q = bucket[key]
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit_per_min:
            return False
        q.append(now)

        # Opportunistic GC: runs at most once per 30s per bucket, or
        # immediately if the bucket is over-full. O(n) in the number
        # of tracked clients, amortized down to a few microseconds
        # per touch even at cap size.
        bucket_id = id(bucket)
        last_prune = _rate_prune_watermark.get(bucket_id, 0.0)
        if now - last_prune > 30.0 or len(bucket) > _RATE_BUCKET_MAX_KEYS:
            _prune_rate_bucket(bucket, cutoff)
            _rate_prune_watermark[bucket_id] = now
        return True


_last_cleanup_expired_at = 0.0
_last_cleanup_recovery_at = 0.0
_CLEANUP_DEBOUNCE_SEC = 60.0


def _cleanup_expired_files() -> None:
    global _last_cleanup_expired_at
    if RESULT_RETENTION_SEC <= 0:
        return
    # Debounce uses monotonic (clock-skew immune). File ``st_mtime``
    # lives in wall-clock epoch seconds, so the cutoff for the actual
    # age check uses ``time.time()`` separately.
    debounce_now = time.monotonic()
    if debounce_now - _last_cleanup_expired_at < _CLEANUP_DEBOUNCE_SEC:
        return
    _last_cleanup_expired_at = debounce_now
    cutoff = time.time() - RESULT_RETENTION_SEC
    for base in (RESULTS_DIR, UPLOADS_DIR):
        for p in base.glob("*"):
            try:
                if not p.is_file():
                    continue
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
            except OSError as e:
                logger.debug("cleanup skipped for %s: %s", p, e)


def _cleanup_live_recovery_files() -> None:
    global _last_cleanup_recovery_at
    if LIVE_RECOVERY_RETENTION_SEC <= 0:
        return
    # Same split as ``_cleanup_expired_files``: monotonic for debounce,
    # wall-clock for the mtime comparison.
    debounce_now = time.monotonic()
    if debounce_now - _last_cleanup_recovery_at < _CLEANUP_DEBOUNCE_SEC:
        return
    _last_cleanup_recovery_at = debounce_now
    cutoff = time.time() - LIVE_RECOVERY_RETENTION_SEC
    for p in LIVE_RECOVERY_DIR.glob("*"):
        try:
            if not p.is_file():
                continue
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except OSError as e:
            logger.debug("live recovery cleanup skipped for %s: %s", p, e)


def _normalize_live_session_id(value: str) -> str:
    raw = (value or "").strip()
    if raw and LIVE_SESSION_ID_RE.fullmatch(raw):
        return raw
    return str(uuid.uuid4())


def _live_recovery_paths(session_id: str) -> tuple[Optional[Path], Optional[Path]]:
    safe_session_id = (session_id or "").strip()
    if not safe_session_id or not LIVE_SESSION_ID_RE.fullmatch(safe_session_id):
        return None, None
    matches = sorted(LIVE_RECOVERY_DIR.glob(f"*_{safe_session_id}.pcm16"))
    if not matches:
        return None, None
    pcm_path = matches[-1]
    meta_path = pcm_path.with_suffix(".json")
    return pcm_path, meta_path


def _delete_live_recovery(session_id: str) -> bool:
    pcm_path, meta_path = _live_recovery_paths(session_id)
    if pcm_path is None:
        return False
    pcm_path.unlink(missing_ok=True)
    if meta_path is not None:
        meta_path.unlink(missing_ok=True)
    return True


def _list_live_recoveries() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for pcm_path in sorted(LIVE_RECOVERY_DIR.glob("*.pcm16"), reverse=True):
        try:
            meta_path = pcm_path.with_suffix(".json")
            raw = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            session_id = str(raw.get("session_id") or "").strip() or pcm_path.stem.split("_")[-1]
            if not LIVE_SESSION_ID_RE.fullmatch(session_id):
                continue
            bytes_count = int(raw.get("bytes") or pcm_path.stat().st_size or 0)
            if bytes_count < 32000:
                continue
            records.append(
                {
                    "session_id": session_id,
                    "started_at": str(raw.get("started_at") or ""),
                    "finished_at": str(raw.get("finished_at") or ""),
                    "sample_rate": int(raw.get("sample_rate") or 16000),
                    "bytes": bytes_count,
                    "model": str(raw.get("model") or "small"),
                    "language": str(raw.get("language") or "auto"),
                    "duration_sec": round(bytes_count / 32000.0, 2),
                }
            )
        except Exception as _list_err:
            logger.warning(
                "_list_live_recoveries: skipping %s — %s", pcm_path, _list_err
            )
            continue
    return records


def _acquire_session_promote_lock(session_id: str) -> threading.Lock:
    """Return a stable per-session lock.

    The registry dict is protected by ``_live_promote_lock`` so two
    concurrent callers never race to create their own lock instance.
    """
    with _live_promote_lock:
        lock = _live_promote_session_locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _live_promote_session_locks[session_id] = lock
        return lock


def _release_session_promote_lock(session_id: str) -> None:
    """Drop the per-session lock once the session has been fully
    promoted (or proven absent). The cache entry survives the lock so
    retries still hit a fast idempotent path."""
    with _live_promote_lock:
        _live_promote_session_locks.pop(session_id, None)


def _lookup_live_promote_cache(session_id: str) -> Optional[dict]:
    now = time.monotonic()
    with _live_promote_lock:
        # Opportunistic GC so the cache cannot grow without bound.
        stale = [
            sid
            for sid, (ts, _) in _live_promote_cache.items()
            if now - ts > _LIVE_PROMOTE_CACHE_TTL_SEC
        ]
        for sid in stale:
            _live_promote_cache.pop(sid, None)
        entry = _live_promote_cache.get(session_id)
        if entry is None:
            return None
        ts, payload = entry
        if now - ts > _LIVE_PROMOTE_CACHE_TTL_SEC:
            _live_promote_cache.pop(session_id, None)
            return None
        # Validate that the promoted files still exist on disk. If the
        # user ran DELETE /api/recordings between the original promote
        # and this retry, returning the cached success would claim a
        # nonexistent recording and the frontend's audio fetch would
        # 404. Treat a missing file as a cache miss so the promoter
        # re-runs and recreates the entry.
        name = str(payload.get("name") or "")
        archive_dir_str = str(payload.get("archive_dir") or "")
        if name and archive_dir_str:
            try:
                if not (Path(archive_dir_str) / name).exists():
                    _live_promote_cache.pop(session_id, None)
                    return None
            except OSError:
                # Path computation failed (invalid chars, permission);
                # treat as cache miss and re-run promoter.
                _live_promote_cache.pop(session_id, None)
                return None
        return dict(payload)


def _store_live_promote_cache(session_id: str, payload: dict) -> None:
    # Mirror the opportunistic GC from ``_lookup_live_promote_cache``.
    # Without it, a workload that only writes (recovery promotions with
    # fresh session_ids never revisited by the client) grows the cache
    # without bound — each entry survives until a lookup eventually
    # walks over it. Adding the purge here makes the cache bounded by
    # the recent-activity window regardless of read/write mix.
    now = time.monotonic()
    with _live_promote_lock:
        stale = [
            sid
            for sid, (ts, _) in _live_promote_cache.items()
            if now - ts > _LIVE_PROMOTE_CACHE_TTL_SEC
        ]
        for sid in stale:
            _live_promote_cache.pop(sid, None)
        _live_promote_cache[session_id] = (now, dict(payload))


def _promote_live_recovery(session_id: str, archive_dir: str = "") -> dict[str, Any]:
    # Fast path: a freshly cached success means we served this promotion
    # recently. Return the stored result so UI retries are idempotent
    # instead of producing a 404 or a duplicate WAV.
    cached = _lookup_live_promote_cache(session_id)
    if cached is not None:
        return cached

    session_lock = _acquire_session_promote_lock(session_id)
    try:
        with session_lock:
            # Re-check under the lock — a racing caller may have completed
            # the promotion while we were waiting for the lock.
            cached = _lookup_live_promote_cache(session_id)
            if cached is not None:
                return cached

            pcm_path, meta_path = _live_recovery_paths(session_id)
            if pcm_path is None or meta_path is None or not pcm_path.exists():
                raise HTTPException(status_code=404, detail="live recovery not found")
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
            # Reject oversized spool files BEFORE the read to avoid OOM:
            # np.frombuffer + astype(float32) materialises 3× the raw PCM
            # size in RAM simultaneously.
            pcm_size = pcm_path.stat().st_size
            if pcm_size < 32000:
                raise HTTPException(status_code=400, detail="live recovery too short")
            if pcm_size > MAX_RECOVERY_PROMOTE_BYTES:
                # Do NOT interpolate `pcm_path` into the response body —
                # the absolute filesystem path (containing the user's OS
                # profile name + data dir layout) would leak to any API
                # consumer. Log the path locally; clients get the session
                # id only and can retrieve the spool via the authenticated
                # session-metadata endpoint if needed.
                logger.warning(
                    "live recovery too large (%d B, max %d B); spool left at %s",
                    pcm_size, MAX_RECOVERY_PROMOTE_BYTES, pcm_path,
                )
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"live recovery too large (max "
                        f"{MAX_RECOVERY_PROMOTE_BYTES // (1024 * 1024)} MB)"
                    ),
                )
            audio_bytes = pcm_path.read_bytes()

            pcm = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            started_at = str(meta.get("started_at") or "").strip()
            model = str(meta.get("model") or "small").strip() or "small"
            language = str(meta.get("language") or "auto").strip() or "auto"
            pinned_archive_dir = str(meta.get("archive_dir") or "").strip()
            title = f"Recovered {started_at or datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            stem = _recording_stem(title)
            target_dir = _resolve_recordings_target_dir(archive_dir or pinned_archive_dir)
            _register_archive_dir(target_dir)
            audio_out = target_dir / f"{stem}.wav"
            text_out = target_dir / f"{stem}.txt"
            tmp_audio = _atomic_temp_path(audio_out)
            try:
                write_wav(str(tmp_audio), pcm, 16000)
                os.replace(tmp_audio, audio_out)
                _write_recording_text_file(
                    out=text_out,
                    title=title,
                    source_text="[Recovered live audio capture]",
                    transcript_text="",
                    provider="local",
                    model=model,
                    language=language,
                )
            except Exception:
                # Roll back: if the text write failed after the audio was
                # already placed at its final path, delete the orphaned
                # audio so it doesn't leak on disk with no .txt sibling.
                try:
                    audio_out.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            finally:
                tmp_audio.unlink(missing_ok=True)
            # Same retention policy as ``save_recording_with_audio``: recovered
            # sessions are the new "latest", so older audio files in the archive
            # get pruned.
            _prune_old_recording_audio(target_dir, stem)
            _invalidate_recordings_cache()
            _delete_live_recovery(session_id)
            result = {
                "name": text_out.name,
                "audio_name": audio_out.name,
                "archive_dir": str(target_dir),
            }
            _store_live_promote_cache(session_id, result)
    finally:
        # Always release the per-session lock entry so the dict does not
        # grow unbounded when callers hit 404/400 and never retry.
        _release_session_promote_lock(session_id)
    return result


async def _require_api_auth(request: Request) -> None:
    if request.url.path in {"/api/health", "/api/network"}:
        return
    provided = (request.headers.get("x-api-token") or request.query_params.get("token") or "").strip()
    # Constant-time comparison — prevents a timing-attack-based byte-by-byte
    # recovery of API_TOKEN over the loopback/LAN. secrets.compare_digest
    # requires both operands to be the same type; encode to bytes so a
    # unicode-only user input cannot panic the comparison.
    if not provided or not secrets.compare_digest(provided.encode("utf-8"), API_TOKEN.encode("utf-8")):
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


# Cache-control policy:
#   /           → no-store (HTML entry changes on every rebuild; clients must
#                 always fetch the latest bundle hashes).
#   /assets/*   → immutable, 1 year (Vite emits hashed filenames).
#   /api/*      → no caching headers (let FastAPI responses decide).
_INDEX_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}
_ASSETS_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=31536000, immutable",
}


@app.middleware("http")
async def add_frontend_cache_control(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path or ""
    if path.startswith("/assets/"):
        for k, v in _ASSETS_CACHE_HEADERS.items():
            response.headers[k] = v
    return response


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
        html = html.replace("</body>", injected + "</body>")
    else:
        html = html + injected
    return HTMLResponse(html, headers=_INDEX_CACHE_HEADERS)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/transcribe/warmup")
async def transcribe_warmup(
    _auth: None = Depends(_require_api_auth),
    model: str = Form("small"),
):
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")
    loop = asyncio.get_running_loop()
    state = await loop.run_in_executor(None, lambda: warm_model(model, probe=False))
    return {"ok": True, "model": model, "state": warm_state(model) or state}


@app.get("/api/network")
async def network_status(_auth: None = Depends(_require_api_auth)):
    """Probe public URLs for connectivity.

    Runs in a thread pool via asyncio.to_thread so the blocking
    urllib calls never stall the FastAPI event loop — without this,
    3 × 2.5 s sequential probes would freeze all concurrent WS
    frames and recording saves for up to 7.5 s.
    """
    probes = (
        "https://openrouter.ai",
        "https://www.google.com/generate_204",
        "https://www.cloudflare.com/cdn-cgi/trace",
    )

    def _probe_sync() -> dict:
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

    return await asyncio.to_thread(_probe_sync)


async def _save_upload_file(upload: UploadFile, target: Path) -> int:
    """Stream an UploadFile to disk with a hard MAX_UPLOAD_BYTES ceiling.

    If the request exceeds the ceiling OR any other exception bubbles
    out of the copy loop, the partially-written target is unlinked
    before the exception propagates. Without the cleanup, a client
    uploading a 2 GB file would leave up to 500 MB of orphaned bytes
    on disk on every attempt, eventually filling the data volume.

    The partial file is rendered unusable anyway (it's truncated at
    the ceiling), and FastAPI endpoints always retry with a fresh
    tmp path if needed, so deleting it here is safe.
    """
    total = 0
    try:
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
    except BaseException:
        # Partial upload cleanup. BaseException covers HTTPException,
        # asyncio.CancelledError (client disconnected mid-upload), and
        # unexpected OSErrors (disk full, permission change). In every
        # case the file on disk is either truncated or incomplete —
        # deleting it is the correct contract. ``missing_ok`` guards
        # against the (rare) case where ``target.open`` itself threw
        # before the file was ever created.
        try:
            target.unlink(missing_ok=True)
        except OSError as cleanup_err:
            logger.warning(
                "partial upload cleanup failed for %s: %s", target, cleanup_err
            )
        raise


def _atomic_write_text(path: Path, content: str) -> None:
    tmp_path = path.with_suffix(path.suffix + f".tmp-{uuid.uuid4().hex}")
    tmp_path.write_text(content, encoding="utf-8")
    try:
        os.replace(tmp_path, path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


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
    """Return True if the exception is a harmless broken-pipe or WebSocket shutdown race.

    These errors occur when the client disconnects mid-stream (e.g., tab close,
    network drop) and the server tries to write to a closed pipe. They are
    transient and safe to ignore — the recording data has already been captured.
    """
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
    # ``websockets`` library (used for the upstream Deepgram connection)
    # raises this when ``send()`` fires after ``close()`` has already
    # gone out. It's the same class of post-close race as the Starlette
    # "after sending 'websocket.close'" message above, just from the
    # opposite side of the socket. Treating it as harmless keeps
    # production logs clean — previously it surfaced as a WARNING
    # (``ws send failed: Cannot call "send" once a close message has
    # been sent``) several times per recording during finalize.
    if 'cannot call "send" once a close message has been sent' in msg:
        return True
    # Same class, different phrasing used by some websockets versions
    # and by the ``ConnectionClosedOK``/``ConnectionClosedError``
    # exception chain.
    if "no close frame received or sent" in msg:
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
            logger.warning("transcribe retry: broken pipe on attempt %d, retrying...", attempt + 1)
            time.sleep(0.35)
    if last_exc:
        raise last_exc
    raise RuntimeError("transcribe_with_retry failed without exception")


def _run_local_transcribe_once(
    *,
    run_id: str,
    upload_path: Path,
    model: str,
    language: Optional[str],
    split_stereo: bool,
    word_timestamps: bool,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> dict[str, Any]:
    temp_paths: list[str] = []

    def set_progress(value: float) -> None:
        if progress_cb is None:
            return
        try:
            progress_cb(value)
        except Exception as e:
            logger.debug("progress callback raised: %s", e)

    try:
        if split_stereo:
            wav_path = str(RESULTS_DIR / f"{run_id}.16k.wav")
            temp_paths.append(wav_path)
            ensure_wav_16k(str(upload_path), wav_path, channels=2)
            set_progress(0.15)
            ch1, ch2 = split_channels(wav_path)
        else:
            ch1, ch2 = (None, None)
            set_progress(0.15)

        if ch1 and ch2:
            temp_paths.extend([ch1, ch2])
            set_progress(0.2)
            t1 = _transcribe_with_retry(
                ch1, model, language=language, word_timestamps=word_timestamps
            )
            set_progress(0.6)
            t2 = _transcribe_with_retry(
                ch2, model, language=language, word_timestamps=word_timestamps
            )
            set_progress(0.9)
            return merge_channel_transcripts(t1, t2)

        set_progress(0.25)
        mono_wav = str(RESULTS_DIR / f"{run_id}.mono16k.wav")
        temp_paths.append(mono_wav)
        ensure_wav_16k(str(upload_path), mono_wav, channels=1)
        return _transcribe_with_retry(
            mono_wav, model, language=language, word_timestamps=word_timestamps
        )
    finally:
        for p in temp_paths:
            try:
                os.remove(p)
            except OSError as e:
                logger.debug("temp file removal skipped for %s: %s", p, e)


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


# Single lock guards all three (result, timestamp, key) triples for the
# list/graph/stats caches below. The GIL makes each individual assignment
# atomic, but the three-write mutation sequence can interleave across
# concurrent FastAPI workers, leaving cache globals in an inconsistent
# state (new data + old key → persistent cache miss until TTL). Each
# cache's read/write paths acquire this lock; contention is minimal
# because the critical sections are a handful of scalar writes.
_recordings_caches_lock = threading.Lock()


def _invalidate_recordings_cache() -> None:
    global _list_cache, _list_cache_at, _list_cache_key
    global _graph_cache, _graph_cache_at, _graph_cache_key
    global _stats_cache, _stats_cache_at, _stats_cache_key
    with _recordings_caches_lock:
        _list_cache = None
        _list_cache_at = 0.0
        _list_cache_key = None
        _graph_cache = None
        _graph_cache_at = 0.0
        _graph_cache_key = None
        _stats_cache = None
        _stats_cache_at = 0.0
        _stats_cache_key = None


def _invalidate_recordings_dir_cache() -> None:
    global _rec_dir_cache, _rec_dir_cache_at
    _rec_dir_cache = None
    _rec_dir_cache_at = 0.0


def _resolve_recordings_dir(cfg: Optional[dict] = None) -> Path:
    global _rec_dir_cache, _rec_dir_cache_at
    # monotonic for TTL — internal cache check, immune to clock skew.
    now = time.monotonic()
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
            except OSError as e:
                logger.warning("volatile recordings migration failed: %s", e)
            try:
                prefs["recordings_dir"] = ""
                cfg["preferences"] = prefs
                save_config(cfg)
            except OSError as e:
                logger.warning("volatile config reset failed: %s", e)
            _rec_dir_cache = default_dir
            _rec_dir_cache_at = now
            return default_dir

        # Security: mirror the containment check in
        # _resolve_recordings_target_dir. A config-driven path outside
        # the user's home dir (manual edit, migration bug, attacker
        # with write access to config.json) would otherwise let the
        # backend create directories under /tmp, /var, /etc — anywhere
        # the process can write. Fall back to the default when unsafe.
        try:
            p.relative_to(Path.home().resolve())
        except ValueError:
            logger.warning(
                "recordings_dir %s is outside home; falling back to default %s",
                p, default_dir,
            )
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


def _recording_stem(name_or_title: str) -> str:
    raw = os.path.basename(name_or_title or "").strip()
    if raw.endswith(".txt"):
        return Path(raw).stem
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return f"{ts}__{_sanitize_name(raw or 'recording')}"


def _atomic_temp_path(final_path: Path) -> Path:
    suffix = "".join(final_path.suffixes)
    stem = final_path.name[: -len(suffix)] if suffix else final_path.name
    return final_path.with_name(f"{stem}.tmp-{uuid.uuid4().hex}{suffix}")


def _recording_path_or_404(name: str, target_dir: Optional[Path] = None) -> Path:
    safe = os.path.basename(name or "")
    if not safe.endswith(".txt") or safe in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="invalid recording name")
    p = (target_dir or _resolve_recordings_dir()) / safe
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="recording not found")
    return p


def _resolve_recordings_target_dir(archive_dir: str = "", *, create: bool = True) -> Path:
    """Validate + resolve a user-supplied recordings archive path.

    Security invariant: the *resolved* path (with symlinks followed
    via ``Path.resolve()``) must be inside the user's home directory.
    This blocks the classic symlink-escape bug where a path like
    ``~/evil -> /etc/shadow`` looks innocuous but actually targets a
    system file: ``resolve()`` returns ``/etc/shadow``, the
    ``relative_to(home_dir)`` check then raises ``ValueError`` and
    we surface a 403. The same logic also handles macOS's ``/var``
    → ``/private/var`` symlinks safely.

    Note that for a local Electron app the threat model is "protect
    the app from misconfiguration", not "protect the user from
    themselves" — this is defence against typos and stale paths, not
    against a malicious local user.
    """
    hint = str(archive_dir or "").strip()
    if not hint:
        resolved = _resolve_recordings_dir()
        if create:
            resolved.mkdir(parents=True, exist_ok=True)
        return resolved
    candidate = Path(hint).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="archive_dir must be an absolute path")
    resolved = candidate.resolve()
    home_dir = Path.home().resolve()
    try:
        resolved.relative_to(home_dir)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="archive_dir is outside allowed directories") from exc
    if create:
        resolved.mkdir(parents=True, exist_ok=True)
    elif not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=409, detail="archive directory is no longer available")
    return resolved


def _recording_audio_path(name: str, target_dir: Optional[Path] = None) -> Optional[Path]:
    stem = Path(os.path.basename(name or "")).stem
    if not stem:
        return None
    root_dir = target_dir or _resolve_recordings_dir()
    for ext in (".wav", ".m4a", ".mp3", ".flac", ".ogg", ".aac", ".mp4", ".webm"):
        candidate = root_dir / f"{stem}{ext}"
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


_AUDIO_EXTS_FOR_RETENTION: tuple[str, ...] = (
    ".wav",
    ".m4a",
    ".mp3",
    ".flac",
    ".ogg",
    ".aac",
    ".mp4",
    ".webm",
)


def _prune_old_recording_audio(
    target_dir: Path, keep_stem: str
) -> int:
    """Retention policy: keep audio only for the *latest* recording.

    Every recording still keeps its ``.txt`` transcript forever —
    transcripts are cheap text and the user wants history. Audio files
    are the expensive part (tens of MB each) and the user only ever
    wants to re-listen to the MOST RECENT recording. This helper walks
    the archive directory and deletes any audio whose stem does not
    match ``keep_stem`` (the stem of the freshly-saved recording).

    Returns the number of audio files deleted.
    """
    if not keep_stem:
        return 0
    deleted = 0
    try:
        entries = list(target_dir.iterdir())
    except OSError as e:
        logger.warning("audio retention scan failed for %s: %s", target_dir, e)
        return 0
    for entry in entries:
        try:
            if not entry.is_file():
                continue
            ext = entry.suffix.lower()
            if ext not in _AUDIO_EXTS_FOR_RETENTION:
                continue
            if entry.stem == keep_stem:
                continue
            # Only delete if there's a sibling .txt — this guards
            # against nuking an orphan audio file that might belong to
            # an in-progress save from another process.
            txt_sibling = entry.with_suffix(".txt")
            if not txt_sibling.exists():
                continue
            try:
                entry.unlink()
                deleted += 1
                logger.info(
                    "audio retention: removed %s (keeping only %s)",
                    entry.name,
                    keep_stem,
                )
            except OSError as e:
                logger.warning("audio retention: failed to remove %s: %s", entry, e)
        except OSError as e:
            logger.debug("audio retention: skip %s: %s", entry, e)
    return deleted


def _register_archive_dir(path: Path) -> None:
    """Persist *path* in the known-archive-dirs registry.

    Only custom dirs (those that differ from the current default) need
    to be registered — the default dir is always scanned by
    ``_retroactive_audio_retention`` without any registry entry.

    The registry file is a JSON array of absolute path strings stored
    at ``_ARCHIVE_DIR_REGISTRY_PATH``.  Writes are serialised by
    ``_archive_dir_registry_lock`` and executed atomically via a
    temp-file rename so a crash mid-write never produces a corrupt
    registry.
    """
    try:
        default = _resolve_recordings_dir()
        if path.resolve() == default.resolve():
            return  # Default dir always included — no need to register
    except Exception:
        pass  # Can't compare; register defensively
    abs_str = str(path.resolve())
    with _archive_dir_registry_lock:
        try:
            parsed = (
                json.loads(_ARCHIVE_DIR_REGISTRY_PATH.read_text(encoding="utf-8"))
                if _ARCHIVE_DIR_REGISTRY_PATH.exists()
                else []
            )
            # Defend against a corrupted registry (manual edit, partial
            # write from an old build): anything other than a list of
            # strings is treated as empty and rewritten from scratch on
            # the next append. We never raise on bad data — retention
            # sweeps must not crash because one JSON file is malformed.
            existing: list[str] = (
                [str(x) for x in parsed if isinstance(x, str)]
                if isinstance(parsed, list)
                else []
            )
        except Exception:
            existing = []
        if abs_str in existing:
            return  # Already known — no write needed
        existing.append(abs_str)
        try:
            _atomic_write_text(_ARCHIVE_DIR_REGISTRY_PATH, json.dumps(sorted(existing)))
        except Exception as exc:
            logger.warning("register_archive_dir: write failed for %s: %s", abs_str, exc)


def _get_known_archive_dirs() -> list[Path]:
    """Return all archive dirs that should be scanned for audio retention.

    Always includes the current default recordings dir.  Additionally
    includes every custom dir persisted by ``_register_archive_dir``,
    filtering out entries that no longer exist on disk (e.g. removable
    drives that are not currently mounted).  Duplicates (resolved) are
    deduplicated.
    """
    candidates: list[Path] = []
    try:
        candidates.append(_resolve_recordings_dir())
    except Exception as exc:
        logger.warning("known_archive_dirs: default dir resolve failed: %s", exc)
    with _archive_dir_registry_lock:
        try:
            parsed = (
                json.loads(_ARCHIVE_DIR_REGISTRY_PATH.read_text(encoding="utf-8"))
                if _ARCHIVE_DIR_REGISTRY_PATH.exists()
                else []
            )
            # Defend against a corrupted registry — see _register_archive_dir.
            raw_list: list[str] = (
                [str(x) for x in parsed if isinstance(x, str)]
                if isinstance(parsed, list)
                else []
            )
        except Exception:
            raw_list = []
    for s in raw_list:
        try:
            p = Path(s)
            if p.exists() and p.is_dir():
                candidates.append(p)
        except Exception:
            continue
    # Deduplicate by resolved absolute path.
    seen: set[str] = set()
    result: list[Path] = []
    for d in candidates:
        try:
            key = str(d.resolve())
        except Exception:
            key = str(d)
        if key not in seen:
            seen.add(key)
            result.append(d)
    return result


def _retroactive_audio_retention(target_dir: Optional[Path] = None) -> int:
    """Enforce the "one audio per archive" rule on an existing archive.

    The per-save retention policy (_prune_old_recording_audio) only
    runs when a NEW recording is saved. For users who accumulated
    audio files from previous app versions, those stay on disk
    forever. This helper walks the whole archive, finds the newest
    ``.txt`` transcript, and deletes every audio file that doesn't
    belong to that newest stem.

    Called once on backend startup with no argument: scans ALL known
    archive dirs (default + every custom dir persisted via
    ``_register_archive_dir``).  Can also be called with a specific
    ``target_dir`` for single-directory retention (used internally by
    the multi-dir loop below).

    Safe to call repeatedly — it becomes a no-op when there's nothing
    to prune.
    """
    # Multi-dir startup sweep: iterate every known archive dir.
    if target_dir is None:
        total = 0
        for d in _get_known_archive_dirs():
            total += _retroactive_audio_retention(target_dir=d)
        return total

    root = target_dir
    try:
        entries = list(root.iterdir())
    except OSError as e:
        logger.warning("retroactive audio retention: iterdir failed: %s", e)
        return 0

    # Pick the newest .txt transcript by mtime; its stem is the one we
    # keep audio for.
    newest_txt: Optional[Path] = None
    newest_mtime: float = -1.0
    for entry in entries:
        try:
            if not entry.is_file():
                continue
            if entry.suffix.lower() != ".txt":
                continue
            m = entry.stat().st_mtime
            if m > newest_mtime:
                newest_mtime = m
                newest_txt = entry
        except OSError as e:
            logger.debug("retroactive audio retention: stat failed for %s: %s", entry, e)
            continue

    keep_stem = newest_txt.stem if newest_txt else ""
    if not keep_stem:
        # Nothing to keep; don't nuke everything.
        return 0
    pruned = _prune_old_recording_audio(root, keep_stem)
    if pruned > 0:
        logger.info(
            "retroactive audio retention: pruned %d old audio files, kept %s",
            pruned,
            keep_stem,
        )
    return pruned


def _recording_audio_payload(name: str, target_dir: Optional[Path] = None) -> dict[str, Any]:
    audio_path = _recording_audio_path(name, target_dir=target_dir)
    if audio_path is None:
        return {
            "has_audio": False,
            "audio_name": "",
            "audio_size_bytes": 0,
            "audio_mime": "",
        }
    mime = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    try:
        size_bytes = audio_path.stat().st_size
    except Exception:
        size_bytes = 0
    return {
        "has_audio": True,
        "audio_name": audio_path.name,
        "audio_size_bytes": size_bytes,
        "audio_mime": mime,
    }


def _render_recording_content(
    *,
    title: str,
    source_text: str,
    transcript_text: str,
    provider: str,
    model: str,
    language: str,
) -> str:
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
    return "\n".join(lines).strip() + "\n"


def _write_recording_text_file(
    *,
    out: Path,
    title: str,
    source_text: str,
    transcript_text: str,
    provider: str,
    model: str,
    language: str,
) -> None:
    _atomic_write_text(
        out,
        _render_recording_content(
            title=title,
            source_text=source_text,
            transcript_text=transcript_text,
            provider=provider,
            model=model,
            language=language,
        ),
    )


def _extract_stats_text(content: str) -> str:
    text = (content or "").strip()
    if not text:
        return ""
    # Prefer Transcription section (clean text) over Original (raw live)
    m_trans = re.search(r"Transcription:\s*(.*)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_trans:
        result = m_trans.group(1).strip()
        # Strip any trailing sections that might follow
        result = re.split(r"\n\s*Original:", result, maxsplit=1, flags=re.IGNORECASE)[0].strip()
        if result:
            return result
    m_orig = re.search(r"Original:\s*(.*)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_orig:
        result = m_orig.group(1).strip()
        result = re.split(r"\n\s*Transcription:", result, maxsplit=1, flags=re.IGNORECASE)[0].strip()
        if result:
            return result
    return text


def _extract_transcript_text(content: str) -> str:
    """Extract transcript text specifically for display name generation.
    Prefers Transcription section, falls back to Original."""
    text = (content or "").strip()
    if not text:
        return ""
    m_trans = re.search(r"Transcription:\s*(.*?)(?:\n\s*$|\nOriginal:|$)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_trans and m_trans.group(1).strip():
        return m_trans.group(1).strip()
    m_orig = re.search(r"Original:\s*(.*?)(?:\n\s*$|\nTranscription:|$)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_orig and m_orig.group(1).strip():
        return m_orig.group(1).strip()
    return ""


def _first_words(content: str, max_words: int = 8) -> str:
    """Extract first N meaningful words from recording file content for display name."""
    text = _extract_transcript_text(content)
    if not text:
        return ""
    # Strip bracketed markers like [Silence]
    text = re.sub(r"\[.*?\]", "", text).strip()
    if not text:
        return ""
    # Collapse whitespace and take first N words
    words = text.split()
    preview = " ".join(words[:max_words])
    if len(words) > max_words:
        preview += "..."
    # Limit total length for UI
    if len(preview) > 80:
        preview = preview[:77] + "..."
    return preview


def _tokenize_words(text: str) -> list[str]:
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]{2,}", (text or "").lower())
    return [w for w in words if w not in COMMON_STOPWORDS]


def _extract_meta_field(content: str, field: str) -> str:
    pattern = rf"^{re.escape(field)}:\s*(.+)$"
    m = re.search(pattern, content or "", flags=re.IGNORECASE | re.MULTILINE)
    return (m.group(1).strip() if m else "")


def _upscale_preset_path(preset_id: str) -> Path:
    raw = (preset_id or "").strip()
    if not UPSCALE_PRESET_ID_RE.fullmatch(raw):
        raise HTTPException(status_code=400, detail="invalid preset id")
    return UPSCALE_PRESETS_DIR / f"{raw}.json"


def _write_upscale_preset(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write: tmp → replace. A crash mid-write leaves the tmp
    # file and the original preset intact instead of corrupting the
    # .json and permanently losing the user's custom preset.
    tmp = path.with_suffix(f".tmp-{uuid.uuid4().hex}.json")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


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
    """Provider-aware live transcription WebSocket.

    Protocol (client → server):
        - Binary PCM16LE mono frames at the configured sample rate.
        - Text JSON control messages, e.g. ``{"type": "finalize"}`` which
          flushes the upstream session and causes the server to emit a
          canonical ``{"type": "final", ...}`` event before closing.

    Protocol (server → client):
        - ``{"type": "segments", "segments": [...], "is_final": bool}`` —
          a committed chunk of transcript ready to merge into the SSOT.
        - ``{"type": "interim", "segment": {...}}`` — (Deepgram only) a
          non-committed partial hypothesis for the tail of the stream.
        - ``{"type": "final", "text": str, "segments": [...],
             "durationSec": float}`` — the canonical transcript at end
          of session.
        - ``{"type": "error", "error": str}`` — unrecoverable failure.
    """
    # Kick the recovery cleanup off the event loop — the websocket
    # handshake must not wait for a directory scan on slow filesystems.
    # Attach a done-callback so exceptions (permission denied, disk full)
    # surface in the log instead of being silently lost by the executor.
    _cleanup_future = asyncio.get_running_loop().run_in_executor(
        None, _cleanup_live_recovery_files
    )

    def _log_cleanup_error(fut: "asyncio.Future[None]") -> None:
        exc = fut.exception()
        if exc is not None:
            logger.warning("live recovery cleanup failed: %s", exc)

    _cleanup_future.add_done_callback(_log_cleanup_error)
    token = (websocket.query_params.get("token") or "").strip()
    # Constant-time comparison — matches the HTTP auth path (see
    # `_require_api_auth`). Without this a local attacker can recover
    # API_TOKEN one byte at a time by measuring WS close latency.
    if not token or not secrets.compare_digest(token.encode("utf-8"), API_TOKEN.encode("utf-8")):
        await websocket.close(code=4401, reason="unauthorized")
        return
    client_key = websocket.client.host if websocket.client else "unknown"
    if not _touch_rate_limit(_ws_windows, client_key, WS_CONNECT_LIMIT_PER_MIN):
        await websocket.close(code=4429, reason="rate limit exceeded")
        return
    await websocket.accept()

    qp = websocket.query_params
    provider = _normalize_live_provider(qp.get("provider"))
    model = (qp.get("model") or "").strip()
    language = (qp.get("language") or "auto").strip()
    lang_opt: Optional[str] = None if language in ("", "auto", "Auto") else language
    session_id = _normalize_live_session_id(qp.get("session_id") or "")
    archive_dir = str(qp.get("archive_dir") or "").strip()
    diarize = str(qp.get("diarize") or "").strip().lower() in ("1", "true", "yes", "on")

    started_at = datetime.now()
    recovery_ctx: Optional[dict] = None
    try:
        # Open inside the try so that any filesystem error (ENOSPC,
        # EACCES, stale network mount) is caught by the finally below
        # and the accepted WebSocket is still closed cleanly.
        recovery_ctx = _open_live_recovery(
            session_id=session_id,
            started_at=started_at,
            provider=provider,
            model=model or ("nova-3" if provider == "deepgram" else "small"),
            language=lang_opt or "auto",
            archive_dir=archive_dir,
        )
        if provider == "deepgram":
            dg_cfg = load_config()
            dg_key = (((dg_cfg.get("providers") or {}).get("deepgram") or {}).get("key") or "").strip()
            if not dg_key:
                await _ws_send_json(
                    websocket,
                    {
                        "type": "error",
                        "error": "Deepgram API key is not configured",
                        "fatal": True,
                    },
                )
                await _ws_send_json(
                    websocket,
                    {
                        "type": "final",
                        "text": "",
                        "segments": [],
                        "durationSec": 0.0,
                        "source": "deepgram-live",
                        "error": "Deepgram API key is not configured",
                    },
                )
                if recovery_ctx is not None:
                    recovery_ctx["had_error"] = True
                return
            await _run_deepgram_live_session(
                websocket=websocket,
                api_key=dg_key,
                model=model or "nova-3",
                language=language,
                diarize=diarize,
                recovery=recovery_ctx,
            )
        else:
            await _run_local_live_session(
                websocket=websocket,
                model=model or "small",
                language=lang_opt,
                recovery=recovery_ctx,
            )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        if not _is_broken_pipe_error(e):
            if recovery_ctx is not None:
                recovery_ctx["had_error"] = True
            logger.error("ws/transcribe fatal error: %s", e, exc_info=True)
            await _ws_send_json(
                websocket,
                {"type": "error", "error": str(e), "fatal": True},
            )
        else:
            logger.warning("ws/transcribe transient broken pipe: %s", e)
    finally:
        if recovery_ctx is not None:
            _finalize_live_recovery(recovery_ctx)


def _normalize_live_provider(raw: Optional[str]) -> str:
    """Return the provider to use for a live WebSocket session.

    Only providers with genuine streaming support (``deepgram``) take a
    dedicated path; everything else runs the local ``LiveSession``
    assist pipeline.
    """
    value = (raw or "").strip().lower()
    if value == "deepgram":
        return "deepgram"
    return "local"


def _open_live_recovery(
    *,
    session_id: str,
    started_at: datetime,
    provider: str,
    model: str,
    language: str,
    archive_dir: str,
) -> dict:
    """Create a recovery PCM file + metadata for a live session.

    Ordering is critical for leak-freedom:
      1. Build ``meta_payload`` in memory (infallible).
      2. Write metadata JSON to disk (cheap, fails fast on ENOSPC /
         permission denied / etc.).
      3. Only NOW open the PCM file for append. If any step before
         this raises, there is no file handle to close.
      4. If the function is about to succeed but a later step inside
         this function raises, the local ``pcm_file`` is closed
         before re-raising. Callers receive either a fully-usable
         recovery context or an exception with nothing leaked.
    """
    stem = f"{started_at.strftime('%Y%m%d_%H%M%S')}_{session_id}"
    pcm_path = LIVE_RECOVERY_DIR / f"{stem}.pcm16"
    meta_path = LIVE_RECOVERY_DIR / f"{stem}.json"
    meta_payload = {
        "session_id": session_id,
        "started_at": started_at.isoformat(),
        "finished_at": "",
        "sample_rate": 16000,
        "format": "pcm16le_mono",
        "bytes": 0,
        "chunks": 0,
        "model": model,
        "language": language,
        "archive_dir": archive_dir,
        "status": "recording",
        "provider": provider,
    }
    # Metadata first — if this fails there is no file handle to leak.
    meta_path.write_text(
        json.dumps(meta_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    pcm_file = pcm_path.open("wb")
    try:
        return {
            "session_id": session_id,
            "started_at": started_at,
            "pcm_path": pcm_path,
            "meta_path": meta_path,
            "pcm_file": pcm_file,
            "meta": meta_payload,
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }
    except BaseException:
        # Closing the file before propagating so no FD leaks on an
        # unexpected error constructing the return dict.
        try:
            pcm_file.close()
        except OSError:
            pass
        raise


def _record_recovery_chunk(recovery: dict, data: bytes) -> None:
    # Hard cap on the per-session recovery spool. Without this a user
    # who leaves a tab streaming overnight (or a runaway reconnect loop)
    # can fill a small SSD. We stop writing silently once the ceiling is
    # reached — the live-transcription stream itself is unaffected and
    # the finalized transcript lands in recordings/ normally.
    if recovery["bytes"] >= MAX_LIVE_RECOVERY_BYTES:
        if not recovery.get("over_limit"):
            recovery["over_limit"] = True
            logger.warning(
                "live recovery byte cap reached (%d B >= %d B); "
                "dropping further recovery writes for this session",
                recovery["bytes"], MAX_LIVE_RECOVERY_BYTES,
            )
        return
    recovery["chunks"] += 1
    recovery["bytes"] += len(data)
    try:
        recovery["pcm_file"].write(data)
    except OSError as e:
        logger.warning("live recovery write failed: %s", e)


def _finalize_live_recovery(recovery: dict) -> None:
    try:
        recovery["pcm_file"].flush()
        recovery["pcm_file"].close()
    except OSError as e:
        logger.warning("live recovery close failed: %s", e)
    try:
        if recovery["bytes"] < 32000:  # ~1s at 16kHz mono pcm16
            recovery["pcm_path"].unlink(missing_ok=True)
            recovery["meta_path"].unlink(missing_ok=True)
            return
        meta = dict(recovery["meta"])
        meta.update(
            {
                "finished_at": datetime.now().isoformat(),
                "bytes": recovery["bytes"],
                "chunks": recovery["chunks"],
                "status": "error" if recovery["had_error"] else "recoverable",
            }
        )
        recovery["meta_path"].write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as e:
        logger.warning("live recovery meta write failed: %s", e)


async def _ws_send_json(websocket: WebSocket, payload: dict) -> bool:
    """Send a JSON payload on a WebSocket, swallowing harmless shutdown races.

    Returns ``True`` on success. Logs transient broken-pipe errors and
    returns ``False`` without raising so the caller can continue its
    cleanup.
    """
    try:
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception as e:
        if _is_broken_pipe_error(e):
            logger.debug("ws send skipped (pipe closed): %s", e)
        else:
            logger.warning("ws send failed: %s", e)
        return False


async def _ws_recv_next(websocket: WebSocket) -> dict:
    """Receive the next WebSocket message as a normalized dict.

    Returns ``{"kind": "bytes", "data": bytes}`` for binary frames,
    ``{"kind": "control", "payload": dict}`` for JSON text frames
    (e.g., ``{"type": "finalize"}``), ``{"kind": "text", "data": str}``
    for text frames that fail to parse as JSON, or
    ``{"kind": "disconnect"}`` when the client closed the socket.
    """
    try:
        message = await websocket.receive()
    except WebSocketDisconnect:
        return {"kind": "disconnect"}
    mtype = message.get("type")
    if mtype == "websocket.disconnect":
        return {"kind": "disconnect"}
    if "bytes" in message and message["bytes"] is not None:
        return {"kind": "bytes", "data": message["bytes"]}
    text = message.get("text")
    if text is None:
        return {"kind": "disconnect"}
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return {"kind": "control", "payload": parsed}
    except (ValueError, TypeError) as e:
        logger.debug("ws recv: non-json text frame ignored: %s", e)
    return {"kind": "text", "data": text}


async def _run_local_live_session(
    *,
    websocket: WebSocket,
    model: str,
    language: Optional[str],
    recovery: dict,
) -> None:
    """Drive the local faster-whisper assist pipeline for a live session."""
    if model not in ALLOWED_LOCAL_MODELS:
        model = "small"
    session = LiveSession(model_name=model, language=language)
    stop = asyncio.Event()

    async def receiver() -> None:
        try:
            while not stop.is_set():
                msg = await _ws_recv_next(websocket)
                kind = msg["kind"]
                if kind == "disconnect":
                    stop.set()
                    return
                if kind == "bytes":
                    data = msg["data"]
                    _record_recovery_chunk(recovery, data)
                    await session.append_pcm16le(data)
                    continue
                if kind == "control":
                    if msg["payload"].get("type") == "finalize":
                        stop.set()
                        return
        except Exception as e:
            if _is_broken_pipe_error(e):
                logger.warning("ws local receiver broken pipe: %s", e)
            else:
                recovery["had_error"] = True
                logger.error("ws local receiver error: %s", e, exc_info=True)
            stop.set()

    async def transcriber() -> None:
        try:
            while not stop.is_set():
                out = await session.maybe_transcribe()
                if out:
                    if not await _ws_send_json(websocket, out):
                        stop.set()
                        return
                    # A fatal error envelope from LiveSession means the
                    # pipeline exceeded its retry budget and cannot
                    # produce more segments. Mark the session as errored
                    # so `_finalize_live_recovery` retains the PCM for
                    # offline recovery, then let the receiver drain.
                    if (
                        isinstance(out, dict)
                        and out.get("type") == "error"
                        and out.get("fatal")
                    ):
                        recovery["had_error"] = True
                        stop.set()
                        return
                try:
                    await asyncio.wait_for(stop.wait(), timeout=0.2)
                except asyncio.TimeoutError:
                    pass
        except Exception as e:
            if _is_broken_pipe_error(e):
                logger.warning("ws local transcriber broken pipe: %s", e)
            else:
                recovery["had_error"] = True
                logger.error("ws local transcriber error: %s", e, exc_info=True)
            stop.set()

    rx = asyncio.create_task(receiver(), name="ws-local-rx")
    tx = asyncio.create_task(transcriber(), name="ws-local-tx")
    try:
        await asyncio.wait({rx, tx}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.set()
        for task in (rx, tx):
            if not task.done():
                task.cancel()
        for task in (rx, tx):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        # Best-effort final emit in case transcriber missed the tail
        try:
            tail = await session.maybe_transcribe()
            if tail:
                await _ws_send_json(websocket, tail)
        except Exception as e:
            if not _is_broken_pipe_error(e):
                logger.debug("ws local tail emit failed: %s", e)
        await _ws_send_json(
            websocket,
            {
                "type": "final",
                "text": "",
                "segments": [],
                "durationSec": 0.0,
                "source": "local-assist",
            },
        )


async def _run_deepgram_live_session(
    *,
    websocket: WebSocket,
    api_key: str,
    model: str,
    language: str,
    diarize: bool,
    recovery: dict,
) -> None:
    """Drive the Deepgram live streaming proxy for one recording.

    On a hard Deepgram failure (connect error, mid-stream fatal error,
    socket drop) we do NOT swallow the failure — we surface it to the
    frontend via ``{"type":"error","fatal":true}`` and the subsequent
    ``{"type":"final","error":...}``. The frontend then falls back to
    the Deepgram REST endpoint on the saved canonical WAV. This gives
    us two independent paths into Deepgram (WS + REST) without coupling
    the server state machine to either one.
    """
    dg_cfg = DeepgramLiveConfig(
        model=model or "nova-3",
        language=language or "auto",
        sample_rate=16000,
        interim_results=True,
        diarize=bool(diarize),
    )
    session = DeepgramLiveSession(api_key=api_key, config=dg_cfg)
    try:
        await session.connect()
    except DeepgramLiveError as e:
        logger.warning("ws deepgram connect failed: %s", e)
        await _ws_send_json(
            websocket,
            {"type": "error", "error": str(e), "fatal": True},
        )
        await _ws_send_json(
            websocket,
            {
                "type": "final",
                "text": "",
                "segments": [],
                "durationSec": 0.0,
                "source": "deepgram-live",
                "error": str(e),
            },
        )
        recovery["had_error"] = True
        return

    stop = asyncio.Event()
    upstream_fatal = False

    async def receiver() -> None:
        try:
            while not stop.is_set():
                msg = await _ws_recv_next(websocket)
                kind = msg["kind"]
                if kind == "disconnect":
                    stop.set()
                    return
                if kind == "bytes":
                    if session.is_closed:
                        # Upstream already died; keep recording the
                        # PCM locally so the REST fallback has the full
                        # audio but don't waste cycles pushing it.
                        _record_recovery_chunk(recovery, msg["data"])
                        continue
                    data = msg["data"]
                    _record_recovery_chunk(recovery, data)
                    await session.send_pcm(data)
                    continue
                if kind == "control":
                    if msg["payload"].get("type") == "finalize":
                        # Tail-preserving drain: the frontend stops the
                        # microphone BEFORE sending ``finalize``, so on a
                        # healthy connection there should be no more
                        # bytes in flight. But the wire still has in-
                        # transit frames — WebSocket MessageEvent delivery
                        # is async, and if we ``return`` immediately any
                        # bytes that arrived AFTER the finalize text
                        # frame but BEFORE we drained the receive buffer
                        # would be silently dropped. A short non-blocking
                        # drain forwards those frames to Deepgram first;
                        # finalize then happens with the full audio
                        # already upstream. 250 ms covers the wire RTT
                        # and any queued fragments; anything longer is a
                        # network stall and not worth waiting for.
                        drain_deadline = time.monotonic() + 0.25
                        while time.monotonic() < drain_deadline:
                            try:
                                tail_msg = await asyncio.wait_for(
                                    _ws_recv_next(websocket),
                                    timeout=max(
                                        0.0,
                                        drain_deadline - time.monotonic(),
                                    ),
                                )
                            except asyncio.TimeoutError:
                                break
                            tail_kind = tail_msg["kind"]
                            if tail_kind == "bytes":
                                if session.is_closed:
                                    _record_recovery_chunk(
                                        recovery, tail_msg["data"],
                                    )
                                    continue
                                tail_data = tail_msg["data"]
                                _record_recovery_chunk(recovery, tail_data)
                                await session.send_pcm(tail_data)
                                continue
                            if tail_kind == "disconnect":
                                break
                            # Any non-bytes non-disconnect frame (stray
                            # control msg, text, etc.) ends the drain.
                            break
                        stop.set()
                        return
        except Exception as e:
            if _is_broken_pipe_error(e):
                logger.warning("ws deepgram receiver broken pipe: %s", e)
            else:
                recovery["had_error"] = True
                logger.error("ws deepgram receiver error: %s", e, exc_info=True)
            stop.set()

    async def forwarder() -> None:
        nonlocal upstream_fatal
        try:
            async for event in session.events():
                if not await _ws_send_json(websocket, event):
                    stop.set()
                    return
                if event.get("type") == "error":
                    recovery["had_error"] = True
                    if event.get("fatal"):
                        upstream_fatal = True
                        stop.set()
                        return
        except Exception as e:
            if not _is_broken_pipe_error(e):
                recovery["had_error"] = True
                logger.error("ws deepgram forwarder error: %s", e, exc_info=True)
            stop.set()

    rx = asyncio.create_task(receiver(), name="ws-dg-rx")
    fw = asyncio.create_task(forwarder(), name="ws-dg-fw")
    try:
        await asyncio.wait({rx, fw}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.set()
        if not rx.done():
            rx.cancel()
        try:
            await rx
        except (asyncio.CancelledError, Exception):
            pass

        final_payload: dict
        finalize_error: Optional[str] = None
        try:
            drained = await session.finalize(wait_timeout=3.0)
            final_payload = {
                "type": "final",
                "text": drained.get("text", ""),
                "segments": drained.get("segments", []),
                "durationSec": drained.get("durationSec", 0.0),
                "source": "deepgram-live",
                "stats": drained.get("stats"),
            }
        except Exception as e:
            finalize_error = str(e)
            recovery["had_error"] = True
            logger.error("deepgram finalize failed: %s", e, exc_info=True)
            final_payload = {
                "type": "final",
                "text": session.final_text(),
                "segments": [],
                "durationSec": 0.0,
                "source": "deepgram-live",
                "error": finalize_error,
            }

        if upstream_fatal and session.last_error:
            final_payload["error"] = session.last_error

        if not fw.done():
            try:
                await asyncio.wait_for(fw, timeout=0.25)
            except asyncio.TimeoutError:
                fw.cancel()
                try:
                    await fw
                except (asyncio.CancelledError, Exception):
                    pass

        logger.info(
            "ws deepgram session complete: bytes=%d chunks=%d final_segs=%d interim_segs=%d connect_ms=%s finalize_ms=%s",
            session.stats.bytes_sent,
            session.stats.chunks_sent,
            session.stats.segments_final,
            session.stats.segments_interim,
            f"{session.stats.connect_ms:.0f}" if session.stats.connect_ms else "?",
            f"{session.stats.finalize_ms:.0f}" if session.stats.finalize_ms else "?",
        )

        await _ws_send_json(websocket, final_payload)
        await session.close()


@app.get("/api/live/recoveries")
def list_live_recoveries(_auth: None = Depends(_require_api_auth)):
    _cleanup_live_recovery_files()
    return {"items": _list_live_recoveries()}


@app.post("/api/live/recoveries/{session_id}/discard")
def discard_live_recovery(session_id: str, _auth: None = Depends(_require_api_auth)):
    deleted = _delete_live_recovery(session_id)
    return {"ok": True, "deleted": deleted}


@app.post("/api/live/recoveries/{session_id}/promote")
def promote_live_recovery(
    session_id: str,
    payload: dict = Body(default_factory=dict),
    _auth: None = Depends(_require_api_auth),
):
    result = _promote_live_recovery(session_id, str((payload or {}).get("archive_dir") or "").strip())
    return {"ok": True, **result}


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
        try:
            jobs.set_running(job_id)
            result = _run_local_transcribe_once(
                run_id=job_id,
                upload_path=upload_path,
                model=model,
                language=lang_opt,
                split_stereo=split_stereo,
                word_timestamps=word_timestamps,
                progress_cb=lambda value: jobs.set_progress(job_id, value),
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
            jobs.set_error(job_id, _safe_error_text(e))
        except Exception as e:
            # Log the full exception locally so operators still have
            # the trace (paths, ffmpeg stderr, etc.), but redact before
            # persisting to the job store — job errors are returned
            # verbatim to the renderer.
            logger.exception("local transcription job failed (job_id=%s)", job_id)
            jobs.set_error(job_id, f"Transcription failed: {_safe_error_text(e)}")
        finally:
            try:
                os.remove(upload_path)
            except OSError as e:
                logger.debug("upload cleanup skipped for %s: %s", upload_path, e)

    jobs.submit(run)
    return {"job_id": job_id}


@app.post("/api/transcribe-sync")
async def transcribe_sync(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model: str = Form("small"),
    split_stereo: bool = Form(True),
    word_timestamps: bool = Form(False),
):
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")

    request_id = str(uuid.uuid4())
    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    upload_path = UPLOADS_DIR / f"{request_id}.{orig_name}"
    await _save_upload_file(file, upload_path)
    lang_opt = _normalize_language(language)
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: _run_local_transcribe_once(
                run_id=request_id,
                upload_path=upload_path,
                model=model,
                language=lang_opt,
                split_stereo=split_stereo,
                word_timestamps=word_timestamps,
            ),
        )
        return {"ok": True, "result": result}
    except AudioError as e:
        raise HTTPException(status_code=400, detail=_safe_error_text(e))
    except Exception as e:
        # Log the full trace locally; redact the response so the
        # HTTP body never carries absolute paths or ffmpeg stderr.
        logger.exception("transcribe_sync failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {_safe_error_text(e)}")
    finally:
        try:
            os.remove(upload_path)
        except OSError as e:
            logger.debug("sync upload cleanup skipped for %s: %s", upload_path, e)


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
    # Defensive `or {}` — `cfg.get("preferences", {})` returns None when
    # the key IS present with a null value (hand-edited config.json).
    # The rest of the module uses the `or {}` pattern; mirror it here
    # so a ``"preferences": null`` config doesn't crash with AttributeError.
    prov = (
        provider_norm
        or ((cfg.get("preferences") or {}).get("remote_provider"))
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
            diarize=bool(diarize),
        )
        return {
            "provider": "deepgram",
            "model": model,
            "text": (out.get("text") or "").strip(),
            "raw": out.get("raw"),
        }

    # Bad input → ValueError (translates to HTTP 400 at the endpoints).
    # Bare Exception would have been caught by the generic "Remote
    # transcription failed" branch and surfaced as 500, misleading
    # the client into retrying an unrecoverable validation error.
    raise ValueError(f"Unknown provider: {prov!r}")


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
        except ValueError as e:
            jobs.set_error(job_id, f"bad_request: {_safe_error_text(e)}")
        except (OpenRouterError, DeepgramRemoteError) as e:
            jobs.set_error(job_id, _safe_error_text(e))
        except Exception as e:
            logger.exception("remote transcription job failed (job_id=%s)", job_id)
            jobs.set_error(job_id, f"Remote transcription failed: {_safe_error_text(e)}")
        finally:
            try:
                os.remove(upload_path)
            except OSError as e:
                logger.debug("upload cleanup skipped for %s: %s", upload_path, e)

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
    # Read audio bytes into memory for speed, but enforce the same
    # MAX_UPLOAD_BYTES ceiling that _save_upload_file uses — without
    # this a 2 GB file would be fully loaded into the Python heap,
    # causing an OOM that kills the backend and all ongoing sessions.
    # Use a bytearray (O(N) amortised append) instead of immutable bytes
    # concatenation (O(N²) — reallocates the full prefix on every chunk).
    # For a 500 MB file that difference is ~125 GB of transient heap vs
    # ~500 MB, which the OOM killer resolves before the ceiling guard fires.
    _upload_buf = bytearray()
    async for chunk in file:
        _upload_buf.extend(chunk)
        if len(_upload_buf) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
            )
    audio_bytes = bytes(_upload_buf)
    del _upload_buf
    lang_opt = _normalize_language(language)
    cfg = load_config()
    loop = asyncio.get_running_loop()
    try:
        # CRITICAL: run in thread pool so synchronous requests.request()
        # does NOT block the event loop. Without this, parallel chunk
        # requests from the frontend serialize (5×3s = 15-60s).
        result = await loop.run_in_executor(
            None,
            lambda: _run_remote_transcribe_once(
                provider_norm=provider_norm,
                audio_bytes=audio_bytes,
                orig_name=orig_name,
                language=lang_opt,
                diarize=diarize,
                num_speakers=num_speakers,
                openrouter_model=openrouter_model,
                cfg=cfg,
            ),
        )
        return {"ok": True, "result": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_text(e))
    except (OpenRouterError, DeepgramRemoteError) as e:
        raise HTTPException(status_code=502, detail=_safe_error_text(e))
    except Exception as e:
        logger.exception("remote_transcribe_sync failed")
        raise HTTPException(status_code=500, detail=f"Remote transcription failed: {_safe_error_text(e)}")


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
    loop = asyncio.get_running_loop()
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
            except OpenRouterError as e:
                last_err = e
                msg = str(e)
                # Retry with fallback models only for invalid/non-existing model issues.
                if ("HTTP 404" in msg) or ("not found" in msg.lower()):
                    continue
                raise
        if out is None:
            raise last_err or RuntimeError("upscale failed")
    except OpenRouterError as e:
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
    # Deliberately omit config_path — we do not expose internal filesystem
    # layout to the renderer (user explicitly requested this).
    cfg = redact_config(load_config())
    return cfg


@app.post("/api/config")
def set_config(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _validate_config_payload(payload)
    try:
        save_config(payload)
    except OSError as e:
        # save_config logs the underlying reason; surface a clean 500 so
        # the renderer can show a meaningful toast instead of hanging on
        # an uncaught server exception.
        raise HTTPException(
            status_code=500,
            detail=f"failed to persist config: {e}",
        )
    _invalidate_recordings_dir_cache()
    _invalidate_recordings_cache()
    return {"ok": True}


def _resolve_picker_command() -> tuple[list[str], str]:
    """Pick a folder-selection command for the current platform.

    Returns (cmd_list, platform_kind). The "platform_kind" tag lets the
    caller parse the output correctly — osascript prints the path raw,
    zenity/kdialog print it newline-terminated, PowerShell's
    FolderBrowserDialog prints it with Windows-style line endings.
    """
    if sys.platform == "darwin":
        return (
            ["osascript", "-e",
             'POSIX path of (choose folder with prompt "Select folder for recordings")'],
            "mac",
        )
    if sys.platform == "win32":
        # PowerShell FolderBrowserDialog — ships with Windows, no external
        # deps. The script prints the selected path or "CANCEL" on cancel.
        ps_script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
            "$f.Description = 'Select folder for recordings';"
            "$f.ShowNewFolderButton = $true;"
            "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
            "{ Write-Output $f.SelectedPath } else { Write-Output 'CANCEL' }"
        )
        return (
            ["powershell", "-NoProfile", "-STA", "-Command", ps_script],
            "win",
        )
    # Linux: prefer zenity (GNOME/most distros), fall back to kdialog (KDE).
    import shutil as _sh
    if _sh.which("zenity"):
        return (
            ["zenity", "--file-selection", "--directory",
             "--title=Select folder for recordings"],
            "linux",
        )
    if _sh.which("kdialog"):
        return (
            ["kdialog", "--getexistingdirectory", str(Path.home()),
             "--title", "Select folder for recordings"],
            "linux",
        )
    # No picker tool found — caller handles this.
    return ([], "none")


@app.post("/api/recordings/pick-folder")
def pick_recordings_folder(_auth: None = Depends(_require_api_auth)):
    cmd, kind = _resolve_picker_command()
    if kind == "none":
        raise HTTPException(
            status_code=400,
            detail="No folder picker available. Install 'zenity' or 'kdialog' "
                   "(sudo apt install zenity) and try again, or type the path manually.",
        )
    # Force UTF-8 encoding on Windows. PowerShell's default stdout
    # encoding is the system OEM/ANSI codepage (cp1252/cp1251/cp932)
    # unless $OutputEncoding is set. Without forcing UTF-8 on BOTH the
    # producer (PowerShell) and consumer (subprocess.run) sides, a
    # folder path containing Cyrillic/CJK/accented chars is mojibaked
    # into unreadable bytes — Path().resolve() then either raises or
    # points at a phantom directory.
    if kind == "win":
        cmd = list(cmd)
        cmd[-1] = (
            "$OutputEncoding = [System.Text.Encoding]::UTF8; "
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
            + cmd[-1]
        )
    try:
        result = subprocess.run(
            cmd, check=True, capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="folder picker timed out")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        # zenity returns exit code 1 on Cancel — treat as "no folder selected".
        if kind == "linux" and e.returncode == 1:
            raise HTTPException(status_code=400, detail="selection canceled")
        if "User canceled" in stderr:
            raise HTTPException(status_code=400, detail="selection canceled")
        raise HTTPException(status_code=500, detail=f"folder picker failed: {stderr or 'unknown error'}")
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"folder picker command missing: {e}")

    selected = (result.stdout or "").strip()
    # PowerShell FolderBrowserDialog encodes cancel as literal "CANCEL".
    if not selected or selected == "CANCEL":
        raise HTTPException(status_code=400, detail="no folder selected")
    p = Path(selected).expanduser().resolve()
    # Containment invariant: recordings must live inside the user's home
    # directory. _resolve_recordings_target_dir enforces this at load time;
    # the picker enforces it at write time so a user can't persist a path
    # the resolver will later silently reject.
    home_dir = Path.home().resolve()
    try:
        p.relative_to(home_dir)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="recordings folder must live inside your home directory",
        )
    p.mkdir(parents=True, exist_ok=True)
    return {"path": str(p)}


@app.post("/api/recordings/open-folder")
def open_recordings_folder(payload: dict = Body(default_factory=dict), _auth: None = Depends(_require_api_auth)):
    requested = str((payload or {}).get("path") or "").strip()
    if requested:
        d = Path(requested).expanduser()
        if not d.is_absolute():
            d = (_resolve_recordings_dir() / d).resolve()
        else:
            d = d.resolve()
        # Safety: only allow opening the recordings dir or its subdirectories,
        # or well-known user-accessible directories.
        recordings_root = _resolve_recordings_dir().resolve()
        home_dir = Path.home().resolve()
        try:
            d.relative_to(recordings_root)
        except ValueError:
            try:
                d.relative_to(home_dir)
            except ValueError:
                raise HTTPException(status_code=403, detail="path outside allowed directories")
        d.mkdir(parents=True, exist_ok=True)
    else:
        d = _resolve_recordings_dir()
    # Pick the right open-folder command per platform.
    if sys.platform == "darwin":
        open_cmd = ["open", str(d)]
    elif sys.platform == "win32":
        # os.startfile is the canonical Explorer opener on Windows.
        # It returns immediately and raises OSError on failure.
        try:
            os.startfile(str(d))  # type: ignore[attr-defined]
            return {"ok": True, "path": str(d)}
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"open folder failed: {e}")
    elif sys.platform.startswith("linux"):
        open_cmd = ["xdg-open", str(d)]
    else:
        raise HTTPException(status_code=400, detail=f"open folder not implemented for platform {sys.platform}")
    try:
        subprocess.run(open_cmd, check=True, capture_output=True, text=True, timeout=15)
        return {"ok": True, "path": str(d)}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="open folder timed out")
    except FileNotFoundError:
        tool = open_cmd[0]
        raise HTTPException(status_code=500, detail=f"open folder failed: '{tool}' not found")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        raise HTTPException(status_code=500, detail=f"open folder failed: {stderr or 'unknown error'}")


_list_cache: Optional[dict] = None
_list_cache_at = 0.0
_list_cache_key: Optional[tuple] = None
_LIST_CACHE_TTL = 5.0


@app.get("/api/recordings")
def list_recordings(_auth: None = Depends(_require_api_auth)):
    global _list_cache, _list_cache_at, _list_cache_key
    d = _resolve_recordings_dir()
    now = time.monotonic()

    # Build lightweight cache key: dir mtime + file count
    try:
        dir_mtime = d.stat().st_mtime
        file_count = sum(1 for _ in d.glob("*.txt"))
    except Exception:
        dir_mtime = 0.0
        file_count = -1
    cache_key = (str(d), dir_mtime, file_count)

    with _recordings_caches_lock:
        if (
            _list_cache is not None
            and _list_cache_key == cache_key
            and (now - _list_cache_at) < _LIST_CACHE_TTL
        ):
            return _list_cache

    items = []
    for p in d.glob("*.txt"):
        try:
            st = p.stat()
            raw = p.read_text(encoding="utf-8", errors="replace")
            # Smart display_name: first words of transcript text
            first = _first_words(raw)
            display = first if first else p.stem
            # Extract metadata from file header
            provider = _extract_meta_field(raw, "Provider").lower() or ""
            language = _extract_meta_field(raw, "Language").lower() or ""
            items.append(
                {
                    "name": p.name,
                    "display_name": display,
                    "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
                    "size_bytes": st.st_size,
                    "provider": provider,
                    "language": language,
                    **_recording_audio_payload(p.name),
                }
            )
        except Exception:
            continue
    items.sort(key=lambda x: x["modified_at"], reverse=True)
    result = {"items": items, "directory": str(d)}
    with _recordings_caches_lock:
        _list_cache = result
        _list_cache_at = now
        _list_cache_key = cache_key
    return result


_graph_cache: Optional[dict] = None
_graph_cache_at = 0.0
_graph_cache_key: Optional[tuple] = None
_GRAPH_CACHE_TTL = 30.0


@app.get("/api/recordings/graph")
def recordings_graph(_auth: None = Depends(_require_api_auth)):
    """Return recordings with extracted keywords for semantic graph visualization."""
    global _graph_cache, _graph_cache_at, _graph_cache_key
    d = _resolve_recordings_dir()
    now = time.monotonic()

    try:
        dir_mtime = d.stat().st_mtime
        file_count = sum(1 for _ in d.glob("*.txt"))
    except Exception:
        dir_mtime = 0.0
        file_count = -1
    cache_key = (str(d), dir_mtime, file_count)

    with _recordings_caches_lock:
        if (
            _graph_cache is not None
            and _graph_cache_key == cache_key
            and (now - _graph_cache_at) < _GRAPH_CACHE_TTL
        ):
            return _graph_cache

    nodes = []
    for p in d.glob("*.txt"):
        try:
            st = p.stat()
            raw = p.read_text(encoding="utf-8", errors="replace")
            first = _first_words(raw)
            display = first if first else p.stem
            provider = _extract_meta_field(raw, "Provider").lower() or "unknown"
            text = _extract_stats_text(raw)
            keywords = _tokenize_words(text)
            # Count frequency and take top 10
            freq: dict[str, int] = {}
            for w in keywords:
                freq[w] = freq.get(w, 0) + 1
            top = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:10]
            nodes.append(
                {
                    "name": p.name,
                    "display_name": display,
                    "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
                    "size_bytes": st.st_size,
                    "provider": provider,
                    "keywords": [w for w, _ in top],
                }
            )
        except Exception:
            continue

    result = {"nodes": nodes}
    with _recordings_caches_lock:
        _graph_cache = result
        _graph_cache_at = now
        _graph_cache_key = cache_key
    return result


@app.delete("/api/recordings")
def delete_all_recordings(_auth: None = Depends(_require_api_auth)):
    # Scan ALL known archive dirs — not just the default one — so that
    # recordings saved to custom directories are fully removed. Without
    # this, only the TXT files in the default dir were deleted while
    # audio files and TXT files in custom dirs were left on disk.
    # Invalidate the list/graph/stats caches BEFORE the delete loop AND
    # after — a concurrent GET /api/recordings landing mid-delete would
    # otherwise repopulate the cache with stale entries that survive
    # until the next invalidation. Double-invalidate is cheap and
    # closes the race window entirely.
    _invalidate_recordings_cache()
    deleted = 0
    failed = 0
    for d in _get_known_archive_dirs():
        for p in list(d.glob("*.txt")):
            try:
                p.unlink()
                audio_path = _recording_audio_path(p.name, target_dir=d)
                if audio_path is not None:
                    audio_path.unlink(missing_ok=True)
                deleted += 1
            except Exception:
                failed += 1
    _invalidate_recordings_cache()
    return {"deleted": deleted, "failed": failed}


@app.get("/api/recordings/{recording_name}")
def get_recording(recording_name: str, _auth: None = Depends(_require_api_auth)):
    p = _recording_path_or_404(recording_name)
    st = p.stat()
    raw = p.read_text(encoding="utf-8", errors="replace")
    # ``display_text`` strips the file header (Title/Saved at/Language/
    # Provider/Model) and returns only the transcript body. The raw
    # ``content`` is still returned for backwards compat / export.
    display = _extract_transcript_text(raw)
    return {
        "name": p.name,
        "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
        "size_bytes": st.st_size,
        "content": raw,
        "display_text": display or raw,
        **_recording_audio_payload(p.name),
    }


@app.get("/api/recordings/{recording_name}/audio")
def get_recording_audio(
    recording_name: str,
    archive_dir: str = "",
    _auth: None = Depends(_require_api_auth),
):
    target_dir = _resolve_recordings_target_dir(archive_dir, create=False) if str(archive_dir or "").strip() else None
    p = _recording_path_or_404(recording_name, target_dir=target_dir)
    audio_path = _recording_audio_path(p.name, target_dir=target_dir)
    if audio_path is None:
        raise HTTPException(status_code=404, detail="recording audio not found")
    media_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    return FileResponse(str(audio_path), media_type=media_type, filename=audio_path.name)


_stats_cache: Optional[dict] = None
_stats_cache_at = 0.0
_stats_cache_key: Optional[tuple] = None
_STATS_CACHE_TTL = 30.0


@app.get("/api/recordings/stats/summary")
def get_recordings_stats(_auth: None = Depends(_require_api_auth)):
    global _stats_cache, _stats_cache_at, _stats_cache_key
    d = _resolve_recordings_dir()
    now = time.monotonic()

    # Build a lightweight cache key: dir mtime + file count
    try:
        dir_mtime = d.stat().st_mtime
        file_count = sum(1 for _ in d.glob("*.txt"))
    except Exception:
        dir_mtime = 0.0
        file_count = -1
    cache_key = (str(d), dir_mtime, file_count)

    with _recordings_caches_lock:
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
    with _recordings_caches_lock:
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
    archive_dir = str(payload.get("archive_dir") or "").strip()
    require_existing = bool(payload.get("require_existing"))
    title = _sanitize_name(str(payload.get("title") or "recording"))
    source_text = str(payload.get("source_text") or "").strip()
    transcript_text = str(payload.get("transcript_text") or "").strip()
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    language = str(payload.get("language") or "").strip()
    if not source_text and not transcript_text:
        source_text = "[No speech captured]"

    target_dir = _resolve_recordings_target_dir(archive_dir, create=not require_existing)
    if existing_name:
        if existing_name in {"", ".", ".."} or not existing_name.endswith(".txt"):
            raise HTTPException(status_code=400, detail="invalid recording name")
        out = target_dir / existing_name
        if require_existing and not out.exists():
            raise HTTPException(status_code=409, detail="recording no longer exists in the target archive")
    else:
        if require_existing:
            raise HTTPException(status_code=400, detail="require_existing needs an existing recording name")
        out = target_dir / _recording_filename(title)
    _write_recording_text_file(
        out=out,
        title=title,
        source_text=source_text,
        transcript_text=transcript_text,
        provider=provider,
        model=model,
        language=language,
    )
    _invalidate_recordings_cache()
    return {"ok": True, "name": out.name, "archive_dir": str(target_dir)}


@app.post("/api/recordings/save-with-audio")
async def save_recording_with_audio(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    name: str = Form(""),
    archive_dir: str = Form(""),
    require_existing: bool = Form(False),
    title: str = Form("recording"),
    source_text: str = Form(""),
    transcript_text: str = Form(""),
    provider: str = Form(""),
    model: str = Form(""),
    language: str = Form(""),
    live_session_id: str = Form(""),
):
    existing_name = os.path.basename(str(name or "").strip())
    safe_title = _sanitize_name(str(title or "recording"))
    safe_source_text = str(source_text or "").strip()
    safe_transcript_text = str(transcript_text or "").strip()
    safe_provider = str(provider or "").strip()
    safe_model = str(model or "").strip()
    safe_language = str(language or "").strip()
    if not safe_source_text and not safe_transcript_text:
        safe_source_text = "[No speech captured]"

    orig_name = _normalize_filename(file.filename or "recording.wav")
    _validate_audio_filename(orig_name)
    ext = Path(orig_name).suffix.lower() or ".wav"

    target_dir = _resolve_recordings_target_dir(archive_dir, create=not bool(require_existing))
    # Persist this dir so startup retroactive retention covers it even if
    # the user changes their default recordings_dir between app launches.
    _register_archive_dir(target_dir)
    if existing_name:
        if existing_name in {"", ".", ".."} or not existing_name.endswith(".txt"):
            raise HTTPException(status_code=400, detail="invalid recording name")
        stem = Path(existing_name).stem
        if require_existing and not (target_dir / existing_name).exists():
            raise HTTPException(status_code=409, detail="recording no longer exists in the target archive")
    else:
        if require_existing:
            raise HTTPException(status_code=400, detail="require_existing needs an existing recording name")
        stem = _recording_stem(safe_title)

    out_text = target_dir / f"{stem}.txt"
    out_audio = target_dir / f"{stem}{ext}"
    tmp_audio = _atomic_temp_path(out_audio)
    existing_audio = _recording_audio_path(f"{stem}.txt", target_dir=target_dir)
    # Backup the pre-existing audio at out_audio (if any) so the
    # text-write-failure rollback can restore it instead of destroying
    # user data on the edit-existing-recording path. The rollback
    # previously did `out_audio.unlink()` unconditionally, which for
    # the edit path erased audio the user ALREADY had.
    audio_backup: Optional[Path] = None
    if out_audio.exists():
        try:
            audio_backup = out_audio.with_name(f"{out_audio.name}.backup-{uuid.uuid4().hex}")
            os.replace(out_audio, audio_backup)
        except OSError:
            audio_backup = None  # Couldn't backup — rollback will only be safe for new-recording path
    try:
        await _save_upload_file(file, tmp_audio)
        os.replace(tmp_audio, out_audio)
        try:
            _write_recording_text_file(
                out=out_text,
                title=safe_title,
                source_text=safe_source_text,
                transcript_text=safe_transcript_text,
                provider=safe_provider,
                model=safe_model,
                language=safe_language,
            )
        except Exception:
            # Text-write failed AFTER the audio reached its final path.
            # _prune_old_recording_audio requires a sibling .txt to keep
            # an audio file, so without a rollback the .wav/.m4a would
            # sit on disk forever as an orphan that no retention rule
            # ever cleans. Delete the failed-write audio, then restore
            # the pre-existing one from backup if we have it.
            try:
                out_audio.unlink(missing_ok=True)
            except OSError:
                pass
            if audio_backup is not None and audio_backup.exists():
                try:
                    os.replace(audio_backup, out_audio)
                    audio_backup = None  # Restored, don't clean up below.
                except OSError:
                    pass
            raise
    finally:
        tmp_audio.unlink(missing_ok=True)
        # Remove any orphaned backup after a successful save. The
        # backup only survives here on the happy path (no rollback).
        if audio_backup is not None and audio_backup.exists():
            try:
                audio_backup.unlink(missing_ok=True)
            except OSError:
                pass
    if existing_audio is not None and existing_audio.resolve() != out_audio.resolve():
        existing_audio.unlink(missing_ok=True)
    # Audio retention: only the NEWEST recording keeps its audio file.
    # Delete audio from every older recording in the same archive so
    # the user never ends up with gigabytes of old takes piling up.
    pruned = _prune_old_recording_audio(target_dir, stem)
    _invalidate_recordings_cache()
    # Atomically discard the live recovery spool now that the audio is
    # safely on disk. This closes the race window between a successful
    # save and the separate /api/live/recoveries/{id}/discard call that
    # the frontend makes — if the app crashes between those two events,
    # the recovery would otherwise be promoted at next startup and create
    # a duplicate archive entry.
    # Only delete a recovery when the client actually supplied a session
    # id. _normalize_live_session_id would otherwise mint a fresh uuid4,
    # and while the subsequent _delete_live_recovery no-ops for a
    # non-existent session, the contract should be explicit: empty ⇒
    # skip.  This also closes a vanishingly small but real risk that the
    # fresh uuid collides with a concurrent live recovery and nukes it.
    raw_sid = str(live_session_id or "").strip()
    if raw_sid and LIVE_SESSION_ID_RE.fullmatch(raw_sid):
        _delete_live_recovery(raw_sid)
    return {
        "ok": True,
        "name": out_text.name,
        "audio_name": out_audio.name,
        "archive_dir": str(target_dir),
        "pruned_audio_count": pruned,
    }
