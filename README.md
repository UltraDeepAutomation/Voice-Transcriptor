# Transcriptor

Desktop voice transcription app with live recording, file upload transcription, AI text cleanup, local history, global hotkeys, a single recording status capsule, and auto-paste.

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

Developer ID DMG release flow:

```bash
export TRANSCRIPTOR_SIGNING_IDENTITY="Developer ID Application: Your Team (TEAMID)"
npm --prefix desktop run dist

export NOTARYTOOL_KEYCHAIN_PROFILE="TranscriptorNotaryProfile"
npm --prefix desktop run notarize:dmg
```

The notarization command submits the signed DMG with `notarytool`, staples the
ticket, validates the staple, and runs Gatekeeper validation on the final DMG.
All release environment variables are documented in `.env.example`.

#### Mac App Store / TestFlight builds

The App Store/TestFlight artifact is a MAS `.pkg`, not the public DMG. It must use an explicit App Store Connect bundle ID, a matching Mac App Store provisioning profile, an app signing certificate, and an installer signing certificate. The build fails before packaging if any required signing input is missing.

`.env.example` is the environment-variable SSOT. Export the MAS values in your shell, or source a local env file before running the build scripts.

```bash
export TRANSCRIPTOR_MAS_APP_ID="com.yourcompany.transcriptor"
export TRANSCRIPTOR_MAS_PROVISIONING_PROFILE="/absolute/path/Transcriptor_Mac_App_Store.provisionprofile"
export TRANSCRIPTOR_MAS_SIGNING_IDENTITY="Apple Distribution: Your Team (TEAMID)"
export TRANSCRIPTOR_MAS_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Your Team (TEAMID)"

npm --prefix desktop run dist:mas
```

Upload the generated `desktop/dist/Transcriptor-<version>-mas-arm64.pkg` after App Store Connect credentials are available:

```bash
export ASC_API_KEY="KEYID"
export ASC_API_ISSUER="ISSUER-UUID"
export ASC_API_KEY_PATH="/absolute/path/AuthKey_KEYID.p8"
npm --prefix desktop run testflight:upload
```

Apple ID upload also works with `ASC_USERNAME` and `ASC_APP_SPECIFIC_PASSWORD`.
For Apple accounts attached to multiple providers, also export
`ASC_PROVIDER_PUBLIC_ID`.

### Windows x64

1. Download `Transcriptor Setup <version>.exe`.
2. Run the installer.
3. Allow microphone access when Windows asks (Settings → Privacy & security →
   Microphone → Let desktop apps access your microphone).

No extra tools are required: auto-paste and auto-send use built-in Windows
APIs, and the bundled runtime already contains Python and ffmpeg.

### Linux x64

Linux release builds include the bundled runtime. Desktop integration tools are still distro-specific:

```bash
sudo apt install xdotool wmctrl zenity
chmod +x Transcriptor-<version>.AppImage
./Transcriptor-<version>.AppImage
```

`xdotool` drives auto-paste and auto-send, `wmctrl` restores the window that
was focused when recording started, and `zenity` provides the archive-folder
picker. Without them the app still records and transcribes; only those
integrations degrade.

On Wayland, install the matching paste tools for your compositor (`wtype` or `ydotool`) and configure input permissions as required by your distro.

## Permissions Per Platform

| Platform | Required | Needed for | Where to grant |
| --- | --- | --- | --- |
| macOS | Microphone | Recording | System Settings → Privacy & Security → Microphone |
| macOS | Accessibility | Auto-paste and auto-send keystrokes | System Settings → Privacy & Security → Accessibility |
| macOS | Automation | Refocusing the app you recorded from | System Settings → Privacy & Security → Automation |
| Windows | Microphone | Recording | Settings → Privacy & security → Microphone |
| Linux | Microphone | Recording | Distro audio stack (PipeWire/PulseAudio) |
| Linux | Input tools | Auto-paste / auto-send | `xdotool`, `wmctrl` (X11) or `wtype` / `ydotool` (Wayland) |

The app never requests these at startup. Each prompt appears the first time
the corresponding action runs.

## Hotkeys

Two global hotkeys work from any application, including when the Transcriptor
window is hidden.

| Action | macOS default | Windows / Linux default |
| --- | --- | --- |
| Start / stop recording | `Option`+`←` | `F9` |
| Paste the last transcript again | `Option`+`Shift`+`V` | `F10` |

Defaults live in `desktop/shortcut-defaults.json`, which is the SSOT for both
the Electron main process and the Settings UI.

### Changing a hotkey

