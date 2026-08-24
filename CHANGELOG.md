# Changelog

All notable changes to Transcriptor are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.2] — 2026-08-24

### Fixed
- **Update check "Failed to fetch":** the Content-Security-Policy now allows the renderer to reach `api.github.com`, so "Check for updates" actually works.
- **Build footprint:** a finished build no longer keeps three full copies of the same version (~715 MB → ~470 MB); the root-level internal zip is dropped once the install kit embeds it.

## [1.3.1] — 2026-08-24

### Fixed
- **Live tail truncation (BUG-20):** the end of dictated messages no longer gets cut off. Backend now waits up to 3 s for Deepgram's post-Finalize flush (was 1.5 s; healthy sessions still return instantly); an unflushed interim at the tail counts as proof of speech and triggers tail recovery; proven uncovered speech (>0.5 s) surfaces a visible warning instead of silent holes.

### Added
- **Update detection:** Settings header gains "Check for updates". The app checks GitHub releases at most once per day (plus on demand) and links to the new release page when one exists. Detection only — no automatic download/install.

## [1.3.0] — 2026-08-23

Recording reliability and stop-to-paste latency pass. Every number below
was measured from `main.log`, before and after.

### Added (integration pass, same release)

- **ESLint 9 flat config** as a hard CI gate at zero-warning baseline
  (`npm run lint`; adopted from external PR #4 by @chiliec).
- **GitHub Actions** running all three suites on every push/PR:
  backend unittest on the shipped Python 3.12 runtime (including the
  ten live-coverage TS cross-tests), frontend lint/typecheck/vitest/
  build on Node pinned by `.nvmrc`, desktop node:test.
- **BUGS_AUDIT.md** — full 19-defect audit with per-bug resolution
  status kept in-repo.
 and stop-to-paste latency pass. Every number below
was measured from `main.log`, before and after.

### Fixed

- **Recordings captured pure silence.** `askForMediaAccess` was only
  reached from the global-hotkey path, so starting a recording from the
  in-app button never asked macOS for microphone access — and a renderer
  `getUserMedia` does not reject when access was never granted, it
  resolves with a live track that emits zeros. No waveform, no words, no
  error. Microphone access is now resolved once at startup through a
  single `ensureMacMicrophoneAccess` helper shared by every entry point,
  and the TCC status is read live instead of latched.
- **Quiet recordings and clipped phrase boundaries.** Capture used
  Chromium's call-oriented defaults; echo cancellation and noise
  suppression are tuned for conferencing and both attenuate a quiet
  source and gate low-energy speech. Both are off for dictation, gain
  control stays on, defined once in `DICTATION_AUDIO_PROCESSING`.
- **The opening words of short recordings were dropped.** Frames captured
  while the live WebSocket was still connecting were drained only from
  inside `pushCapturedFrame`, so the flush depended on another frame
  arriving after the socket opened. A recording that ended inside the
  handshake window kept its first frames buffered forever. The socket's
  `open` event now drains them, and stop drains them again before
  finalize.
- **The last sentence went missing when Stop landed mid-phrase.**
  `Finalize` and `CloseStream` were written in the same millisecond, so
  the close raced the transcript Finalize had just flushed. Across 14
  sessions, streams that ended naturally left 0.25 s of audio undecoded
  on average; streams stopped mid-utterance left 1.86 s. `finalize()`
  now waits for the flushed transcript, bounded and short-circuited on
  arrival.
- **A client disconnect was logged as a server error.**
  `_is_broken_pipe_error` matched substrings of the message and missed
  `ConnectionClosedOK`, producing a full traceback thirteen times in one
  session. Classification is type-first and walks the cause chain.

### Changed

- **Stop → text in the target app: 9.56 s → 1.1–1.7 s.** The transcript
  now goes into whatever holds focus rather than restoring a start
  target. The trace showed the target app was *already* frontmost and the
  pipeline still spent 2.46 s restoring it and 2.20 s activating it,
  while Transcriptor's own window bounced forward mid-sequence. Target
  resolution went from 4156 ms to 13 ms.
- **Frontmost-app lookup: ~800 ms → ~110 ms.** `first process whose
  frontmost is true` makes AppleScript enumerate every process;
  `lsappinfo` reads the same facts from LaunchServices. Callers that
  route by window still use the AppleScript path.
- **Local stop no longer re-transcribes what was already decoded.** The
  live assist runs the same model the final pass would in the default
  configuration, so `LiveSession` now reports coverage truth — seconds
  covered, dropped, and left untranscribed — and the stop path adopts the
  live transcript only when the backend certifies full coverage, the
  models match, and no frame was stranded in the renderer.
- **Model warm-up is symmetric.** Startup probed the default model while
  the user-triggered warmup only loaded weights, leaving the lazy VAD
  load and first encoder pass to the first live window. Both probe now,
  and the probe exercises the decode path rather than only silence.
- **Recording capsule** narrowed 1.25× to 110 px, waveform column kept at
  30 px with a taller 15 px envelope, and the pill is fully opaque.

### Added

- **Microphone health state machine** (`frontend/src/mic-health.ts`) —
  classifies the capture stream on *digital silence*, no sample above one
  16-bit LSB, rather than on loudness, so a quiet room is never mistaken
  for a broken microphone. Flags a dead pipeline 2.5 s after start or
  after 4 s mid-session, with a 10 s watchdog for an audio graph that
  never starts. A topbar pill and the stop-time summary name the actual
  cause — permission, OS mute, device loss — instead of "No speech
  captured".
- **Live-transcript adoption policy** (`frontend/src/live-coverage.ts`) —
  pure, typed rejection reasons, so choosing the slow path is visible in
  the trace log.
- 42 tests across the new paths: mic-health FSM, coverage contract,
  adoption policy, disconnect classification, finalize ordering.

### Security

- **Purged a leaked OpenRouter API key from the entire git history.** It
  had been committed in `data/config.json` in the initial commit and was
  already published to GitHub. Removing it from history does not
  un-publish it — the key must be revoked at the provider.

## [Unreleased] — 2026-06-25

### Fixed

- **Settings shortcuts UI** — each key in a shortcut is rendered as an
  individual outlined keycap instead of a plain text phrase.
- **Deepgram small-audio REST timeout** — live recovery and short
  re-transcribe payloads no longer inherit the large-upload timeout budget.
  Tiny payloads fail fast on provider/network stalls while large uploads keep
  their long upload window.
- **Deepgram live connect budget** — live WebSocket connection attempts are
  bounded to an 8 s first attempt plus one 4 s retry.
- **Remote offline guard** — remote transcription calls fail fast when the
  app's network probe already reports offline, avoiding long cloud waits.
- **Redacted API-key roundtrip** — saving the Settings payload returned by
  `/api/config` preserves the real provider secret instead of persisting the
  masked display value.
- **Dormant legacy waveform** — the hidden legacy waveform sink no longer
  creates a canvas context, resize observer, or rAF render loop while disabled.
- **Recordings stats scan** — the expensive summary scan is now lazy and runs
  only when the Stats panel is explicitly opened.

### Build

- Added README guidance for internal ad-hoc macOS arm64 transfer artifacts
  versus production Developer ID + notarized distribution.

## [1.1.25] — 2026-05-10

Historical release-audit batch across 24K LOC. This changelog keeps the
1.1.25 release notes; the current verified bug audit lives in
`VERIFIED_AUDIT.md` and intentionally lists only confirmed real bugs.

### Fixed (audit + post-audit batch)

#### P0 (data-loss / breakage)
- **frontend `setSelectedFile`** — extension-less + MIME-less files no longer
  bypass the upload validator (lenient `!file.type` short-circuit removed).
- **frontend `OpfsPcmSink.finalize`** — recovers in-memory PCM after a write
  failure instead of returning empty WAV; salvages spool prefix + RAM tail.
- **frontend `parseError`** — reads response body once as text then attempts
  JSON; previous form double-consumed the stream and dropped server error
  detail.

#### P1 (incorrect behaviour / leaks)
- **backend Fernet keyfile** — disk-write failure no longer returns an
  in-memory key that would have caused silent permanent loss of every
  encrypted API key on the next boot.
- **backend `decrypt_value`** — distinguishes InvalidToken (warn) from any
  other exception (error + stack), no more silent secret loss.
- **backend `dict(DEFAULT_CONFIG)` → `copy.deepcopy`** — caller mutation no
  longer corrupts the global default for the rest of the process (5 sites).
- **backend Deepgram error envelopes** — final-payload + `/api/upscale` 502
  now route through `_safe_error_text`, no more raw upstream URLs / token
  prefixes leaking into the renderer.
- **backend local-assist final envelope** — `LiveSession.finalize_envelope()`
  reports the cumulative transcript instead of always-empty; frontend stops
  triggering a recovery REST round-trip on every successful local stop.
- **backend `transcribe.py` warm-probe regex** — covers Python 3.12 wording
  ("max() iterable argument is empty"); spurious stack trace on every cold
  start is gone.
- **backend `audio.py` ffmpeg cleanup** — partial output files unlinked on
  ffmpeg failure (both `compact_audio_for_remote` and `ensure_wav_16k`);
  downstream transcribe paths can no longer consume torn files.
- **backend Deepgram `connect()`** — retries on `OSError` (DNS gaierror,
  ConnectionRefused) per the docstring; previous code retried only on
  `TimeoutError`.
- **backend `_finalize_sent` flag** — set AFTER the Finalize send succeeds,
  not before; cancellation between flag-set and send no longer orphans the
  Finalize.
- **backend keepalive race** — snapshots `self._ws` before each send; close()
  on the same event loop can no longer null the reference between guard
  and use.
- **backend `connect()` rollback** — closes the open WebSocket if a
  `BaseException` (incl. `CancelledError`) fires between socket-open and
  recv/keepalive task launch; eliminates a connection-leak path.
- **backend `_ws_send_json`** — 5 s send timeout treats stalled clients as
  broken pipes; one paused renderer can no longer wedge the entire
  forwarder loop.
- **backend `_extract_meta_field`** — restricted to the file header prefix
  (text before first blank line); user transcript content starting with
  "Provider:" / "Language:" no longer corrupts stats / graph / filter.
- **backend `_promote_live_recovery`** — registers archive dir AFTER writes
  succeed, not before; failed writes no longer pollute the registry.
- **backend `compact_audio_for_remote` ffmpeg-missing** — raises
  `RemoteError` with an actionable message for non-Deepgram-native
  containers (.wma / .mkv / .opus / .webm / etc.) instead of degrading
  to a confusing upstream 400.
- **backend validators** — `_validate_audio_filename` rejects empty
  extensions; `_normalize_filename` strips Windows backslashes regardless
  of host OS and ensures fallback `.wav` extension when none exists.
- **backend recordings list** — `_recording_audio_payload` receives
  `target_dir` from list and single-recording paths so non-default
  archives correctly resolve audio existence.
- **frontend `lastSegEnd`** — tail-gap detection uses `Math.max(end)` over
  segments instead of array tail; correct for diarized recordings and
  out-of-order arrivals.
- **frontend `xhr.send`** — wrapped in try/catch + idempotent abort guard;
  pre-send abort no longer surfaces as a network-error reject.
- **frontend `discardLiveRecovery`** — failure no longer misreported as a
  save failure; recovery duplicate-on-restart eliminated.
- **frontend `hideBootOverlayOnce`** — defers `hidden=true` past the CSS
  transition so the documented fade-out actually runs.
- **frontend Re-transcribe token leak** — `activeUiSessionToken` adopted
  on cold-start re-transcribe is now released in `finally`; phantom token
  no longer survives.
- **frontend `reportFileSelectionError`** — non-disruptive notice replaces
  the blanket `patchCurrentRecordingSummary` write that could clobber an
  active live recording's status pill.
- **desktop `toggleRecordingFromShortcut`** — uses
  `execRendererJsWithTimeout(2000)` instead of unbounded
  `executeJavaScript`; stuck renderer no longer makes the hotkey a
  permanent no-op.
- **desktop OneDrive migration** — marker only written when EVERY child
  copy succeeded; partial copy failures now retry on next boot instead
  of permanently stranding user data in the OneDrive path.
- **desktop backend restart timer** — null'd from `.finally` instead of
  the synchronous start path; concurrent `startBackend()` callers no
  longer race into a double-spawn → port-bind collision loop.
- **desktop `hideRecordingOverlay`** — clears `overlayMouseTrackTimer`;
  20 Hz syscall poll no longer wastes CPU + battery for the entire app
  session whenever the overlay is hidden.
- **desktop overlay timer regex** — `\d{2,3}:\d{2}` accepts 100+ minute
  recordings; previous regex froze the overlay timer at 99:59.
- **desktop macOS permissions** — request prompt runs in parallel with
  backend boot, no longer blocks the launch sequence on a modal dialog
  the user might leave for minutes.
- **desktop `playOverlayCue`** — 500 ms cap on executeJavaScript so a
  stuck overlay webContents can't freeze hotkey-bound code paths.
- **desktop overlay close** — resets `overlayQuickSettingsInitialized` and
  `overlayQuickAutoSendInitialized` flags; recreated overlay window no
  longer shows stale checkbox states until manual toggle.
- **desktop `__app_reveal_recording__`** — rejects names containing `..`;
  prevents path-traversal enumeration of the user's home parent through
  `shell.showItemInFolder`.
- **desktop hotkey 1.1.24 regression** — comment block inside
  `createOverlayHtml`'s template literal was breaking the outer literal
  via stray backticks + `${}`; rewritten without those characters.

#### SSOT consolidation
- **`backend/audio_constants.py`** — single source of truth for
  `LIVE_SAMPLE_RATE_HZ` (16 000), `LIVE_PCM_BYTES_PER_SEC` (32 000), and
  `LIVE_RECOVERY_MIN_BYTES`. Every literal `16000`/`32000` in `audio.py`,
  `main.py`, `live.py`, and `remote_deepgram_live.py` migrated.
- **`backend/deepgram_endpoints.py`** — `DEEPGRAM_REST_BASE` and
  `DEEPGRAM_LIVE_URL` centralised; both `remote_deepgram` and
  `remote_deepgram_live` import from here. `TRANSCRIPTOR_DEEPGRAM_HOST`
  env override for regional routing.
- **Version SSOT** — `vite.config.ts` now reads
  `desktop/package.json` instead of `frontend/package.json` for
  `__APP_VERSION__`. One file to bump per release; `frontend/package.json`
  `"version"` field is vestigial.
- **MIME drift assert** — backend module-import-time assertion that
  `ALLOWED_AUDIO_EXTS ⊆ _AUDIO_EXT_TO_MIME.keys()` so a future addition
  to the ext list without a matching MIME entry fails on boot, not
  silently downstream.
- **`DEFAULT_OPENROUTER_AUDIO_MODEL`** — single named constant replaces
  inline `OPENROUTER_AUDIO_MODELS[0]` at 11 sites.
- **`countWords`** — `wordCountOf` aliases the module-level helper
  instead of a divergent inline lambda.

#### Docs / build
- **README** — corrected hotkey defaults per OS, removed Mac Intel
  section (build is arm64-only since 1.1.24), replaced hardcoded
  `1.1.1` filenames with `<version>` placeholders.
- **`.env.example`** — `TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC`
  documented default corrected from 3600 to 86400 (matches code).
- **`install/win/build.bat`** — JS-string backslash escape bug fixed
  (`\b`, `\t`, etc. in user paths). Pass via env var instead.
- **Mac build rules** — arm64-only (M-series); Intel x64 dropped from
  electron-builder target and `dist` script.
- **Renderer trace log bridge** — `console.log("[trace ...]")` lines
  mirror to `main.log` via `webContents.on("console-message", ...)`;
  enables packaged-build debugging without DevTools.

### [Unreleased prior to 1.1.25]
1.1.2 → 1.1.24: 22 release commits between 1.1.1 and 1.1.25
covering tail-cut recovery (1.1.13 → 1.1.16 ladder), parallel
race + Finalize-before-CloseStream (1.1.17 → 1.1.19), the
Deepgram-WS-not-emitting-is_final root cause investigation
(1.1.20 → 1.1.22), the overlay waveform red-line fix (1.1.23) and
the comment-in-template hotkey breakage + restore (1.1.24).
See `git log --oneline --grep "release"` for the full chain.

## [1.1.1] — 2026-04-25

Enterprise-grade storage layer (SSOT) and a dense wave of pre-launch
hardening. Shipped to global users the day after 1.1.0-rc was cut;
**24 audit passes** went into this release, ~105 unique bugs
identified and triaged across the stack.

Final tag at commit `a9a6da9` (chain: pass-15 → … → pass-24c).

### Added (passes 18–24)

#### Persistence / SSOT
- **Shared `backend/storage.py`** — every persistent file write
  (config, upscale presets, archive registry, API token, encryption
  key, recording transcripts, job results, live-recovery meta,
  legacy migration copies) routes through four primitives:
  `atomic_write_bytes`, `atomic_write_text`, `atomic_write_json`,
  `rotate_backup`. Each guarantees atomicity (`tmp + os.replace`),
  durability (`fsync` on file + parent dir on POSIX), recoverability
  (`.bak` rotation where applicable), and matches the
  `<path>.tmp-<hex>` convention swept by `_sweep_orphan_tmp_files`.
- **Config schema versioning** (`SCHEMA_VERSION=2`). Legacy 1.0.x
  configs (no `schema_version`) auto-migrated on load. Pre-migration
  version captured BEFORE `_migrate_schema` mutates it (pass-23 M
  fix), so the stamp-back-to-disk path actually fires for
  beta-shaped configs with encrypted keys.
- **Config `.bak` recovery.** `load_config` falls back to backup
  on parse failure of the primary; backup rotated on every save.
- **Config shape validation.** Wrongly-typed subtrees (e.g.
  `providers: "string"` from a buggy client) reset to defaults
  with a warning instead of crashing.

#### Async + concurrency
- **6 sync routes converted to `async def`** with `asyncio.to_thread`
  offload + per-cache `asyncio.Lock` rebuild gating. Historical batch
  included the Graph route; Graph is now dormant and the backend route is
  no longer registered. Current routes include GET
  `/api/recordings`, `/recordings/stats/summary`,
  `/recordings/{name}`, DELETE `/api/recordings`, POST
  `/recordings/pick-folder`, `/recordings/open-folder`,
  `/live/recoveries/{id}/promote`. Cold-cache scans no longer pin
  executor threads or starve the event loop.
- **`JobStore.shutdown(timeout=1.5)`** in lifespan post-yield drains
  in-flight transcription workers via `cancel_futures=True` +
  daemon-thread join. Prevents the half-written `result.json` /
  `.txt` corruption on Electron SIGTERM.
- **Whisper LRU model cache** (default 2, env-overridable). Cycling
  through tiny→base→small→medium→large-v3 no longer OOM-kills
  on 8 GB hosts.
- **Whisper `run_in_executor` 60 s timeout** in live transcription
  prevents wedged CUDA-OOM hangs from freezing the WS forwarder.
- **`http_retry pool_block=False` + pool_connections=8.** Stalled
  upstream providers no longer freeze the FastAPI executor by
  pinning all 64 connection slots.

#### Desktop
- **Progressive boot-loading UI** — `_bootLoadingDataUrl` shows a
  pulse + live timer immediately during the 5–60 s cold-start;
  120 s → 60 s ceiling.
- **Smart clipboard restore** — polls clipboard contents and
  ABORTS restore if user copied something new during the paste
  window, instead of unconditionally clobbering after 1200 ms.
- **macOS F-key Mission Control collision detection** —
  `getUserDefault("com.apple.keyboard.fnState", "boolean")` piped
  into shortcut status; renderer badges F-key rows with a tooltip
  offering 3 remediations (toggle OS setting, hold Fn, pick
  non-F-key).
- **OneDrive `%APPDATA%` auto-remediation** — detects when
  corporate KFM Roaming routed AppData into OneDrive sync,
  re-homes `userData` to `%LOCALAPPDATA%\Transcriptor` early in
  init, performs one-time `fs.cpSync` migration with
  `.migrated-from-onedrive` marker.
- **Orphaned 1.0.x `.venv` cleanup** on first 1.1.x launch with a
  working bundled runtime. Three safety guards: marker for
  idempotency, exact-path equality (no symlink escape), Python-venv
  signature check.
- **macOS Accessibility-revocation poll** — 30 s poll surfaces
  `__transcriptorAccessibilityStatus` to renderer.
- **Overlay multi-monitor resilience** — `display-metrics-changed`,
  `display-added`, `display-removed` listeners re-pin the overlay
  to the correct display.
- **Windows tree-kill via `taskkill /T /F`** prevents orphan
  uvicorn workers + ffmpeg grandchildren on shutdown.
- **Richer paste target capture** (pass 22) — single struct with
  appName/pid/windowTitle/windowId/hwnd/className/instanceName
  enables exact-window paste targeting (fixes "paste into wrong
  Chrome tab" reports).

#### Frontend / UX
- **Retranscribe session-gating** + `runUpscaleIfEnabled` integration.
- **API key save errors surface to UI** via `setStatus` + red ring
  + aria-invalid (was silent `console.error`).
- **Mic-enumerate error classification** by `DOMException.name`:
  6 distinct messages instead of one misleading "Permission denied".
- **Boot error overlay** classifies known families
  (port-in-use, permission-denied, missing-module, Python-not-found)
  with raw stderr in `<details>` disclosure (no longer leaks paths
  into the paste buffer).
- **Upscale text capped at 120 000 chars** client-side with
  user-visible "trimmed N chars" status, instead of opaque HTTP 400.
- **Custom upscale-preset delete confirms** before destructive action.
- **Silence-seconds + dB threshold inputs reflect clamped value**
  back into the DOM (UI/state mismatch fix).
- **Audio playback no longer disrupted** by routine
  `loadRecordings` refresh when the source URL hasn't changed.

#### Tests + docs
- **24 unit tests** in `backend/tests/` (15 storage primitives + 9
  config lifecycle + 1 pass-23 M regression) — `python -m unittest
  backend.tests.test_storage backend.tests.test_config -v` runs in
  ~70 ms with zero external dependencies.
- **CHANGELOG.md** Keep-a-changelog format documenting every
  user-facing change.

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
  afterPack.js (true) — now `true` in both.
- Hotkey-registration status never reaching the first renderer
  window (cached + replayed from `did-finish-load`, alongside
  accessibility-trust state and any prior boot error).
- Overlay `overlayLoaded` flag stuck `true` after window destroy +
  recreate, leaving the overlay a permanent blank capsule until
  process restart (pass-24c P0 fix).
- `startBackend` early-out order race: concurrent caller seeing
  momentarily-set `backend` during spawn-then-instant-crash window
  could proceed to loadURL against a backend about to die.
- URL `setWindowOpenHandler` / `will-navigate` now use
  `new URL()` origin parsing instead of vulnerable
  `startsWith(BASE_URL)` prefix-match (suffix-injection fix).
- VBS paste temp file uses `crypto.randomUUID()` instead of
  `Date.now()` (millisecond collision fix).
- `setIgnoreMouseEvents(true, { forward: true })` re-invocation
  on overlay mouse-leave is now platform-gated (macOS-only flag).
- `cscript` VBS-paste timeout 2500 → 5000 ms (Windows Defender
  AV scan budget).
- Audio playback no longer reset to position 0 by routine
  `loadRecordings` refresh when source URL hasn't changed.
- Deepgram "API key is not configured" misrouted to
  region-block/VPN hint; now explicitly classified.
- Upscale placeholder collision via text-equality sentinel
  (replaced with per-session `dataset.upscaleNonce`).
- Whisper `run_in_executor` now wrapped in
  `asyncio.wait_for(timeout=60)` — wedged CUDA-OOM hangs no longer
  freeze the WS forwarder.
- Whisper LRU cache evicts oldest model on insert beyond cap
  (was unbounded, OOM on 8 GB hosts when cycling models).
- Historical sync route handlers (then including graph, stats, promote,
  pickers, DELETE, get_recording) converted to `async def` + `asyncio.to_thread` —
  no longer pin the FastAPI executor pool on cold-cache scans.
- 6 raw `str(e)` error leak sites routed through `_safe_error_text`
  (WS fatal, Deepgram WS connect, save_config, picker errors,
  picker FileNotFound, open-folder errors).
- `_rec_dir_cache` reads/writes guarded by lock (race on
  fresh-cache-stale-timestamp).
- `_register_archive_dir` SSOT consistency — text-only save now
  registers the archive dir like audio save does.
- `http_retry pool_connections` 4 → 8 to absorb steady-state burst
  without TLS re-handshake.
- ffmpeg stderr now bounded at 64 KB via background reader thread
  (prevents OOM from corrupt-input ffmpeg crash loops).
- Click-and-hold overlay buttons leaking intervals when user drags
  off (document-level `pointerup`/`pointercancel`/`blur` cleanup).
- Accessibility-poll `setInterval` handle captured + `.unref()`'d
  + cleared on `before-quit`. Same now applied to
  `shortcutPollTimer`.
- `_ERROR_PATH_REDACT_RE` no longer over-matches URL paths
  containing `/Users`, `/home`, `/var`, `/tmp` (negative
  look-behind).
- `"Deleted undefined recording(s)"` in archive-delete UI (shape
  coercion + surfaces partial failures).
- `.encryption_key` write is now atomic — a crash during first-launch
  keyfile creation no longer produces a zero-length keyfile that
  silently invalidates every previously-encrypted value on next
  load.
- 5 persistence sites still using bare `Path.write_text` migrated
  to SSOT atomic writers (job result `.json`/`.txt` for both local
  and remote, live-recovery meta start + finalize, volatile-path
  migration copy).
- Silence-seconds + dB threshold inputs reflect the clamped value
  back into the DOM (UI/state mismatch fix).
- Custom upscale-preset deletion now confirms with `window.confirm`
  before destroying a user's tuned prompt.
- Upscale text > 120 000 chars trimmed client-side (preserving
  trailing summary) with status notice instead of opaque HTTP 400.
- Window-level mousemove drag-pan handler scope-bound to
  mousedown / mouseup / blur — zero overhead outside an active
  drag instead of fire-and-early-return on every mouse move
  for the lifetime of the renderer.
- Schema-version stamp regression: pre-migration version captured
  before `_migrate_schema` mutates it, so the stamp-back-to-disk
  path actually fires for legacy beta-shaped configs (pass-23 M).

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
