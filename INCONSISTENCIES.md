# Несоответствия и костыли — аудит

> **ARCHIVE / НЕ SSOT.** Этот файл оставлен как исторический research-снимок
> от 17 апреля 2026. Он содержит ссылки на файлы и line numbers, которые уже
> изменились или были удалены. Актуальный проверенный аудит находится в
> `AUDIT_100_BUGS.md`; README и PROJECT_STRUCTURE описывают текущие entrypoints.

> Research-проход 17 апреля 2026 по репозиторию `/Voice Transcriptor` (17k LoC).
> Цель: найти реальные несоответствия и костыли, **не чинить** — это документ для последующей работы.
> Все найдённые пункты **лично перечитаны** и подтверждены против исходников.
> Симптом vs. root cause помечен `[S]` или `[R]`.

---

## Критические (блокируют корректность / безопасность)

### 1. `[R]` Дублирующая `RemoteError` выдаётся за два разных класса
**Файлы:** `backend/main.py:40-42`, `backend/remote_openrouter.py:12`, `backend/remote_deepgram.py:17`

Обе `remote_openrouter.py` и `remote_deepgram.py` импортируют **один и тот же** `RemoteError` из `backend/http_retry.py`. В `main.py` они переаliased в `OrRemoteError` и `DgRemoteError`, а потом `except (OrRemoteError, DgRemoteError)` используется как будто это разные типы. По факту это ОДИН класс — любой `except RemoteError` ловит оба. Создаёт иллюзию типизированного провайдер-specific handling, которой нет.

**Root fix:** либо импортировать как единый `RemoteError`, либо реально создать `OpenRouterError(RemoteError)` и `DeepgramRemoteError(RemoteError)` подклассы в своих модулях.

---

### 2. `[R]` `MAX_UPLOAD_BYTES` и `MAX_FILE_BYTES` — хардкод в двух местах
**Файлы:** `backend/main.py:170` (`MAX_UPLOAD_BYTES = 500 * 1024 * 1024`), `frontend/src/main.tsx:305` (`MAX_FILE_BYTES = 500 * 1024 * 1024`)

Два **разных имени** для одного лимита в двух модулях. Если поменять только в backend — frontend пропустит файл, который backend отрежет с 413. Если только в frontend — backend допустит больше чем frontend обещает.

**Root fix:** backend должен отдавать лимит через `/api/health` или подобный endpoint, frontend читать один раз при старте.

---

### 3. `[R]` Дублирование уничтожения backend на порту 8321 в `install/win/run.bat`
**Файл:** `install/win/run.bat:28-38`

Ровно тот баг, который я починил в `install/mac/run.command` в прошлом коммите `0c0dac7`: бат-скрипт сначала запускает `uvicorn` на 8321, потом `npm start` (который через Electron **ещё раз** спавнит backend через `pickBackendPort`). В итоге два Python-процесса, frontend видит только второй, первый висит пока `npm` не закончится. Плюс финальный `netstat ... | taskkill` может убить несвязанный процесс на 8321.

**Root fix:** удалить spawn uvicorn и cleanup, оставить только `set PYTHON=%VENV_PY%` + `npm start`. Electron сам владеет жизненным циклом backend.

---

### 4. `[R]` Данные юзера раскладываются по ДВУМ разным путям на macOS
**Файлы:** `desktop/main.js:3721,3982,4467` (`app.getPath("userData")` → `~/Library/Application Support/transcriptor`, lowercase), `install/mac/setup.command:133,252` + `install/mac/run.command:62,135` (`~/Library/Application Support/Transcriptor`, **Capital T**)

На case-insensitive APFS (default) — одна папка. На case-sensitive разделе — **две разные** папки. Venv создаётся в `Transcriptor/.venv`, а Electron читает `TRANSCRIPTOR_DATA_DIR = transcriptor`. На casual диске работает, на dev-диске с case-sensitive FS — ломается незаметно.

Также на диске есть legacy папка `call-transcriptor-desktop/` (не текущий проект), которая никогда не удаляется миграцией.

**Root fix:** один источник правды для пути — `app.getPath("userData")` (Electron использует `package.json.name` = `"transcriptor"` lowercase). Setup скрипты должны читать ту же самую константу, а не хардкодить Capital T.

---

## Высокие (работает, но хрупко)

### 5. `[R]` Две несовместимые функции санитайзинга имён файлов
**Файлы:** `backend/main.py:806-810` (`_normalize_filename`), `backend/main.py:1050-1052` (`_sanitize_name`)

- `_normalize_filename`: regex `[^A-Za-z0-9._-]+` → `_`, strip `._`, **нет лимита длины**.
- `_sanitize_name`: regex `[^A-Za-z0-9._ -]+` → `_` (**допускает пробелы!**), strip `" ._-"`, обрезает до **80 символов**.

Две логики используются вперемешку для похожих данных (первая для upload-ed файлов, вторая для recording title). Пробел разрешён в одной, не разрешён в другой — создаёт inconsistent UX имён записей в UI.

**Root fix:** одна функция `_sanitize_path_component(value, max_len=255, allow_spaces=False)` со всеми опциями как параметрами.

