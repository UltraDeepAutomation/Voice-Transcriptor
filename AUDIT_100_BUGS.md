# Voice Transcriptor — Verified Audit, 18 June 2026

Итог: подтверждено 34 реальных бага/SSOT-рассинхрона. До 100 не добивал: старый список из 100 содержал много неподтвержденных candidate-пунктов и был заменен.

Статус:
- Исправлено: 33
- Оставлено с явным стопом: 1
- P0: 0 найдено
- P1: 13 найдено, 13 исправлено (100%)

## 1. P1 FIXED — keyfile race could overwrite Fernet key

Файл и строка: `backend/config.py:173`

Суть: первый запуск двух процессов мог перетереть `.encryption_key`.

Последствие: один процесс шифрует config ключом, которого уже нет на диске; API keys становятся нечитаемыми.

Было:
```python
fd = os.open(
    str(_KEYFILE),
    os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
    0o600,
)
```

Стало:
```python
fd = os.open(
    str(_KEYFILE),
    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    0o600,
)
```

Объяснение: `O_EXCL` делает создание ключа single-writer. Если другой процесс выиграл race, код перечитывает уже созданный ключ.

## 2. P1 FIXED — concurrent config saves lost fields

Файл и строка: `backend/config.py:735`

Суть: `save_config()` делал read/merge/write без backend lock.

Последствие: параллельный save API key и UI preferences мог потерять одно из изменений.

Было:
```python
current = load_config()
merged_current = _deep_merge(current, cfg or {})
_atomic_write_json(CONFIG_PATH, encrypted)
```

Стало:
```python
with _CONFIG_IO_LOCK:
    current = _load_config_unlocked()
    merged_current = _deep_merge(current, cfg or {})
    _atomic_write_json(CONFIG_PATH, encrypted)
```

Объяснение: atomic rename защищает от torn write, но не от lost update. `RLock` сериализует config mutations на SSOT boundary.

## 3. P1 FIXED — corrupt primary config could overwrite good backup

Файл и строка: `backend/config.py:548`

Суть: backup rotation копировал текущий `config.json` в `.bak`, даже если primary уже битый.

Последствие: восстановленный из backup config мог потерять последний хороший backup при следующем save.

Было:
```python
_rotate_backup(CONFIG_PATH, _CONFIG_BACKUP_PATH)
_atomic_write_json(CONFIG_PATH, encrypted)
```

Стало:
```python
_rotate_backup_if_primary_valid()
_atomic_write_json(CONFIG_PATH, encrypted)
```

Объяснение: backup можно обновлять только из читаемого JSON object; corrupt primary оставляется для диагностики, но не становится новым `.bak`.

## 4. P1 FIXED — localhost port hijack accepted any 200 OK

Файл и строка: `desktop/main.js:6026`, `backend/main.py:1069`

Суть: Electron считал backend готовым по любому `200 OK` на выбранном port.

Последствие: при local port race окно могло загрузить чужой localhost service.

Было:
```js
if (res.statusCode === 200) {
  resolve();
}
```

Стало:
```js
const payload = JSON.parse(body || "{}");
if (payload?.boot_nonce !== BACKEND_BOOT_NONCE) {
  throw new Error("backend boot nonce mismatch");
}
resolve();
```

Объяснение: Electron генерирует per-launch nonce, передает его backend через `TRANSCRIPTOR_BOOT_NONCE`, и доверяет только health payload с тем же nonce.

## 5. P1 FIXED — root BUILD.command executed deleted script

Файл и строка: `BUILD.command:26`

Суть: `BUILD.command` вызывал удаленный `install/mac/BUILD.sh`.

Последствие: double-click build всегда падал с missing file.

Было:
```bash
exec "$SCRIPT_DIR/install/mac/BUILD.sh" "$@"
```

Стало:
```bash
npm --prefix frontend ci
npm --prefix desktop ci
desktop/scripts/prepare-runtime.sh "$RUNTIME_PLATFORM"
npm --prefix frontend run build
npx electron-builder --mac dmg "--${BUILDER_ARCH}" "$@"
```

