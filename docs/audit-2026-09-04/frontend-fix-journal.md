# Ultra-Audit · FRONTEND · фаза FIX — журнал

Базовая точка: `889c91a`. Базовая верификация до правок:
`typecheck` ok, `lint` ok, `test` **196 passed (17 files)**, `build` ok.

---

## Коммит `74ff589` — P0

**Заголовок:** A failed upload-queue load no longer wipes every completed upload's transcript

**Находки:** U-001 (P0). Побочно подготовлена почва для U-006 (версия схемы) —
не тронута в этом коммите намеренно.

**Файлы:**
* `frontend/src/upload-queue-restore.ts` (новый, 84 строки)
* `frontend/tests/upload-queue-restore.test.ts` (новый, 9 тестов)
* `frontend/src/main.tsx` (`restoreUploadQueueSnapshot`, импорт)

**Перепроверка на текущем коде.** Воспроизводится дословно: `main.tsx:13136-13159`
до правки — `catch { console.warn(...) }`, затем безусловные
`uploadQueueSnapshotLoaded = true; await flushUploadQueueSnapshotNow();`.
Семантика записи бэкенда подтверждена: `backend/main.py` `PUT /api/ui/upload-queue`
→ `atomic_write_json(UPLOAD_QUEUE_STATE_PATH, _normalize_upload_queue_state(payload))`
— полная замена файла.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  18 passed (18)
      Tests  205 passed (205)
$ npm --prefix frontend run typecheck   # чисто
$ npm --prefix frontend run lint        # чисто
$ npm --prefix frontend run build       # ✓ built in 8.55s
```

Тест `tests/upload-queue-restore.test.ts` до правки не существовал вместе с
предметом (решение было размазано по потоку управления async-функции и
непроверяемо); первый же его кейс —
«never writes anything back when the backend read failed» — падал бы на прежней
реализации, потому что прежняя реализация всегда возвращала бы
`persist: true, markLoaded: true`.

**Решения.**
* Выбрано: вынести решение «что можно писать после попытки чтения» в чистый
  модуль (`decideUploadQueueRestore` + `shouldDropLegacyUploadQueueSnapshot`).
  Причина: регион U целиком не покрыт тестами (U-022), а внутри `main.tsx`
  правку нечем доказать. Модуль даёт и тест, и одно место, где правило записано
  словами.
* Отвергнуто: просто `if (!serverReadOk) return;`. Хуже — правило остаётся
  невыразимым и непроверяемым, а второй читатель (сброс legacy-ключа) продолжает
  выводить его самостоятельно.
* Отвергнуто: слияние на бэкенде (merge вместо replace). Это чужой регион
  (другой агент), и это лечит симптом: рендерер всё равно не должен писать то,
  чего не читал.
* При провале чтения латч `uploadQueueSnapshotLoaded` остаётся опущенным —
  `beginUploadQueueSnapshotRestore` обнуляет `uploadQueueRestorePromise` в
  `finally`, поэтому следующий вход в Upload честно перезапустит restore.

**Не сделано:** —

---

## Коммит `0c916b9` — мета-находки аудита

**Заголовок:** Tests are type-checked and the microphone-health FSM is covered by the frontend suite

**Находки:** F-010 / C-023 (`tests/` вне `tsconfig.include`), F-009 (`mic-health.ts` без тестов).

**Файлы:** `frontend/tsconfig.json`, `frontend/vitest.config.ts`,
`frontend/tests/mic-health.test.ts` (новый, 30 тестов), `frontend/src/mic-health.ts` (шапка).

**Перепроверка.** F-010 воспроизводится. F-009 — **частично устарела**: тесты FSM
существуют, но в `backend/tests/test_mic_health.py`, который компилирует
`frontend/src/mic-health.ts` через `tsc` из pytest «потому что у фронтенда нет
JS-раннера» — утверждение, ложное с момента появления vitest, и который
**пропускается молча**, если нет node/tsc. То есть находка верна по существу
(в гейте фронтенда покрытия нет), но не «тестов нет вовсе».

**Верификация (дословно).**

```
# старый include + намеренная ошибка типа в tests/text-match.test.ts
$ npm run typecheck
> tsc --noEmit
(ничего — ошибка не видна)

