# Transcriptor

Desktop voice transcription app with live recording, file upload transcription, AI text cleanup, local history, global hotkeys, overlay controls, and auto-paste.

## Current Scope

- Live microphone transcription through Local Whisper or Deepgram.
- Upload transcription through Local Whisper, Deepgram, or OpenRouter.
- History with saved transcripts, saved source audio, search, stats, re-transcribe, and reveal/open actions.
- AI Upscale presets through OpenRouter.
- macOS arm64, Windows x64, and Linux x64 packaged runtime support.
- Graph view is dormant: sidebar/view markup, active frontend code/styles, and the backend graph route are removed.

## Install

Use release artifacts when available.

### macOS Apple Silicon

1. Download `Transcriptor-<version>-arm64-macos-install.zip` from
   `desktop/dist/release`.
2. Unzip it and run `bash INSTALL_ON_OTHER_MAC.command` from the extracted
   folder.
3. On first launch, allow Microphone, Accessibility, and Automation permissions.

Public macOS release/build output is arm64-only. Intel macOS packaged runtime builds are intentionally unsupported in the current release line.

#### Internal ad-hoc builds

`desktop/dist/release/Transcriptor-<version>-arm64-macos-install.zip` is the
preferred transfer artifact between trusted Macs when no Developer ID
certificate is available on the build machine. The terminal installer mounts
the DMG, installs into `/Applications`, removes quarantine, verifies the bundle,
checks the release manifest, and opens the app. These builds are
self-signed/internal or ad-hoc signed, not notarized.

```bash
unzip Transcriptor-<version>-arm64-macos-install.zip
cd Transcriptor-<version>-arm64-macos-install
bash INSTALL_ON_OTHER_MAC.command
```

Public distribution must use a Developer ID Application identity plus Apple notarization and stapling. Without that identity, macOS Gatekeeper cannot treat the app as a fully trusted external download.

#### Mac App Store / TestFlight builds

The App Store/TestFlight artifact is a MAS `.pkg`, not the public DMG. It must use an explicit App Store Connect bundle ID, a matching Mac App Store provisioning profile, an app signing certificate, and an installer signing certificate. The build fails before packaging if any required signing input is missing.

```bash
export TRANSCRIPTOR_MAS_APP_ID="com.yourcompany.transcriptor"
export TRANSCRIPTOR_MAS_PROVISIONING_PROFILE="/absolute/path/Transcriptor_Mac_App_Store.provisionprofile"
export TRANSCRIPTOR_MAS_SIGNING_IDENTITY="Apple Distribution: Your Team (TEAMID)"
export TRANSCRIPTOR_MAS_INSTALLER_IDENTITY="Mac Installer Distribution: Your Team (TEAMID)"

npm --prefix desktop run dist:mas
```

Upload the generated `desktop/dist/Transcriptor-<version>-mas-arm64.pkg` after App Store Connect credentials are available:

```bash
export ASC_API_KEY="KEYID"
export ASC_API_ISSUER="ISSUER-UUID"
npm --prefix desktop run testflight:upload
```

Apple ID upload also works with `ASC_USERNAME` and `ASC_APP_SPECIFIC_PASSWORD`.

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

Prerequisites:

- Node.js `>=22.12.0`; `.node-version` and `.nvmrc` are the local SSOT.
- npm `>=10` from the same Node distribution.
- Runtime preparation requires `python3` with `pip`, `curl`, `tar`, and `unzip` for macOS/Windows archives.
- macOS arm64 internal release builds require `bash`, Xcode Command Line Tools, `codesign`, and the internal signing identity. `TRANSCRIPTOR_SIGNING_IDENTITY="Developer ID Application: ..."` only signs with a production identity; public distribution still requires a separate notarization and stapling gate before shipment. Use `npm --prefix desktop run dist:adhoc` only for explicit local ad-hoc builds.
- Windows release packaging requires a Bash-capable shell because `desktop/scripts/prepare-runtime.sh` prepares the bundled runtime.
- Linux desktop integration still depends on distro packages such as `xdotool`, `wmctrl`, and `zenity`.

```bash
cd "Voice Transcriptor"
```

### macOS

```bash
./BUILD.command
```

`BUILD.command` installs frontend/desktop dependencies, prepares the arm64 bundled runtime, builds the frontend, packages the DMG, and replaces the installed app bundle with the freshly built bundle.

`./INSTALL.command` delegates to `BUILD.command` on macOS.

### Linux

```bash
./INSTALL.command
```

Linux source builds install npm dependencies, prepare `desktop/runtime/linux-x64`, build the frontend, and package an AppImage with the bundled runtime.

### Windows

Windows release packaging is driven from the desktop package scripts. Run it from Git Bash, WSL, or the macOS/Linux release host that can execute `desktop/scripts/prepare-runtime.sh`:

```bash
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
