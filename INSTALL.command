#!/usr/bin/env bash
# ============================================================================
#  Transcriptor - cross-platform one-click builder
#  ----------------------------------------------------------------------------
#  Double-click this file on macOS/Linux. It uses the current build SSOT:
#  desktop/package.json scripts plus desktop/scripts/prepare-runtime.sh.
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Darwin)
    exec "$SCRIPT_DIR/BUILD.command" "$@"
    ;;
  Linux)
    cd "$SCRIPT_DIR"
    npm --prefix frontend ci
    npm --prefix desktop ci
    desktop/scripts/prepare-runtime.sh linux-x64
    npm --prefix frontend run build
    cd "$SCRIPT_DIR/desktop"
    node ./unlockDist.js
    npx electron-builder --linux AppImage --x64 "$@"
    ;;
  *)
    echo "Unsupported OS: $OS"
    echo "Windows: run npm --prefix desktop run dist:win from a Windows shell."
    exit 1
    ;;
esac
