# Transcriptor

**Голосовой транскриптор с живой записью, AI-улучшением текста и auto-paste для macOS.**

> Нажмите **Option+Left** из любого приложения — Transcriptor запишет речь, транскрибирует её и автоматически вставит текст в активное поле ввода.

---

## ✨ Возможности

- 🎤 **Live-транскрипция** — запись с микрофона в реальном времени с промежуточными результатами
- 🤖 **AI Upscale** — улучшение текста через OpenRouter (Gemini, GPT-4o) с пресетами: Clean, Business, AI & Code
- 📋 **Auto-paste** — автоматическая вставка результата в активное приложение (Cmd+V → Enter)
- ⌨️ **Глобальная горячая клавиша** — Option+Left для старта/стопа записи из любого приложения
- 🔇 **Auto-stop по тишине** — автоматическая остановка записи при паузе в речи
- 🌐 **3 провайдера** — локальный Whisper (offline), OpenRouter, Deepgram Nova-3
- 💊 **Overlay** — компактный pill-виджет поверх всех окон с таймером, VU-метром и быстрыми настройками
- 📁 **История записей** — все транскрипции сохраняются с поиском и статистикой

---

## 🚀 Быстрая установка (одна команда)

### Способ 1 — Двойной клик (самый простой)

1. **Правый клик** на файл `setup.command`
2. Нажмите **Открыть** (Open)
3. В диалоге безопасности нажмите **Открыть** ещё раз
4. ☕ Подождите 2–5 минут — всё установится автоматически

### Способ 2 — Терминал

```bash
cd "Voice Transcriptor"
chmod +x setup.command
./setup.command
```

> 💡 Скрипт автоматически установит все зависимости (Homebrew, Python, Node.js, FFmpeg), соберёт приложение и установит его в `~/Applications`.

---

## 📋 Что устанавливается автоматически

`setup.command` проверяет и при необходимости устанавливает:

| Компонент | Версия | Назначение |
|-----------|--------|------------|
| **Xcode CLI Tools** | Latest | Базовые инструменты сборки |
| **Homebrew** | Latest | Менеджер пакетов |
| **Python** | 3.9+ | Бэкенд (FastAPI, Whisper) |
| **Node.js** | 18+ | Фронтенд (Vite) + Electron |
| **FFmpeg** | Latest | Аудио-конвертация |
| **Python venv** | — | Изолированное окружение в `~/Library/Application Support/Transcriptor/.venv` |

---

## ⚙️ После установки — разрешения macOS

При первом запуске macOS запросит **3 разрешения** — нажмите **Allow** на каждое:

| Разрешение | Зачем |
|-----------|-------|
| 🎤 **Microphone** | Запись голоса |
| ♿ **Accessibility** | Auto-paste транскрипции в активное приложение |
| 🤖 **Automation** | Автоматическая отправка (Cmd+Enter) после вставки |

Если macOS говорит **«unidentified developer»**:
→ **System Settings** → **Privacy & Security** → **Open Anyway**

---

## 🔑 Настройка API-ключей

После запуска откройте вкладку **Settings** в основном окне:

1. **OpenRouter** — вставьте API-ключ с [openrouter.ai](https://openrouter.ai)
2. **Deepgram** — вставьте API-ключ с [deepgram.com](https://console.deepgram.com)
3. **Локальный Whisper** — работает без ключей (модель скачается автоматически)

> 🛡️ Все API-ключи хранятся локально и шифруются с помощью Fernet (AES-128-CBC).

---

## 🛠️ Режим разработки

Для запуска из исходников без сборки `.app`:

```bash
chmod +x run.command
./run.command
```

Или вручную:

```bash
# 1. Python venv
python3 -m venv "$HOME/Library/Application Support/Transcriptor/.venv"
source "$HOME/Library/Application Support/Transcriptor/.venv/bin/activate"
pip install -r requirements.txt

# 2. Frontend
cd frontend && npm install && npm run build && cd ..

# 3. Backend (в отдельном терминале)
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8321

# 4. Electron (в ещё одном терминале)
cd desktop && npm install && npm start
```

> 💡 `run.command` делает всё это автоматически в одну команду.

---

## 🔄 Пересборка приложения

Если вы изменили код и хотите обновить установленное приложение:

```bash
chmod +x BUILD.sh
./BUILD.sh
```

Скрипт соберёт фронтенд, упакует Electron-приложение и установит его в `~/Applications`.

---

## 📁 Переменные окружения

Скопируйте `.env.example` в `.env` для кастомизации:

```bash
cp .env.example .env
```

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `TRANSCRIPTOR_DATA_DIR` | Директория данных | `~/Library/Application Support/Transcriptor` |
| `TRANSCRIPTOR_API_TOKEN` | Токен API-авторизации | Auto-generated |
| `TRANSCRIPTOR_RESULT_RETENTION_SEC` | Время хранения результатов | `86400` (24ч) |
| `TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC` | Время хранения recovery-данных | `3600` (1ч) |
| `PYTHON` | Путь к Python | Auto-detect |

---

## 🏗️ Архитектура

```
┌────────────────────────────────────────────────────────────┐
│                    Electron Shell (desktop/)                │
│    Overlay pill · Global hotkeys · Tray · Auto-paste       │
│           BrowserWindow ← frontend/dist/                   │
├────────────────────────────────────────────────────────────┤
│                    Vite Frontend (frontend/)                │
│    Recording UI · Settings · WebSocket live · Job polling   │
├────────────────────────────────────────────────────────────┤
│                  FastAPI Backend (backend/)                 │
│    REST API · WebSocket · Whisper · OpenRouter · Deepgram   │
│    Audio processing · Jobs · Config · Rate limiting         │
└────────────────────────────────────────────────────────────┘
```

Подробнее: [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)

---

## 🔧 Troubleshooting

### Приложение не запускается

```bash
# Удалить quarantine-атрибут
xattr -cr ~/Applications/Transcriptor.app

# Или переустановить
./setup.command
```

### Бэкенд не стартует (порт занят)

```bash
# Освободить порт 8321
lsof -ti tcp:8321 | xargs kill -9
```

### Python venv сломан

```bash
# Пересоздать venv
rm -rf "$HOME/Library/Application Support/Transcriptor/.venv"
./setup.command
```

### Whisper скачивает модель при каждом запуске

Модели кэшируются в `~/.cache/huggingface/`. Убедитесь, что есть свободное место (~1–3 GB для large-v3).

### Нет звука / микрофон не работает

1. **System Settings** → **Privacy & Security** → **Microphone**
2. Убедитесь, что **Transcriptor** есть в списке и включен
3. Перезапустите приложение

### Auto-paste не работает

1. **System Settings** → **Privacy & Security** → **Accessibility**
2. Убедитесь, что **Transcriptor** включен
3. **System Settings** → **Privacy & Security** → **Automation** → включите для Transcriptor

---

## 📂 Файлы проекта

| Файл / Папка | Описание |
|-------------|----------|
| `setup.command` | 🚀 Полная установка одной командой |
| `run.command` | ▶️ Быстрый запуск (или dev-mode) |
| `BUILD.sh` | 🔄 Пересборка .app |
| `backend/` | 🐍 Python бэкенд (FastAPI + Whisper) |
| `frontend/` | ⚛️ TypeScript фронтенд (Vite) |
| `desktop/` | 🖥️ Electron обёртка |
| `.env.example` | 📋 Шаблон переменных окружения |
| `requirements.txt` | 📦 Python зависимости |
| `PROJECT_STRUCTURE.md` | 🗂️ Детальная структура проекта |
