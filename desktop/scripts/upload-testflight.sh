#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

die() {
  echo "[testflight-upload] $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die "Missing required command: node"
command -v xcrun >/dev/null 2>&1 || die "Missing required command: xcrun"

APP_VERSION="$(node -p "require('./package.json').version")"
PKG_PATH="${TRANSCRIPTOR_MAS_PKG_PATH:-$DESKTOP_DIR/dist/Transcriptor-${APP_VERSION}-mas-arm64.pkg}"

preflight_errors=()
[ -f "$PKG_PATH" ] || preflight_errors+=("MAS pkg not found: $PKG_PATH")

has_api_key=0
has_apple_id=0
[ -n "${ASC_API_KEY:-}" ] && [ -n "${ASC_API_ISSUER:-}" ] && has_api_key=1
[ -n "${ASC_USERNAME:-}" ] && [ -n "${ASC_APP_SPECIFIC_PASSWORD:-}" ] && has_apple_id=1

if [ "$has_api_key" -ne 1 ] && [ "$has_apple_id" -ne 1 ]; then
  if [ -n "${ASC_API_KEY:-}${ASC_API_ISSUER:-}" ]; then
    [ -n "${ASC_API_KEY:-}" ] || preflight_errors+=("Missing required environment variable for API-key upload: ASC_API_KEY")
    [ -n "${ASC_API_ISSUER:-}" ] || preflight_errors+=("Missing required environment variable for API-key upload: ASC_API_ISSUER")
  fi
  if [ -n "${ASC_USERNAME:-}${ASC_APP_SPECIFIC_PASSWORD:-}" ]; then
    [ -n "${ASC_USERNAME:-}" ] || preflight_errors+=("Missing required environment variable for Apple ID upload: ASC_USERNAME")
    [ -n "${ASC_APP_SPECIFIC_PASSWORD:-}" ] || preflight_errors+=("Missing required environment variable for Apple ID upload: ASC_APP_SPECIFIC_PASSWORD")
  fi
  if [ -z "${ASC_API_KEY:-}${ASC_API_ISSUER:-}${ASC_USERNAME:-}${ASC_APP_SPECIFIC_PASSWORD:-}" ]; then
    preflight_errors+=("Set ASC_API_KEY + ASC_API_ISSUER, or ASC_USERNAME + ASC_APP_SPECIFIC_PASSWORD.")
  fi
fi

if [ "${#preflight_errors[@]}" -gt 0 ]; then
  echo "[testflight-upload] Preflight failed:" >&2
  for err in "${preflight_errors[@]}"; do
    echo "[testflight-upload] - $err" >&2
  done
  exit 1
fi

if [ "$has_api_key" -eq 1 ]; then
  echo "[testflight-upload] Uploading with App Store Connect API key"
  xcrun altool --upload-app \
    -f "$PKG_PATH" \
    -t osx \
    --apiKey "$ASC_API_KEY" \
    --apiIssuer "$ASC_API_ISSUER" \
    --output-format xml
elif [ "$has_apple_id" -eq 1 ]; then
  echo "[testflight-upload] Uploading with Apple ID app-specific password"
  xcrun altool --upload-app \
    -f "$PKG_PATH" \
    -t osx \
    -u "$ASC_USERNAME" \
    -p "$ASC_APP_SPECIFIC_PASSWORD" \
    --output-format xml
fi

echo "[testflight-upload] Uploaded. App Store Connect must process the build before it appears in TestFlight."
