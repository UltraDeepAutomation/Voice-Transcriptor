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

# ── 6. Start backend server ─────────────────────────────────────────────
print_step "Starting backend server..."

# Find a free port (default 8321)
BACKEND_PORT=8321
BACKEND_PID=""

# Kill any stale backend on the same port
lsof -ti tcp:$BACKEND_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

# Start backend in background
DATA_DIR="$HOME/Library/Application Support/Transcriptor"
mkdir -p "$DATA_DIR"

export PYTHONPATH="$ROOT_DIR:$PYTHONPATH"
export TRANSCRIPTOR_DATA_DIR="$DATA_DIR"

"$VENV_PY" -m uvicorn backend.main:app \
  --host 127.0.0.1 \
  --port $BACKEND_PORT \
  --log-level warning \
  &
BACKEND_PID=$!

# Cleanup: kill backend when this script exits
cleanup() {
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo -e "\n${CYAN}  Stopping backend (PID $BACKEND_PID)...${NC}"
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── 7. Wait for backend to be ready ─────────────────────────────────────
print_step "Waiting for backend health check..."
MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -s "http://127.0.0.1:$BACKEND_PORT/api/health" 2>/dev/null | grep -q '"ok"'; then
    print_ok "Backend is healthy (port $BACKEND_PORT)"
    break
  fi
  # Check if backend process died
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    print_fail "Backend process died during startup. Check Python logs above."
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  print_fail "Backend did not become healthy after ${MAX_WAIT}s. Check logs."
fi

# ── 8. Launch Electron ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}  ║   Dev mode ready — launching Electron    ║${NC}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Backend:${NC}  http://127.0.0.1:$BACKEND_PORT"
echo -e "  ${BOLD}Press Ctrl+C to stop everything${NC}"
echo ""

(cd desktop && npm start)
