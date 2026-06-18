# Voice Transcriptor — Project Structure

> Голосовой транскриптор с живой записью, AI-улучшением текста и auto-paste для macOS, Windows и Linux.
> **Stack:** Python (FastAPI + Whisper) · TypeScript/Vite (Frontend) · Electron (Desktop Shell)

---

## 📁 Корневая директория

```
Voice Transcriptor/
├── .env.example          # Шаблон переменных окружения (DATA_DIR, API_TOKEN, PYTHON)
├── .gitignore            # Git-исключения (node_modules, __pycache__, dist, .env)
├── BUILD.command         # macOS source build entrypoint
├── INSTALL.command       # macOS/Linux source build entrypoint
├── README.md             # Краткая документация: установка и первые шаги
├── requirements.txt      # Python-зависимости (FastAPI, Whisper, NumPy, SoundFile)
│
├── backend/              # 🐍 Python Backend — FastAPI сервер + AI пайплайн
├── frontend/             # ⚛️  TypeScript Frontend — Vite SPA
└── desktop/              # 🖥️  Electron Shell — desktop wrapper + release build config
```

---

## 🐍 Backend (`backend/`)

FastAPI сервер для транскрипции аудио. Поддерживает локальные и удалённые провайдеры.

```
backend/
├── __init__.py               # Пакетный инициализатор
├── main.py                   # ⭐ Главный сервер (5086 строк)
│                             #    — FastAPI app, REST API эндпоинты
│                             #    — WebSocket для live-транскрипции
│                             #    — Загрузка файлов, управление jobs
│                             #    — Rate limiting, auth (API token)
│                             #    — Upscale-пресеты (clean, business, ai_code)
│                             #    — Управление записями (CRUD, статистика)
│                             #    — Автоочистка устаревших файлов
│
├── config.py                 # Конфигурация приложения (778 строк)
│                             #    — Data directory (~/Library/Application Support/Transcriptor)
│                             #    — JSON config с миграцией legacy-данных
│                             #    — Fernet-шифрование API-ключей (AES-128-CBC)
│                             #    — Deep merge конфигов, редакция секретов
│
├── audio.py                  # Аудио-утилиты (553 строки)
│                             #    — WAV нормализация (16kHz PCM_16 mono)
│                             #    — FFmpeg конвертация с fast-path оптимизацией
│                             #    — Стерео → моно split по каналам
│
├── transcribe.py             # Локальная транскрипция Whisper (380 строк)
│                             #    — Thread-safe кэш моделей (tiny → large-v3)
│                             #    — Транскрипция из array и из файла
│                             #    — Merge стерео-каналов (Speaker A/B)
│                             #    — Обработка пустых аудио (empty sequence)
│
├── live.py                   # Live-сессии реального времени (268 строк)
│                             #    — Ring-buffer с rolling window (12s окно)
│                             #    — Async lock для потокобезопасности
│                             #    — Инкрементальная эмиссия новых сегментов
│
├── remote_openrouter.py      # OpenRouter провайдер (190 строк)
│                             #    — Мультимодальная транскрипция (аудио → текст)
│                             #    — Upscale/улучшение текста через chat completions
│                             #    — Модели: Gemini 2.5 Flash, GPT-4o Audio
│
├── remote_deepgram.py        # Deepgram Nova-3 провайдер (268 строк)
│                             #    — Ультра-быстрая транскрипция (~300ms)
│                             #    — Pre-recorded REST API
│                             #    — Auto-detect языка, smart formatting
│
├── http_retry.py             # HTTP retry-механизм (191 строк)
│                             #    — Exponential backoff (3 попытки)
│                             #    — Общий для OpenRouter и Deepgram
│
├── jobs.py                   # Job Store — очередь задач (166 строк)
                              #    — ThreadPoolExecutor (max 2 воркера)
                              #    — Состояния: queued → running → done/error
│                             #    — Auto-prune при превышении лимита (300 jobs)
├── remote_deepgram_live.py   # Deepgram live WebSocket provider (1057 строк)
└── storage.py                # Atomic write / backup helpers (148 строк)
```

---

## ⚛️ Frontend (`frontend/`)

Vite SPA — единый файл `main.tsx`, рендерит UI для записи, транскрипции и настроек.