1. Open **Settings → Shortcuts**.
2. Click the key row you want to rebind — it switches to `Press keys...`.
3. Press the combination. It is saved and re-registered immediately; there is
   no separate Save button.
4. `Esc`, or a click outside the row, cancels the capture.
5. **Reset shortcuts** restores the platform defaults from the table above.

Rules the picker enforces:

- Letter, digit and punctuation keys require at least one modifier, so a
  binding can never swallow normal typing.
- Function keys (`F1`–`F12`), arrows, and navigation keys (`Home`, `End`,
  `PageUp`, `PageDown`, `Insert`, `Delete`) may be bound on their own.
- The two actions cannot share the same combination.

### When a hotkey does not fire

- A red highlight on the Settings row means the OS refused the registration —
  another application already owns that combination. Pick a different one.
- **macOS + F-keys:** with "Use F1, F2, etc. keys as standard function keys"
  turned OFF, macOS consumes `F9`/`F10` as Mission Control and Notification
  Center before the app sees them. Registration still succeeds, so the row is
  badged with a hint instead. Either enable that setting in System Settings →
  Keyboard → Keyboard Shortcuts → Function Keys, hold `Fn` while pressing, or
  pick a non-F-key combination. This is why macOS defaults to `Option`+`←`.
- Auto-paste needs Accessibility permission. Without it the transcript is
  still copied to the clipboard and the status capsule says so.

### Auto-send (Enter after paste)

**Settings → Auto-send** appends an `Enter` keystroke after a successful
auto-paste, so a dictated message is sent in chat apps without touching the
keyboard. It is off by default and only fires when the paste itself succeeded.

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

Copy `.env.example` to `.env` when you need app/runtime overrides:

```bash
cp .env.example .env
```

Shell-driven build, signing, install, and upload scripts read process environment. Source the file before running those commands when you keep their values in `.env`:

```bash
set -a
source .env
set +a
```

`.env.example` is the SSOT for user-facing environment variables. Internal variables such as `TRANSCRIPTOR_BOOT_NONCE` are owned by Electron/backend startup and should not be set by users.

## Troubleshooting

- Logs live in the Electron userData directory as `main.log` plus timestamped rotated archives. Rotation preserves old logs.
- If the backend fails to start, open the app support panel or inspect `main.log`.
- If port `8321` is busy, Electron can pick another local port. Do not blanket-kill processes with `kill -9`; identify the process first.
- Rebuild the app with `./BUILD.command` on macOS after source changes.

### Recording captures silence ("Mic is not delivering audio")

The topbar mic pill turns red and the session reports `Microphone is not delivering audio — open System Settings → Privacy & Security → Microphone…` instead of a generic "no speech captured". Three common root causes, in order of frequency:

1. **TCC reset after reinstall.** macOS can revoke microphone permission for an app whose code identity changes, which a reinstall via `./BUILD.command` may do. Transcriptor asks the OS for microphone access at launch, so a fresh install shows the system prompt by itself — accept it. macOS never re-asks once a request has been declined, so if you dismissed it, open **System Settings → Privacy & Security → Microphone**, enable Transcriptor, then quit and relaunch the app.
2. **Mic muted at the OS level.** macOS Monterey+ shows a strike-through microphone icon in the menu bar when the active input device is muted. Click it to unmute, or in **System Settings → Sound → Input** raise the input volume slider.
3. **Wrong input device selected.** If multiple inputs are connected (e.g. external webcam, AirPods, virtual audio device), open the in-app mic selector and confirm the expected device is highlighted. The pill shows the resolved `deviceId` for inspection.

The mic health probe is always-on — it runs whether or not auto-stop-on-silence is enabled. It samples the analyser every 50 ms and classifies on *digital silence* (no sample above one 16-bit LSB), not on loudness, so a quiet room is never mistaken for a broken microphone. A dead pipeline is flagged within 2.5 s of pressing record, or after 4 s of continuous digital silence mid-session; a 10 s watchdog covers the case where the audio graph never starts at all. The pill also shows `Mic muted` when the OS mutes the input device and `Mic lost` when the device disconnects mid-recording.

## Project Docs

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — current code layout and ownership.
- [VERIFIED_AUDIT.md](VERIFIED_AUDIT.md) — verified bug audit and fixes.
- [AUDIT_2026-08.md](AUDIT_2026-08.md) — release audit: 30 confirmed defects with code and fixes.
- [CHANGELOG.md](CHANGELOG.md) — historical release notes.

## Version SSOT

`desktop/package.json` owns the app version. Vite injects it into the renderer through `__APP_VERSION__`, and build scripts/package metadata read from the same source.