# новый include + та же ошибка
$ npm run typecheck
> tsc --noEmit
tests/text-match.test.ts(90,7): error TS2322: Type 'string' is not assignable to type 'number'.

$ npx tsc --noEmit --listFiles | grep -c "/frontend/tests/"
18

$ npm --prefix frontend test
 Test Files  19 passed (19)
      Tests  235 passed (235)
```

**Решения.**
* Выбрано: `include: ["src", "tests", "vite.config.ts", "vitest.config.ts"]`.
  Работает сразу, без правок тестов (`noUnusedLocals`/`noUnusedParameters` не
  задеты).
* Отвергнуто: `test: "vitest run --typecheck"` (совет аудита). Хуже: удваивает
  время прогона и дублирует гейт, который теперь даёт `npm run typecheck` —
  команда, которую AGENTS.md и так требует перед каждым коммитом. Блок
  `typecheck` в `vitest.config.ts` оставлен (теперь указывает на конфиг, который
  тесты видит) и снабжён комментарием, объясняющим разделение ролей.
* `backend/tests/test_mic_health.py` **не тронут** — чужой регион и удаление
  теста запрещено уставом. Требует решения человека (см. итог).

**Не сделано:** —

---

## Коммит `3ee4cb9` — P1, тёплый захват

**Заголовок:** The warm microphone hold and its pre-roll can now actually engage…

**Находки:** F-001. Побочно: гипотеза 5 региона F (`micTrackWatchersStream` не
сбрасывается на холодной остановке) — теперь достижима ветка `releaseWarmCapture`,
которая его и обнуляет.

**Файлы:** `frontend/src/main.tsx`, `frontend/src/capture-warm.ts`,
`frontend/tests/capture-warm.test.ts`.

**Перепроверка на текущем коде.** Открыта дословно: `stream.getTracks().forEach(t=>t.stop())`
в `stopLive` шаг 1 (было `main.tsx:10827`), `holdWarmCapture()` в teardown (было `11070`).

**Что сделано.**
1. `holdWarmCapture` разделён на `planWarmCaptureHold()` (решение + `{type:"arm"}`
   ворклету, модульные слоты НЕ трогаются) и `commitWarmCaptureHold(plan)`
   (перенос владения, обнуление слотов) — потому что барьер `flushWorkletPort`
   между ними читает `workletNode`.
2. Шаг 1 стоп-последовательности: `freezeCaptureForStop({planHold, stopTracks})`.
   На «нет» треки глушатся ровно как раньше; на «да» пайплайн замораживает
   `arm` (ворклет флашит накопленное и больше ничего не отдаёт) — та же гарантия
   «ни один кадр после этой точки не попадёт в sink/сокет».
3. `stopMediaRecorderAndFlush()` поднят на шаг 1 (по-прежнему без `await`):
   WebM-контейнер питается от MediaStream, а не от ворклета, поэтому при тёплом
   удержании он один продолжал бы писать пост-стоп аудио.
4. `handOverHeldCapture` в teardown: если запланированное удержание не состоялось
   (слоты сменились), микрофон глушится здесь — единственный режим отказа,
   который переупорядочивание могло бы внести.
5. Один хелпер `stopCaptureTracks()` на обе точки остановки.

**Верификация.**

```
$ npx vitest run tests/capture-warm.test.ts
 Test Files  1 passed (1)
      Tests  32 passed (32)     # было 25
$ npm --prefix frontend test
 Test Files  19 passed (19)
      Tests  242 passed (242)
