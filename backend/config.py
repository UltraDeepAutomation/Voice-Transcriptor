import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict


APP_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DATA_DIR = APP_ROOT / "data"


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
    except Exception:
        # Non-fatal: app should continue even if migration fails.
        pass


_migrate_legacy_data()


DEFAULT_CONFIG: Dict[str, Any] = {
    "providers": {
        "openrouter": {"key": ""},
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
    if not CONFIG_PATH.exists():
        return dict(DEFAULT_CONFIG)
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return dict(DEFAULT_CONFIG)
        return _deep_merge(DEFAULT_CONFIG, raw)
    except Exception:
        return dict(DEFAULT_CONFIG)


def save_config(cfg: Dict[str, Any]) -> None:
    current = load_config()
    merged_current = _deep_merge(current, cfg or {})
    merged = _deep_merge(DEFAULT_CONFIG, merged_current)
    payload = json.dumps(merged, ensure_ascii=False, indent=2)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(CONFIG_PATH)


def redact_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers") or {}
    for name in ("openrouter",):
        if isinstance(providers.get(name), dict) and "key" in providers[name]:
            k = providers[name].get("key") or ""
            providers[name]["key"] = "" if not k else (k[:3] + "..." + k[-2:])
    return cfg
