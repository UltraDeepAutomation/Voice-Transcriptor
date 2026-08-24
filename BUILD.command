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
DIST_DIR="$SCRIPT_DIR/desktop/dist"
cd "$SCRIPT_DIR"

cleanup_path() {
  local target="$1"
  if [ -e "$target" ]; then
    chmod -R u+w "$target" 2>/dev/null || true
    rm -rf "$target"
  fi
}

cleanup_release_output() {
  cleanup_path "$DIST_DIR"
}

cleanup_stale_install_backups() {
  local target_root="$1"
  local backup
  [ -d "$target_root" ] || return 0
  [ -w "$target_root" ] || return 0
  for backup in "$target_root"/Transcriptor.app.backup-*; do
    [ -e "$backup" ] || continue
    cleanup_path "$backup"
  done
}

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)
    BUILDER_ARCH="arm64"
    ;;
  x86_64)
    echo "macOS release builds are arm64-only in this release line." >&2
    echo "Intel Macs are unsupported because the bundled runtime graph is arm64-only." >&2
    exit 1
    ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

cleanup_release_output
cleanup_stale_install_backups "/Applications"
cleanup_stale_install_backups "$HOME/Applications"

npm --prefix frontend ci
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix desktop ci

cd "$SCRIPT_DIR/desktop"
npm run dist -- "$@"

APP_DIR="$DIST_DIR/mac-${BUILDER_ARCH}/Transcriptor.app"
if [ ! -d "$APP_DIR" ]; then
  echo "Built app bundle not found: $APP_DIR" >&2
  exit 1
fi
APP_VERSION="$(node -p "require('./package.json').version")"
APP_ID="$(node -p "require('./package.json').build.appId")"
APP_ARTIFACT_PREFIX="Transcriptor-${APP_VERSION}-${BUILDER_ARCH}"
DMG_PATH="$DIST_DIR/${APP_ARTIFACT_PREFIX}.dmg"
INTERNAL_ZIP="$DIST_DIR/${APP_ARTIFACT_PREFIX}-internal.zip"
RELEASE_DIR="$DIST_DIR/release"
RELEASE_MANIFEST_NAME="TRANSCRIPTOR_RELEASE_MANIFEST.txt"
INSTALL_KIT_NAME="${APP_ARTIFACT_PREFIX}-macos-install"
INSTALL_KIT_DIR="$RELEASE_DIR/$INSTALL_KIT_NAME"
INSTALL_KIT_ZIP="$RELEASE_DIR/${INSTALL_KIT_NAME}.zip"

create_internal_zip() {
  local zip_path="$1"
  cleanup_path "$zip_path"
  (
    cd "$(dirname "$APP_DIR")"
    ditto -c -k --sequesterRsrc --keepParent "$(basename "$APP_DIR")" "$zip_path"
  )
  echo "Created $zip_path"
}

create_internal_zip "$INTERNAL_ZIP"

write_release_manifest() {
  local out="$1"
  cat > "$out" <<EOF
product=Transcriptor
version=$APP_VERSION
arch=$BUILDER_ARCH
app_id=$APP_ID
dmg=$(basename "$DMG_PATH")
internal_zip=$(basename "$INTERNAL_ZIP")
install_zip=$(basename "$INSTALL_KIT_ZIP")
EOF
}

create_release_package() {
  local dmg_base
  local internal_zip_base
  local install_zip_base

  [ -f "$DMG_PATH" ] || {
    echo "Built DMG not found: $DMG_PATH" >&2
    exit 1
  }
  [ -f "$INTERNAL_ZIP" ] || {
    echo "Internal ZIP not found: $INTERNAL_ZIP" >&2
    exit 1
  }
  # Single definition of where the install guide lives. It moved to
  # docs/ during the repo-root cleanup while this script still had the
  # old root path in six places, which broke release packaging. Resolve
  # it once and accept either location so an older checkout still packs.
  INSTALL_DOC="$SCRIPT_DIR/docs/INSTALL_OTHER_MAC.md"
  [ -f "$INSTALL_DOC" ] || INSTALL_DOC="$SCRIPT_DIR/INSTALL_OTHER_MAC.md"

  [ -f "$SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" ] || {
    echo "Installer script not found: $SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" >&2
    exit 1
  }
  [ -f "$INSTALL_DOC" ] || {
    echo "Install docs not found: $INSTALL_DOC" >&2
    exit 1
  }
  command -v zip >/dev/null 2>&1 || {
    echo "Missing required command: zip" >&2
    exit 1
  }
  command -v shasum >/dev/null 2>&1 || {
    echo "Missing required command: shasum" >&2
    exit 1
  }

  cleanup_path "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  write_release_manifest "$RELEASE_DIR/$RELEASE_MANIFEST_NAME"

  cp "$DMG_PATH" "$RELEASE_DIR/"
  cp "$INTERNAL_ZIP" "$RELEASE_DIR/"
  cp "$SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" "$RELEASE_DIR/"
  cp "$INSTALL_DOC" "$RELEASE_DIR/"
  chmod +x "$RELEASE_DIR/INSTALL_ON_OTHER_MAC.command"

  cleanup_path "$INSTALL_KIT_DIR"
  mkdir -p "$INSTALL_KIT_DIR"
  cp "$DMG_PATH" "$INSTALL_KIT_DIR/"
  cp "$SCRIPT_DIR/INSTALL_ON_OTHER_MAC.command" "$INSTALL_KIT_DIR/"
  cp "$INSTALL_DOC" "$INSTALL_KIT_DIR/"
  cp "$RELEASE_DIR/$RELEASE_MANIFEST_NAME" "$INSTALL_KIT_DIR/"
  chmod +x "$INSTALL_KIT_DIR/INSTALL_ON_OTHER_MAC.command"

  cleanup_path "$INSTALL_KIT_ZIP"
  (
    cd "$RELEASE_DIR"
    zip -qry -X "$(basename "$INSTALL_KIT_ZIP")" "$(basename "$INSTALL_KIT_DIR")"
  )
  cleanup_path "$INSTALL_KIT_DIR"

  dmg_base="$(basename "$DMG_PATH")"
  internal_zip_base="$(basename "$INTERNAL_ZIP")"
  install_zip_base="$(basename "$INSTALL_KIT_ZIP")"
  (
    cd "$RELEASE_DIR"
    shasum -a 256 \
      "$dmg_base" \
      "$internal_zip_base" \
      "$install_zip_base" \
      "INSTALL_ON_OTHER_MAC.command" \
      "INSTALL_OTHER_MAC.md" \
      "$RELEASE_MANIFEST_NAME" \
      > SHA256SUMS.txt
  )
  # The root-level INTERNAL_ZIP is a build-time intermediate: the release
  # directory already embeds its own copy inside the install kit. Drop the
  # root duplicate so a finished build leaves DMG + kit (~470 MB), not
  # three full copies of the same version (~715 MB).
  cleanup_path "$INTERNAL_ZIP"
  echo "Created release package in $RELEASE_DIR"
}

