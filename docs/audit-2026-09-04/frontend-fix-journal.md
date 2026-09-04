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

---

# Сессия 2026-09-05 (продолжение с W-9)

Базовая точка: `1a12c3c`. `git diff main...origin/wip/ultra-audit-2026-09-04 -- frontend`
— пусто (предыдущий агент коммитил по группам, незакоммиченного фронтенда нет).
Базовая верификация до правок: `typecheck` ok, `lint` ok,
`test` **281 passed (24 files)**, `build` ok.

Нумерация индексов костылей: в журнале предыдущего агента `W-n` — это индекс
**региона C** (W-1…W-18). Общее «49 позиций» складывается из четырёх индексов:
регион F (11 строк), регион U (K-1…K-10), регион R (10 строк), регион C
(W-1…W-18) = 49. Ниже они разбираются все; ссылки даю как `C/W-n`, `U/K-n`,
`R/n`, `F/n`.

---

## Коммит `e679872` — SSOT, копия, которую показывают две поверхности

> **Замечание о коммите.** Правки этой группы попали в `e679872` вместе с
> работой desktop-агента: агенты этой сессии работают в одном рабочем дереве,
> и параллельный `git commit` подхватил мой уже проиндексированный фронтенд.
> Содержимое группы — файлы `frontend/**` и этот журнал — в `e679872`;
> дальше коммичу с ограничением по путям (`git commit -- frontend docs/…`),
> чтобы это не повторилось.

**Заголовок:** Every string the user reads on two surfaces is written in one place, and the accepted-formats line is the list the app actually enforces

**Находки / строки индексов:** `R`-индекс SSOT — «Choose a recording from the
left list...» (×3), «No recordings match the current search.» (×3), «Choose a
recording» (×2), «Transcription will appear here...» (×2), «costs 2× Deepgram
minutes» (×2); `U`-индекс SSOT — H-7 (список расширений: 10 против 18 у
бэкенда), H-8 (`accept` ×2), H-9 (пустое состояние Upload ×2 + `innerHTML`);
`C`-индекс — S-22 в оставшейся части (третий форматтер времени `fmt` в IIFE
плеера, литерал `"0:00"` ×4).

**Перепроверка на текущем коде.** Все открыты дословно:
`index.html:438/575/592` против `main.tsx:7212/7213/7616/7798/7937/8157`;
`index.html:226` + `main.tsx:14368`; `index.html:221` (10 расширений) против
`ACCEPTED_AUDIO_VIDEO_EXTS`, заполняемого из `accepted_audio_exts` бэкенда;
`index.html:252-257` против `renderUploadQueue` (перезапись `innerHTML` на
каждый рендер); `index.html:446/448` + `main.tsx:2416/2417` + локальная `fmt`
(формат `m:ss` против `mm:ss` у `fmtTime`).

**Файлы:** `frontend/src/ui-copy.ts` (новый), `frontend/tests/ui-copy.test.ts`
(новый, 14 тестов), `frontend/src/deepgram-dual.ts`
(`dualStreamTradeOffText`), `frontend/tests/deepgram-dual.test.ts` (+4),
`frontend/src/main.tsx`, `frontend/index.html`.

**Что сделано.**
* Правило: **разметка не несёт собственной копии**. `applyStaticUiCopy(document)`
  пишет её на бутстрапе — тот же приём, что уже применён к числам
  (`applyAutoStopSilenceBounds`), к списку языков (`#uploadLanguage` из
  `#language`) и к селекту провайдеров.
* `renderAcceptedFormatsHint` рисует строку форматов из списка бэкенда; пока
  список неизвестен, строка **скрыта**, а не заполнена догадкой.
* `dualStreamTradeOffText(secondary?)` — один факт «что даёт и чего стоит второй
  поток» на обе поверхности; языковой аргумент — единственное, чем они
  отличаются, потому что только Record-вид знает выбранный язык.
* `PLAYER_TIME_ZERO = fmtTime(0)`; локальная `fmt` плеера стала `fmtTime`.
* Перезапись пустого состояния Upload на каждом рендере (вместе с
  единственным содержательным `innerHTML` в файле) удалена: копия теперь
  пишется один раз.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  25 passed (25)
      Tests  299 passed (299)