Объяснение: root script теперь сам использует текущий build SSOT: npm lockfiles, `prepare-runtime.sh`, electron-builder.

## 6. P1 FIXED — root INSTALL.command executed deleted installers

Файл и строка: `INSTALL.command:14`

Суть: `INSTALL.command` dispatch-ил в удаленные `install/mac/setup.command` и `install/linux/setup.sh`.

Последствие: source install был сломан на macOS/Linux.

Было:
```bash
exec "$SCRIPT_DIR/install/mac/setup.command" "$@"
exec "$SCRIPT_DIR/install/linux/setup.sh" "$@"
```

Стало:
```bash
exec "$SCRIPT_DIR/BUILD.command" "$@"
desktop/scripts/prepare-runtime.sh linux-x64
npx electron-builder --linux AppImage --x64 "$@"
```

Объяснение: entrypoint больше не зависит от удаленного `install/` дерева.

## 7. P1 FIXED — mono audio was upmixed then transcribed as stereo

Файл и строка: `backend/main.py:1418`, `backend/audio.py:461`

Суть: `split_stereo=True` вызывал `ensure_wav_16k(..., channels=2)`.

Последствие: mono file превращался в два одинаковых канала; transcript дублировался как speaker A/B.

Было:
```python
ensure_wav_16k(str(upload_path), wav_path, channels=2)
ch1, ch2 = split_channels(wav_path)
```

Стало:
```python
ensure_wav_16k_preserve_channels(str(upload_path), wav_path)
ch1, ch2 = split_channels(wav_path)
```

Объяснение: split должен разделять реальные каналы, а не создавать второй канал из mono.

## 8. P1 FIXED — fallback recovery page reloaded the data: URL

Файл и строка: `desktop/main.js:6660`

Суть: error page был `data:` document и делал `location.reload()` после successful health.

Последствие: окно могло навсегда остаться на "Backend startup failed".

Было:
```js
setTimeout(() => location.reload(), 500);
```

Стало:
```js
setTimeout(() => { window.location.href = '${BASE_URL}/'; }, 500);
```

Объяснение: recovery должен явно навигировать на backend app URL. Теперь он еще проверяет boot nonce перед навигацией.

## 9. P1 FIXED — Deepgram live forwarder could end receiver too early

Файл и строка: `backend/main.py:3251`

Суть: `asyncio.wait(... FIRST_COMPLETED)` завершает session, когда первым заканчивается forwarder.

Последствие: если upstream Deepgram WS закрылся во время записи, receiver отменяется и tail PCM после обрыва может потеряться.

Было:
```python
await asyncio.wait({rx, fw}, return_when=asyncio.FIRST_COMPLETED)
finally:
    stop.set()
    if not rx.done():
        rx.cancel()
```

Стало:
```python
done, _pending = await asyncio.wait({rx, fw}, return_when=asyncio.FIRST_COMPLETED)
if fw in done and not rx.done() and session.is_closed and not session.last_fatal:
    _mark_recovery_error(recovery)
    await rx
```

Объяснение: если upstream Deepgram закрылся без fatal error, backend теперь помечает recovery и продолжает принимать PCM до finalize/disconnect, чтобы fallback получил полный хвост аудио.

## 10. P2 FIXED — JSON bool `split_stereo` parsed `"false"` as true

Файл и строка: `backend/main.py:3387`

Суть: `bool("false")` возвращает `True`.

Последствие: retry-by-path мог включить stereo split вопреки UI.

Было:
```python
split_stereo = bool((payload or {}).get("split_stereo", True))
```

Стало:
```python
split_stereo = _payload_bool(payload, "split_stereo", True)
```

Объяснение: `_payload_bool` выравнивает JSON semantics с FastAPI Form bool.

## 11. P2 FIXED — JSON bool `word_timestamps` parsed `"false"` as true

Файл и строка: `backend/main.py:3388`

Суть: строковое false становилось true.

