# Transcriptor

Desktop voice transcription app with live recording, file upload transcription, AI text cleanup, local history, global hotkeys, overlay controls, and auto-paste.

## Current Scope

- Live microphone transcription through Local Whisper or Deepgram.
- Upload transcription through Local Whisper, Deepgram, or OpenRouter.
- History with saved transcripts, saved source audio, search, stats, re-transcribe, and reveal/open actions.
- AI Upscale presets through OpenRouter.
- macOS/Windows/Linux packaged runtime support.
- Graph view is dormant: sidebar/view markup is commented out, active frontend code/styles are removed, and the backend graph route is not registered.

## Install

Use release artifacts when available.

### macOS Apple Silicon

1. Download `Transcriptor-<version>-arm64.dmg`.
2. Open the DMG and move `Transcriptor.app` to Applications.
3. On first launch, allow Microphone, Accessibility, and Automation permissions.

Public macOS release builds are arm64-only. Intel Macs are source-build only and must use an x64-capable local build path.

### Windows x64

1. Download `Transcriptor Setup <version>.exe`.
2. Run the installer.
3. Allow microphone access when Windows asks.

### Linux x64

Linux release builds include the bundled runtime. Desktop integration tools are still distro-specific:

```bash
sudo apt install xdotool wmctrl zenity
chmod +x Transcriptor-<version>.AppImage
./Transcriptor-<version>.AppImage
```

On Wayland, install the matching paste tools for your compositor (`wtype` or `ydotool`) and configure input permissions as required by your distro.

## Source Build

```bash
cd "Voice Transcriptor"
```

### macOS

```bash
./BUILD.command
```

`BUILD.command` installs frontend/desktop dependencies, prepares the bundled runtime, builds the frontend, packages the DMG, and replaces the installed app bundle with the freshly built bundle.

`./INSTALL.command` delegates to `BUILD.command` on macOS.

### Linux

```bash
./INSTALL.command
```

Linux source builds install npm dependencies, prepare `desktop/runtime/linux-x64`, build the frontend, and package an AppImage with the bundled runtime.

### Windows

Windows release packaging is driven from the desktop package scripts:

```powershell
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:win
```

`desktop/scripts/prepare-runtime.sh win-x64` is a Bash release-host script, not a plain `cmd.exe`/PowerShell script.

## Development Run

Electron owns the backend lifecycle in normal development. Do not start `uvicorn` manually in a second terminal for the desktop app.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix frontend run build
npm --prefix desktop run dev
```

For backend-only API work, running `uvicorn backend.main:app` manually is fine, but do not run it alongside Electron unless you intentionally want a separate server.

## Configuration

Copy `.env.example` to `.env` when you need overrides:

```bash
cp .env.example .env
```

`.env.example` is the SSOT for user-facing environment variables. Internal variables such as `TRANSCRIPTOR_BOOT_NONCE` are owned by Electron/backend startup and should not be set by users.

## Troubleshooting

- Logs live in the Electron userData directory as `main.log` plus timestamped rotated archives. Rotation preserves old logs.
- If the backend fails to start, open the app support panel or inspect `main.log`.
- If port `8321` is busy, Electron can pick another local port. Do not blanket-kill processes with `kill -9`; identify the process first.
- Rebuild the app with `./BUILD.command` on macOS after source changes.

## Project Docs

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — current code layout and ownership.
- [VERIFIED_AUDIT.md](VERIFIED_AUDIT.md) — verified bug audit and fixes.
- [CHANGELOG.md](CHANGELOG.md) — historical release notes.

## Version SSOT

`desktop/package.json` owns the app version. Vite injects it into the renderer through `__APP_VERSION__`, and build scripts/package metadata read from the same source.
