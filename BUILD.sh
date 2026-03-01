#!/bin/bash

set -e

cd "$(dirname "$0")"

echo "=== Building Transcriptor App ==="

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

echo "=== Done! ==="
echo "Installed app: $TARGET_APP"
echo "You can now open Transcriptor from Dock/Applications"
