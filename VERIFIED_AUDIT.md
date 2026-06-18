# Voice Transcriptor — Verified Audit, 18 June 2026

Итог: подтверждено 58 реальных багов/SSOT-рассинхронов. До 100 не добивал: старый список из 100 содержал много неподтвержденных candidate-пунктов и был заменен.

Статус:
- Исправлено: 58
- Оставлено с явным стопом: 0
- P0: 0 найдено
- P1: 31 найдено, 31 исправлено (100%)

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

## 29. P2 FIXED — ffmpeg release asset used `latest` without checksum

Файл и строка: `desktop/scripts/prepare-runtime.sh:35`

Суть: Windows ffmpeg URL pointed to GitHub `latest` and no SHA256 verification was enforced.

Последствие: release builds are not fully reproducible; upstream asset changes can break or alter builds.

Было:
```bash
FFMPEG_WIN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
curl -fSL --retry 3 --retry-delay 2 -o "${dest}.part" "${url}"
```

Стало:
```bash
FFMPEG_WIN_RELEASE="autobuild-2026-06-18-14-21"
FFMPEG_WIN_ASSET="ffmpeg-N-125093-gd2d371d10d-win64-gpl.zip"
FFMPEG_WIN_SHA256="90582d696445953f154beac0f73180961fe8c079db1c50238f9f28b5f84dfc1c"
fetch "${FFMPEG_WIN_URL}" "${zip}" "${FFMPEG_WIN_SHA256}"
```

Объяснение: Windows ffmpeg теперь pinned к конкретному BtbN release asset. `fetch()` валидирует cached/downloaded file по SHA256 и refetches cache, если URL/checksum metadata расходятся.

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

Последствие: изменение текста существующей записи или audio-sidecar могло не инвалидировать History/Stats cache, если число файлов не менялось.

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

## 34. P2 FIXED — uppercase `.TXT` recordings disappeared from History/Stats

Файл и строка: `backend/main.py:4481`, `backend/main.py:4598`

Суть: builders использовали `glob("*.txt")`, хотя save/get endpoints уже принимают `.TXT`.

Последствие: на case-sensitive filesystem запись `Existing.TXT` можно было сохранить и открыть напрямую, но она пропадала из History list и Stats summary.

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

## 35. P1 FIXED — release runtime build had no transitive wheel lock

Файл и строка: `desktop/scripts/prepare-runtime.sh:27`, `requirements.runtime-lock.txt:1`

Суть: `prepare-runtime.sh` устанавливал broad transitive wheel graph только из `requirements.txt`, без constraints lock.

Последствие: full app rebuild уходил в долгий `pip` backtracking по `numpy`, `huggingface-hub`, `filelock`, `fsspec`, `onnxruntime` и мог практически зависать до packaging stage.

Было:
```bash
pip_args+=(-r "${REQS}")
```

Стало:
```bash
REQS_LOCK="${ROOT_DIR}/requirements.runtime-lock.txt"
[ -f "${REQS_LOCK}" ] || die "missing runtime constraints lock: ${REQS_LOCK}"
pip_args+=(-c "${REQS_LOCK}")
pip_args+=(-r "${REQS}")
```

Объяснение: `requirements.txt` остается SSOT прямых backend dependencies, а `requirements.runtime-lock.txt` фиксирует уже существующий working bundled-runtime graph из установленного app. Release runtime build теперь fail-fast падает без constraints lock, чтобы не возвращаться к broad resolver path. Новые packages не добавлены; зафиксированы версии уже используемых transitive wheels.

## 36. P1 FIXED — dormant Graph still had an active backend/resource surface

Файл и строка: `backend/main.py:4669`, `frontend/src/main.tsx:9092`, `frontend/src/styles.css:2808`

Суть: Graph был скрыт в sidebar, но backend route/cache/builder и frontend graph implementation оставались активным кодом.

Последствие: прямой HTTP вызов или случайный restore view мог запускать полный graph scan, держать canvas/listeners и расходовать CPU/RAM для функции, которую мы пока не используем.

Было:
```python
@app.get("/api/recordings/graph")
def recordings_graph():
    return _build_recordings_graph_payload()
```

Стало:
```python
# Graph is intentionally dormant. The frontend sidebar/view and TS/CSS
# implementation are commented out, and the backend route is not registered
# so no graph scan can be triggered by OpenAPI or direct HTTP calls.
```

