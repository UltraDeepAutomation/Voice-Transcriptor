# Changelog

All notable changes to Transcriptor are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.1] — 2026-04-24

Enterprise-grade storage layer (SSOT) and a dense wave of pre-launch
hardening. Shipped to global users the day after 1.1.0-rc was cut;
21 audit passes went into this release.

### Added
- **SSOT storage layer** (`backend/storage.py`). Every backend file
  write — config, upscale presets, archive registry, API token,
  encryption key, recording transcripts — now routes through four
  shared primitives (`atomic_write_bytes`, `atomic_write_text`,
  `atomic_write_json`, `rotate_backup`). Each write is:
  atomic (`tmp + os.replace`), durable (`fsync` + parent-dir
  `fsync` on POSIX), recoverable (optional `.bak` rotation), and
  observable (matching `<path>.tmp-<hex>` convention swept by
  `_sweep_orphan_tmp_files`).
- **Config schema versioning** (`SCHEMA_VERSION=2`). Legacy configs
  from 1.0.x implicitly treated as v1 and migrated on load.
  Forward-compat preserved: newer-than-us configs are NOT downgraded,
  unknown fields are kept.
- **Config `.bak` recovery.** On every `save_config`, the previous
  on-disk config is rotated to `config.json.bak`. If a future save
  produces a corrupt file, `load_config` falls back to the backup
  automatically — user API keys never lost to a single bad write.
- **Config shape validation.** Wrongly-typed subtrees (e.g.
  `providers: "string"` from a buggy client) are reset to defaults
  with a warning instead of crashing the backend or silently
  merging.
- **Progressive boot-loading UI.** Launching the app now shows a
  pulse-animated "Starting Transcriptor…" screen with a live timer
  while the backend cold-starts, instead of a blank window or the
  scary "Backend failed" error page.
- **macOS F-key collision detection.** If the user's macOS keyboard
  mode is "media keys" and they have F9/F10 set as accelerators,
  Settings now badges those rows with a tooltip explaining the
  three fixes (toggle the OS setting, hold Fn, or pick a non-F key).
- **OneDrive-managed `%APPDATA%` auto-remediation on Windows.**
  Detects when corporate Group Policy routed Roaming AppData into
  OneDrive sync, auto-moves `userData` to `%LOCALAPPDATA%\Transcriptor`,
  and performs a one-time copy of config/keys/recordings/presets to
  the new location.
- **Smart clipboard restore.** Paste's clipboard-restore now polls
  actual clipboard contents and aborts if the user copied something
  new during the paste window — previously a fixed 1200 ms delay
  could clobber the user's new clipboard or steal a chained paste.
- **Windows process tree-kill via `taskkill /T /F`.** Prior SIGTERM
  path on Win32 only killed the immediate python.exe child; uvicorn
  workers + ffmpeg grandchildren survived as orphans holding port
  8321. Next launch then failed health check for 120 s.
- **Lifespan job-pool drain.** On SIGTERM the backend now attempts
  to finish in-flight transcription threads via
  `jobs._pool.shutdown(wait=True, cancel_futures=True)` inside a
  1.5-s budget. Half-written `result.json` / `.txt` files that
  silently parsed as corrupt recordings on next launch are now
  prevented in the common case.
- **Whisper model cache LRU eviction.** Cache capped at 2 models
  (configurable via `TRANSCRIPTOR_WHISPER_CACHE_SIZE`); cycling
  through tiny/base/small/medium/large-v3 no longer OOM-kills the
  backend on 8 GB hosts.
- **Legacy 1.0.x venv auto-cleanup.** First launch of 1.1.x with a
  working bundled runtime deletes `userData/.venv` (~300–500 MB)
  from the prior install. Three safety guards prevent accidental
  deletion of arbitrary `.venv` directories.
- **Accessibility permission poll (macOS).** If the user revokes
  Accessibility via System Settings mid-session, the renderer is
  notified via `window.__transcriptorAccessibilityStatus` so the
  UI can prompt for re-grant.
- **Overlay multi-monitor resilience.** `display-metrics-changed`,
  `display-added`, `display-removed` listeners re-pin the overlay
  to the correct display when the user undocks a monitor or
  changes scale factor mid-session.

