#!/bin/bash
# ============================================================================
#  Transcriptor — Quick Launch
#  Launches the installed app, or runs in dev mode if not built yet.
#  Double-click this file, or run: chmod +x run.command && ./run.command
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
  echo -e "\n${RED}${BOLD}  ✖ Launch failed at line ${line}. See output above for details.${NC}"
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

# ── Try installed app first ──────────────────────────────────────────────
for app in \
  "$HOME/Applications/Transcriptor.app" \
  "/Applications/Transcriptor.app"; do
  if [ -d "$app" ]; then
    echo -e "${GREEN}${BOLD}  Launching $app ...${NC}"
    open "$app"
    exit 0
  fi
done

# ── Dev mode: run from source ────────────────────────────────────────────
echo -e "${YELLOW}${BOLD}  No installed app found — running in dev mode...${NC}\n"

# ── 1. Verify prerequisites ─────────────────────────────────────────────
print_step "Checking prerequisites..."

command -v python3 &>/dev/null || print_fail "Python 3 not found. Run setup.command first."
command -v node    &>/dev/null || print_fail "Node.js not found. Run setup.command first."
command -v npm     &>/dev/null || print_fail "npm not found. Run setup.command first."
print_ok "python3, node, npm found"

# ── 2. Python venv ───────────────────────────────────────────────────────
print_step "Checking Python environment..."
APP_VENV="$HOME/Library/Application Support/Transcriptor/.venv"
VENV_PY="$APP_VENV/bin/python3"
VENV_PIP="$APP_VENV/bin/pip"

if [ ! -f "$VENV_PY" ]; then
  print_warn "No venv found — creating at: $APP_VENV"
  mkdir -p "$(dirname "$APP_VENV")"
  python3 -m venv "$APP_VENV"
  "$VENV_PIP" install --upgrade pip --quiet 2>&1 | tail -1
  "$VENV_PIP" install -r "$ROOT_DIR/requirements.txt" --quiet
  print_ok "Venv created and packages installed"
else
  # Verify existing venv works and has critical packages
  if "$VENV_PY" -c "import fastapi, uvicorn" 2>/dev/null; then
    print_ok "Python venv OK"
  else
    print_warn "Venv packages missing — installing..."
    "$VENV_PIP" install -r "$ROOT_DIR/requirements.txt" --quiet
    print_ok "Packages installed"
  fi
fi

# ── 3. Frontend dependencies ────────────────────────────────────────────
print_step "Checking frontend..."
if [ ! -d "frontend/node_modules" ]; then
  print_warn "Installing frontend dependencies..."
  (cd frontend && npm install --silent 2>&1 | tail -2)
  print_ok "Frontend deps installed"
else
  print_ok "Frontend deps present"
fi

# ── 4. Build frontend if needed ─────────────────────────────────────────
if [ ! -d "frontend/dist" ]; then
  print_step "Building frontend..."
  (cd frontend && npm run build 2>&1 | tail -5)
  print_ok "Frontend built"
fi

# ── 5. Desktop (Electron) dependencies ──────────────────────────────────
print_step "Checking desktop dependencies..."
if [ ! -d "desktop/node_modules" ]; then
  print_warn "Installing desktop dependencies..."
  (cd desktop && npm install --silent 2>&1 | tail -2)
  print_ok "Desktop deps installed"
else
  print_ok "Desktop deps present"
fi

# ── 6. Export env for Electron to spawn the backend ─────────────────────
#
# We deliberately do NOT start a uvicorn process here. Electron's main
# process already knows how to spawn the backend (see desktop/main.js
# ``startBackend``): it picks a free port via ``pickBackendPort``,
# installs a stdin-pipe watchdog so the Python child dies when Electron
# dies (SIGKILL-safe via ``_start_parent_death_watchdog`` in backend/
# main.py), and plumbs stdout/stderr through ``appendMainLog``.
#
# The prior behaviour of ``run.command`` — spawn our OWN backend on
# 8321, then ``npm start`` Electron which ALSO spawns its own backend
# via ``startBackend`` — produced TWO Python processes per dev launch:
# ours on 8321 and Electron's auto-picked fallback on 8322 (because
# ``pickBackendPort`` found 8321 already bound and iterated). The
# frontend talked to Electron's 8322 instance while ours on 8321 sat
# orphan until this script's trap cleanup ran. Plus ``lsof -ti tcp:8321
# | xargs kill -9`` risked killing an unrelated process that happened
# to be bound to 8321.
#
# Correct contract: Electron owns backend lifecycle. We only export
# the venv python path so ``resolvePython`` in desktop/main.js picks
# it up on the first probe, and the data dir.
print_step "Preparing dev launch..."

DATA_DIR="$HOME/Library/Application Support/Transcriptor"
mkdir -p "$DATA_DIR"

export PYTHON="$VENV_PY"
export TRANSCRIPTOR_DATA_DIR="$DATA_DIR"

# ── 7. Launch Electron ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}  ║   Dev mode ready — launching Electron    ║${NC}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Python venv:${NC}  $VENV_PY"
echo -e "  ${BOLD}Data dir:${NC}     $DATA_DIR"
echo -e "  ${BOLD}Press Ctrl+C to stop everything${NC}"
echo ""

# Electron's ``before-quit`` + parent-death watchdog handle backend
# shutdown cleanly regardless of how this script exits — no explicit
# trap needed.
(cd desktop && npm start)
