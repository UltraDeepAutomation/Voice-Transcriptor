# Install Transcriptor On Another Mac

This package is for Apple Silicon Macs.

## macOS / Internal Install

Use the terminal installer for this internal build. It mounts the DMG, quits any
running Transcriptor, copies the app to `/Applications`, removes quarantine,
verifies the bundle, and opens the app.

1. Copy these files to the same folder on the target Mac:
   - `Transcriptor-<version>-arm64.dmg`
   - `INSTALL_ON_OTHER_MAC.command`
2. Open Terminal in that folder.
3. Run:

```bash
bash INSTALL_ON_OTHER_MAC.command
```

4. Grant Microphone, Accessibility, and Automation permissions when prompted.

If the app was already dragged into `/Applications` manually and Sonoma shows
"Cannot open Transcriptor", run:

```bash
xattr -dr com.apple.quarantine /Applications/Transcriptor.app
codesign --verify --deep --strict --verbose=2 /Applications/Transcriptor.app
open /Applications/Transcriptor.app
```

If the DMG cannot be used in the transfer channel, put the matching
`Transcriptor-<version>-arm64-internal.zip` created by `BUILD.command` next to
`INSTALL_ON_OTHER_MAC.command` and run the same command.

`BUILD.command` also writes a ready-to-send archive:
`desktop/dist/release/Transcriptor-<version>-arm64-macos-install.zip`. That
archive contains the DMG, this document, `INSTALL_ON_OTHER_MAC.command`, and
`TRANSCRIPTOR_RELEASE_MANIFEST.txt`.

## Production Distribution

For public or customer distribution, build with a valid Developer ID
Application identity, notarize with Apple, and staple the ticket. Ad-hoc
signing is not enough for Gatekeeper-trusted drag-and-drop installs on a clean
Sonoma Mac.

## Verification

On the target Mac, verify the app bundle before first launch:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Transcriptor.app
APP=/Applications/Transcriptor.app
RES="$APP/Contents/Resources"
PYTHONPATH="$RES" PYTHONDONTWRITEBYTECODE=1 "$RES/runtime/python/bin/python3" - <<'PY'
import backend.remote_deepgram as rest
import backend.remote_deepgram_live as live
print(rest._deepgram_http_policy(40379))
print(live.DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC, live.DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC)
PY
```