### Changed
- **Enterprise error redaction** (`backend/main.py `_safe_error_text`).
  Absolute filesystem paths and API-key-shaped tokens are stripped
  from every error string that reaches HTTP response bodies or the
  job store. Full exceptions still `logger.exception`'d locally.
- **API token comparison is constant-time** via
  `secrets.compare_digest` on both HTTP and WebSocket auth paths.
- **Live-recovery PCM spool has a 1 GB ceiling** (~8.7 h of
  16 kHz mono audio). Prevents a runaway session from filling a
  small SSD. Cap configurable via `MAX_LIVE_RECOVERY_BYTES`.
- **`http_retry` connection pool is non-blocking**. Previously,
  stalled upstream providers could freeze the FastAPI executor
  threadpool by pinning all 64 pool slots. Overflow connections
  now open transparently (100–300 ms TLS cost vs. a minute-long
  backend hang).
- **Mic enumeration errors are classified**. `DOMException.name`
  is inspected: `NotAllowedError` → "Permission denied",
  `NotFoundError` → "No microphone detected", `NotReadableError`
  → "Microphone in use by another app", etc. Previously everything
  mapped to the single misleading "Permission denied".
- **Boot-error overlay shows friendly headlines** (port-in-use,
  permission-denied, missing-module, Python-not-found) with the
  raw stderr moved to a `<details>` disclosure. Previously the
  raw text was visible by default and could leak into the paste
  buffer on first Cmd+V.
- **API key save failures surface to the user** via `setStatus`,
  red input ring, and `aria-invalid`. Previously silent
  `console.error` → user had no idea why transcription later
  complained about a missing key.
- **Retranscribe session-gated.** The "Re-transcribe" button now
  captures a session token, checks it before every DOM write, and
  routes through `runUpscaleIfEnabled` so AI rewriting applies to
  retranscripts when enabled.

### Fixed
- Windows SIGTERM orphaning python.exe subtree (→ `taskkill /T /F`).
- hardenedRuntime inconsistency between package.json (false) and
  afterPack.js (true) — now `true` in both for consistency.
- Hotkey-registration status never reaching the first renderer
  window (replayed from `did-finish-load`).
- Deepgram "API key is not configured" misrouted to
  region-block/VPN hint; now explicitly classified and points the
  user to Settings → API Keys.
- Upscale placeholder collision via text-equality sentinel
  (replaced with per-session `dataset.upscaleNonce`).
- Click-and-hold overlay buttons leaking intervals when the user
  drags off the overlay (document-level `pointerup`/`pointercancel`/
  `blur` safety net).
- Accessibility-poll `setInterval` handle captured + `.unref()`'d
  + cleared on `before-quit` (previously leaked a refed timer
  delaying clean shutdown).
- `_ERROR_PATH_REDACT_RE` no longer over-matches URL paths
  containing `/Users`, `/home`, `/var`, `/tmp` (negative
  look-behind).
- `"Deleted undefined recording(s)"` in archive-delete UI (fixed
  shape coercion + surfacing partial failures).
- `.encryption_key` write is now atomic — a crash during first-launch
  keyfile creation no longer produces a zero-length keyfile that
  silently invalidates every previously-encrypted value on next
  load.

### Infrastructure
- `install/win/build.bat` and `install/linux/build.sh` post-build
  filename hints corrected (1.0.0 → 1.1.1).
- `.gitignore` ignores `.claude/` harness state.

### Security
- Constant-time API-token comparison (`secrets.compare_digest`)
  on both HTTP and WebSocket auth surfaces.
- Absolute filesystem paths redacted from HTTP error responses
  and persisted job errors.
- API-key-shaped token patterns stripped from error strings.
- Live-recovery PCM spool cap prevents disk-fill DoS.
- Config file written atomically with `fsync` + parent-dir `fsync`
  on POSIX.

---

## [1.1.0] — 2026-04-14 (internal RC)

Bundled Python + ffmpeg runtime for zero-setup install on
Windows + macOS. Not publicly shipped — superseded by 1.1.1.

## [1.0.2] — 2026-03-28

Diagnostics + user-friendly network errors.

## [1.0.1] — 2026-03-15

Fixed blank Windows window; version badge; update story.

## [1.0.0] — 2026-03-01

Initial public release.