$ npm --prefix frontend run typecheck / lint / build — чисто, ✓ built
```

Семь новых тестов в блоке «the stop-sequence ordering (F-001)». Ключевой —
`end to end: a live track is held, and the same graph refused once it has ended`:
на старом порядке достижима была ТОЛЬКО вторая половина.

**Прогон по коду (второй старт, чего нельзя записать здесь микрофоном).**
`stopLive` шаг 1 → `planWarmCaptureHold` → `decideWarmHold({trackLive:true,…})`
→ `{hold:true,reason:"held"}` → `port.postMessage({type:"arm",preRollMs:500})`
→ треки НЕ глушатся → teardown → `commitWarmCaptureHold` → `warmCapture` заполнен,
слоты обнулены, TTL 30 000 мс.
Следующий старт: `takeWarmCapture(deviceId)` → `decideWarmReuse` видит
`streamHasLiveAudio(held.stream) === true` (трек не останавливали) → reuse →
`sessionStartedWarm = true` → `port.postMessage({type:"start"})` → ворклет отдаёт
`{type:"pre-roll"}` из кольца → `acceptPreRoll` → `sessionPreRollMs = verdict.durationMs`
→ трасса `[trace startLive] … warm=1 preRollMs=500`.

**Решения.**
* Выбрано: разделение plan/commit вместо простого переноса вызова вверх
  (как предлагал аудит). Причина: `holdWarmCapture` обнуляет `workletNode`, а
  шаги 2-5 стоп-последовательности его читают — буквальный перенос сломал бы
  барьер `flushWorkletPort`.
* Выбрано: `arm` как эквивалент `track.stop()` для заморозки пайплайна.
  Доказательство в `pcm-worklet.js`: `arm()` вызывает `flushPending()` и ставит
  `this.armed = true`, после чего `process()` ничего не постит.
* Отвергнуто: оставить MediaRecorder на шаге 3. Хуже — на тёплой ветке микрофон
  жив, и контейнер писал бы пост-стоп аудио, которое потом взвешивает
  `selectCanonicalCapturedAudio`.
* Отвергнуто: тест порядка через чтение исходника (`indexOf` по main.tsx).
  Хуже — хрупко и проверяет текст, а не поведение. Вместо этого кооперация
  вынесена в модуль с инъекцией — ровно то, что рекомендует раздел «уровень
  инженерии» самого аудита.
* Не трогал `discarding`: удержание на отброшенном дубль-тапе полезно (следующее
  нажатие будет немедленно), а `stopTailHoldMs` для него и так пропускается.

**Не сделано:** —

---

## Коммит `585b45f` — P1, целостность настроек

**Заголовок:** A failed settings load no longer lets the next click overwrite keyterms, the archive path and both hotkeys with defaults

**Находки:** F-002, R-006 (и его близнецы R-016/S-05 частично), U-006 (+ H-1).

**Файлы:** `frontend/src/settings-autosave.ts` (новый),
`frontend/tests/settings-autosave.test.ts` (новый, 4 теста),
`frontend/src/main.tsx`, `frontend/index.html`, `frontend/tests/deepgram-dual.test.ts`.

**Перепроверка.** Все три открыты дословно на текущем HEAD.

**Что сделано.**
* `uiPreferencesLoaded` — новое состояние «настройки ни разу не прочитаны».
  Правило вынесено в `settings-autosave.ts` (`mayAutosaveUiPreferences`), где
  явно разведены `suppressed` (guard от реентрантности, снимается в `finally`)
  и `loaded` (факт успешного чтения, который `finally` снять не может).
* Провал `loadCfg` теперь виден: `setSettingsArchiveStatus(... "error")` +
  `showRecordSessionNotice(... 9000)`.
* `loadCfgOnce()` — single-flight повтор загрузки; вызывается со старта и из
  `refreshNetworkState` после первого успешного `/api/health`.
* `index.html`: `#deepgramDualStreamCheck` получил `checked` (бэкендовый
  дефолт `DUAL_STREAM_DEFAULT = true`).
* `uploadQueueSnapshotPayload`: `version: uploadQueueServerVersion` вместо
  литерала `1`; тип `UploadQueueStoragePayload.version` — `number`.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  20 passed (20)
      Tests  247 passed (247)
$ typecheck / lint / build — чисто, ✓ built
```

Доказательство «падало до, проходит после» для R-006 (единственный из трёх,
который вообще можно проверить тестом):

```
$ git stash push index.html && npx vitest run tests/deepgram-dual.test.ts
     × #deepgramDualStreamCheck carries DUAL_STREAM_DEFAULT 9ms
AssertionError: expected false to be true // Object.is equality
      Tests  1 failed | 6 passed (7)
$ git stash pop && npx vitest run tests/deepgram-dual.test.ts
      Tests  7 passed (7)