---

### 6. `[S]` 30+ magic numbers в `desktop/main.js` (overlay delays, sleeps, timeouts)
**Файл:** `desktop/main.js` — 31 совпадение `setTimeout` с захардкоженным числом

Примеры:
- `hideRecordingOverlay()` таймауты: `1200`, `1300`, `1400` — **7 разных мест** (линии 2107, 2115, 2124, 2147, 2188, 2287, 2291, 3225, 3565, 3598)
- `sleep()` в retry loops: `30`, `45`, `70`, `110`, `120`, `220`, `350`
- Health-check retry: `250` (line 4051, 4054)

Если нужно изменить "через сколько овrlay скрывается после ошибки" — 3 разных значения в 7 местах.

Frontend имеет `UI_TOKENS`/`AUDIO_TOKENS` блок (`main.tsx:306-335`) — правильный паттерн, **но в desktop/main.js его нет**. В backend тоже нет.

**Root fix:** создать `desktop/tokens.js` с экспортированным объектом `{ overlay: { hideDelayAfterError: 1200, ... } }`, импортировать в `main.js`.

---

### 7. `[R]` String-matched error detection (хрупкие fingerprint'ы)
Несколько мест ловят ошибки по подстроке в сообщении, а не по типу exception:

| Файл:line | Паттерн | Проблема |
|---|---|---|
| `backend/main.py:841-864` | `"broken pipe"`, `"errno 32"`, `"unexpected asgi message"`, `"cannot call send once a close"`, `"no close frame"` | Whitelist из 5 строк. Новая версия `websockets` или `starlette` изменит формулировку — логи зальёт WARNING до следующего патча. |
| `backend/main.py:2494` | `"HTTP 404" in msg` | Предполагает format от `requests.HTTPError.__str__()`. |
| `backend/transcribe.py:44-46` | `"empty sequence" in msg and "max()" in msg` | Детектит специфичный ValueError из numpy — сломается при обновлении faster-whisper. |
| `frontend/src/main.tsx:1618-1628` | 9 подстрок для сетевых ошибок (`"bad gateway"`, `"nodename nor servname"`, etc.) | Каждая платформа/браузер возвращает свой текст. |
| `frontend/src/main.tsx:4841-4844` | `"overconstrained"`, `"notfound"`, `"constraint"` для getUserMedia errors | Зависит от текста WebRTC ошибок. |
| `backend/remote_openrouter.py:72` | `"input_audio" in error_text.lower() or "image"` | Полагается на формулировки OpenRouter. |

**Root fix:** использовать типы exceptions/codes где возможно (`response.status_code == 404`, `isinstance(e, DOMException)` с `e.name` вместо message). Где нельзя (API ошибки) — централизованный модуль `fingerprints.py` со всеми regex в одном месте + unit tests которые заморозят контракт.

---

### 8. `[R]` Hardcoded 8321 в 4 местах desktop/main.js + install-скриптах
**Файлы:** `desktop/main.js:59,3699,3700,3951`, `install/win/run.bat:28,38` (я только что убрал из mac)

```js
let PORT = 8321;                                       // line 59
async function pickBackendPort(host, preferred = 8321) // line 3699
  const start = Number(preferred || 8321);             // line 3700
const preferredPort = Number(process.env.TRANSCRIPTOR_PORT || 8321) || 8321; // 3951
```

4 места с одним значением. Если поменять default — легко пропустить.

**Root fix:** `const DEFAULT_BACKEND_PORT = 8321;` вверху файла, использовать константу везде.

---

### 9. `[R]` Install-скрипты несимметричны между OS

| Действие | macOS | Windows | Linux |
|---|:---:|:---:|:---:|
| **setup** (auto-install Python/Node/ffmpeg) | ✓ setup.command | ⚠ setup.bat *(только check, не install)* | ❌ нет |
| **build** (DMG/exe/AppImage) | ✓ BUILD.sh | ✓ build.bat | ✓ build.sh |
| **run** (dev launch) | ✓ run.command | ✓ run.bat | ❌ нет |

Mac setup.command автоматически ставит brew + python + node + ffmpeg + venv + deps + собирает приложение + установливает в `/Applications`. Win setup.bat только **проверяет** наличие python/node и показывает ошибку если нет. Linux даже setup.sh не существует.

README утверждает одинаковый one-click UX — это не так.

**Root fix:** написать win/setup.bat через chocolatey или winget, linux/setup.sh через auto-detect `apt`/`dnf`/`pacman`. Плюс linux/run.sh по образцу mac/run.command.

---

### 10. `[R]` `PREFERRED_SIGNING_IDENTITY` захардкожена в `afterPack.js`
**Файл:** `desktop/afterPack.js:62`

```js
const PREFERRED_SIGNING_IDENTITY = "AntigravityTelegramDev";
```

Имя персонального сертификата разработчика в коде. Если кто-то другой клонирует репо, у него не будет этого cert в keychain → ad-hoc signing (функционально работает, но TCC permissions не сохраняются между сборками).

**Root fix:** `process.env.TRANSCRIPTOR_SIGNING_IDENTITY` с fallback на текущую строку. В `.env.example` добавить пример.

