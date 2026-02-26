#!/bin/bash

# Очистить кэш Electron
rm -rf ~/Library/Application\ Support/transcriptor 2>/dev/null
rm -rf ~/Library/Caches/transcriptor 2>/dev/null

# Запустить приложение
npm start