```

**Решения.**
* Выбрано: правило автосейва — в модуль, как в P0. Причина: единообразие и
  проверяемость; тест `refuses to write preferences that were never read`
  описывает ровно то состояние, в котором ломался продукт.
* Выбрано: повтор загрузки на health-поллинге, а не на кнопке Retry
  boot-оверлея (совет аудита). Причина: Retry перезагружает рендерер целиком —
  хук там был бы мёртвым кодом. Health-поллинг — единственное место, где
  «бэкенд ответил впервые» наблюдается.
* Отвергнуто: разрешать автосейв, но слать только изменённые ключи (частичный
  апдейт). Хуже — это второй формат записи конфига и вторая семантика merge на
  бэкенде, ради обхода состояния, которое проще назвать.
* Отвергнуто (пока): вынести `DUAL_STREAM_DEFAULT` в bootstrap-инъекцию из
  бэкенда (R-016 целиком). Требует правки `backend/` — чужой регион; вместо
  этого закрыт достижимый путь расхождения (разметка) тестом. См. «требует
  решения человека».

**Не сделано в этом коммите:** тест на `uiPreferencesLoaded` в живом
`main.tsx` (DOM-связанный код не покрыт ничем; проверено прогоном по коду) —
и на `version: uploadQueueServerVersion` (та же причина).

---

## Коммит `9afe53e` — P1, обвязка UI

**Заголовок:** The provider picker, the model download button, the History window and four other controls now do what they claim

**Находки:** C-001, C-002, C-003, C-004, C-005 (= R-002), R-001, R-003, U-003,
U-004, U-005. Попутно (P2): C-012 (копия модалки), U-008 (недостижимая проверка
ключа), U-018 (`isUploadTerminalStatus` вместо трёх литералов ×2), W-6 (TDZ-
зависимый порядок объявлений в `wireLocalModelsUi`), одна из строк
хардкод-индекса R («Audio for this recording could not be loaded.» ×2 →
`AUDIO_LOAD_FAILED_TEXT`).

**Перепроверка.** Все десять открыты дословно на текущем HEAD.

**Файлы:** `frontend/src/main.tsx`, `frontend/src/gated-poll.ts`,
`frontend/src/list-window.ts`, `frontend/src/styles.css`,
`frontend/tests/gated-poll.test.ts`, `frontend/tests/list-window.test.ts`.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  20 passed (20)
      Tests  257 passed (257)
$ typecheck / lint / build — чисто, ✓ built
```

Доказательство «падало до, проходит после» для U-005:

```
$ git stash push src/gated-poll.ts && npx vitest run tests/gated-poll.test.ts
     × runs the queued refresh once the in-flight tick finishes 4ms
     × coalesces several mid-tick refreshes into one catch-up run 2ms
      Tests  2 failed | 13 passed (15)
$ git stash pop && npx vitest run tests/gated-poll.test.ts
      Tests  15 passed (15)
```

R-001 покрыт шестью тестами `shouldResetWindowAfterLoad` в `list-window.test.ts`
(новая чистая функция; ключевой кейс — «keeps the window on a background
refresh that only prepends a new recording»).

**Решения.**
* C-001: `wantsNone` входит и в подпись, и в сборку — одна переменная вместо
  двух независимых условий, чтобы третьего расхождения не возникло.
* C-002: `sel.value` присваивается безусловно **только** для `#providerSelect`.
  Отвергнуто: присваивать и зеркалу Upload — у него нет опции «None», и `""`
  дал бы `selectedIndex = -1`, то есть пустой селект. Исключение записано в
  комментарии.
* C-003: заведён `pendingModelDownloadCandidate` (вопрос модалки) отдельно от
  `pendingModelSelection` (пин применения после успешной загрузки). `closeModal`
  теперь сбрасывает только вопрос: пин от ДРУГОЙ, ещё летящей загрузки не его
  дело. Отвергнуто: писать `pendingModelSelection` в `change`-обработчике —
  это вернуло бы BUG-45 (селект как источник состояния, а не вид).
* R-001: решение вынесено в `list-window.ts` (`shouldResetWindowAfterLoad`) —
  там уже живёт вся оконная политика. Правило: сброс, если сменилась директория
  архива ИЛИ ни один из видимых ключей не пережил загрузку. Отвергнуто:
  «сбрасывать только при `!background`» — не покрывает смену директории,
  которая тоже приходит фоном.
