"""Application configuration: data directory, config file, and API key encryption.

Configuration is stored as JSON in ~/Library/Application Support/Transcriptor/config.json
(macOS) or ~/.config/Transcriptor/config.json (Linux). API keys are encrypted at rest
using Fernet symmetric encryption when the cryptography package is available; otherwise
keys are stored in plain text with a warning logged at startup.
"""

import json
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict

try:
    from cryptography.fernet import Fernet, InvalidToken
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False
    Fernet = None  # type: ignore[assignment,misc]
    InvalidToken = Exception  # type: ignore[assignment,misc]
    logging.warning(
        "cryptography package not installed — API keys will be stored in plain text. "
        "Run: pip3 install 'cryptography>=42.0.0' to enable encryption."
    )


APP_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DATA_DIR = APP_ROOT / "data"

_ENC_PREFIX = "enc:"


def _default_data_dir() -> Path:
    env_dir = (os.environ.get("TRANSCRIPTOR_DATA_DIR") or "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Transcriptor"
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home())
        return base / "Transcriptor"
    return Path.home() / ".local" / "share" / "transcriptor"


DATA_DIR = _default_data_dir()
CONFIG_PATH = DATA_DIR / "config.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Fernet encryption key — one per machine, stored with strict permissions.
# ---------------------------------------------------------------------------
_KEYFILE = DATA_DIR / ".encryption_key"


def _load_or_create_fernet_key() -> bytes:
    """Return a 32-byte URL-safe base64-encoded Fernet key.

    Created once per machine and stored in the user data directory with
    ``chmod 0600`` so that only the file owner can read it.
    Returns ``b""`` when the cryptography package is not installed.
    """
    if not _HAS_CRYPTO:
        return b""
    if _KEYFILE.exists():
        raw = _KEYFILE.read_bytes().strip()
        if raw:
            try:
                # Validate it is a real Fernet key.
                Fernet(raw)
                return raw
            except Exception:
                pass  # Corrupted — regenerate below.
    key = Fernet.generate_key()
    _KEYFILE.parent.mkdir(parents=True, exist_ok=True)
    _KEYFILE.write_bytes(key)
    try:
        os.chmod(_KEYFILE, 0o600)
    except Exception:
        pass
    return key


_FERNET_KEY = _load_or_create_fernet_key()
_FERNET = Fernet(_FERNET_KEY) if _HAS_CRYPTO and _FERNET_KEY else None


def encrypt_value(plain: str) -> str:
    """Encrypt a string and return it with the ``enc:`` prefix.
    Returns the plain string unchanged when cryptography is unavailable.
    """
    if not plain:
        return ""
    if _FERNET is None:
        return plain  # no-crypto fallback
    token = _FERNET.encrypt(plain.encode("utf-8"))
    return _ENC_PREFIX + token.decode("ascii")


