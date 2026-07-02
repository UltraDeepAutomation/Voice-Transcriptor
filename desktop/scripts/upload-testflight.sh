#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

die() {
  echo "[testflight-upload] $*" >&2
  exit 1
}

command -v xcrun >/dev/null 2>&1 || die "Missing required command: xcrun"

APP_VERSION="$(node -p "require('./package.json').version")"
PKG_PATH="${TRANSCRIPTOR_MAS_PKG_PATH:-$DESKTOP_DIR/dist/Transcriptor-${APP_VERSION}-mas-arm64.pkg}"
[ -f "$PKG_PATH" ] || die "MAS pkg not found: $PKG_PATH"

if [ -n "${ASC_API_KEY:-}" ] && [ -n "${ASC_API_ISSUER:-}" ]; then
  echo "[testflight-upload] Uploading with App Store Connect API key"
  xcrun altool --upload-app \
    -f "$PKG_PATH" \
    -t osx \
    --apiKey "$ASC_API_KEY" \
    --apiIssuer "$ASC_API_ISSUER" \
    --output-format xml
elif [ -n "${ASC_USERNAME:-}" ] && [ -n "${ASC_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "[testflight-upload] Uploading with Apple ID app-specific password"
  xcrun altool --upload-app \
    -f "$PKG_PATH" \
    -t osx \
    -u "$ASC_USERNAME" \
    -p "$ASC_APP_SPECIFIC_PASSWORD" \
    --output-format xml
else
  die "Set ASC_API_KEY + ASC_API_ISSUER, or ASC_USERNAME + ASC_APP_SPECIFIC_PASSWORD."
fi

echo "[testflight-upload] Uploaded. App Store Connect must process the build before it appears in TestFlight."
