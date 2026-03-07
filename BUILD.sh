#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

echo "=== Building Transcriptor App ==="

# Clean stale build artifacts to prevent duplicate Spotlight entries
rm -rf desktop/dist/mac desktop/dist/mac-arm64 2>/dev/null || true

cd desktop

# Install frontend dependencies if needed
if [ ! -d "../frontend/node_modules" ]; then
    echo "Installing frontend npm dependencies..."
    (cd ../frontend && npm install)
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
fi

# Build the app
echo "Building app..."
npm run dist

# Find the built app
APP_PATH=""
if [ -d "dist/mac-arm64/Transcriptor.app" ]; then
    APP_PATH="dist/mac-arm64/Transcriptor.app"
elif [ -d "dist/mac/Transcriptor.app" ]; then
    APP_PATH="dist/mac/Transcriptor.app"
elif [ -d "dist/Transcriptor.app" ]; then
    APP_PATH="dist/Transcriptor.app"
fi

if [ -z "$APP_PATH" ]; then
    echo "ERROR: Could not find built app"
    exit 1
fi

echo "Built app: $APP_PATH"

INSTALL_ROOT="$HOME/Applications"
if [ -w "/Applications" ]; then
    INSTALL_ROOT="/Applications"
fi

mkdir -p "$INSTALL_ROOT"
TARGET_APP="$INSTALL_ROOT/Transcriptor.app"

if [ -d "$TARGET_APP" ]; then
    echo "Removing old app from $INSTALL_ROOT..."
    rm -rf "$TARGET_APP"
fi

echo "Installing to $INSTALL_ROOT..."
cp -R "$APP_PATH" "$INSTALL_ROOT/"

# Clean build artifacts to prevent duplicate Spotlight entries
echo "Cleaning build artifacts..."
rm -rf dist/mac dist/mac-arm64 2>/dev/null

# Remove quarantine for unsigned apps
xattr -rd com.apple.quarantine "$TARGET_APP" 2>/dev/null || true

echo "=== Done! ==="
echo "Installed app: $TARGET_APP"
echo "You can now open Transcriptor from Dock/Applications"
