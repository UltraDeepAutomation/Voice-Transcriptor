#!/bin/bash
# ============================================================================
#  Transcriptor - one-click macOS release build
#
#  Rebuilds the frontend, prepares the bundled runtime, packages the
#  Electron app, and installs the freshly built macOS app bundle.
#  Release artifacts are still written under desktop/dist/.
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
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix desktop ci
desktop/scripts/prepare-runtime.sh "$RUNTIME_PLATFORM"
npm --prefix frontend run build

cd "$SCRIPT_DIR/desktop"
node ./unlockDist.js
npx electron-builder --mac dmg "--${BUILDER_ARCH}" "$@"

APP_DIR="$SCRIPT_DIR/desktop/dist/mac-${BUILDER_ARCH}/Transcriptor.app"
if [ "$BUILDER_ARCH" = "x64" ] && [ ! -d "$APP_DIR" ]; then
  APP_DIR="$SCRIPT_DIR/desktop/dist/mac/Transcriptor.app"
fi
if [ ! -d "$APP_DIR" ]; then
  echo "Built app bundle not found: $APP_DIR" >&2
  exit 1
fi

install_app_bundle() {
  local target_app="$1"
  local target_root
  target_root="$(dirname "$target_app")"
  mkdir -p "$target_root"
  ditto "$APP_DIR" "$target_app"
  echo "Installed $target_app"
}

INSTALL_ROOT="${TRANSCRIPTOR_INSTALL_DIR:-/Applications}"
if [ ! -d "$INSTALL_ROOT" ] || [ ! -w "$INSTALL_ROOT" ]; then
  INSTALL_ROOT="$HOME/Applications"
fi
PRIMARY_APP="$INSTALL_ROOT/Transcriptor.app"
install_app_bundle "$PRIMARY_APP"

LEGACY_USER_APP="$HOME/Applications/Transcriptor.app"
if [ -d "$LEGACY_USER_APP" ] && [ "$LEGACY_USER_APP" != "$PRIMARY_APP" ]; then
  install_app_bundle "$LEGACY_USER_APP"
fi
