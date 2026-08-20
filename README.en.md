# Transcriptor

Десктопное приложение для транскрибации речи: запись с микрофона, загрузка файлов, ИИ-очистка текста, локальная история, глобальные хоткеи, автовставка.

## Возможности

- **Живая транскрибация** — Local Whisper (офлайн) или Deepgram (облако).
- **Файловая транскрибация** — Whisper / Deepgram / OpenRouter.
- **История** — сохранённые транскрипты и исходный аудио, поиск, статистика, повторная транскрибация.
- **ИИ-апскейл** — пресеты через OpenRouter.
- **Автовставка** — результат сразу в фокусное поле (Enter после вставки — опционально).
- **Платформы** — macOS Apple Silicon, Windows x64, Linux x64.

## Установка

### macOS (Apple Silicon)

1. Скачайте `Transcriptor-<версия>-arm64-macos-install.zip` из `desktop/dist/release`.
2. Распакуйте и запустите `bash INSTALL_ON_OTHER_MAC.command`.
3. Разрешите **Микрофон**, **Universal Access**, **Автоматизация** (Системные настройки → Приватность и безопасность).

> Публичные релизы требуют Developer ID + нотаризацию. Сборки из репозитория — ad-hoc, для доверенных машин.

### Windows x64

1. Скачайте `Transcriptor Setup <версия>.exe`.
2. Запустите установщик.
3. Разрешите доступ к микрофону (Параметры → Приватность → Микрофон).

### Linux x64

```bash
sudo apt install xdotool wmctrl zenity
chmod +x Transcriptor-<версия>.AppImage
./Transcriptor-<версия>.AppImage
```

На Wayland — `wtype`/`ydotool` вместо `xdotool`.

## Глобальные хоткеи

| Действие | macOS | Windows / Linux |
|----------|-------|-----------------|
| Запись / Стоп | `Option`+`←` | `F9` |
| Вставить последний текст повторно | `Option`+`Shift`+`V` | `F10` |

Настройка: **Настройки → Ярлыки**. Красная подсветка = комбинация занята другой программой.

## Разработка

```bash
cd "Voice Transcriptor"

# macOS
./BUILD.command          # сборка DMG + замена установленного приложения

# Linux
./INSTALL.command

# Windows (из Git Bash / WSL / macOS хоста)
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:win
```

### Запуск в dev-режиме

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix frontend run build
npm --prefix desktop run dev
```

Электрон сам управляет бэкендом — отдельный `uvicorn` не нужен.

## Конфигурация

```bash
cp .env.example .env
# отредактируйте .env при необходимости
```

Переменные: токен API, порт бэкенда, Deepgram хост, TTL результатов, Whisper-потоки, пути кэша и др. Полный список в `.env.example`.

## Траблшутинг

- **Логи**: `~/Library/Application Support/Transcriptor/main.log` (macOS) или `%APPDATA%\Transcriptor\main.log` (Windows).
- **Микрофон тишина**: переключите разрешение **Микрофон** выкл/вкл в настройках macOS или `tccutil reset Microphone local.transcriptor.app`.
- **Порт 8321 занят**: Electron сам выберет другой.

## Документация

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — структура кода.
- [VERIFIED_AUDIT.md](VERIFIED_AUDIT.md) — аудит багов и фиксы.
- [CHANGELOG.md](CHANGELOG.md) — история релизов.

---

**English version:** [README.en.md](README.en.md)