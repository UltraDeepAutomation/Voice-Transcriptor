# Transcriptor

**Голосовой транскриптор с живой записью, AI-улучшением текста и auto-paste для macOS, Windows и Linux.**

> Нажмите глобальный hotkey из любого приложения — Transcriptor запишет речь, транскрибирует её и автоматически вставит текст в активное поле ввода.
>
> **Дефолтные комбинации:**
> - **macOS:** `Option+Left` старт/стоп записи, `Option+Shift+V` вставить последний транскрипт.
> - **Windows / Linux:** `F9` старт/стоп записи, `F10` вставить последний транскрипт.
>
> Обе клавиши настраиваются в Settings.

---

## ✨ Возможности

- 🎤 **Live-транскрипция** — запись с микрофона в реальном времени с промежуточными результатами
- 🤖 **AI Upscale** — улучшение текста через OpenRouter (Gemini, GPT-4o, Claude) с пресетами: Clean, Business, AI & Code
- 📋 **Auto-paste** — автоматическая вставка результата в активное приложение с платформенными шорткатами (`Cmd+V` / `Ctrl+V`, затем `Cmd+Enter` / `Ctrl+Enter`, если включён auto-send)
- ⌨️ **Глобальная горячая клавиша** — старт/стоп записи + повтор-paste. Дефолты: `Option+Left` / `Option+Shift+V` (macOS), `F9` / `F10` (Windows / Linux). Переназначаются в Settings
- 🔇 **Auto-stop по тишине** — автоматическая остановка записи при паузе в речи (настраивается прямо в overlay-капсуле во время записи: +/- кнопки с click-and-hold)
- 🌐 **3 провайдера** — локальный Whisper (offline, работает без интернета), OpenRouter, Deepgram Nova-3
- 💊 **Overlay** — компактный pill-виджет поверх всех окон с таймером, VU-метром и быстрыми настройками
- 📁 **История записей** — все транскрипции сохраняются с поиском и статистикой
- 🔐 **Zero telemetry** — приложение не отправляет никаких данных на сервера. Логи пишутся только локально в userData
- 📦 **Bundled Python** — Windows + macOS инсталляторы уже содержат Python 3.12 + все зависимости + ffmpeg. Никаких winget/brew/pip/setup-скриптов

---

## 🚀 Установка (для конечных пользователей)

**1.1.0+ идёт с Python 3.12 + ffmpeg внутри инсталлятора для Windows и macOS.** Никаких предварительных установок (winget / brew / pip / setup-скриптов) больше не нужно — двойной клик, и всё работает.

> Имена файлов в инструкциях ниже используют `<version>` как плейсхолдер.
> Подставь актуальную версию из release-страницы (текущая релизная — `1.1.25`).
> SSOT для версии: `desktop/package.json` → используется vite-инжектом `__APP_VERSION__`,
> electron-builder, `BUILD.command`, `INSTALL.command`, и скриптами `desktop/package.json`.

### Windows x64 (~201 MB)
1. Скачать `Transcriptor Setup <version>.exe`
2. Двойной клик → SmartScreen **"Подробнее"** → **"Выполнить в любом случае"**
3. Через ~30 секунд приложение запущено. Разрешить микрофон при запросе Windows

### macOS Apple Silicon M1-M4 (~220 MB)
1. Скачать `Transcriptor-<version>-arm64.dmg`
2. Открыть DMG, перетащить Transcriptor.app в Applications
3. **macOS Sonoma 14+ / Sequoia 15+:** System Settings → Privacy & Security → прокрутить вниз → **"Open Anyway"** рядом с предупреждением Transcriptor → потом двойной клик → **"Open"**
4. Разрешить 3 permissions: **Microphone**, **Accessibility**, **Automation** (для AppleScript-paste). Это всё, что приложение запрашивает у системы — Input Monitoring не используется.

> 💡 **Только Apple Silicon.** Начиная с релиза 1.1.24 build rules production-сборки — `arm64-only` (M1/M2/M3/M4). Для Intel-Mac можно собрать локально через `npm --prefix desktop run dist:dir -- --x64`, но в публичном relэase такой DMG больше не выкладывается.

### Linux x64 (~101 MB, AppImage)
```bash
chmod +x Transcriptor-<version>.AppImage
./Transcriptor-<version>.AppImage
```

На Linux AppImage **всё ещё нужны системные зависимости** (Python 3.10+ и ffmpeg), потому что bundling Python на Linux упирается в PyPI timeout. Установить заранее:

```bash
# Ubuntu / Debian (X11)
sudo apt install python3 python3-venv python3-pip ffmpeg xdotool wmctrl zenity

# Ubuntu / Debian (Wayland)
sudo apt install python3 python3-venv python3-pip ffmpeg wtype ydotool zenity
sudo usermod -aG input $USER  # потом выйти и войти заново
```

---

## 🛠️ Для разработчиков — сборка из исходников

```bash
cd "Voice Transcriptor"

# macOS
./INSTALL.command          # подготовить runtime и собрать .dmg
./BUILD.command            # то же самое, macOS-only entrypoint

# Windows (из Windows shell)
npm --prefix frontend ci
npm --prefix desktop ci
desktop\scripts\prepare-runtime.sh win-x64
npm --prefix desktop run dist:win

# Linux
./INSTALL.command          # подготовить runtime и собрать AppImage
```

Эти скрипты — для **разработчиков**, собирающих приложение из исходников. Для конечных пользователей достаточно скачать готовый инсталлятор (см. выше).

Release build: см. `desktop/scripts/prepare-runtime.sh` + `npm run dist` / `npm run dist:win` / `npm run dist:linux` в папке `desktop/`.

---

## 📋 Что делает сборочный entrypoint

`BUILD.command` / `INSTALL.command` используют текущий SSOT сборки:

| Компонент | Версия | Назначение |
|-----------|--------|------------|
| **npm ci** | lockfile | Установка frontend/desktop зависимостей |
| **desktop/scripts/prepare-runtime.sh** | pinned Python tag | Сборка bundled Python runtime и ffmpeg |
| **Vite build** | `frontend/package.json` | Сборка `frontend/dist` |
| **electron-builder** | `desktop/package.json` | DMG / AppImage / Windows installer |

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

---

## 🔄 Пересборка приложения

Если вы изменили код и хотите обновить установленное приложение:

```bash
# macOS
chmod +x BUILD.command
./BUILD.command
```

Скрипт соберёт frontend, подготовит bundled runtime и положит artifacts в `desktop/dist`.

```bash
# Windows (из Windows shell)
npm --prefix desktop run dist:win

# Linux
chmod +x INSTALL.command
./INSTALL.command
```

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
| `TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC` | Время хранения recovery-данных | `86400` (24ч) |
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

# Или пересобрать source checkout
./INSTALL.command
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
python3 -m venv "$HOME/Library/Application Support/Transcriptor/.venv"
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
| `INSTALL.command` | 🚀 Cross-platform source build entrypoint |
| `BUILD.command` | 🔄 macOS source build entrypoint |
| `backend/` | 🐍 Python бэкенд (FastAPI + Whisper) |
| `frontend/` | ⚛️ TypeScript фронтенд (Vite) |
| `desktop/` | 🖥️ Electron обёртка |
| `.env.example` | 📋 Шаблон переменных окружения |
| `requirements.txt` | 📦 Python зависимости |
| `PROJECT_STRUCTURE.md` | 🗂️ Детальная структура проекта |
