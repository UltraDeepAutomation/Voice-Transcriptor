# Transcriptor

Голосовой транскриптор с поддержкой живой записи, удалённой транскрипции (OpenRouter, Deepgram) и локального Whisper.

## Установка (macOS)

### Один скрипт — всё установит:

```bash
chmod +x setup.sh && ./setup.sh
```

Скрипт автоматически:
- Установит Homebrew (если нет)
- Установит Python 3, Node.js, ffmpeg
- Установит все Python и Node зависимости
- Соберёт frontend и Electron приложение
- Установит `Transcriptor.app` в Applications
- Снимет карантин macOS

### Запуск

```bash
./run.sh
```

Или откройте **Transcriptor** из Applications / Dock.

## Настройка после установки

1. Откройте **Settings** в приложении
2. Введите свои API-ключи:
   - **OpenRouter** — для удалённой транскрипции и улучшения текста
   - **Deepgram** — альтернативный провайдер транскрипции
3. Ключи хранятся зашифрованными локально на вашем Mac

## Возможности

- 🎙 **Live транскрипция** — запись с микрофона в реальном времени
- 📝 **Upscale** — улучшение текста через AI с кастомными пресетами
- 🔒 **Шифрование** — API-ключи зашифрованы Fernet (AES-128)
- 💾 **Записи** — все транскрипции сохраняются локально
- 🌐 **Провайдеры** — Local Whisper, OpenRouter, Deepgram

## Системные требования

- macOS 11+ (Big Sur и выше)
- 4 GB RAM (8 GB для больших моделей Whisper)
- Микрофон

## Структура проекта

```
backend/     — Python FastAPI сервер
frontend/    — Vite + TypeScript UI
desktop/     — Electron приложение
data/        — Рабочая директория (не коммитится)
setup.sh     — Установка одной командой
run.sh       — Быстрый запуск
BUILD.sh     — Сборка Electron .app
```