Объяснение: Graph теперь действительно dormant на всех boundary: HTML markup закомментирован, TS/CSS implementation снят с active bundle, backend route не регистрируется.

## 37. P1 FIXED — API token file had a permission race window

Файл и строка: `backend/main.py:481`, `backend/main.py:539`

Суть: auto-generated API token записывался обычным atomic writer, а `chmod 0600` выполнялся уже после rename.

Последствие: на системах с permissive umask token мог коротко появиться с более широкими permissions.

Было:
```python
atomic_write_text(API_TOKEN_PATH, token)
try:
    os.chmod(API_TOKEN_PATH, 0o600)
except Exception:
    pass
```

Стало:
```python
fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
...
os.replace(str(tmp), str(path))
os.chmod(path, 0o600)
```

Объяснение: `_secure_atomic_write_text()` создает временный token file сразу с `0600`, fsync-ит и только потом atomically replaces final path.

## 38. P2 FIXED — Deepgram `num_speakers` setting was ignored

Файл и строка: `backend/main.py:3656`, `backend/remote_deepgram.py:106`

Суть: API принимал `num_speakers`, но provider call не передавал параметр в Deepgram request.

Последствие: пользователь выбирал speaker count, а diarization работал в auto mode.

Было:
```python
out = deepgram_transcribe(api_key, input_path, language=language)
```

Стало:
```python
out = deepgram_transcribe(
    api_key,
    input_path,
    language=language,
    diarize=diarize,
    num_speakers=num_speakers,
)
```

Объяснение: provider boundary теперь валидирует `num_speakers` как integer 1..10 и добавляет его в Deepgram params только при включенной diarization.

## 39. P2 FIXED — Delete All missed uppercase `.TXT` recordings

Файл и строка: `backend/main.py:4674`

Суть: delete-all cleanup использовал lowercase-only scan в части старого recordings path.

Последствие: на case-sensitive filesystem `Existing.TXT` мог остаться после "Delete all", вместе с audio sidecar.

Было:
```python
for p in d.glob("*.txt"):
    ...
```

Стало:
```python
for p in _iter_recording_text_files(d):
    ...
```

Объяснение: destructive recording actions теперь используют тот же case-insensitive transcript iterator, что и list/stats/read paths.

## 40. P2 FIXED — audio retention missed uppercase `.TXT` sidecars

Файл и строка: `backend/main.py:2146`, `backend/main.py:2155`

Суть: audio pruning проверял наличие transcript через `entry.with_suffix(".txt")`.

Последствие: `Old.TXT` считался отсутствующим transcript, поэтому связанный `Old.webm` мог пережить retention cleanup или быть обработан неверно.

Было:
```python
if entry.stem != keep_stem and not entry.with_suffix(".txt").exists():
    entry.unlink()
```

Стало:
```python
if entry.stem != keep_stem and not _recording_text_sibling_exists(target_dir, entry.stem):
    entry.unlink()
```

Объяснение: sibling lookup теперь идет через `_iter_recording_text_files()` и не зависит от casing расширения.

## 41. P1 FIXED — log rotation deleted log files

Файл и строка: `desktop/main.js:304`, `desktop/main.js:314`

Суть: rotation удалял stale `main.log.rotating` и мог unlink-нуть pending archive при ошибках.

Последствие: диагностические logs терялись без явного запроса пользователя.

Было:
```js
if (fs.existsSync(pending)) fs.unlinkSync(pending);
fs.renameSync(MAIN_LOG_FILE, pending);
...
if (fs.existsSync(pending)) fs.unlinkSync(pending);
```

Стало:
```js
const pending = mainLogArchivePath("rotating");
const archived = mainLogArchivePath("archive");
fs.renameSync(MAIN_LOG_FILE, pending);
fs.renameSync(pending, archived);
```

Объяснение: rotation теперь всегда moves old logs into timestamped archive/recovered files and never deletes logs.

## 42. P1 FIXED — macOS install could merge a new app over stale bundle files

Файл и строка: `BUILD.command:47`

Суть: installed `.app` обновлялся прямым `ditto "$APP_DIR" "$target_app"`.

Последствие: файлы, удаленные из новой сборки, могли остаться в installed app bundle и влиять на runtime.

Было:
```bash
mkdir -p "$target_root"
ditto "$APP_DIR" "$target_app"
```

