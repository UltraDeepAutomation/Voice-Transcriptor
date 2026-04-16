#!/bin/bash
# ============================================================================
#  Transcriptor — One-click installer for macOS
#
#  Double-click this file in Finder to install Transcriptor end-to-end:
#  dependencies → build → install to /Applications → launch.
#
#  Requires only macOS. Everything else (Python, Node, ffmpeg, Xcode CLI
#  tools, Homebrew) is auto-installed if missing.
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/install/mac/setup.command" "$@"
