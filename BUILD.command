#!/bin/bash
# ============================================================================
#  Transcriptor - one-click macOS release build
#
#  Rebuilds the frontend, prepares the bundled runtime, and packages
#  the Electron app. Artifacts are written under desktop/dist/.
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)
    RUNTIME_PLATFORM="mac-arm64"
    BUILDER_ARCH="arm64"
    ;;
  x86_64)
    RUNTIME_PLATFORM="mac-x64"
    BUILDER_ARCH="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

npm --prefix frontend ci
npm --prefix desktop ci
desktop/scripts/prepare-runtime.sh "$RUNTIME_PLATFORM"
npm --prefix frontend run build

cd "$SCRIPT_DIR/desktop"
node ./unlockDist.js
npx electron-builder --mac dmg "--${BUILDER_ARCH}" "$@"