Стало:
```bash
tmp_app="$target_root/.${target_name}.installing.$$"
backup_app="$target_app.backup-$(date -u +%Y%m%dT%H%M%SZ)"
ditto "$APP_DIR" "$tmp_app"
codesign --verify --deep --strict "$tmp_app"
mv "$target_app" "$backup_app"
mv "$tmp_app" "$target_app"
```

Объяснение: install now stages a clean bundle, verifies it, then swaps it into place. Old bundle is preserved as a timestamped backup, not merged.

## 43. P1 FIXED — Linux source build bypassed packaged runtime SSOT

Файл и строка: `INSTALL.command:21`, `desktop/package.json:15`, `desktop/package.json:121`

Суть: Linux source entrypoint ran electron-builder directly instead of the desktop package script, while runtime preparation and resources lived in package config.

Последствие: AppImage could be built without the bundled Python/ffmpeg runtime even though docs and package config claimed packaged runtime support.

Было:
```bash
npm --prefix frontend run build
cd "$SCRIPT_DIR/desktop"
node ./unlockDist.js
npx electron-builder --linux AppImage --x64 "$@"
```

Стало:
```bash
npm --prefix desktop run dist:linux -- "$@"
```

Объяснение: `dist:linux` is now the single Linux package pipeline: prepare `runtime/linux-x64`, build frontend, unlock dist, and package AppImage with Linux `extraResources`.

## 44. P1 FIXED — frontend release build skipped TypeScript checking

Файл и строка: `frontend/package.json:8`

Суть: `npm --prefix frontend run build` executed only `vite build`.

Последствие: TypeScript regressions could ship because Vite transpiles without enforcing `tsc --noEmit`.

Было:
```json
"build": "vite build"
```

Стало:
```json
"typecheck": "tsc --noEmit",
"build": "tsc --noEmit && vite build"
```

Объяснение: release frontend build now fails on renderer TypeScript errors instead of relying on Vite's transpile-only build path.

## 45. P3 FIXED — frontend package-lock version drifted

Файл и строка: `frontend/package-lock.json:3`

Суть: `frontend/package.json` was `1.1.25`, lockfile root metadata was still `1.0.0`.

Последствие: scripts/tooling reading lock metadata could report the wrong frontend/app version.

Было:
```json
"version": "1.0.0"
```

Стало:
```json
"version": "1.1.25"
```

Объяснение: frontend lock metadata now matches the package version SSOT.

## 46. P1 FIXED — release npm graph used old vulnerable build/runtime stack

Файл и строка: `frontend/package.json:12`, `desktop/package.json:17`

Суть: frontend and desktop release builds were pinned to old Vite/Electron/electron-builder generations.

Последствие: `npm audit` reported vulnerabilities, the packaged app shipped on Electron 30, and the release pipeline missed the stricter validation available in the current builder.

Было:
```json
"devDependencies": {
  "typescript": "^5.6.3",
  "vite": "^5.4.10"
}
```

```json
"devDependencies": {
  "electron": "30.5.1",
  "electron-builder": "24.13.3"
}
```

Стало:
```json
"devDependencies": {
  "@types/node": "25.9.3",
  "typescript": "6.0.3",
  "vite": "8.0.16"
}
```

```json
"devDependencies": {
  "@electron/osx-sign": "2.4.0",
  "electron": "42.4.1",
  "electron-builder": "26.15.3"
}
```

Объяснение: package manifests and lockfiles now pin the current audited release toolchain. `npm audit --audit-level=moderate` passes for both npm workspaces.

## 47. P1 FIXED — mac signing hook imported a transitive package as if it were direct

Файл и строка: `desktop/afterPack.js:1`, `desktop/package.json:17`

Суть: `afterPack.js` required `@electron/osx-sign`, but `desktop/package.json` did not declare it directly.

Последствие: a package-manager graph change could prune or move the transitive module and make macOS release signing fail at package time.

Было:
```json
"devDependencies": {
  "electron": "30.5.1",
  "electron-builder": "24.13.3"
}
```

Стало:
```json
"devDependencies": {
  "@electron/osx-sign": "2.4.0",
  "electron": "42.4.1",
  "electron-builder": "26.15.3"
}
```

Объяснение: direct imports now have direct dependencies; signing no longer depends on electron-builder's private dependency graph.

## 48. P1 FIXED — electron-builder 26 rejected stale Windows/Linux config