Последствие: backend мог включать дорогие word timestamps без намерения пользователя.

Было:
```python
word_timestamps = bool((payload or {}).get("word_timestamps", False))
```

Стало:
```python
word_timestamps = _payload_bool(payload, "word_timestamps", False)
```

Объяснение: invalid boolean strings теперь возвращают HTTP 400, а не молча меняют смысл.

## 12. P2 FIXED — remote from-path `diarize` parsed `"false"` as true

Файл и строка: `backend/main.py:3815`

Суть: `bool(payload["diarize"])` ломал JSON contract.

Последствие: Deepgram diarization включалась при `"false"`.

Было:
```python
diarize=bool((payload or {}).get("diarize", False)),
```

Стало:
```python
diarize=_payload_bool(payload, "diarize", False),
```

Объяснение: boolean parser стал единым для JSON endpoints.

## 13. P2 FIXED — transcribe-on-disk `diarize` parsed `"false"` as true

Файл и строка: `backend/main.py:3946`

Суть: on-disk retranscribe имел тот же string-bool bug.

Последствие: повторная транскрибация могла неожиданно включать speaker labels.

Было:
```python
diarize=bool(payload.get("diarize") or False),
```

Стало:
```python
diarize=_payload_bool(payload, "diarize", False),
```

Объяснение: один helper устраняет несколько расходящихся источников правды.

## 14. P2 FIXED — save `require_existing` parsed `"false"` as true

Файл и строка: `backend/main.py:4838`

Суть: string `"false"` включал edit-existing mode.

Последствие: create save мог падать с `require_existing needs an existing recording name`.

Было:
```python
require_existing = bool(payload.get("require_existing"))
```

Стало:
```python
require_existing = _payload_bool(payload, "require_existing", False)
```

Объяснение: JSON save path больше не отличается от Form path.

## 15. P2 FIXED — save-from-path `require_existing` parsed `"false"` as true

Файл и строка: `backend/main.py:5078`

Суть: upload save-from-path имел тот же string-bool bug.

Последствие: source-path uploads могли идти в wrong edit mode.

Было:
```python
require_existing=bool((payload or {}).get("require_existing")),
```

Стало:
```python
require_existing=_payload_bool(payload, "require_existing", False),
```

Объяснение: endpoint now shares backend-owned boolean SSOT.

## 16. P2 FIXED — MIME invariant used `assert`

Файл и строка: `backend/main.py:1999`

Суть: import-time SSOT check отключался под `python -O`.

Последствие: missing MIME mapping мог уйти в production.

Было:
```python
assert not _missing_mime_exts, (...)
```

Стало:
```python
if _missing_mime_exts:
    raise RuntimeError(...)
```

Объяснение: production invariant должен работать независимо от optimize flags.

## 17. P2 FIXED — `.TXT` names rejected in text-only save

Файл и строка: `backend/main.py:4861`

Суть: extension check был case-sensitive.

Последствие: valid `Existing.TXT` не принимался.

Было:
```python
not existing_name.endswith(".txt")
```

Стало:
```python
not existing_name.lower().endswith(".txt")
```

Объяснение: extension validation теперь соответствует остальным case-insensitive filename checks.

## 18. P2 FIXED — `.TXT` names rejected in save-with-audio path

Файл и строка: `backend/main.py:4924`

Суть: audio save helper повторял case-sensitive check.

Последствие: edit-existing recording with uppercase extension ломался в одном save path, но не в другом.

Было:
```python
not existing_name.endswith(".txt")
```

Стало:
```python
not existing_name.lower().endswith(".txt")
```

Объяснение: save paths now share the same filename semantics.

## 19. P2 FIXED — REST diarization was hidden from user-facing text

Файл и строка: `backend/remote_deepgram.py:230`

Суть: `diarize=True` попадал только в raw response, но `text` оставался flat transcript.

Последствие: UI показывал transcript без speaker labels.

Было:
```python
paragraphs_obj = channel.get("alternatives", [{}])[0].get("paragraphs")
text = alternatives[0].get("transcript", "")
```