$ typecheck / lint / build — чисто, ✓ built
```

Доказательство «падало до, проходит после»:

```
$ git stash push index.html && npx vitest run tests/ui-copy.test.ts
     × does not repeat the result placeholder
     × does not repeat the History viewer placeholder
     × does not repeat the History viewer title
     × does not repeat the Upload empty-state title
     × does not repeat the Upload empty-state lead
     × leaves the file dialog's filter to ui-copy
     × does not claim a list of accepted formats the backend has not reported
     … 10 failed
$ git stash pop && npx vitest run tests/ui-copy.test.ts
      Tests  14 passed (14)
```

**Решения.**
* Выбрано: пустая разметка + запись на бутстрапе. Отвергнуто: оставить копию в
  разметке и читать её из неё в рендерере — это меняет направление дрейфа, но
  не убирает его: значение по умолчанию у параметра функции всё равно надо
  где-то написать, а разметка не типизируется.
* Отвергнуто: одна строка на обе формулировки dual-stream. Хуже: Record-вид
  называет язык («A second RU stream…»), Settings — нет; склейка в один литерал
  дала бы либо безличную фразу на Record-виде, либо язык там, где он неизвестен.
  Общий у них ровно факт — он и вынесен.
* Список форматов: отвергнуто «оставить десять как fallback». Это ровно та
  копия, которая уже разошлась (нет `oga, opus, wma, m4v, avi, mpg, mpeg, 3gp`);
  показывать пользователю список, который не совпадает с проверкой в
  `uploadFileValidationError`, — врать в интерфейсе.
* Плеер теперь показывает `00:42`, а не `0:42`. Это осознанная смена
  представления: в приложении один формат часов, и живой таймер записи всегда
  показывал `mm:ss`.
* `#deepgramDualStreamNote` и `#uploadAcceptedFormats` перестали быть id без
  потребителей (`C/W-9` в этой части закрыт кодом, а не отговоркой).

**Не сделано:** —

---

## Коммит `50e52f6` — SSOT, числа, которые задают поведение интерфейса

**Заголовок:** The numbers that shape the interface have names and one home, and a Copy button says the same thing everywhere

**Находки / строки индексов:** `R`-индекс SSOT — 900 мс вспышки Copy,
`.slice(0,10)`/`.slice(0,8)` статистики, дебаунсы 160/220/120, 15 000 мс
bootstrap, `RECORDING_VIEWER_AUDIO_READY_TIMEOUT_MS` вне `UI_TOKENS`,
подпись провайдера (R-011), порядок провайдеров (R-011);
`U`-индекс SSOT — H-3 (1200 мс), H-4 (`60`), H-5 (8000 мс) = `U/K-10`,
H-11 («deepgram» ×3); `C`-индекс — S-23 (тайминги вне `UI_TOKENS`, разные
способы задать период), S-24 (ключ localStorage без версии), S-25
(`7000` дважды). Попутно закрыты **R-008** (P2) и **U-010** (P2), **U-013** (P2).

**Перепроверка на текущем коде.** Открыты дословно все, кроме `R/8`
(«явная передача `7000` при том, что это уже дефолт») — **устранено ранее**:
единственный вызов на этом месте (`showRecordSessionNotice(summary, tone)`)
длительность не передаёт.

**Файлы:** `frontend/src/main.tsx`, `frontend/src/button-feedback.ts` (новый),
`frontend/src/ui-copy.ts` (`resultPaneTitle`), `frontend/src/update-check.ts`,
`frontend/tests/button-feedback.test.ts` (новый, 8),
`frontend/tests/ui-copy.test.ts` (+5).

**Что сделано.**
* `UI_TOKENS` получил четыре группы с обоснованием: `feedback` (одна вспышка),
  `notice` (шкала `briefMs`/`defaultMs`/`longMs` — раньше 6000/7000/7000/9000
  без объяснения разницы; шаг задаётся тем, сколько пользователю надо с
  сообщением сделать), `recordings` (у History не было ни одной записи в
  `UI_TOKENS` вообще), `upload`.
* `flashButtonFeedback` вынесен в `button-feedback.ts` и стал единственным
  механизмом подтверждения копирования. Заодно вылечены обе его поломки:
  прежние подписи читались из живого DOM, где уже стояло «Copied», и таймер не
  сохранялся — двойной клик оставлял кнопку с `aria-label="Copied"` навсегда
  (**R-008**). Кнопка Upload, у которой были свой `setTimeout` и свои 1200 мс,
  теперь зовёт его же с `swapLabel` (**U-010**, H-3).
