#!/bin/bash

set -e

cd "$(dirname "$0")"

echo "🔨 Сборка Transcriptor..."

rm -rf dist
npm --prefix ../frontend run build
npm run dist

APP_PATH="./dist/mac-arm64/Transcriptor.app"
if [ ! -d "$APP_PATH" ]; then
  APP_PATH="./dist/mac/Transcriptor.app"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "❌ .app не найден"
  exit 1
fi

# Stable local signing to keep macOS privacy permissions attached to one identity.
SIGN_IDENTITY="${TRANSCRIPTOR_SIGN_IDENTITY:-AntigravityTelegramDev}"
if security find-identity -v -p codesigning | grep -q "$SIGN_IDENTITY"; then
  echo "🔏 Подпись: $SIGN_IDENTITY"
  codesign --force --deep --sign "$SIGN_IDENTITY" --identifier local.transcriptor.app "$APP_PATH"
else
  echo "⚠️ Сертификат '$SIGN_IDENTITY' не найден. Подпись пропущена."
fi

rm -rf ~/Desktop/Transcriptor.app 2>/dev/null || true
cp -R "$APP_PATH" ~/Desktop/

echo "✅ Готово! Transcriptor на рабочем столе"
open ~/Desktop/Transcriptor.app