Стало:
```python
if diarize:
    text = _format_deepgram_speaker_words(alternative.get("words"))
```

Объяснение: backend contract принимает `diarize`, значит основной `text` тоже отражает speakers.

## 20. P2 FIXED — Electron granted video capture

Файл и строка: `desktop/main.js:6232`

Суть: permission set включал `videoCapture` и generic `media`.

Последствие: compromised renderer/backend origin мог запросить camera permission, хотя продукту нужен microphone.

Было:
```js
const mediaPermissions = new Set(["media", "microphone", "audioCapture", "videoCapture"]);
const allow = knownPerm && fromBackend;
```

Стало:
```js
const audioPermissions = new Set(["microphone", "audioCapture"]);
const audioOnlyMedia = perm === "media" && mediaTypesAreAudioOnly(details);
const allow = allowedCapability && fromBackend;
```

Объяснение: permission surface теперь минимальный: microphone/audio-only media + clipboard write.

## 21. P2 FIXED — Quick Settings saved inverted state

Файл и строка: `frontend/src/main.tsx:5777`

Суть: код сравнивал `panel.hidden` с `open`, хотя это обратные значения.

Последствие: unchanged state мог сохраняться как changed, а real open/close не сохранялся.

Было:
```ts
const next = !!open;
const changed = panel.hidden !== next;
syncQuickSettingsVisibility(next);
```

Стало:
```ts
const nextOpen = !!open;
const currentOpen = !panel.hidden;
const changed = currentOpen !== nextOpen;
syncQuickSettingsVisibility(nextOpen);
```

Объяснение: источник правды теперь хранит actual open state.

## 22. P2 FIXED — Upload provider default ignored loaded Deepgram key

Файл и строка: `frontend/src/main.tsx:4198`

Суть: `setupUploadView()` выбирал fallback до завершения `loadCfg()`.

Последствие: пользователь с Deepgram key мог видеть `local` default.

Было:
```ts
const initialProvider: Provider = isProviderKeyConfigured("deepgram") ? "deepgram" : "local";
provider.value = initialProvider;
```

Стало:
```ts
const fallback: Provider = isProviderKeyConfigured("deepgram") ? "deepgram" : "local";
const next = wanted || fallback;
uploadProviderEl.value = next;
```

Объяснение: config load now reapplies saved/fallback provider after key state is known.

## 23. P2 FIXED — modal dialogs lacked dialog semantics

Файл и строка: `frontend/index.html:741`

Суть: modals were plain `div`s.

Последствие: screen readers did not get dialog role, modal flag, or label.

Было:
```html
<div class="modal-backdrop" id="upscalePresetModal" hidden>
  <h3>New Upscale Preset</h3>
```

Стало:
```html
<div class="modal-backdrop" id="upscalePresetModal" role="dialog" aria-modal="true"
  aria-labelledby="upscalePresetTitle" hidden>
  <h3 id="upscalePresetTitle">New Upscale Preset</h3>
```

Объяснение: repeated modal pattern now exposes expected accessibility contract.

## 24. P2 FIXED — macOS runtime extraction used GNU-only `head -z`

Файл и строка: `desktop/scripts/prepare-runtime.sh:170`

Суть: release script used `head -z`, unavailable on stock macOS.

Последствие: fallback ffmpeg extraction could fail on release host.

Было:
```bash
find "${tmp}" -name "ffmpeg" -type f -print0 | head -z -n 1 | xargs -0 -I {} cp {} ...
```

Стало:
```bash
while IFS= read -r -d '' f; do
  found="$f"
  break
done < <(find "${tmp}" -name "ffmpeg" -type f -not -path "*/__MACOSX/*" -print0)
```

Объяснение: Bash `read -d ''` works on macOS without GNU coreutils.

## 25. P3 FIXED — version SSOT comments pointed to frontend package

Файл и строка: `frontend/src/main.tsx:285`, `frontend/index.html:638`, `frontend/vite.config.ts:6`