Файл и строка: `desktop/package.json:106`, `desktop/package.json:129`

Суть: after upgrading builder, the config still used fields that are no longer valid in the installed schema.

Последствие: `./BUILD.command` failed before packaging with `Invalid configuration object`, so the app could not be rebuilt.

Было:
```json
"win": {
  "publisherName": "Transcriptor",
  "signAndEditExecutable": false,
  "sign": null
},
"linux": {
  "desktop": {
    "StartupWMClass": "Transcriptor"
  }
}
```

Стало:
```json
"win": {
  "signExecutable": false
},
"linux": {
  "category": "Audio",
  "synopsis": "Voice-to-text transcription with auto-paste"
}
```

Объяснение: config now matches `app-builder-lib/scheme.json` for `MacConfiguration`, `WindowsConfiguration`, and `LinuxConfiguration`; macOS packaging no longer fails on unrelated cross-platform config validation.

## 49. P1 FIXED — TypeScript 6 DOM types broke quick-settings toggle build

Файл и строка: `frontend/src/main.tsx:5835`

Суть: code passed `HTMLElement.hidden` directly into a boolean-only function, but current DOM types expose it as `string | boolean`.

Последствие: release frontend typecheck failed inside `./BUILD.command`, blocking app rebuilds.

Было:
```ts
const next = $("quickSettingsPanel").hidden;
syncQuickSettingsVisibility(next);
```

Стало:
```ts
const next = $("quickSettingsPanel").hidden !== false;
syncQuickSettingsVisibility(next);
```

Объяснение: the UI boundary now normalizes the DOM state to a strict boolean before calling the app state helper.

## 50. P1 FIXED — API token leaked through HTTP and WebSocket query strings

Файл и строка: `backend/main.py:1064`, `backend/main.py:2758`, `frontend/src/main.tsx:6833`

Суть: HTTP auth accepted `?token=...`, and live WebSocket auth sent the API token in the URL query.

Последствие: local access logs, crash logs, browser/devtools history, proxies, or screenshots could expose the API token.

Было:
```python
provided = (request.headers.get("x-api-token") or request.query_params.get("token") or "").strip()
token = (websocket.query_params.get("token") or "").strip()
await websocket.accept()
```

```ts
wsQuery.set("token", apiToken());
ws = new WebSocket(wsBase() + "/ws/transcribe?" + wsQuery.toString());
```

Стало:
```python
provided = (request.headers.get("x-api-token") or "").strip()
token = _websocket_api_token(websocket)
await websocket.accept(subprotocol=_websocket_accept_subprotocol(websocket))
```

```ts
ws = new WebSocket(
  wsBase() + "/ws/transcribe?" + wsQuery.toString(),
  websocketAuthProtocols(),
);
```

Объяснение: HTTP auth теперь принимает token только из `X-Api-Token`; browser WebSocket передает token как base64url subprotocol (`transcriptor-token.<payload>`), а accepted subprotocol возвращается без секрета.

## 51. P1 FIXED — macOS arm64/Linux ffmpeg release inputs were not fully pinned

Файл и строка: `desktop/scripts/prepare-runtime.sh:44`

Суть: macOS arm64 ffmpeg archive was fetched without SHA256 validation, and Linux used the mutable `ffmpeg-release-amd64-static.tar.xz` alias.

Последствие: release builds were not reproducible across platforms; a changed or corrupted upstream asset could enter the packaged runtime silently.

Было:
```bash
FFMPEG_MAC_ARM64_URL="https://www.osxexperts.net/ffmpeg71arm.zip"
FFMPEG_LINUX_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
fetch "${url}" "${zip}"
fetch "${FFMPEG_LINUX_URL}" "${tar}"
```

Стало:
```bash
FFMPEG_MAC_ARM64_SHA256="0878f3313311c2c1b2c818e7c955c0bd828c97b357fa86211b42a5c36d01e36f"
FFMPEG_LINUX_ASSET="ffmpeg-7.0.2-amd64-static.tar.xz"
FFMPEG_LINUX_SHA256="abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67"
fetch "${url}" "${zip}" "${sha256}"
fetch "${FFMPEG_LINUX_URL}" "${tar}" "${FFMPEG_LINUX_SHA256}"
```

Объяснение: every bundled ffmpeg asset now has immutable URL intent plus SHA256 validation through the existing `fetch()` SSOT.

