#!/usr/bin/env bash
# ============================================================================
#  Transcriptor — Quick Launch (Linux)
#  Launches the installed AppImage if present, otherwise falls through
#  to dev mode (Electron spawns its own backend).
# ============================================================================
set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

print_step()  { printf "\n${CYAN}${BOLD}▸ %s${NC}\n" "$1"; }
print_ok()    { printf "  ${GREEN}✔ %s${NC}\n" "$1"; }
print_warn()  { printf "  ${YELLOW}⚠ %s${NC}\n" "$1"; }
print_fail()  { printf "  ${RED}✖ %s${NC}\n" "$1"; exit 1; }

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

# ── 1. Launch installed AppImage if present ──────────────────────────────
for app in \
  "$HOME/.local/bin/Transcriptor.AppImage" \
  "$HOME/Applications/Transcriptor.AppImage" \
  "/opt/Transcriptor/Transcriptor.AppImage"; do
  if [ -x "$app" ]; then
    printf "${GREEN}${BOLD}  Launching %s ...${NC}\n" "$app"
    setsid nohup "$app" </dev/null >/dev/null 2>&1 &
    exit 0
  fi
done

# ── 2. Dev-mode fallback: run Electron from source ───────────────────────
#
# Same contract as mac/run.command:0c0dac7 — do NOT spawn our own
# uvicorn. Electron's startBackend in desktop/main.js picks a free
# port via pickBackendPort, spawns Python with stdin-piped stdio,
# and the parent-death watchdog in backend/main.py ensures the
# Python child dies with Electron for ANY exit reason (SIGKILL,
# compositor crash, laptop sleep forced kill, etc.).
printf "${YELLOW}${BOLD}  No installed AppImage found — running in dev mode...${NC}\n"

print_step "Checking prerequisites..."
command -v python3 &>/dev/null || print_fail "Python 3 not found. Run setup.sh first."
command -v node    &>/dev/null || print_fail "Node.js not found. Run setup.sh first."
command -v npm     &>/dev/null || print_fail "npm not found. Run setup.sh first."
print_ok "python3, node, npm found"

# Python venv
print_step "Checking Python environment..."
DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/transcriptor"
APP_VENV="$DATA_DIR/.venv"
VENV_PY="$APP_VENV/bin/python3"

if [ ! -x "$VENV_PY" ]; then
  print_warn "No venv — creating at $APP_VENV"
  mkdir -p "$DATA_DIR"
  python3 -m venv "$APP_VENV"
  "$APP_VENV/bin/pip" install --upgrade pip --quiet
  "$APP_VENV/bin/pip" install -r "$ROOT_DIR/requirements.txt" --quiet
fi

if "$VENV_PY" -c "import fastapi, uvicorn" 2>/dev/null; then
  print_ok "Python venv OK"
else
  print_warn "Venv missing packages — installing..."
  "$APP_VENV/bin/pip" install -r "$ROOT_DIR/requirements.txt" --quiet
fi

# Frontend build if needed
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  print_step "Installing frontend deps..."
  (cd "$ROOT_DIR/frontend" && npm install --silent 2>&1 | tail -2)
fi
if [ ! -d "$ROOT_DIR/frontend/dist" ]; then
  print_step "Building frontend..."
  (cd "$ROOT_DIR/frontend" && npm run build 2>&1 | tail -3)
fi

# Desktop deps
if [ ! -d "$ROOT_DIR/desktop/node_modules" ]; then
  print_step "Installing desktop deps..."
  (cd "$ROOT_DIR/desktop" && npm install --silent 2>&1 | tail -2)
fi

# ── 3. Launch Electron with venv python in env ───────────────────────────
export PYTHON="$VENV_PY"
export TRANSCRIPTOR_DATA_DIR="$DATA_DIR"

echo
printf "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗${NC}\n"
printf "${GREEN}${BOLD}  ║   Dev mode — launching Electron          ║${NC}\n"
printf "${GREEN}${BOLD}  ╚══════════════════════════════════════════╝${NC}\n"
echo  "  Python venv: $VENV_PY"
echo  "  Data dir:    $DATA_DIR"
echo  "  Press Ctrl+C to stop."
echo

(cd "$ROOT_DIR/desktop" && npm start)