Суть: comments said `frontend/package.json`, while Vite reads `desktop/package.json`.

Последствие: next release could bump the wrong file.

Было:
```ts
// Compile-time injected by vite.config.ts from frontend/package.json's version field.
```

Стало:
```ts
// Compile-time injected by vite.config.ts from desktop/package.json's version field.
```

Объяснение: shipped app version SSOT is `desktop/package.json`.

## 26. P3 FIXED — README documented wrong Windows/Linux paste shortcut

Файл и строка: `README.md:9`

Суть: README said Windows/Linux paste default is `Alt+Shift+V`.

Последствие: user presses the wrong shortcut; app actually registers `F10`.

Было:
```md
Windows / Linux: F9 старт/стоп записи, Alt+Shift+V вставить последний транскрипт.
```

Стало:
```md
Windows / Linux: F9 старт/стоп записи, F10 вставить последний транскрипт.
```

Объяснение: README now matches frontend and Electron defaults.

## 27. P3 FIXED — README documented wrong live recovery retention

Файл и строка: `README.md:194`

Суть: README said recovery retention default is `3600`.

Последствие: operator expects 1 hour, app keeps 24 hours.

Было:
```md
TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC | ... | 3600 (1ч)
```

Стало:
```md
TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC | ... | 86400 (24ч)
```

Объяснение: README now matches `backend/main.py` and `.env.example`.

## 28. P3 FIXED — package-lock root version drifted

Файл и строка: `desktop/package-lock.json:3`

Суть: `desktop/package.json` was `1.1.25`, lockfile root was `1.0.0`.

Последствие: tooling reading lock metadata could show the wrong shipped version.

Было:
```json
"version": "1.0.0"
```

Стало:
```json
"version": "1.1.25"
```

Объяснение: lock metadata now matches desktop package SSOT.

## 29. P2 OPEN — ffmpeg release asset uses `latest` without checksum

Файл и строка: `desktop/scripts/prepare-runtime.sh:35`

Суть: Windows ffmpeg URL points to GitHub `latest` and no SHA256 verification is enforced.

Последствие: release builds are not fully reproducible; upstream asset changes can break or alter builds.

Текущий код:
```bash
FFMPEG_WIN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
curl -fSL --retry 3 --retry-delay 2 -o "${dest}.part" "${url}"
```

Предлагаемый код:
```bash
FFMPEG_WIN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/<pinned-release>/<asset>.zip"
FFMPEG_WIN_SHA256="<sha256>"
printf '%s  %s\n' "$FFMPEG_WIN_SHA256" "${dest}.part" | shasum -a 256 -c -
```

Объяснение: фикс требует выбрать конкретный upstream release artifact и checksum. Я не стал выдумывать external supply-chain pin без подтверждения.

## 30. P1 FIXED — full release build could hang on Electron postinstall

Файл и строка: `BUILD.command:30`, `INSTALL.command:19`

Суть: release entrypoint запускал `desktop npm ci` без отключения Electron binary postinstall download.

Последствие: full rebuild зависал на `desktop/node_modules/electron/install.js`; установленный `.app` оставался старым.

Было:
```bash
npm --prefix desktop ci
```

Стало:
```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix desktop ci
```

Объяснение: release packaging берет Electron по версии из `desktop/package.json` через `electron-builder`; dev binary download во время `npm ci` не нужен для сборки DMG/AppImage и не должен блокировать релизный entrypoint.

## 31. P1 FIXED — macOS build produced artifacts but did not update installed app

Файл и строка: `BUILD.command:36`

Суть: `BUILD.command` завершался после DMG packaging и не копировал свежий `Transcriptor.app` в install location.

Последствие: build-check мог быть зеленым, но пользователь продолжал запускать старый `/Applications/Transcriptor.app` или `~/Applications/Transcriptor.app`.

Было:
```bash
npx electron-builder --mac dmg "--${BUILDER_ARCH}" "$@"
```