## 52. P3 FIXED — LICENSE omitted Linux bundled runtime distribution

Файл и строка: `LICENSE:30`

Суть: license notes said bundled Python/ffmpeg were distributed only for Windows and macOS.

Последствие: legal/docs inventory did not match the actual Linux AppImage packaging.

Было:
```text
Windows + macOS installers.
binary for Windows + macOS.
```

Стало:
```text
Windows x64, macOS arm64, and Linux x64 installers.
binary for Windows x64, macOS arm64, and Linux x64.
```

Объяснение: third-party component disclosure now follows the same platform matrix as electron-builder `extraResources`.

## 53. P2 FIXED — Windows release docs used PowerShell for a Bash-only build script

Файл и строка: `README.md:75`, `desktop/package.json:18`, `desktop/scripts/require-bash.js:1`, `INSTALL.command:25`

Суть: README showed the Windows package command inside a PowerShell block and the npm script failed with a raw missing-`bash` error.

Последствие: Windows release builds could fail immediately for users running the documented command in plain PowerShell/cmd, without explaining the required shell.

Было:
```powershell
npm --prefix desktop run dist:win
```

Стало:
```bash
npm --prefix desktop run dist:win
```

```js
"dist:win": "node ./scripts/require-bash.js win-x64 && bash ./scripts/prepare-runtime.sh win-x64 && ..."
```

Объяснение: README and INSTALL now state the Bash requirement, and `dist:win` fail-fast reports the required shell before runtime preparation starts.

## 54. P1 FIXED — Node version requirement was implicit and not enforced by repo metadata

Файл и строка: `README.md:46`, `frontend/package.json:6`, `desktop/package.json:8`

Суть: current Vite/Electron release tooling requires modern Node, but the repo had no `.node-version`, `.nvmrc`, or package `engines`.

Последствие: source builds could fail with opaque npm/engine errors on older Node installations.

Было:
```json
{
  "scripts": {
    "build": "tsc --noEmit && vite build"
  }
}
```

Стало:
```json
{
  "engines": {
    "node": ">=22.12.0",
    "npm": ">=10"
  }
}
```

Объяснение: Node runtime expectations are now visible in README, package manifests, lockfiles, `.node-version`, and `.nvmrc`.

## 55. P1 FIXED — backend runtime import check covered only a subset of runtime dependencies

Файл и строка: `desktop/main.js:8`, `desktop/main.js:5681`

Суть: Electron startup verified only `fastapi`, `uvicorn`, `multipart`, and `cryptography`, missing core runtime imports such as `faster_whisper`, `soundfile`, `numpy`, `requests`, and `websockets`.

Последствие: a broken bundled runtime could pass boot checks and fail later during transcription or provider calls.

Было:
```js
["-c", "import fastapi, uvicorn, multipart, cryptography"]
```

Стало:
```js
const BACKEND_RUNTIME_IMPORTS = Object.freeze([
  "fastapi", "uvicorn", "multipart", "cryptography", "faster_whisper",
  "soundfile", "numpy", "requests", "websockets",
]);
const BACKEND_RUNTIME_IMPORT_CHECK = `import ${BACKEND_RUNTIME_IMPORTS.join(", ")}`;
["-c", BACKEND_RUNTIME_IMPORT_CHECK]
```

Объяснение: startup and post-install verification now share one runtime import SSOT, so dependency drift is caught before the app exposes a broken backend.

## 56. P1 FIXED — python-build-standalone runtime downloads were unverified

Файл и строка: `desktop/scripts/prepare-runtime.sh:61`, `desktop/scripts/prepare-runtime.sh:106`, `desktop/scripts/prepare-runtime.sh:137`

Суть: Python runtime tarballs were pinned by version tag but fetched without SHA256 verification.

Последствие: a corrupted or replaced Python runtime archive could be cached and packaged without detection.

Было:
```bash
fetch "${url}" "${cached}"
```

Стало:
```bash
python_sha256_for_triple() {
  case "${triple}" in
    aarch64-apple-darwin) printf '%s\n' "38f71c324ae14ee5ef844c62e06b6faa5ba3040c898b4c1d03b8b6e88794356b" ;;
    x86_64-apple-darwin) printf '%s\n' "bf9e2eb4834272cae196e4a8473d48f15878114cedbc278fe53cd85ab28dc0ed" ;;
    x86_64-pc-windows-msvc) printf '%s\n' "d785d2e901a8194dcdb8c23c2b37a46ed84fdc04e87398dc5b832644330de71e" ;;
    x86_64-unknown-linux-gnu) printf '%s\n' "3c3427e5628648478da2aa227472c350475a68bc58109f1b43849636a4aecb89" ;;
  esac
}
fetch "${url}" "${cached}" "$(python_sha256_for_triple "${triple}")"
```

