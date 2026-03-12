# Voice Transcriptor — Project Structure

> Голосовой транскриптор с живой записью, AI-улучшением текста и auto-paste для macOS.
> **Stack:** Python (FastAPI + Whisper) · TypeScript/Vite (Frontend) · Electron (Desktop Shell)

---

## 📁 Корневая директория

```
Voice Transcriptor/
├── .env.example          # Шаблон переменных окружения (DATA_DIR, API_TOKEN, PYTHON)
├── .gitignore            # Git-исключения (node_modules, __pycache__, dist, .env)
├── BUILD.sh              # Скрипт сборки проекта
├── README.md             # Краткая документация: установка и первые шаги
├── requirements.txt      # Python-зависимости (FastAPI, Whisper, NumPy, SoundFile)
├── run.command           # macOS: быстрый запуск приложения (двойной клик)
├── setup.command         # macOS: полная установка (Python venv, npm, Electron)
│
├── backend/              # 🐍 Python Backend — FastAPI сервер + AI пайплайн
├── frontend/             # ⚛️  TypeScript Frontend — Vite SPA
└── desktop/              # 🖥️  Electron Shell — нативная macOS обёртка
```

---

## 🐍 Backend (`backend/`)

FastAPI сервер для транскрипции аудио. Поддерживает локальные и удалённые провайдеры.

```
backend/
├── __init__.py               # Пакетный инициализатор
├── main.py                   # ⭐ Главный сервер (1504 строки)
│                             #    — FastAPI app, REST API эндпоинты
│                             #    — WebSocket для live-транскрипции
│                             #    — Загрузка файлов, управление jobs
│                             #    — Rate limiting, auth (API token)
│                             #    — Upscale-пресеты (clean, business, ai_code)
│                             #    — Управление записями (CRUD, статистика)
│                             #    — Автоочистка устаревших файлов
│
├── config.py                 # Конфигурация приложения (269 строк)
│                             #    — Data directory (~/Library/Application Support/Transcriptor)
│                             #    — JSON config с миграцией legacy-данных
│                             #    — Fernet-шифрование API-ключей (AES-128-CBC)
│                             #    — Deep merge конфигов, редакция секретов
│
├── audio.py                  # Аудио-утилиты (119 строк)
│                             #    — WAV нормализация (16kHz PCM_16 mono)
│                             #    — FFmpeg конвертация с fast-path оптимизацией
│                             #    — Стерео → моно split по каналам
│
├── transcribe.py             # Локальная транскрипция Whisper (175 строк)
│                             #    — Thread-safe кэш моделей (tiny → large-v3)
│                             #    — Транскрипция из array и из файла
│                             #    — Merge стерео-каналов (Speaker A/B)
│                             #    — Обработка пустых аудио (empty sequence)
│
├── live.py                   # Live-сессии реального времени (156 строк)
│                             #    — Ring-buffer с rolling window (12s окно)
│                             #    — Async lock для потокобезопасности
│                             #    — Инкрементальная эмиссия новых сегментов
│
├── remote_openrouter.py      # OpenRouter провайдер (138 строк)
│                             #    — Мультимодальная транскрипция (аудио → текст)
│                             #    — Upscale/улучшение текста через chat completions
│                             #    — Модели: Gemini 2.5 Flash, GPT-4o Audio
│
├── remote_deepgram.py        # Deepgram Nova-3 провайдер (100 строк)
│                             #    — Ультра-быстрая транскрипция (~300ms)
│                             #    — Pre-recorded REST API
│                             #    — Auto-detect языка, smart formatting
│
├── http_retry.py             # HTTP retry-механизм (46 строк)
│                             #    — Exponential backoff (3 попытки)
│                             #    — Общий для OpenRouter и Deepgram
│
└── jobs.py                   # Job Store — очередь задач (74 строки)
                              #    — ThreadPoolExecutor (max 2 воркера)
                              #    — Состояния: queued → running → done/error
                              #    — Auto-prune при превышении лимита (300 jobs)
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
    ├── main.tsx              # ⭐ Главный UI-файл (2633 строки)
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
├── main.js                   # ⭐ Electron main process (3734 строки)
│                             #    — BrowserWindow + overlay (always-on-top pill)
│                             #    — Глобальные горячие клавиши (Option+Left для записи)
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
├── icon.png                  # Иконка приложения
├── README.md                 # Документация desktop-модуля
├── entitlements.mac.plist    # macOS entitlements (microphone, accessibility)
└── entitlements.mac.inherit.plist  # Inherited entitlements для code signing
```

---

## 🔑 Ключевые файлы

| Файл | Строки | Роль |
|---|---|---|
| `backend/main.py` | 1 504 | FastAPI сервер, REST/WS API, jobs, записи |
| `frontend/src/main.tsx` | 2 633 | Весь UI: запись, транскрипция, настройки |
| `desktop/main.js` | 3 734 | Electron shell, overlay, auto-paste |
| `backend/config.py` | 269 | Конфигурация + шифрование ключей |
| `backend/transcribe.py` | 175 | Локальный Whisper (faster-whisper) |
| `backend/live.py` | 156 | Live-транскрипция (ring buffer) |
| `backend/remote_openrouter.py` | 138 | OpenRouter API (Gemini, GPT-4o) |
| `backend/audio.py` | 119 | Аудио конвертация (FFmpeg/SoundFile) |
| `backend/remote_deepgram.py` | 100 | Deepgram Nova-3 API |
| `backend/jobs.py` | 74 | Job queue (ThreadPoolExecutor) |
| `backend/http_retry.py` | 46 | HTTP retry с backoff |

---

## 🛠️ Технологический стек

| Слой | Технологии |
|---|---|
| **Backend** | Python 3, FastAPI, Uvicorn, faster-whisper, NumPy, SoundFile, FFmpeg |
| **Frontend** | TypeScript, Vite, Vanilla CSS, AudioWorklet API, WebSocket |
| **Desktop** | Electron 30.5, electron-builder, AppleScript (auto-paste) |
| **AI Providers** | Local Whisper (tiny–large-v3), OpenRouter (Gemini/GPT-4o), Deepgram Nova-3 |
| **Security** | Fernet encryption (API keys), API token auth, rate limiting |

---

## 📊 Статистика проекта

- **Всего файлов:** 34 (без `node_modules`, `.git`, `__pycache__`)
- **Backend:** 10 файлов (~2 484 строки Python)
- **Frontend:** 5 файлов (~2 633+ строки TypeScript/CSS)
- **Desktop:** 7 файлов (~3 734+ строки JavaScript)
- **Суммарный код:** ~8 850+ строк
