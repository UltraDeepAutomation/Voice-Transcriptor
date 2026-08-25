# Voice Transcriptor — Project Structure

This file documents the current source layout. It intentionally avoids exact line counts because they drift on every audit/fix pass.

## Root

```text
Voice Transcriptor/
├── BUILD.command                  # macOS source build + install entrypoint
├── INSTALL.command                # macOS delegate / Linux AppImage source build
├── INSTALL_ON_OTHER_MAC.command   # target-Mac installer shipped inside macOS transfer zips
├── README.md                      # install, build, development, troubleshooting
├── CHANGELOG.md                   # historical release notes
├── LICENSE                        # repository license
├── requirements.txt               # direct backend/runtime Python dependencies
├── requirements-gigaam.txt        # optional GigaAM engine stack (ENABLE_GIGAAM opt-in)
├── requirements.runtime-lock.txt  # release-runtime transitive wheel constraints
├── BUGS_AUDIT.md                  # running audit ledger (2026-08-23 wave)
├── BUGS_AUDIT_2026-08-24.md       # dated audit waves + fix statuses (root per audit charter)
├── .env.example                   # user-facing environment-variable SSOT
├── docs/                          # VERIFIED_AUDIT.md, AUDIT_2026-08.md, PRODUCT.md, VISION.md, install guides
├── backend/                       # FastAPI backend and transcription pipeline
├── frontend/                      # Vite/TypeScript renderer
└── desktop/                       # Electron shell and package config
```

Removed root clutter:

- `INCONSISTENCIES.md` was an obsolete research snapshot and is no longer SSOT.
- `desktop/README.md` duplicated stale desktop instructions and was removed.
- `AUDIT_100_BUGS.md` was renamed to `VERIFIED_AUDIT.md` and moved to `docs/` because the audit intentionally lists only verified real bugs.
- `INSTALL_OTHER_MAC.md` and the audit documents live under `docs/`, not the root.

## Backend

```text
backend/
├── main.py                    # FastAPI app, REST/WS routes, jobs, recordings, config endpoints;
│                              #   audio-retention policy table + recordings-scan caches
├── config.py                  # config loading, migration, encrypted provider keys
├── audio.py                   # ffmpeg/soundfile conversion and chunking
├── audio_constants.py         # shared audio constants
├── live.py                    # local live transcription session logic
├── transcribe.py              # engine dispatch, faster-whisper model cache + idle unload, local transcription
├── transcribe_gigaam.py       # optional Sber GigaAM-v3 engine adapter (gigaam-* ids)
├── models_manager.py          # local model presence/download manager (Settings → Local models)
├── remote_deepgram.py         # Deepgram prerecorded REST provider
├── remote_deepgram_live.py    # Deepgram live WebSocket provider
├── remote_openrouter.py       # OpenRouter audio transcription and text upscale
├── deepgram_endpoints.py      # Deepgram endpoint SSOT
├── http_retry.py              # remote request retry handling
├── jobs.py                    # in-memory job store and cancellation
├── storage.py                 # atomic write helpers
└── tests/                     # backend unit/regression tests
```

Backend owns:

- API token auth.
- local and remote transcription.
- live WebSocket sessions.
- recording persistence and retention.
- upload/from-path job lifecycle.
- provider config storage.

Graph is dormant: no backend graph route is registered.

## Frontend

```text
frontend/
├── index.html                        # renderer DOM shell; dormant Graph markup removed
├── package.json                      # frontend build dependencies/scripts
├── tsconfig.json                     # TypeScript config
├── vite.config.ts                    # Vite config and app-version injection
└── src/
    ├── main.tsx                      # renderer app logic
    ├── styles.css                    # renderer styles; Graph styles removed while dormant
    ├── pcm-worklet.js                # AudioWorklet PCM/VU processor
    ├── text-match.ts                 # transcript word-normalisation SSOT (pure)
    ├── transcript-merge.ts           # transcript adoption policy SSOT (pure)
    ├── live-coverage.ts              # live-envelope reuse decision SSOT (pure)
    ├── mic-health.ts                 # microphone-health FSM SSOT (clock-injected, pure)
    ├── recordings-list-reconciler.ts # keyed DOM reconciler for the history list (pure)
    ├── gated-poll.ts                 # conditional-polling scheduler SSOT (pure, timer-injected)
    ├── list-window.ts                # history-list windowing policy SSOT (pure)
    └── update-check.ts               # GitHub release detection (Level 1), version compare (pure)
```

Frontend owns:

- upload queue and job polling.
- live recording UI.
- settings UI.
- history/search/stats UI.
- local audio preview and re-transcribe actions.
- OpenRouter upscale UI.

## Desktop

```text
desktop/
├── main.js                         # Electron main process, backend lifecycle, recording monitor, hotkeys
├── accelerator.js                  # accelerator canonicalisation SSOT (pure, node --test)
├── engine-deps.js                  # GigaAM engine dependency-policy SSOT (pure, node --test)
├── preload.js                      # safe renderer bridge (path-for-file, engine lifecycle invoke-only)
├── package.json                    # electron-builder config and desktop scripts
├── shortcut-defaults.json          # per-platform default hotkey manifest
├── afterPack.js                    # macOS bundle signing/runtime fixups
├── afterAllArtifactBuild.js        # macOS DMG artifact signing hook
├── unlockDist.js                   # build artifact lock cleanup
├── entitlements.mac.plist          # macOS app entitlements
├── entitlements.mac.inherit.plist  # macOS helper entitlements
├── entitlements.mas.plist          # Mac App Store app entitlements
├── entitlements.mas.inherit.plist  # Mac App Store helper entitlements
├── icon.png / icon.ico             # package icons
└── scripts/
    ├── prepare-runtime.sh          # macOS arm64 / Windows x64 / Linux x64 runtime builder
    ├── build-mas.sh                # Mac App Store package build entrypoint
    ├── sign-mas.js                 # Mac App Store signing and provisioning preflight
    ├── upload-testflight.sh        # App Store Connect/TestFlight upload entrypoint
    ├── macos-signing-utils.js      # shared macOS signing/provisioning helpers
    └── require-bash.js             # release-host shell guard for Windows packaging
```

Desktop owns:

- single-instance app lock.
- backend process spawn and port selection.
- boot nonce verification.
- global hotkeys.
- headless recording state monitor and global hotkey coordination.
- auto-paste platform integrations.
- log writing and non-destructive rotation.
- GigaAM engine lifecycle: user-initiated install (Settings → Local models),
  network/disk gates, staging+swap into userData/engine-site, overlap policy
  against the pinned bundle (`engine-deps.js`), boot-time reconcile only.
- bundled runtime packaging for macOS, Windows, and Linux.
- Developer ID app/DMG signing handoff for notarization.
- Mac App Store packaging, provisioning preflight, and TestFlight upload handoff.

## Build SSOT

- App version: `desktop/package.json`.
- Direct Python dependencies: `requirements.txt`.
- Release runtime constraints: `requirements.runtime-lock.txt`.
- User-facing environment variables: `.env.example`.
- Frontend output: `frontend/dist` generated by Vite.
- Packaged resources: `desktop/package.json` `build.extraResources`.