Объяснение: `fetch()` now requires SHA256 for every release artifact, including Python; unsupported triples fail closed instead of downloading unverified runtime code.

## 57. P1 FIXED — macOS signer tried to codesign Electron binary resource files

Файл и строка: `desktop/afterPack.js:90`, `desktop/afterPack.js:457`

Суть: `@electron/osx-sign` walked every binary file under `Contents`, and our per-file hook gave entitlements to non-code Electron resources such as `*.pak` locale/resource files.

Последствие: Electron 42 macOS packaging failed during signing with `No such file or directory` for `Electron Framework.framework/.../lv.lproj/locale.pak`, blocking release builds.

Было:
```js
await signApp({
  app: appPath,
  optionsForFile: (filePath) => ({ entitlements: inheritEntitlements, hardenedRuntime: true }),
});
```

Стало:
```js
function shouldIgnoreOsxSignPath(filePath, appPath, runtimeRoot) {
  if (filePath === appPath) return false;
  if (pathIsInside(filePath, runtimeRoot)) return true;
  if (filePath.endsWith(".app") || filePath.endsWith(".framework")) return false;
  const kind = classifyMacho(filePath);
  return kind === "non-macho" || kind === "macho-other";
}

await signApp({
  app: appPath,
  ignore: (filePath) => shouldIgnoreOsxSignPath(filePath, appPath, runtimeRoot),
  optionsForFile: (filePath) => ({ entitlements: inheritEntitlements, hardenedRuntime: true }),
});
```

Объяснение: runtime Mach-O files are pre-signed once, Electron app/framework bundles are still signed by `osx-sign`, and non-Mach-O binary resources remain unsigned resources captured by the top-level CodeResources envelope.

## 58. P1 FIXED — stale macOS Intel runtime target contradicted arm64-only build policy

Файл и строка: `desktop/scripts/prepare-runtime.sh:12`, `README.md:11`, `PROJECT_STRUCTURE.md:95`

Суть: changelog/build scripts already made macOS release packaging arm64-only, but `prepare-runtime.sh`, README, and project docs still advertised a mac-x64 bundled runtime path.

Последствие: `prepare-runtime.sh mac-x64` and `prepare-runtime.sh all` failed because the wheel-only runtime graph pins `cryptography==49.0.0`, and that version publishes macOS arm64 wheels but no macOS x86_64 wheels.

Было:
```bash
# Usage included mac-x64
mac-x64) build_mac_x64 ;;
all)
  build_win_x64
  build_mac_arm64
  build_mac_x64
  build_linux_x64
  ;;
```

Стало:
```bash
# macOS packaged runtime support is arm64-only.
all)
  build_win_x64
  build_mac_arm64
  build_linux_x64
  ;;
```

Объяснение: platform support now has one truth across script usage, README, LICENSE, PROJECT_STRUCTURE, and changelog: macOS arm64, Windows x64, Linux x64. The impossible Intel runtime path no longer breaks `all`.

## Verification

Пройдено:
```text
python3 -m unittest discover backend/tests -q
python3 -m compileall -q backend
npm --prefix frontend audit --audit-level=moderate
npm --prefix desktop audit --audit-level=moderate
npm --prefix frontend ci --dry-run --ignore-scripts
npm --prefix desktop ci --dry-run --ignore-scripts
npm --prefix frontend run build
npm --prefix desktop run build:frontend
node --check desktop/main.js && node --check desktop/preload.js && node --check desktop/unlockDist.js && node --check desktop/afterPack.js && node --check desktop/scripts/require-bash.js
bash -n BUILD.command INSTALL.command desktop/scripts/prepare-runtime.sh
node desktop/scripts/require-bash.js win-x64
bash desktop/scripts/prepare-runtime.sh all
./BUILD.command
codesign --verify --deep --strict /Applications/Transcriptor.app
codesign --verify --deep --strict ~/Applications/Transcriptor.app
git diff --check
```
