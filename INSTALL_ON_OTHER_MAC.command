#!/usr/bin/env bash
# ============================================================================
#  Transcriptor - installer for another Apple Silicon Mac
#
#  Put this file next to either:
#    - Transcriptor-1.1.25-arm64.dmg
#    - Transcriptor-1.1.25-arm64-internal.zip
#    - Transcriptor.app
#
#  Then run:
#    bash INSTALL_ON_OTHER_MAC.command
# ============================================================================
set -euo pipefail

PRODUCT_NAME="Transcriptor"
APP_NAME="Transcriptor.app"
DMG_NAME="Transcriptor-1.1.25-arm64.dmg"
ZIP_NAME="Transcriptor-1.1.25-arm64-internal.zip"
TARGET_ROOT="${TRANSCRIPTOR_INSTALL_DIR:-/Applications}"
TARGET_APP="${TARGET_ROOT}/${APP_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR=""
MOUNT_DIR=""
SOURCE_APP=""

log() {
  printf '[Transcriptor installer] %s\n' "$*"
}

die() {
  printf '[Transcriptor installer] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    chmod -R u+w "$TMP_DIR" 2>/dev/null || true
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

run_privileged() {
  if [ "${NEEDS_SUDO}" = "1" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

remove_path_privileged() {
  local target="$1"
  [ -e "$target" ] || return 0
  run_privileged chmod -R u+w "$target" 2>/dev/null || true
  run_privileged rm -rf "$target"
}

verify_app() {
  local app_path="$1"
  [ -d "$app_path" ] || die "App bundle not found: $app_path"
  if ! codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null 2>&1; then
    codesign --verify --deep --strict --verbose=2 "$app_path"
    die "Code signature verification failed: $app_path"
  fi
  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist" 2>/dev/null || true)"
  [ "$bundle_id" = "local.transcriptor.app" ] || die "Unexpected bundle id: ${bundle_id:-unknown}"
}

prepare_source_app() {
  if [ -d "${SCRIPT_DIR}/${APP_NAME}" ]; then
    SOURCE_APP="${SCRIPT_DIR}/${APP_NAME}"
    return
  fi

  TMP_DIR="$(mktemp -d)"

  if [ -f "${SCRIPT_DIR}/${DMG_NAME}" ]; then
    MOUNT_DIR="$(mktemp -d)"
    log "Mounting ${DMG_NAME}"
    hdiutil attach "${SCRIPT_DIR}/${DMG_NAME}" -readonly -nobrowse -mountpoint "$MOUNT_DIR" -quiet
    SOURCE_APP="${MOUNT_DIR}/${APP_NAME}"
    return
  fi

  if [ -f "${SCRIPT_DIR}/${ZIP_NAME}" ]; then
    log "Unpacking ${ZIP_NAME}"
    unzip -q "${SCRIPT_DIR}/${ZIP_NAME}" -d "$TMP_DIR"
    SOURCE_APP="${TMP_DIR}/${APP_NAME}"
    return
  fi

  die "Put ${DMG_NAME}, ${ZIP_NAME}, or ${APP_NAME} next to this installer."
}

quit_existing_app() {
  osascript -e "tell application \"${PRODUCT_NAME}\" to quit" >/dev/null 2>&1 || true
  local deadline=$((SECONDS + 12))
  while pgrep -x "$PRODUCT_NAME" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "Stopping still-running ${PRODUCT_NAME} process"
      pkill -x "$PRODUCT_NAME" >/dev/null 2>&1 || true
      sleep 1
      break
    fi
    sleep 1
  done
}

install_app() {
  local target_root="$1"
  local target_app="$2"
  local stamp
  local installing_app
  local backup_app
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  installing_app="${target_root}/.${APP_NAME}.installing.$$"
  backup_app="${target_app}.backup-${stamp}"

  run_privileged mkdir -p "$target_root"
  remove_path_privileged "$installing_app"

  log "Copying ${APP_NAME} to ${target_root}"
  run_privileged ditto "$SOURCE_APP" "$installing_app"
  run_privileged xattr -dr com.apple.quarantine "$installing_app" 2>/dev/null || true

  verify_app "$installing_app"

  if [ -e "$target_app" ]; then
    log "Replacing existing ${target_app}"
    remove_path_privileged "$backup_app"
    run_privileged mv "$target_app" "$backup_app"
  fi

  if ! run_privileged mv "$installing_app" "$target_app"; then
    if [ -e "$backup_app" ] && [ ! -e "$target_app" ]; then
      run_privileged mv "$backup_app" "$target_app"
    fi
    remove_path_privileged "$installing_app"
    die "Failed to move app into ${target_app}"
  fi

  run_privileged xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
  verify_app "$target_app"

  if [ -e "$backup_app" ]; then
    remove_path_privileged "$backup_app"
  fi
}

main() {
  [ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS."
  [ "$(uname -m)" = "arm64" ] || die "This build is for Apple Silicon Macs only."
  require_cmd hdiutil
  require_cmd unzip
  require_cmd ditto
  require_cmd codesign
  require_cmd xattr
  require_cmd osascript
  require_cmd pgrep

  prepare_source_app
  verify_app "$SOURCE_APP"

  local target_parent
  target_parent="$(dirname "$TARGET_ROOT")"
  if { [ -d "$TARGET_ROOT" ] && [ -w "$TARGET_ROOT" ]; } || { [ ! -d "$TARGET_ROOT" ] && [ -w "$target_parent" ]; }; then
    NEEDS_SUDO=0
  else
    NEEDS_SUDO=1
    log "${TARGET_ROOT} needs administrator permission; sudo may ask for your password."
    sudo -v
  fi

  quit_existing_app
  install_app "$TARGET_ROOT" "$TARGET_APP"

  log "Installed: ${TARGET_APP}"
  if [ "${TRANSCRIPTOR_SKIP_OPEN:-0}" = "1" ]; then
    log "Open skipped because TRANSCRIPTOR_SKIP_OPEN=1"
  else
    log "Opening ${PRODUCT_NAME}"
    open "$TARGET_APP"
    log "If macOS asks, grant Microphone, Accessibility, and Automation permissions."
  fi
}

main "$@"
