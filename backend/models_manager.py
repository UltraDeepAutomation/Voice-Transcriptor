"""Local model download management (Settings → Models).

SSOT for "is this local ASR model present on this machine":

* faster-whisper variants live in the Hugging Face cache; presence is
  detected via ``huggingface_hub`` (already a transitive dependency of
  faster-whisper, so no new package);
* GigaAM weights are managed inside its own package cache — from the
  app's perspective the whole ENGINE is the unit, so a GigaAM entry is
  "downloaded" exactly when the engine imports.

Downloads run on a daemon thread with per-file progress; state is kept
in-process (a restart forgets transient progress but presence detection
above is authoritative anyway).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# faster-whisper's canonical repos per catalog id (SSOT mapping here —
# the catalog owns ids, this table owns their upstream homes).
WHISPER_REPOS: Dict[str, str] = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}

# Approximate on-disk sizes for the UI (bytes). Hints only — never used
# for decisions.
SIZE_HINTS: Dict[str, int] = {
    "tiny": 75_000_000,
    "base": 145_000_000,
    "small": 484_000_000,
    "medium": 1_500_000_000,
    "large-v3": 3_100_000_000,
    "gigaam-v3-rnnt": 900_000_000,
    "gigaam-v3-e2e-rnnt": 950_000_000,
}

_lock = threading.Lock()
_state: Dict[str, Dict[str, Any]] = {}


def _get_state(model_id: str) -> Dict[str, Any]:
    with _lock:
        return dict(_state.get(model_id) or {"status": "idle", "progress": 0.0})


def _set_state(model_id: str, **fields: Any) -> None:
    with _lock:
        entry = dict(_state.get(model_id) or {"status": "idle", "progress": 0.0})
        entry.update(fields)
        _state[model_id] = entry


def whisper_downloaded(model_id: str) -> bool:
    """Authoritative check: does the HF cache hold this repo's payload?

    ``try_to_load_from_cache`` resolves the actual blob for model.bin —
    the one large file every faster-whisper repo ships. A partial
    download therefore reports as not-downloaded, which is the safe
    direction (the selector would offer a re-download instead of
    failing at record time).
    """
    repo = WHISPER_REPOS.get(model_id)
    if not repo:
        return False
    try:
        from huggingface_hub import try_to_load_from_cache
        from huggingface_hub.utils import (
            EntryNotFoundError,  # type: ignore[attr-defined]
            RepositoryNotFoundError,  # type: ignore[attr-defined]
        )

        result = try_to_load_from_cache(repo_id=repo, filename="model.bin")
        return isinstance(result, str)
    except Exception as e:  # cache dir unreadable etc. — treat as absent
        logger.debug("whisper presence check failed for %s: %s", model_id, e)
        return False


def list_local_models() -> list[dict[str, Any]]:
    from backend.model_catalog import (
        LOCAL_TRANSCRIPTION_MODELS,
        gigaam_available,
    )

    engine_ok_gigaam = gigaam_available()
    rows: list[dict[str, Any]] = []
    for model_id in LOCAL_TRANSCRIPTION_MODELS:
        if model_id.startswith("gigaam-"):
            engine = "gigaam"
            downloaded = engine_ok_gigaam
            note = "" if engine_ok_gigaam else "engine not installed"
        else:
            engine = "whisper"
            downloaded = whisper_downloaded(model_id)
            note = ""
        st = _get_state(model_id)
        rows.append({
            "id": model_id,
            "engine": engine,
            "size_hint_bytes": SIZE_HINTS.get(model_id),
            "downloaded": bool(downloaded and st.get("status") != "downloading"),
            "note": note,
            **st,
        })
    return rows


def is_downloaded(model_id: str) -> bool:
    if model_id.startswith("gigaam-"):
        from backend.model_catalog import gigaam_available

        return gigaam_available()
    return whisper_downloaded(model_id)


def _repo_file_sizes(repo: str, files: list[str]) -> dict[str, int]:
    """Best-effort byte sizes for *files* in *repo* (BUG-44).

    faster-whisper repos are dominated by one ``model.bin`` (~95 % of the
    bytes); a per-FILE progress counter therefore sits at ~0 % for nearly
    the whole multi-gigabyte transfer and jumps to 100 % at the end,
    which reads as a hang. Weighting by bytes needs the sizes up front:
    one ``HfApi.repo_info(files_metadata=True)`` call provides them.
    Any failure degrades to an empty mapping — the caller falls back to
    the old count-based scheme rather than blocking the download.
    """
    try:
        from huggingface_hub import HfApi

        info = HfApi().repo_info(repo_id=repo, files_metadata=True)
        sizes: dict[str, int] = {}
        for sibling in getattr(info, "siblings", None) or []:
            name = getattr(sibling, "rfilename", None)
            size = getattr(sibling, "size", None)
            if name and isinstance(size, int) and size > 0:
                sizes[name] = size
        return {name: sizes[name] for name in files if name in sizes}
    except Exception as e:  # metadata endpoint down / rate-limited — non-fatal
        logger.debug("models: file-size metadata unavailable for %s: %s", repo, e)
        return {}


def _download_worker(model_id: str) -> None:
    import time

    from huggingface_hub import hf_hub_download, list_repo_files

    repo = WHISPER_REPOS[model_id]
    try:
        files = [
            f for f in list_repo_files(repo)
            if not f.startswith(".")
        ]
        sizes = _repo_file_sizes(repo, files)
        total_bytes = sum(sizes.values())
        done_bytes = 0
        for i, name in enumerate(files):
            _set_state(
                model_id,
                status="downloading",
                # Byte-weighted when sizes are known; otherwise the
                # legacy per-file fraction. Both stay monotonic.
                progress=(done_bytes / total_bytes * 100.0) if total_bytes
                else (i / max(1, len(files)) * 100.0),
            )
            hf_hub_download(repo_id=repo, filename=name)
            done_bytes += sizes.get(name, 0)
        _set_state(model_id, status="done", progress=100.0)
        logger.info("models: %s downloaded (%d files)", model_id, len(files))
    except Exception as e:
        logger.warning("models: download failed for %s: %s", model_id, e)
        _set_state(model_id, status="error", error=f"{type(e).__name__}: {e}")
    finally:
        # Give pollers a moment to observe the terminal state.
        time.sleep(0.5)


def start_download(model_id: str) -> Dict[str, Any]:
    """Kick off a background download; returns the immediate state."""
    from backend.model_catalog import (
        LOCAL_TRANSCRIPTION_MODELS,
        gigaam_available,
    )
    from backend.transcribe_gigaam import gigaam_import_error

    if model_id not in LOCAL_TRANSCRIPTION_MODELS:
        raise KeyError(model_id)

    if model_id.startswith("gigaam-"):
        if gigaam_available():
            return {"status": "done", "progress": 100.0}
        reason = gigaam_import_error() or "package not installed"
        raise RuntimeError(
            f"GigaAM engine is not installed in this runtime ({reason}); "
            "install requirements-gigaam.txt and relaunch"
        )

    if whisper_downloaded(model_id):
        _set_state(model_id, status="done", progress=100.0, error=None)
        return _get_state(model_id)

    current = _get_state(model_id)
    if current.get("status") == "downloading":
        return current

    _set_state(model_id, status="downloading", progress=0.0, error=None)
    thread = threading.Thread(
        target=_download_worker,
        args=(model_id,),
        name=f"model-dl-{model_id}",
        daemon=True,
    )
    thread.start()
    return _get_state(model_id)