---

## Средние (code hygiene)

### 11. `[S]` `window.__transcriptor*` globals растут органически
**Файл:** `frontend/src/main.tsx` — 30+ переменных типа `window.__transcriptorIsRecording`, `__transcriptorCurrentRecordingId`, `__transcriptorLastFinishedAt`, `__transcriptorLastUiFinalText` и т.д.

Это IPC-контракт с `desktop/main.js` — main process читает эти globals через `executeJavaScript`. Но:
- Нет **центрального определения контракта** (TypeScript interface) — каждое поле заводится ad-hoc
- Нет `resetAllTranscriptorGlobals()` кроме функции `clearRecordingFinalSignal()` которая сбрасывает только часть
- Easy to drift — frontend может добавить поле, которое desktop никогда не читает (или наоборот)

**Root fix:** один `interface TranscriptorIpcState` в `frontend/src/ipc.ts`, exported constant для списка полей. `desktop/main.js` читает через тот же контракт в executeJavaScript snippet.

---

### 12. `[S]` `_live_promote_cache` — GC только на lookup-пути
**Файл:** `backend/main.py:530-548`

Opportunistic garbage collection стаrых entries происходит **только** когда кто-то делает `_lookup_live_promote_cache`. Если клиент никогда не перечитывает session, entry висит в памяти до рестарта процесса.

Практически не страшно (сессий не миллионы), но строго говоря — **неограниченный рост** кэша под редкий usage pattern.

**Root fix:** периодический background thread (как `_cleanup_expired_files`), либо GC также в `_store_live_promote_cache` write-path.

---

### 13. `[S]` `time.sleep(0.35)` в середине event-processing логики
**Файл:** `backend/main.py:889`

Непонятный `time.sleep(0.35)` без комментария. В async-heavy коде blocking sleep может задержать event loop на 350ms — неприемлемо для live-стрима.

**Root fix:** прочитать контекст, либо заменить на `await asyncio.sleep`, либо добавить комментарий почему именно sync sleep нужен.

---

### 14. `[R]` `desktop/main.js` — 4604 строки в одном файле, 93 top-level функции
Нет модульной разбивки. Overlay HTML, spawn logic, AppleScript paste, PowerShell paste, VBS paste, tray menu, hotkey handling, config read, afterpack — всё в одном monolith.

**Root fix:** разбить на `overlay.js`, `paste.js`, `backend-lifecycle.js`, `hotkeys.js`, `tray.js`.

---

### 15. `[S]` Ad-hoc env vars без единого реестра
Разбросаны по коду:
- `TRANSCRIPTOR_DATA_DIR`
- `TRANSCRIPTOR_PORT`
- `TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG`
- `TRANSCRIPTOR_WHISPER_NUM_WORKERS`
- `PYTHON`
- `PYTHONPATH`, `PYTHONUNBUFFERED`

Нет общего документа "вот все env vars приложения и что они делают". `.env.example` в корне не полон.

**Root fix:** дополнить `.env.example` всеми поддерживаемыми env vars + одна константа `ENV_VARS` где-то читаемая.

---

## Низкие (nice-to-have / cosmetic)

### 16. `[S]` Legacy данные миграция без explicit user notification
**Файл:** `backend/config.py:177-217`

`_migrate_legacy_data()` читает старую папку `APP_ROOT/data` и копирует в новую. Бросает OSError — ловится и логируется DEBUG level. Юзер не узнает если миграция не удалась (permission denied, например).

---

### 17. `[S]` README помечает `Transcriptor-1.0.0.dmg` как "Intel", но archname не подтверждает
**Файл:** `README.md:32-33`

По умолчанию electron-builder строит универсальный или arm64-only, label "Intel" может ввести в заблуждение. Надо явно проверить `lipo -info` для `.dmg`-файла.

---

### 18. `[S]` `.venv` в `~/Library/Application Support/Transcriptor/.venv` хардкод в `desktop/main.js:3721`
```js
function getAppVenvDir() {
  return path.join(app.getPath("userData"), ".venv");
}
```

ОК, но нет комментария что это одно и то же место куда setup.command ставит venv. Если setup.command **изменит** путь (скажем на `.venv-py312`) — десктопная часть сломается.

---

## Summary

| Категория | Count |
|---|---|
| Критические (corrupt / security) | 4 |
| Высокие (хрупко, но работает) | 6 |
| Средние (hygiene) | 5 |
| Низкие (cosmetic) | 3 |
| **Всего пунктов** | **18** |

**Root causes vs. симптомы:** 13 root, 5 симптомы — хорошее соотношение, основные проблемы это реальная архитектурная дрейф (magic numbers, duplicate sanitizers, несимметричные install скрипты), а не косметические жалобы.

**Общий observation:** проект в хорошем состоянии для ~17k LoC — нет TODO/FIXME/HACK меток (только 1 match, и тот — комментарий в VBS paste). Основные проблемы — **архитектурная симметрия**: mac имеет полный UX, win/linux отстают. И **одна функция, много вариантов** (sanitizers, error detection, data dir path).

Готов делать фиксы по приоритету — скажи с какого пункта начинать.