def decrypt_value(stored: str) -> str:
    """Decrypt a value previously encrypted by :func:`encrypt_value`.

    If *stored* does not carry the ``enc:`` prefix it is returned as-is so
    that plain-text values written before encryption was enabled still work
    (transparent migration).
    """
    if not stored:
        return ""
    if not stored.startswith(_ENC_PREFIX):
        return stored  # plain-text (legacy / not encrypted yet)
    if _FERNET is None:
        return ""  # encrypted value but no crypto — can't decrypt
    token = stored[len(_ENC_PREFIX):]
    try:
        return _FERNET.decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, Exception):
        return ""  # corrupted — treat as empty


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def _encrypt_provider_keys(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep copy of *cfg* with all ``providers.*.key`` values encrypted."""
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers")
    if isinstance(providers, dict):
        for name in list(providers.keys()):
            prov = providers.get(name)
            if isinstance(prov, dict) and "key" in prov:
                raw = str(prov.get("key") or "").strip()
                if raw and not raw.startswith(_ENC_PREFIX):
                    prov["key"] = encrypt_value(raw)
    return cfg


def _decrypt_provider_keys(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep copy of *cfg* with all ``providers.*.key`` values decrypted."""
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers")
    if isinstance(providers, dict):
        for name in list(providers.keys()):
            prov = providers.get(name)
            if isinstance(prov, dict) and "key" in prov:
                stored = str(prov.get("key") or "").strip()
                if stored:
                    prov["key"] = decrypt_value(stored)
    return cfg


def _migrate_legacy_data() -> None:
    # Packaged app previously stored data inside app resources; migrate once
    # to a stable user directory.
    if DATA_DIR.resolve() == LEGACY_DATA_DIR.resolve():
        return
    if not LEGACY_DATA_DIR.exists() or not LEGACY_DATA_DIR.is_dir():
        return
    try:
        # Copy config if new config is missing.
        legacy_cfg = LEGACY_DATA_DIR / "config.json"
        if legacy_cfg.exists() and not CONFIG_PATH.exists():
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(legacy_cfg, CONFIG_PATH)

        # Copy recordings if destination is empty.
        legacy_rec = LEGACY_DATA_DIR / "recordings"
        new_rec = DATA_DIR / "recordings"
        if legacy_rec.exists() and legacy_rec.is_dir():
            new_rec.mkdir(parents=True, exist_ok=True)
            has_new_txt = any(new_rec.glob("*.txt"))
            if not has_new_txt:
                for p in legacy_rec.glob("*.txt"):
                    dst = new_rec / p.name
                    if not dst.exists():
                        shutil.copy2(p, dst)
                    stem = p.stem
                    for ext in (".wav", ".m4a", ".mp3", ".flac", ".ogg", ".aac", ".mp4", ".webm"):
                        audio_src = legacy_rec / f"{stem}{ext}"
                        audio_dst = new_rec / audio_src.name
                        if audio_src.exists() and not audio_dst.exists():
                            shutil.copy2(audio_src, audio_dst)
    except Exception:
        # Non-fatal: app should continue even if migration fails.
        pass


_migrate_legacy_data()


DEFAULT_CONFIG: Dict[str, Any] = {
    "providers": {
        "openrouter": {"key": ""},
        "deepgram": {"key": ""},
    },
    "preferences": {
        "remote_provider": "openrouter",
        "recordings_dir": "",
        "openrouter": {
            "model": "google/gemini-2.5-flash",
        },
    },
}


def _deep_merge(base: Dict[str, Any], overlay: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in (overlay or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config() -> Dict[str, Any]:
    """Load config and return it with decrypted provider keys.

    If the on-disk config contains plain-text keys (pre-encryption era),
    they are transparently encrypted in-place on first read.
    """
    if not CONFIG_PATH.exists():
        return dict(DEFAULT_CONFIG)
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return dict(DEFAULT_CONFIG)
        merged = _deep_merge(DEFAULT_CONFIG, raw)

        # Auto-migrate: if any provider key is plain-text, encrypt it on disk.
        needs_migration = False
        providers = merged.get("providers")
        if isinstance(providers, dict):
            for prov in providers.values():
                if isinstance(prov, dict) and "key" in prov:
                    k = str(prov.get("key") or "").strip()
                    if k and not k.startswith(_ENC_PREFIX):
                        needs_migration = True
                        break
        if needs_migration:
            encrypted_cfg = _encrypt_provider_keys(merged)
            payload = json.dumps(encrypted_cfg, ensure_ascii=False, indent=2)
            tmp = CONFIG_PATH.with_suffix(".tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(CONFIG_PATH)

        return _decrypt_provider_keys(merged)
    except Exception:
        return dict(DEFAULT_CONFIG)


def save_config(cfg: Dict[str, Any]) -> None:
    """Merge *cfg* into the current config and persist with encrypted keys."""
    current = load_config()
    merged_current = _deep_merge(current, cfg or {})
    merged = _deep_merge(DEFAULT_CONFIG, merged_current)
    encrypted = _encrypt_provider_keys(merged)
    payload = json.dumps(encrypted, ensure_ascii=False, indent=2)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(CONFIG_PATH)


def redact_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers") or {}
    for name in ("openrouter", "deepgram"):
        if isinstance(providers.get(name), dict) and "key" in providers[name]:
            k = providers[name].get("key") or ""
            providers[name]["key"] = "" if not k else (k[:3] + "..." + k[-2:])
    return cfg
