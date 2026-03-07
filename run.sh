#!/bin/bash
# ============================================================================
#  Transcriptor — Quick Launch
#  Launches the installed app, or runs in dev mode if not built yet.
# ============================================================================
cd "$(dirname "$0")"

# Try installed app first
for app in \
  "$HOME/Applications/Transcriptor.app" \
  "/Applications/Transcriptor.app"; do
  if [ -d "$app" ]; then
    echo "Launching $app ..."
    open "$app"
    exit 0
  fi
done

# Fallback: run in dev mode via Electron
echo "No installed app found — running in dev mode..."
if [ ! -d "desktop/node_modules" ]; then
  echo "Installing desktop dependencies..."
  (cd desktop && npm install)
fi
if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd frontend && npm install)
fi
if [ ! -d "frontend/dist" ]; then
  echo "Building frontend..."
  (cd frontend && npm run build)
fi
(cd desktop && npm start)