* R-003: `setStatus` (видна из любого вида) + `resetRecordingViewer(summary)`
  ПОСЛЕ `loadRecordings`, а не до.
* U-005: `refreshQueued` + догоняющий проход в `finally`. `return` из `finally`
  запрещён линтером (`no-unsafe-finally`) — переписано на `if/else` без
  раннего выхода.
* U-004: поле `providerFallbackNote` в `UploadQueueItem`, заполняется тем же
  `localFallbackReason`, что и Live-путь; отдельный класс `.upload-queue-item-note`
  (нейтральный `--text-2`, а не danger — это не ошибка).
* U-008: недостижимая проверка ключа удалена, а не «оставлена на всякий
  случай»: `resolveEffectiveProvider` строкой выше уже вернул `local`, и
  `await` между ними нет. Причина записана в комментарии.

**Не сделано в этом коммите:** тестов на C-001…C-005, R-003, U-003, U-004 нет —
весь этот код живёт в `main.tsx` и связан с DOM; проверено прогоном по коду.

---

## Коммит `06f3330` — P1, CSP и слой представления

**Заголовок:** The CSP actually pins the WebSocket to the backend origin, and the designed styles are the ones that render

**Находки:** C-006, C-007, C-008, U-002. Попутно (P2): U-011 (класс
`update-check-status-link` не снимался), S-13 (5 необъявленных токенов),
S-14 (9 токенов с противоречащими fallback-литералами), S-19 (второй
`@keyframes boot-spin`), W-14, W-15 (`.model-row-empty` ×2), W-16
(литерал вместо `--overlay-backdrop`).

**Файлы:** `frontend/index.html`, `frontend/src/styles.css`,
`frontend/src/main.tsx`, `frontend/tests/styles-tokens.test.ts` (новый),
`frontend/styles.css` (удалён через `git rm`).

**Перепроверка.** Все четыре открыты дословно на текущем HEAD.

**C-006 — эмпирическая проверка, а не рассуждение о спецификации.**
Заявление «`'self'` в CSP3 покрывает `ws://` того же origin» проверено в
Chromium через Browser pane: страница на `http://localhost:8791` с
`connect-src 'self' https://api.github.com`.

```
# позитивный кейс: ws:// на свой же host
constructed WebSocket without throwing
ws onerror (connection refused is expected; CSP block also lands here)
ws onclose code=1006
console: WebSocket connection to 'ws://localhost:8791/ws/probe' failed:
→ НИ ОДНОГО securitypolicyviolation: CSP пропустил, обрыв на транспорте
  (статический сервер не говорит по WebSocket)

# негативный контроль: ws:// на чужой host, та же политика
constructed WebSocket without throwing
CSP-VIOLATION directive=connect-src blocked=ws://evil.example.com:9/x
ws onerror
```

То есть после правки политика ровно та, которую обещает комментарий:
сокет на свой origin разрешён, на чужой — заблокирован. Порт при этом
нигде не дублируется: рендерер строит URL из `location.host` (`wsBase()`,
`main.tsx:870`), и origin страницы И ЕСТЬ то единственное место, где
динамический порт известен — генерировать CSP не из чего и незачем.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  21 passed (21)
      Tests  262 passed (262)
