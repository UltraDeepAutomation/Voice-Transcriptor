#!/usr/bin/env bash
# ============================================================================
#  Transcriptor - cross-platform one-click builder
#  ----------------------------------------------------------------------------
#  Double-click this file on macOS/Linux. macOS delegates to BUILD.command;
#  Linux delegates packaging to the desktop package script so runtime
#  preparation and electron-builder resources stay in one SSOT.
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
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix desktop ci
    npm --prefix desktop run dist:linux -- "$@"
    ;;
  *)
    echo "Unsupported OS: $OS"
    echo "Windows: run npm --prefix desktop run dist:win from a Windows shell."
    exit 1
    ;;
esac
