#!/bin/bash
# ============================================================================
#  Transcriptor — Build & Install
#  Builds the Electron app and installs it to ~/Applications (or /Applications).
#  Usage: chmod +x BUILD.sh && ./BUILD.sh
# ============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

print_step()  { echo -e "\n${CYAN}${BOLD}▸ $1${NC}"; }
print_ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
print_warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
print_fail()  { echo -e "  ${RED}✖ $1${NC}"; exit 1; }

on_error() {
  local line=$1
  echo -e "\n${RED}${BOLD}  ✖ Build failed at line ${line}. See output above for details.${NC}"
  exit 1
}
trap 'on_error $LINENO' ERR
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

# Ensure Homebrew is in PATH (Apple Silicon vs Intel)
if [ -f /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -f /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Transcriptor — Build & Install     ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Pre-flight checks ────────────────────────────────────────────────
print_step "Pre-flight checks..."

command -v node &>/dev/null || print_fail "Node.js not found. Run setup.command first."
command -v npm  &>/dev/null || print_fail "npm not found. Run setup.command first."

NODE_VER=$(node --version 2>&1 | grep -oE '[0-9]+' | head -1)
if [ "$NODE_VER" -lt 18 ] 2>/dev/null; then
  print_fail "Node.js $(node --version) is too old. Need v18+. Run setup.command to upgrade."
fi
print_ok "Node.js $(node --version), npm $(npm --version)"

# ── 2. Clean stale builds ───────────────────────────────────────────────
print_step "Cleaning stale build artifacts..."
rm -rf \
  "$ROOT_DIR/desktop/dist/mac" \
  "$ROOT_DIR/desktop/dist/mac-arm64" \
  "$ROOT_DIR/desktop/dist"/*.dmg \
  "$ROOT_DIR/desktop/dist"/*.dmg.blockmap \
  "$ROOT_DIR/desktop/dist/builder-debug.yml" \
  "$ROOT_DIR/desktop/dist/builder-effective-config.yaml" \
  2>/dev/null || true
print_ok "Clean"

# ── 3. Frontend dependencies ────────────────────────────────────────────
print_step "Checking frontend dependencies..."
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  print_warn "Installing frontend npm dependencies..."
  (cd "$ROOT_DIR/frontend" && npm install --silent 2>&1 | tail -2)
  print_ok "Frontend deps installed"
else
  print_ok "Frontend deps present"
fi

# ── 4. Desktop dependencies ─────────────────────────────────────────────
print_step "Checking desktop dependencies..."
if [ ! -d "$ROOT_DIR/desktop/node_modules" ]; then
  print_warn "Installing desktop npm dependencies..."
  (cd "$ROOT_DIR/desktop" && npm install --silent 2>&1 | tail -2)
  print_ok "Desktop deps installed"
else
  print_ok "Desktop deps present"
fi

# ── 5. Build app ────────────────────────────────────────────────────────
# NOTE: we stream the full electron-builder output instead of piping
# through ``tail`` — a partial pipe hides the real error on failure
# (you see the stack trace footer without the preceding message that
# actually describes the cause). ``set -o pipefail`` is still active,
# so any non-zero exit from ``npm run dist`` aborts the script.
print_step "Building Electron app (this may take a minute)..."
(cd "$ROOT_DIR/desktop" && npm run dist)

# ── 6. Find built app ───────────────────────────────────────────────────
APP_PATH=""
for p in \
  "$ROOT_DIR/desktop/dist/mac-arm64/Transcriptor.app" \
  "$ROOT_DIR/desktop/dist/mac/Transcriptor.app" \
  "$ROOT_DIR/desktop/dist/Transcriptor.app"; do
  if [ -d "$p" ]; then
    APP_PATH="$p"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  print_fail "Could not find built app — check build output above"
fi

# Verify app bundle structure
if [ ! -f "$APP_PATH/Contents/Resources/backend/main.py" ]; then
  print_warn "App bundle may be incomplete — backend/main.py not found inside .app"
fi
if [ ! -f "$APP_PATH/Contents/Resources/frontend/index.html" ]; then
  print_warn "App bundle may be incomplete — frontend/index.html not found inside .app"
fi
print_ok "App built: $APP_PATH"

# ── 7. Install to Applications ──────────────────────────────────────────
INSTALL_ROOT="$HOME/Applications"
if [ -w "/Applications" ]; then
  INSTALL_ROOT="/Applications"
fi
mkdir -p "$INSTALL_ROOT"
TARGET_APP="$INSTALL_ROOT/Transcriptor.app"

if [ -d "$TARGET_APP" ]; then
  print_step "Removing old installation..."
  rm -rf "$TARGET_APP"
  print_ok "Old app removed"
fi

print_step "Installing to $INSTALL_ROOT..."
cp -R "$APP_PATH" "$INSTALL_ROOT/"
print_ok "Installed: $TARGET_APP"

# ── 8. Collect DMG installers into repo-level dist/ ─────────────────────
# electron-builder writes the .dmg files into ``desktop/dist/`` alongside
# the .app staging directories. We copy them up to ``<repo>/dist/`` with
# stable names so the user can share / install the DMG on any Mac by
# double-clicking and dragging Transcriptor.app into Applications.
print_step "Collecting DMG installers..."
REPO_DIST_DIR="$ROOT_DIR/dist"
mkdir -p "$REPO_DIST_DIR"
# Clear any prior DMG copies so the dist/ directory only reflects the
# latest successful build.
rm -f "$REPO_DIST_DIR"/Transcriptor-*.dmg 2>/dev/null || true

DMG_FILES=()
while IFS= read -r dmg; do
  [ -z "$dmg" ] && continue
  DMG_FILES+=("$dmg")
done < <(find "$ROOT_DIR/desktop/dist" -maxdepth 1 -type f -name "*.dmg" 2>/dev/null | sort)

if [ ${#DMG_FILES[@]} -eq 0 ]; then
  print_warn "No .dmg files produced — check electron-builder output above"
else
  for src_dmg in "${DMG_FILES[@]}"; do
    dst_dmg="$REPO_DIST_DIR/$(basename "$src_dmg")"
    cp -f "$src_dmg" "$dst_dmg"
    # Strip the quarantine xattr on the local copy so double-click
    # opens the DMG instantly on THIS machine. Shared DMGs will still
    # receive quarantine from whatever delivery mechanism (AirDrop,
    # email, download) and the recipient will need to confirm once.
    xattr -rd com.apple.quarantine "$dst_dmg" 2>/dev/null || true
    print_ok "$(basename "$dst_dmg") ($(du -h "$dst_dmg" | cut -f1))"
  done
fi

# ── 9. Cleanup ──────────────────────────────────────────────────────────
print_step "Cleaning intermediate build artifacts..."
rm -rf \
  "$ROOT_DIR/desktop/dist/mac" \
  "$ROOT_DIR/desktop/dist/mac-arm64" \
  "$ROOT_DIR/desktop/dist"/*.dmg.blockmap \
  "$ROOT_DIR/desktop/dist/builder-debug.yml" \
  "$ROOT_DIR/desktop/dist/builder-effective-config.yaml" \
  2>/dev/null || true
# Remove the staged DMGs from desktop/dist/ — the canonical copies now
# live in <repo>/dist/ and duplicating them would be confusing.
rm -f "$ROOT_DIR/desktop/dist"/*.dmg 2>/dev/null || true
xattr -rd com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
print_ok "Intermediate artifacts cleaned, quarantine removed"

# ── Done! ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}  ║     ✔ Build complete!                    ║${NC}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Installed locally:${NC} $TARGET_APP"
echo -e "  ${BOLD}Open from:${NC} Dock · Spotlight · Launchpad"
if [ ${#DMG_FILES[@]} -gt 0 ]; then
  echo ""
  echo -e "  ${BOLD}DMG installers (drag-and-drop to Applications):${NC}"
  for src_dmg in "${DMG_FILES[@]}"; do
    echo -e "    ${CYAN}$REPO_DIST_DIR/$(basename "$src_dmg")${NC}"
  done
  echo ""
  echo -e "  ${YELLOW}Note:${NC} these DMGs are unsigned. On another Mac the first"
  echo -e "  open may require: right-click → Open → Open (to confirm)."
fi
echo ""