$ typecheck / lint — чисто
$ npm --prefix frontend run build → ✓ built
$ grep -o "connect-src [^;]*" dist/index.html
connect-src 'self' https://api.github.com
$ grep -c "update-check-status" dist/assets/*.js
5                      # правила update-check теперь В СБОРКЕ (были в 0)
```

Доказательство «падало до, проходит после» для S-13/S-14: первый прогон
`tests/styles-tokens.test.ts` на исходном `styles.css` дал

```
Tests  1 failed | 4 passed (5)
+ [ "--danger-bg: #2a1818 | rgba(239, 68, 68, 0.12)",
+   "--danger-text: #ef4444 | #f87171 | #ff8080",
+   "--text-2: #6b7280 | #777777 | #a0a0a0 | #c4c4c4",
+   … 9 токенов ]
```

**Решения.**
* C-006: `connect-src 'self' https://api.github.com`. Отвергнуто: подставлять
  `ws://localhost:<port>` в CSP при сборке/инъекции бэкенда — это ВТОРОЙ
  источник порта рядом с `location.host`, ровно то, что устав запрещает, и он
  ломается на любом изменении хоста.
* C-007: фолбэк переписан на те же классы и ту же специфичность, объявлен
  раньше дизайн-системы. Спиннер из фолбэка убран (второй `@keyframes` вместе
  с ним) — иначе фолбэк неотличим от нормального состояния.
* C-008/S-13: пять необъявленных токенов заменены на реальные
  (`--text-dim`→`--text-2`, `--ok`→`--net-online`, `--err`→`--danger-text`,
  `--surface`→`--glass-modal-bg`, `--accent` исчез вместе с правилом).
* S-14: снято 83 fallback-литерала у ОБЪЯВЛЕННЫХ токенов. Отвергнуто:
  привести литералы в соответствие значениям токенов — это оставляет второй
  источник, который снова разъедется; fallback у объявленного токена
  недостижим по определению, а окно «стили ещё не загрузились» закрывает
  инлайн-блок в `index.html`.
* U-002: `git rm frontend/styles.css` (не «оставить на всякий случай» —
  файл не собирается ничем и вводит в заблуждение); правила перенесены в конец
  `src/styles.css`. `--accent, #6ee7b7` в тоне «new» заменён на `--net-online`.

**Не сделано:** —

---

## Коммит `27fba8d` — P1, SSOT-константы и снапшот сессии

**Заголовок:** Auto-stop-on-silence has one set of numbers, and speaker diarization is snapshotted at start and remembered between launches

**Находки:** F-003 (= S-03, строка 1 индекса «хардкод → SSOT»), F-006 (= R-004,
R-030).

**Файлы:** `frontend/src/main.tsx`, `frontend/index.html`,
`frontend/tests/auto-stop-silence.test.ts` (новый, 5 тестов).

**Перепроверка на текущем коде.**
* F-003 — открыта: 4 копии (`index.html:733/735`, `getAutoStopSilenceConfig`,
  `loadCfg`, `desktop/main.js:332`).
* F-006/R-004/R-030 — открыта: 5 чтений `#diarizeCheck`, 4 из них жёстким
  кастом через `document.getElementById`; поля в снапшоте нет; настройка не
  сохраняется.
* **F-004 — устранено удалением в `889c91a`.** `normalizeWordsCompat` в
  `transcript-merge.ts` больше не существует (файл ужат с 993 до 64 строк).
* **F-014 — устранено удалением в `889c91a`.** Псевдонима `wordCountOf` в
  `main.tsx` нет.
* **F-005 — устранено в `889c91a`.** Ветка не-стриминговых провайдеров теперь
  проставляет `transcriptSource` во всех четырёх точках изменения
  `transcriptRaw` (`main.tsx:12228 "remote"`, `12238`/`12249`
  `"ondisk-fallback"`/`"none"`). Инвариант соблюдён.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  22 passed (22)
      Tests  267 passed (267)
$ typecheck / lint / build — чисто, ✓ built
```

Доказательство «падало до, проходит после» для F-003:

```
$ git stash push index.html && npx vitest run tests/auto-stop-silence.test.ts
     × #autoStopSilenceSeconds carries no min/max/value attribute 6ms
     × #autoStopSilenceDb carries no min/max/value attribute 1ms
AssertionError: expected '<input id="autoStopSilenceSeconds"\n …' not to match /\bmin=/
      Tests  2 failed | 3 passed (5)
$ git stash pop && npx vitest run tests/auto-stop-silence.test.ts
      Tests  5 passed (5)
```

**Решения.**
* F-003: `UI_TOKENS.autoStopSilence` + два клампера (`clampAutoStopSeconds`,
  `clampAutoStopThresholdDb`), которые читают оба потребителя;
  `applyAutoStopSilenceBounds()` пишет атрибуты в разметку на бутстрапе.
  Вызов размещён в блоке бутстрапа, а НЕ рядом с
  `installAppearanceStateClasses()`: `UI_TOKENS` — `const`, и вызов до его
  инициализации упал бы в TDZ на старте.
* Четвёртая копия — `desktop/main.js:332` — **не тронута** (чужой регион).
  Вместо правки написан тест-сверка `DEFAULT_RECORDING_AUTO_STOP_CONFIG`
  против токена: значения сегодня совпадают, и любое расхождение теперь
  роняет фронтовый прогон. Полный перенос desktop на `liveStatusSnapshot`
  требует решения человека (см. итог).
* F-006: `diarize` — поле `LiveSessionSnapshot`, заполняется в обеих точках
  построения снапшота (старт и резервный снимок в `stopLive`); три
  восстановительных прохода читают `diarizeValue`. Путь History
  «Re-transcribe» (`main.tsx:8131`) намеренно оставлен на
  `readDiarizeEnabled()`: это не сессия, там нет снапшота, и пользователь
  задаёт настройку прямо сейчас.
* R-004: слушатель `change` + поле `diarize` в `collectUiPreferences` + ветка
  восстановления в `loadCfg` + ключ `diarize?: boolean` в типе `AppConfig`.

**Не сделано:** —

---

## Коммит `58bafe8` — P1 (последняя), производительность History

**Заголовок:** Scrolling History no longer refilters the whole archive on every scroll event

**Находки:** R-005 (= U-021).

**Файлы:** `frontend/src/main.tsx`.

**Что сделано.** `getFilteredRecordings()` мемоизирован; инвалидация у двух
писателей — присваивание `recordingItems` в `loadRecordings` и смена
`recordingsSearchQuery`. Проверено, что других писателей нет
(`grep recordingItems` — одно присваивание, остальные 15 вхождений — чтения).
Дешёвая геометрическая проверка `shouldGrowWindow` поднята на первую строку
обработчика скролла.

**Верификация.**

```
$ node filterbench.mjs      # архив 5900, 60 событий скролла (~1 с прокрутки)
  recomputed every event : 302.5 ms  (5.04 ms/event)
  memoised               :   7.2 ms  (0.119 ms/event)
$ npm --prefix frontend test → 267 passed
$ typecheck / lint / build — чисто
```

**Решения.** Отвергнуто: троттлинг обработчика через `requestAnimationFrame` —
лечит частоту, а не стоимость; при росте окна фильтрация всё равно шла бы
дважды за кадр, и поиск продолжал бы платить дважды за нажатие.

**Не сделано:** —

---

## Коммит `f09c904` — P2, безымянные константы → SSOT

**Заголовок:** The numbers that decide a stop have names, the memory fallback has the bound its comment claimed, and a recording is titled by one rule

**Находки:** F-007 (= строка 11), F-008 (= строка 3), F-011 (= K-7), F-012,
F-015, строки 4, 7, 10, 12, 13 индекса «хардкод → SSOT», H-6, S-02.

**Файлы:** `frontend/src/main.tsx`, `frontend/src/recording-title.ts` (новый),
`frontend/index.html`, `frontend/tests/recording-title.test.ts` (новый, 8),
`frontend/tests/renderer-main-contract.test.ts` (новый, 2).

**Перепроверка — что оказалось устранено рефакторингом `889c91a`:**
* **строка 5** (`recordedSec * 2.5`, `* 0.3`, `> 5`) — кода нет;
* **строка 6** (`0.9` / `0.85` в `candidateConfirmsTranscriptCoverage`) —
  функции нет, `transcript-merge.ts` ужат до 64 строк;
* **строка 8** (`tailActivityGapSec > 0.2`) — символа нет;
* **строка 9** (`provenUncoveredSec > 0.5`) — символа нет;
* **F-016** в части `transcript-merge`/`live-source` — `REDECODE_MAX_WINDOW_WORDS`,
  `foldInterim`, `SEAM_STRADDLE_WINDOW_SEC`, `SEAM_NGRAM_MAX_WORDS` больше не
  экспортируются (в файлах остались `joinTranscriptSegments`, `richerTranscript`,
  `mergeInterim` — все три импортируются `main.tsx`).

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  24 passed (24)
      Tests  277 passed (277)
$ typecheck / lint / build — чисто, ✓ built
```

**Решения.**
* F-007: `UI_TOKENS.capture.fallbackWindowSec` — ОДНО число на оба фолбэка
  (WebM в чанках, memory в сэмплах), потому что это одно решение. Отвергнуто:
  два независимых токена — именно так и разъезжаются копии.
* F-008: `smartRecordingTitle` вынесен в модуль `recording-title.ts`, а не
  оставлен приватной функцией `main.tsx`. Причина: только так у правила
  появляется тест; 8 тестов, включая пустой результат и потолок с многоточием.
* Строка 12: `FINISHED_RECORDS_KEPT` на стороне рендерера + тест-сверка с
  `.slice(-30)` в `desktop/main.js` (чужой регион — правится тестом, не кодом).
* F-011(б): `try/catch` удалён целиком, а не снабжён комментарием — внутри
  опциональное чтение DOM, бросить нечему; заодно снят третий копипаст списка
  языков (H-6) — проверка идёт по опциям самого селекта.
* S-02: `#uploadLanguage` в разметке опустошён, опции копируются из `#language`
  тем же приёмом, что уже применён к `#deepgramDualSecondaryLang`.

**Не сделано:** —

---

## Коммит `b0eecd1` — P2, мёртвый код и продублированная логика

**Заголовок:** "Is this a network failure?" is answered in one place, and eight pieces of code that only looked like they did something are gone

**Находки:** S-20 (W-2), C-009 (W-12), C-013 (W-10), C-014 (W-1), C-015 (W-4),
C-016а (W-11), C-017 (W-13), C-018, C-020, C-024 (W-8), F-013, S-22.

**Файлы:** `frontend/src/main.tsx`, `frontend/src/error-text.ts`,
`frontend/src/live-pane.ts`, `frontend/index.html`,
`frontend/tests/error-text.test.ts` (+4 теста), `frontend/tests/live-pane.test.ts`.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  24 passed (24)
      Tests  281 passed (281)
$ typecheck / lint / build — чисто, ✓ built
```

`isGenericFetchFailure` покрыт 4 тестами, включая ключевой негативный:
`failed to load model 'large-v3': file not found` НЕ является сетевым сбоем —
именно эту ошибку старый substring-матч в `explainNetworkError` уводил в
объяснение «включите VPN».

**Решения.**
* S-20: предикат в `error-text.ts`, а не в `main.tsx` — чтобы он был покрыт
  тестом; три вызывающих (`sanitizeUiErrorMessage`, `explainNetworkError`,
  ветка upscale) теперь читают один список.
* C-013: карантинные ключи НЕ удалены как механизм — это единственная улика
  и потенциально спасаемый транскрипт. Ограничены тремя последними на префикс
  (`quarantineCorruptSnapshot`), ключи таймстемпнуты, поэтому «последние» — это
  лексическая сортировка. Отвергнуто: убрать запись целиком (потеря данных для
  разбора) и читать их в UI (фича, которой никто не просил).
* C-015: фолбэк не удалён, а заменён на корректный минимальный (экранирование
  кавычек/скобок для атрибутного селектора) — единственный вызывающий передаёт
  уже `encodeURIComponent`-нутый ключ, так что ветка формальна, но теперь она
  хотя бы не врёт.
* C-022: исправлен ТЕСТ и докстринг, а не продакшн-формат. Прод даёт `00:42`
  (`fmtTime` с `padStart`), тест ожидал `0:42` — то есть тест был зелёным на
  формате, которого не существует. Это не ослабление теста: ассерты те же,
  исправлены ожидаемые данные на реальные.
* C-020: `seg.speaker + 1`. Отвергнуто: менять индексацию на бэкенде — там
  индекс правильный, он машинный; человекочитаемая нумерация — дело
  представления.

**Не сделано (в этом коммите):**
* **W-9** (12 id в `index.html` без потребителей) — оставлены намеренно.
  Проверено: у всех десяти проверенных `js=0 css=0`. Но `#appVersionBadge`
  несёт `aria-live="polite"` и обёртывает `#appVersionNumber`, который
  пишется; `#updateCheckRow`, `#livePane`, `#resultPane`, `#upscalePane` —
  структурные контейнеры. Снятие id с разметки ради чистоты — это churn в
  файле, который параллельно правят, при нулевой пользе и ненулевом риске
  (ссылки `aria-*`, будущие стили). Не дефект.
