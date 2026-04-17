#!/usr/bin/env bash
# ============================================================================
#  Transcriptor — Cross-platform one-click installer
#  ----------------------------------------------------------------------------
#  Double-click this file (macOS/Linux). Detects the host OS and dispatches
#  to the matching installer under install/<os>/:
#
#     macOS   → install/mac/setup.command   (brew + venv + build + /Applications)
#     Linux   → install/linux/setup.sh      (apt/dnf/pacman + venv + AppImage)
#     Windows → user must run install\win\setup.bat instead — .command files
#               aren't executable on Windows Explorer. README points them there.
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Darwin)
    exec "$SCRIPT_DIR/install/mac/setup.command" "$@"
    ;;
  Linux)
    exec "$SCRIPT_DIR/install/linux/setup.sh" "$@"
    ;;
  *)
    echo "Unsupported OS: $OS"
    echo "Windows: double-click install\\win\\setup.bat"
    exit 1
    ;;
esac
