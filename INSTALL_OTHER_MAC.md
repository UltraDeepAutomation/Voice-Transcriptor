# Install Transcriptor On Another Mac

This package is for Apple Silicon Macs.

## Internal Ad-Hoc Build

Use this flow for a trusted internal transfer when the build machine has no
Developer ID Application certificate.

1. Copy `Transcriptor-1.1.25-arm64.dmg` to the target Mac.
2. Open the DMG and drag `Transcriptor.app` to `/Applications`.
3. Remove quarantine if macOS blocks the first launch:

```bash
xattr -dr com.apple.quarantine /Applications/Transcriptor.app
open /Applications/Transcriptor.app
```

4. Grant Microphone, Accessibility, and Automation permissions when prompted.

If the DMG cannot be used in the transfer channel, copy
`Transcriptor-1.1.25-arm64-internal.zip`, unzip it, and move
`Transcriptor.app` to `/Applications` manually.

## Production Distribution

For public or customer distribution, build with a valid Developer ID
Application identity, notarize with Apple, and staple the ticket. Ad-hoc
signing is not enough for Gatekeeper-trusted external downloads.

## Verification

On the target Mac, verify the app bundle before first launch:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Transcriptor.app
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 - <<'PY'
import backend.remote_deepgram as rest
import backend.remote_deepgram_live as live
print(rest._deepgram_http_policy(40379))
print(live.DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC, live.DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC)
PY
```