Стало:
```bash
npx electron-builder --mac dmg "--${BUILDER_ARCH}" "$@"
APP_DIR="$SCRIPT_DIR/desktop/dist/mac-${BUILDER_ARCH}/Transcriptor.app"
ditto "$APP_DIR" "$PRIMARY_APP"
```

Объяснение: сборочный entrypoint теперь имеет единый результат: свежий DMG в `desktop/dist` и свежий установленный app bundle. Если есть legacy `~/Applications/Transcriptor.app`, он синхронизируется тем же bundle без удаления файлов.

## 32. P1 FIXED — recordings cache ignored edits when file count was unchanged

Файл и строка: `backend/main.py:1916`

Суть: recordings list cache key учитывал directory mtime и количество lowercase `.txt`, но не mtime/size transcript/audio файлов.

Последствие: изменение текста существующей записи или audio-sidecar могло не инвалидировать History/Stats/Graph cache, если число файлов не менялось.

Было:
```python
parts: list[tuple[str, float, int]] = []
dir_mtime = d.stat().st_mtime
file_count = sum(1 for _ in d.glob("*.txt"))
parts.append((str(d), dir_mtime, file_count))
```

Стало:
```python
parts: list[tuple[str, float, int, int, int]] = []
tracked_exts = {".txt", *_RECORDING_AUDIO_EXTS}
newest_file_mtime_ns = 0
total_file_size = 0
for entry in _iter_recording_files_by_suffix(d, tracked_exts):
    st = entry.stat()
    file_count += 1
    newest_file_mtime_ns = max(newest_file_mtime_ns, int(st.st_mtime_ns))
    total_file_size += int(st.st_size)
parts.append((str(d), dir_mtime, file_count, newest_file_mtime_ns, total_file_size))
```

Объяснение: cache key теперь привязан к observable state transcript + audio sidecars через тот же suffix SSOT, а не только к составу директории.

## 33. P1 FIXED — audio attach normalized existing `.TXT` recording into a second `.txt`

Файл и строка: `backend/main.py:4948`

Суть: `save_recording_with_audio()` валидировал существующий `Existing.TXT`, но путь записи строил заново через `f"{stem}.txt"`.

Последствие: на case-sensitive FS или при нестандартном casing backend мог создать второй text file и привязать audio не к выбранной записи.

Было:
```python
stem = Path(existing_name).stem
out_text = target_dir / f"{stem}.txt"
```

Стало:
```python
stem = Path(existing_name).stem
text_name = existing_name
out_text = target_dir / text_name
```

Объяснение: выбранный пользователем filename теперь остается SSOT для существующей записи; stem используется только для связанного audio filename.

## 34. P2 FIXED — uppercase `.TXT` recordings disappeared from History/Graph/Stats

Файл и строка: `backend/main.py:4481`, `backend/main.py:4598`, `backend/main.py:4779`

Суть: builders использовали `glob("*.txt")`, хотя save/get endpoints уже принимают `.TXT`.

Последствие: на case-sensitive filesystem запись `Existing.TXT` можно было сохранить и открыть напрямую, но она пропадала из History list, Graph payload и Stats summary.

Было:
```python
for p in archive_dir.glob("*.txt"):
    ...
files.extend(archive_dir.glob("*.txt"))
```

Стало:
```python
for p in _iter_recording_text_files(archive_dir):
    ...
files.extend(_iter_recording_text_files(archive_dir))
```

Объяснение: `_iter_recording_text_files()` делает case-insensitive suffix check (`entry.suffix.lower() == ".txt"`) и стал единым SSOT для всех transcript scans.

## Verification

Пройдено:
```text
python3 -m unittest discover backend/tests -q
python3 -m compileall -q backend
(cd frontend && ./node_modules/.bin/tsc --noEmit)
npm --prefix frontend run build
npm --prefix desktop run build:frontend
node --check desktop/main.js && node --check desktop/preload.js && node --check desktop/unlockDist.js && node --check desktop/afterPack.js
bash -n BUILD.command INSTALL.command desktop/scripts/prepare-runtime.sh
git diff --check
```
