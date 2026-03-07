#!/bin/bash
# ============================================================================
#  Transcriptor — One-command Setup for macOS
#  Double-click this file, or run: chmod +x setup.command && ./setup.command
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

# Enterprise error handler — shows the exact line that failed.
on_error() {
  local line=$1
  echo -e "\n${RED}${BOLD}  ✖ Setup failed at line ${line}. See output above for details.${NC}"
  echo -e "  ${YELLOW}If the issue persists, please send this log to the developer.${NC}\n"
  exit 1
}
trap 'on_error $LINENO' ERR
set -euo pipefail

# ── Resolve this script's directory (works when double-clicked in Finder) ──
cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     Transcriptor — macOS Setup       ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
echo "  Working directory: $ROOT_DIR"

# ── 1. Xcode command line tools ──────────────────────────────────────────
print_step "Checking Xcode CLI tools..."
if xcode-select -p &>/dev/null; then
  print_ok "Xcode CLI tools present"
else
  print_warn "Installing Xcode CLI tools (may prompt for password)..."
  xcode-select --install 2>/dev/null || true
  echo "  Waiting for Xcode CLI tools installation to complete..."
  until xcode-select -p &>/dev/null; do sleep 5; done
  print_ok "Xcode CLI tools installed"
fi

# ── 2. Homebrew ──────────────────────────────────────────────────────────
print_step "Checking Homebrew..."
if command -v brew &>/dev/null; then
  print_ok "Homebrew is installed"
else
  print_warn "Homebrew not found — installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  print_ok "Homebrew installed"
fi

# Ensure Homebrew is in PATH for this session (Apple Silicon vs Intel)
if [ -f /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -f /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# ── 3. Python 3.9+ ──────────────────────────────────────────────────────
print_step "Checking Python 3..."
PYTHON=""
for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if command -v "$candidate" &>/dev/null; then
    PY_VER=$("$candidate" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if [ "$PY_MAJOR" -ge 3 ] && [ "$PY_MINOR" -ge 9 ] 2>/dev/null; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [ -n "$PYTHON" ]; then
  print_ok "Python 3 found: $PYTHON ($($PYTHON --version 2>&1))"
else
  print_warn "Python 3.9+ not found — installing via Homebrew..."
  brew install python@3.12
  PYTHON="$(brew --prefix python@3.12)/bin/python3"
  if [ ! -f "$PYTHON" ]; then
    PYTHON="python3"
  fi
  print_ok "Python installed: $($PYTHON --version 2>&1)"
fi

# ── 4. Node.js 18+ ──────────────────────────────────────────────────────
print_step "Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>&1 | grep -oE '[0-9]+' | head -1)
  if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    print_ok "Node.js found: $(node --version)"
  else
    print_warn "Node.js too old ($(node --version)) — installing LTS via Homebrew..."
    brew install node@20
    export PATH="$(brew --prefix node@20)/bin:$PATH"
    print_ok "Node.js installed: $(node --version)"
  fi
else
  print_warn "Node.js not found — installing via Homebrew..."
  brew install node@20
  export PATH="$(brew --prefix node@20)/bin:$PATH"
  print_ok "Node.js installed: $(node --version)"
fi

# ── 5. ffmpeg ────────────────────────────────────────────────────────────
print_step "Checking ffmpeg..."
if command -v ffmpeg &>/dev/null; then
  print_ok "ffmpeg is installed"
else
  print_warn "ffmpeg not found — installing via Homebrew..."
  brew install ffmpeg
  print_ok "ffmpeg installed"
fi

# ── 6. Python dependencies ───────────────────────────────────────────────
print_step "Installing Python dependencies..."
# Try --user first; fall back to --break-system-packages for macOS 14+ managed Python.
if ! $PYTHON -m pip install --user -r "$ROOT_DIR/requirements.txt" --quiet 2>&1; then
  print_warn "Retrying with --break-system-packages (macOS 14+ managed Python)..."
  $PYTHON -m pip install --user --break-system-packages -r "$ROOT_DIR/requirements.txt" --quiet 2>&1 || true
fi
# Verify critical imports
$PYTHON -c "import fastapi, uvicorn, cryptography" 2>/dev/null \
  && print_ok "Python packages installed and verified" \
  || print_warn "Some packages may need manual install — app will attempt auto-install on launch"

# ── 7. Frontend npm dependencies ─────────────────────────────────────────
print_step "Installing frontend dependencies..."
(cd "$ROOT_DIR/frontend" && npm install --silent 2>&1 | tail -2)
print_ok "Frontend packages installed"

# ── 8. Desktop (Electron) npm dependencies ───────────────────────────────
print_step "Installing desktop (Electron) dependencies..."
(cd "$ROOT_DIR/desktop" && npm install --silent 2>&1 | tail -2)
print_ok "Desktop packages installed"

# ── 9. Build frontend ───────────────────────────────────────────────────
print_step "Building frontend..."
(cd "$ROOT_DIR/frontend" && npm run build 2>&1 | tail -5)
print_ok "Frontend built"

# ── 10. Build Electron app ──────────────────────────────────────────────
print_step "Building Electron app..."
# Clean stale build artifacts first
rm -rf "$ROOT_DIR/desktop/dist/mac" "$ROOT_DIR/desktop/dist/mac-arm64" 2>/dev/null || true
(cd "$ROOT_DIR/desktop" && npm run dist 2>&1 | tail -10)

# Find the built app
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
print_ok "App built: $APP_PATH"

# ── 11. Install to Applications ──────────────────────────────────────────
print_step "Installing to Applications..."
INSTALL_DIR="$HOME/Applications"
if [ -w "/Applications" ]; then
  INSTALL_DIR="/Applications"
fi
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/Transcriptor.app"

if [ -d "$TARGET" ]; then
  echo "  Removing old installation..."
  rm -rf "$TARGET"
fi
cp -R "$APP_PATH" "$INSTALL_DIR/"
print_ok "Installed to: $TARGET"

# ── 12. Cleanup build artifacts (prevent duplicate Spotlight entries) ────
print_step "Cleaning build artifacts..."
rm -rf "$ROOT_DIR/desktop/dist/mac" "$ROOT_DIR/desktop/dist/mac-arm64" 2>/dev/null || true
print_ok "Build artifacts cleaned"

# ── 13. macOS permissions ────────────────────────────────────────────────
print_step "Setting macOS permissions..."
xattr -rd com.apple.quarantine "$TARGET" 2>/dev/null || true
print_ok "Quarantine attribute removed"
echo -e "  ${YELLOW}Note: On first launch macOS will ask for Microphone access.${NC}"
echo -e "  ${YELLOW}      If prompted about 'unidentified developer', go to${NC}"
echo -e "  ${YELLOW}      System Settings → Privacy & Security → Open Anyway.${NC}"

# ── 14. Create data directory ────────────────────────────────────────────
print_step "Preparing user data directory..."
DATA_DIR="$HOME/Library/Application Support/Transcriptor"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/recordings"
print_ok "Data directory: $DATA_DIR"

# ── Done! ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}  ║     ✔ Setup complete!                    ║${NC}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Launching Transcriptor...${NC}"
open "$TARGET"
echo ""
echo -e "  ${BOLD}First steps:${NC}"
echo -e "    1. Open Settings tab"
echo -e "    2. Enter your API keys (OpenRouter / Deepgram)"
echo -e "    3. Start recording!"
echo ""