create_release_package

install_app_bundle() {
  local target_app="$1"
  local target_root
  local target_name
  local tmp_app
  local backup_app
  target_root="$(dirname "$target_app")"
  target_name="$(basename "$target_app")"
  tmp_app="$target_root/.${target_name}.installing.$$"
  backup_app="$target_app.backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cleanup_tmp_app() {
    cleanup_path "$tmp_app"
  }
  cleanup_backup_app() {
    cleanup_path "$backup_app"
  }
  mkdir -p "$target_root"
  cleanup_tmp_app
  if ! ditto "$APP_DIR" "$tmp_app"; then
    cleanup_tmp_app
    return 1
  fi
  if ! codesign --verify --deep --strict "$tmp_app"; then
    cleanup_tmp_app
    return 1
  fi
  if [ -e "$target_app" ]; then
    mv "$target_app" "$backup_app"
  fi
  if ! mv "$tmp_app" "$target_app"; then
    if [ -e "$backup_app" ] && [ ! -e "$target_app" ]; then
      mv "$backup_app" "$target_app"
    fi
    cleanup_tmp_app
    return 1
  fi
  cleanup_backup_app
  echo "Installed $target_app"
}

bundle_identifier() {
  local app_path="$1"
  plutil -extract CFBundleIdentifier raw -o - "$app_path/Contents/Info.plist" 2>/dev/null || true
}

retire_duplicate_app_bundle() {
  local duplicate_app="$1"
  local canonical_app="$2"
  local duplicate_id
  local canonical_id
  [ -d "$duplicate_app" ] || return 0
  [ "$duplicate_app" != "$canonical_app" ] || return 0
  duplicate_id="$(bundle_identifier "$duplicate_app")"
  canonical_id="$(bundle_identifier "$canonical_app")"
  if [ -n "$duplicate_id" ] && [ "$duplicate_id" = "$canonical_id" ]; then
    cleanup_path "$duplicate_app"
    echo "Removed duplicate $duplicate_app (same bundle id as $canonical_app)"
    return 0
  fi
  echo "Keeping $duplicate_app because its bundle id differs from $canonical_app" >&2
}

INSTALL_ROOT="${TRANSCRIPTOR_INSTALL_DIR:-/Applications}"
if [ ! -d "$INSTALL_ROOT" ] || [ ! -w "$INSTALL_ROOT" ]; then
  if [ -n "${TRANSCRIPTOR_INSTALL_DIR:-}" ]; then
    echo "Install directory is not writable: $INSTALL_ROOT" >&2
    exit 1
  fi
  if [ -d "/Applications/Transcriptor.app" ]; then
    echo "Existing /Applications/Transcriptor.app cannot be updated without write access." >&2
    echo "Set TRANSCRIPTOR_INSTALL_DIR explicitly or rerun with permissions." >&2
    exit 1
  fi
  INSTALL_ROOT="$HOME/Applications"
fi
PRIMARY_APP="$INSTALL_ROOT/Transcriptor.app"
install_app_bundle "$PRIMARY_APP"

LEGACY_USER_APP="$HOME/Applications/Transcriptor.app"
if [ -d "$LEGACY_USER_APP" ] && [ "$LEGACY_USER_APP" != "$PRIMARY_APP" ]; then
  retire_duplicate_app_bundle "$LEGACY_USER_APP" "$PRIMARY_APP"
fi
