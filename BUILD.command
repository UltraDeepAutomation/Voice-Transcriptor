#!/bin/bash
# ============================================================================
#  Transcriptor — One-click build + install (macOS)
#
#  Rebuilds the frontend, packages the Electron app, signs it, and
#  installs the fresh bundle to ~/Applications/Transcriptor.app.
#  Use this when you've pulled new commits and want the running
#  app to pick them up.
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/install/mac/BUILD.sh" "$@"