```
frontend/
├── index.html                # HTML entry point
├── package.json              # NPM конфиг (vite, typescript)
├── package-lock.json         # Lock-файл зависимостей
├── tsconfig.json             # TypeScript конфигурация
├── vite.config.ts            # Vite конфигурация (dev server, build)
│
└── src/
    ├── main.tsx              # ⭐ Главный UI-файл (11204 строки)
    │                         #    — Типы: Provider, JobStatus, AppConfig, RecordingItem
    │                         #    — Запись аудио (MediaRecorder + PCM Worklet)
    │                         #    — WebSocket live-транскрипция
    │                         #    — Загрузка файлов для транскрипции
    │                         #    — Polling статуса jobs
    │                         #    — Настройки: API-ключи, модели, язык
    │                         #    — Auto-stop по тишине
    │                         #    — Upscale пресеты (clean, business, ai_code)
    │                         #    — Управление записями (список, удаление, статистика)
    │                         #    — Dark theme UI
    │
    ├── styles.css            # Стили приложения
    │
    └── pcm-worklet.js        # AudioWorklet процессор
                              #    — Конвертация Float32 → PCM16LE
                              #    — VU-метр (RMS уровень)
                              #    — Downsampling (48kHz → 16kHz)
```

---

## 🖥️ Desktop (`desktop/`)

Electron-обёртка для macOS с глобальным overlay, горячими клавишами и auto-paste.

```
desktop/
├── main.js                   # ⭐ Electron main process (7335 строк)
│                             #    — BrowserWindow + overlay (always-on-top pill)
│                             #    — Глобальные горячие клавиши (platform defaults)
│                             #    — Tray-иконка с контекстным меню
│                             #    — Backend lifecycle (spawn Python, health-check)
│                             #    — Auto-paste в активное окно (AppleScript)
│                             #    — Overlay UI: таймер, VU-метр, статус
│                             #    — Quick Settings popup (модель, язык, upscale)
│                             #    — Single-instance lock
│                             #    — Настройки пресетов из overlay
│
├── package.json              # NPM конфиг (electron 30.5.1, electron-builder)
├── package-lock.json         # Lock-файл зависимостей
├── preload.js                # Minimal preload bridge
├── afterPack.js              # electron-builder afterPack hook
├── unlockDist.js             # dist cleanup helper
├── scripts/
│   └── prepare-runtime.sh    # Bundled Python/ffmpeg runtime builder
├── icon.png                  # Иконка приложения
├── README.md                 # Документация desktop-модуля
├── entitlements.mac.plist    # macOS entitlements (microphone, accessibility)
└── entitlements.mac.inherit.plist  # Inherited entitlements для code signing
```

---

## 🔑 Ключевые файлы

| Файл | Строки | Роль |
|---|---|---|
| `backend/main.py` | 5 086 | FastAPI сервер, REST/WS API, jobs, записи |
| `frontend/src/main.tsx` | 11 204 | Весь UI: запись, транскрипция, настройки |
| `desktop/main.js` | 7 335 | Electron shell, overlay, auto-paste |
| `frontend/src/styles.css` | 3 579 | UI styles |
| `backend/remote_deepgram_live.py` | 1 057 | Deepgram live WebSocket |
| `backend/config.py` | 778 | Конфигурация + шифрование ключей |
| `backend/audio.py` | 553 | Аудио конвертация (FFmpeg/SoundFile) |
| `backend/transcribe.py` | 380 | Локальный Whisper (faster-whisper) |
| `backend/live.py` | 268 | Live-транскрипция (ring buffer) |
| `backend/remote_deepgram.py` | 268 | Deepgram Nova-3 API |
| `backend/remote_openrouter.py` | 190 | OpenRouter API (Gemini, GPT-4o) |
| `backend/http_retry.py` | 191 | HTTP retry с backoff |
| `backend/jobs.py` | 166 | Job queue |

---

## 🛠️ Технологический стек

| Слой | Технологии |
|---|---|
| **Backend** | Python 3, FastAPI, Uvicorn, faster-whisper, NumPy, SoundFile, FFmpeg |
| **Frontend** | TypeScript, Vite, Vanilla CSS, AudioWorklet API, WebSocket |
| **Desktop** | Electron 30.5, electron-builder, AppleScript/PowerShell/xdotool/wtype auto-paste |
| **AI Providers** | Local Whisper (tiny–large-v3), OpenRouter (Gemini/GPT-4o), Deepgram Nova-3 |
| **Security** | Fernet encryption (API keys), API token auth, rate limiting |

---

## 📊 Статистика проекта

- **Всего основных code/config файлов:** 38 (без `node_modules`, `.git`, `dist`, `runtime`, `__pycache__`)
- **Backend:** 23 Python/test files (~9 500+ строк)
- **Frontend:** 7 TS/HTML/CSS/config files (~15 500+ строк)
- **Desktop:** 8 JS/JSON/shell files (~7 600+ строк)
- **Суммарный код основных файлов:** ~32 000+ строк