* `resultPaneTitle` — длинное имя файла усекается, а не схлопывает заголовок до
  голого «Result», который скрывал, какой именно из двадцати файлов показан
  (**U-013**, H-4).
* `PROVIDER_DISPLAY_ORDER` рядом с `providerLabel`; чипы статистики печатают
  `providerLabel(...)`, а не сырой lowercase — «Deepgram» и «deepgram» больше
  не соседствуют на одном экране (**R-011**).
* `normalizeUploadProvider` — единственное место с дефолтом; два вызывающих
  перестали подставлять `|| "deepgram"` перед функцией, которая и так это
  делает (H-11).
* `REQUEST_TIMEOUT_MS` в `update-check.ts` рядом с `CHECK_INTERVAL_MS` (H-5).
* `UPDATE_CHECK_CACHE_KEY` получил `.v1`, как три остальных ключа (S-24).

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  26 passed (26)
      Tests  312 passed (312)
$ typecheck / lint / build — чисто, ✓ built
```

Тесты `button-feedback.test.ts` инжектируют таймеры; ключевой —
`restores the ORIGINAL labels after a second click inside the window`: на
прежней реализации он падал бы дважды (прежние подписи читались из DOM после
первой вспышки, и первый таймер не отменялся).

**Решения.**
* Выбрано: вынести вспышку в модуль с инъекцией таймеров, а не чинить на месте.
  Причина та же, что у P0 предыдущего агента: внутри `main.tsx` правку нечем
  доказать, а обе поломки — про порядок во времени.
* Выбрано: `swapLabel` как опция одного механизма. Отвергнуто: оставить
  Upload'у собственную подмену текста «потому что это текстовая кнопка» —
  тогда у неё по-прежнему нет ни `aria-label`, ни состояния «не удалось».
* Отвергнуто: перенести в `UI_TOKENS` вообще все именованные тайминги
  (`LIVE_ENVELOPE_*`, `MIC_ACQUIRE_TIMEOUT_MS`, `PIPELINE_FAILSAFE_MS`…).
  Они названы и обоснованы прямо там, где применяются, и их обоснование —
  это абзац про конкретный шаг стопа; перенос сделал бы `UI_TOKENS` свалкой,
  а не набором продуктовых решений. В индекс долга это не идёт: S-23 закрыт в
  части «безымянные литералы» и «два способа задать одно и то же».
* Шкала уведомлений: отвергнуто «одна длительность на все». Разница реальна
  (подтверждение против стартовой ошибки), её надо было назвать, а не стереть.

**Не сделано:** —

---

## Коммит `9cca7d0` — исправление предыдущего коммита

`50e52f6` перевёл все кнопки Copy на `src/button-feedback.ts`, но сам файл в
коммит не попал: `git commit -- <пути>` не подхватывает неотслеживаемые файлы.
На `main` оказался импорт несуществующего модуля — с чистого клона не собралось
бы. Модуль и его 8 тестов доложены отдельным коммитом. Урок для следующего
агента в общем рабочем дереве: **новые файлы добавлять `git add` явно**,
и только потом коммитить с ограничением по путям.

---

## Коммит `a52e976` — SSOT, типы и стили

**Заголовок:** One declaration per type and per design token, and one number bounds the status pill

**Находки / строки индексов:** `C`-индекс — S-10 (`RemoteProvider` ≡ `KeyProvider`),
S-11 (`WireProvider` экспортируется и не импортируется, каст вместо импорта),
S-12 (`LiveFinalEnvelope` ≡ ветка `final`), S-15 (мёртвая палитра
`--record-stop-*`), S-21 (два механизма обрезания строки статуса),
C-025 (38 объявленных и никем не читаемых токенов), `C/W-3` (устаревший NOTE),
`C/W-7` (частично), `C/W-17` (двойной парс манифеста),
`C/W-18` (`cssMinify: false` без объяснения).

**Перепроверка на текущем коде.** Все открыты дословно. `C/W-5` (третий
форматтер времени) — устранено в коммите `e679872` этой сессии.
`C-018` (комментарий о порядке установки консоли) — **устранено ранее**:
в коде уже стоит правильное «in an ES module the importing body runs after
every import has been evaluated».

**Файлы:** `frontend/src/main.tsx`, `frontend/src/styles.css`,
`frontend/vite.config.ts`, `frontend/tests/styles-tokens.test.ts` (+2 теста).

**Что сделано.**
* `Provider = WireProvider` — тип объявлен там же, где живёт отображение
  UI-групп на провод; три каста `as Provider` исчезли (последний заменён не
  импортом, а нормализацией: снапшот очереди — недоверенный ввод, и утверждать
  тип того, что записано в файле, нельзя).
* `RemoteProvider = Exclude<Provider, "local" | "">`; `KeyProvider` удалён.
  Второго понятия здесь нет: удалённый провайдер — ровно тот, которому нужен ключ.
* `LiveFinalEnvelope = Omit<Extract<LiveWsMessage, {type:"final"}>, "type">`.
* Статусная строка: `--status-pill-max-chars` в `:root`, ширина пилюли —
  `min(calc(var(--status-pill-max-chars) * 1ch), 42vw)`. Число одно, слои сшиты
  тестом (стиль не может импортировать `main.tsx` — тот же приём, что у границ
  auto-stop и `desktop/main.js`). JS по-прежнему решает, **какая часть**
  сообщения выживает; CSS — только «влезло ли».
* 38 нечитаемых токенов удалены (46 объявлений — часть повторялась в блоках тем
  и forced-colors). Инвариант закреплён тестом: 142 объявлено, 0 не прочитано,
  0 прочитано без объявления.
* `vite.config.ts`: `desktop/package.json` читается один раз; `cssMinify: false`
  объяснён.
* NOTE о «`deepgram_dual.py` ещё не приземлился» заменён на проверенный
  контракт: `stats.dual_stream` пишется в `deepgram_dual.py:1029`,
  `stats.recovery.spans_sec` — в `deepgram_recovery.py:575`.
* `health.clone().json()` → `health.json()`; записано, почему `/api/health` —
  единственный запрос мимо `apiGet`.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  26 passed (26)
      Tests  314 passed (314)
$ typecheck / lint / build — чисто, ✓ built
$ grep -c "as Provider" frontend/src/main.tsx   # 0
```

Доказательство «падало до, проходит после»:

```
$ git stash push src/styles.css && npx vitest run tests/styles-tokens.test.ts
     × declares nothing the app never paints with
     × bounds the status pill by the same number the renderer abbreviates to
      Tests  2 failed | 5 passed (7)
$ git stash pop && npx vitest run tests/styles-tokens.test.ts
      Tests  7 passed (7)
```

**Решения.**
* S-21: отвергнуто «привести 360px к 42 символам числом» — осталось бы два
  числа, обязанных совпадать вручную. Отвергнуто и обратное, снять
  JS-обрезание совсем: оно выбирает фразу до первого «:», чего таблица стилей
  сделать не может.
* C-025: отвергнуто «оставить `--space-1`/`--space-5` ради целостности шкалы».
  Токен, который никто не читает, — не шкала, а обещание.
* `--focus-ring` удалён вместе с двумя отображениями в forced-colors, а
  комментарий, обещавший «оба токена», исправлен: он описывал токен, которым
  ничего не рисовалось.
* `C/W-7` закрыт частично и осознанно: `clone()` — дефект и исправлен; обход
  `apiGet` для `/api/health` — **не баг**, причина записана в коде.
* `cssMinify`: отвергнуто «включить минификацию» — проверить визуально
  минифицированный результат в этой сессии нечем, а флаг не дефект, если у него
  есть причина; причина записана.

**Не сделано:** —

---

## Коммит `<D>` — костыли: слушатели, таймеры и часы, живущие дольше своего повода

**Заголовок:** Nothing the renderer starts outlives what started it, and a clock set backwards no longer switches the update check off for good

**Находки / строки индексов:** `U`-индекс костылей — K-3
(`pickUploadRetryFile`: «отмену» определял `focus` + 250 мс, `{once:true}`
слушатель висел до произвольного будущего фокуса), K-4 (глобальные
`dragover`/`drop` внутри `setupUploadView`), K-6 = **U-019** (`PUT` на выгрузке
без `keepalive`), K-8 = `R`-индекс 10 (`Promise.race` с неотменяемым
`setTimeout`); `U`-индекс SSOT — H-13 = **U-016** (поэкземплярный teardown
опросов). Плюс P2: **U-012**, **U-017**.

**Перепроверка на текущем коде.** Все открыты дословно. `K-4` оказался не
утечкой (`setupUploadView` вызывается один раз), но регистрация процессного
guard'а изнутри setup-функции — именно то, что делает его похожим на забытый
слушатель и ломается на втором вызове; поднят на уровень модуля с объяснением.

**Файлы:** `frontend/src/main.tsx`, `frontend/src/update-check.ts`,
`frontend/tests/update-check.test.ts` (+6 тестов).

**Что сделано.**
* `stopGatedPolls()` над реестром `gatedPolls` и один `pagehide`-слушатель.
  Реестр существовал ровно для того, чтобы вызывающий не знал, какие опросы
  есть, — и использовался только для `sync`; у `local-models` boilerplate'а не
  написали, и он продолжал тикать после `pagehide`.
* Таймаут гонки бутстрапа гасится в `finally`. Проигравший в `Promise.race` не
  отменяется победой: таймер оставался взведённым все 15 с после бутстрапа,
  который занял 40 мс.
* `pickUploadRetryFile` слушает событие `cancel` самого `<input type=file>`
  вместо `focus` + `setTimeout(250)`; ни висящего слушателя, ни догадки.
* `apiPut(url, body, {keepalive})`; выгрузочный сброс снапшота очереди просит
  `keepalive`, а `apiPut` снимает флаг, если тело не влезает в 64 KiB
  (иначе запрос отклоняется целиком — это хуже, чем прерванный).
* Глобальный `dragover`/`drop` guard поднят из `setupUploadView` на уровень
  модуля.
* `update-check.ts`: `prerelease` теперь читается (комментарий обещал «drafts
  **and prereleases**», код проверял только `draft`); `compareVersions`
  разбирает предрелизный суффикс — `1.3.0-rc1` уходил в лексическую ветку через
  `Number("0-rc1") = NaN` и объявлялся **новее** `1.3.0`, то есть пользователю
  предлагали даунгрейд; штамп из будущего (часы переставили вперёд и вернули)
  больше не выключает фоновую проверку навсегда.

**Верификация.**

```
$ npm --prefix frontend test
 Test Files  26 passed (26)
      Tests  320 passed (320)
$ typecheck / lint / build — чисто, ✓ built
```

```
$ git stash push src/update-check.ts && npx vitest run tests/update-check.test.ts
     × orders a release candidate below the release
     × refuses a payload marked prerelease, as its comment always claimed
     × checks when the stored stamp is in the future
      Tests  3 failed | 14 passed (17)
```

**Решения.**
* `keepalive`: отвергнуто `navigator.sendBeacon` — он не даёт поставить
  заголовок с API-токеном, а бэкенд его требует. Отвергнуто и «слать
  `keepalive` всегда»: браузер отклоняет тело больше 64 KiB, а снапшот с
  двумя сотнями транскриптов его превышает; тогда сохранение не «пострадало
  бы», а не состоялось вовсе.
* K-3: отвергнуто «оставить фолбэк на `focus` для старых движков». Приложение
  везде Chromium (`cssTarget: "chrome142"`), `cancel` есть с 113; второй путь
  вернул бы ровно ту догадку, ради устранения которой правка делается.
* Опросы: отвергнуто «дописать `localModelsPoll.stop()` третьей строкой». Это
  четвёртая копия boilerplate'а вместо использования реестра, который для
  этого и заведён.

**Не сделано (в этом коммите):**
* **K-2** (`_stageCrossoverDelay` — придуманный переход «uploading →
  processing» по таймеру `size/10000`) — в долг. Честный источник прогресса
  тела запроса существует (`XMLHttpRequest.upload.onprogress`), но это замена
  транспорта загрузки целиком, вместе с отменой и заголовками; отдельная
  задача, не побочная правка. Комментарий у кода причину признаёт.
* **K-5 / U-020** (восстановление reveal-целей сопоставлением обрезанного
  превью с `display_name`, неограниченные последовательные `apiGet` на старте)
  — в долг: это одноразовая миграция легаси-снапшотов, и переписывать её надо
  вместе с решением, храним ли мы вообще reveal-цель отдельно от `savedName`.
