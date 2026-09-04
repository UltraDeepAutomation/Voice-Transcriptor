# Ultra-Audit · BACKEND · фаза FIX

**Дата:** 2026-09-04
**Точка отката:** `22c6e3d` (backend на `bf84d6b`).
**Базовая линия тестов:** 631, все зелёные.

```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 631 tests in 32.230s
OK
```

---

## Коммит 1 — `d590a4e` · P0

**Заголовок:** «A Deepgram final that arrives without a word list is a reading again, and the merge of two long readings no longer stops the backend for half a minute»

**ID:** B-001 (P0), B-002 (P0). Попутно закрыта часть B-033 — новая публичная точка входа `segment_word_records` вместо четвёртой копии правила.

**Файлы:** `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/tests/test_deepgram_dual.py`.

**Верификация.**

Репродукция B-001/B-002 (`/tmp/repro_p0.py`, интерпретатор приложения) — ДО:
```
D: primary had no word list -> merged text = 'это'
D: primary no words, no secondary        = ''
  250 words/reading -> merge_readings    135 ms
 1000 words/reading -> merge_readings   2811 ms
 3000 words/reading -> merge_readings   30.8 s        (из отчёта аудита)
```
ПОСЛЕ:
```
D: primary had no word list -> merged text = 'это весь мой текст'
D: primary no words, no secondary       = 'это весь мой текст'
  750x750   -> cpu     8.2 ms   wall  14.7 ms
 1500x1500  -> cpu    17.4 ms   wall  25.0 ms
 3000x3000  -> cpu    39.6 ms   wall  65.2 ms     (load average 44 — машина под нагрузкой других агентов)
```

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 640 tests in 58.957s
OK
```
(631 → 640: +9 тестов; ни один не ослаблен.)

**Решения.**

* *Выбрано:* одно правило `segment_word_records(segment)` в `remote_deepgram_live` — сегмент со словами читается как слова, сегмент без них как ОДНА запись на весь свой span с его текстом и флагом `spanless`. Через него теперь ходят все четыре спрашивающих: `_spanless_coverage`, `deepgram_recovery.covered_spans`, `deepgram_dual.flatten_words` и (через первый) `_word_covered_by_spanless_final`.
  *Почему:* три места уже отвечали на этот вопрос, четвёртое (merge) отвечало «ничего», и это и есть B-001. Требование задания — «unify, don't add a fourth».
* *Выбрано:* на любом участке звука выигрывает ровно одно чтение. Блоб проигрывает реальным словам другого чтения, если те покрывают ≥ 50 % его span (`SPANLESS_SHADOW_MIN_FRACTION`); слова, попавшие под выживший блоб (правило центра — то же, что `_word_covered_by_spanless_final`), выбрасываются.
  *Отвергнуто:* «оставлять и блоб, и слова» — первая версия давала «это весь мой текст это», то есть ту самую дупликацию, с которой борются последние три релиза. *Отвергнуто:* «сопоставлять блоб со словом в `_same_audio`» — `_resolve` тогда заменяет целую клаузу одним словом (потеря текста хуже исходного бага).
* *Выбрано:* заметание (sweep) с кучей по `end` вместо двух указателей. *Отвергнуто:* предложенный в отчёте `lo`-указатель по `end` — `end` не монотонен в списке, отсортированном по `start`, поэтому продвижение `lo` по `end` может пропустить длинное слово, которое ещё релевантно. Куча ретайрит ровно то, что уже не может совпасть ни с этим, ни с любым последующим словом.
* *Выбрано:* merge остаётся синхронным. *Отвергнуто:* `asyncio.to_thread` — 40 мс CPU на 3000×3000 укладывается в объявленный `FINALIZE_ASSEMBLY_ALLOWANCE_SEC = 0.15`, а перевод `_merged_envelope` в async сделал бы асинхронным документированно синхронный `partial_result()`.
* *Выбрано:* перф-тест меряет `time.process_time`, а не настенные часы. *Почему:* дефект занимал event loop; CPU-время — единственная мера этого, которую загруженная машина не превращает в ложный красный (на этой машине load average 44).
* *Переписан тест* `test_a_wordless_segment_contributes_nothing` — он фиксировал сам дефект. Заменён двумя: правило и единственный по-настоящему пустой случай (нет ни слов, ни текста).

**Не сделано:** —

---

## Коммит 2 — `3b8f5a8` · P1 (запись восстановлена постфактум)

Предыдущий агент закоммитил эту группу, но не успел занести её в журнал; запись
добавлена следующим агентом по коммиту, без изменения кода.

**Заголовок:** «Deepgram's answer to Finalize is no longer thrown away, so the stop ends when the provider has answered instead of when a timer runs out»

**ID:** B-005 (P1), B-007 (P1), B-024 (P2). Попутно: `FINALIZE_COVERED_WAIT_SEC` и `FINALIZE_EMPTY_TAIL_WAIT_SEC` удалены — это и был костыль, названный в §5.1 первой строкой.

**Файлы:** `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/tests/test_deepgram_finalize_budget.py`, `backend/tests/test_deepgram_finalize_flush.py`, `backend/tests/test_deepgram_seam_tail.py`.

**Верификация:** сьют 640 → 652, зелёный (см. тело коммита; перепроверено на `1a12c3c`: `Ran 652 tests … OK`).

**Решения:** подробно изложены в теле коммита `3b8f5a8` (одна причина вместо трёх констант; пустой финал — это факт «флаш отвечен» и «окно декодировано и пусто», но не сегмент; `tail_needs_flush` остаётся правилом ПОВТОРА, `tail_needs_recovery` — правилом ПЕРЕДЕКОДИРОВАНИЯ, и первое по построению подмножество второго; `UtteranceEnd` вынесен в общий `confirmed_silence_gap`).

**Не сделано:** —

---

## Коммит 3 — `stats.recovery` · контракт с рендерером

**Заголовок:** «The stop trace can state how many seconds were re-decoded, because the envelope now reports the number the renderer reads»

**ID:** контракт из `docs/NEXT_SESSION_2026-09-04b.md` §5.3 (рендерер `889c91a` ↔ бэкенд `bf84d6b`).

**Файлы:** `backend/deepgram_recovery.py`, `backend/tests/test_deepgram_recovery.py`.

**Верификация.**

До правки — поле, которое рендерер парсит, в конверте отсутствовало:
```
$ PYTHONPATH=. …/python3 -c "from backend.deepgram_recovery import RecoveryReport; print(RecoveryReport(spans=[(5.2,6.4)]).as_dict())"
{'spans': [[5.2, 6.4]], 'ms': 0.0, 'words': 0}
```
После:
```
{'spans': [[5.2, 6.4]], 'spans_sec': 1.2, 'ms': 0.0, 'words': 0}
```
Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 656 tests in 34.556s
OK
```
(652 → 656: +4 теста формы провода.)

**Решения.**

* *Выбрано:* `spans_sec` **выводится** из `spans` методом `RecoveryReport.spans_sec()`, а не хранится рядом полем.
  *Почему:* сумма и список, который она суммирует, не могут разойтись — это то же правило SSOT, по которому `uncoveredSpeechSec` пересчитывается, а не корректируется (`run_recovery`).
  *Отвергнуто:* второе поле в датаклассе, заполняемое вызывающим, — второй источник той же истины.
* *Выбрано:* лог-строка `recovery: spans=… total=…` теперь читает тот же `RecoveryReport`, а не считает `total_span_sec` третьим выражением. Отчёт строится один раз перед логом и он же уходит в `stats`.
* *Выбрано:* `spans` и `words` остаются в проводе. *Почему:* рендерер их не читает, но это диагностика, которую читают лог и тесты; удалять поле контракта ради «рендерер не смотрит» — сузить конверт без причины.
* *Выбрано:* форма провода закреплена отдельным тест-классом `RecoveryReportWireShapeTests` (имена ключей, типы, вывод суммы, пустой случай, неотрицательность).
  *Почему:* переименование на этой стороне не роняло ни одного теста — рендерер просто переставал показывать два числа; ровно этот класс дефекта и создал расхождение.

**Не сделано:** —

---

## Коммит 4 — тёплый пул × dual-stream

**Заголовок:** «A dual-stream recording pays one connect before its first byte instead of two, and the second reading is warmed like the first»

**ID:** B-003 (P1), B-004 (P1), B-013 (P1, частично — см. «решения»), B-087 (P2).

**Файлы:** `backend/deepgram_warm.py`, `backend/main.py`, `backend/tests/test_deepgram_warm.py`, `backend/tests/test_deepgram_coverage_holes.py`.

**Верификация.**

Новые тесты на коде ДО правки (`git show HEAD:backend/deepgram_warm.py`, `…:backend/main.py`):
```
FAIL: test_two_configurations_connect_at_the_same_time
AssertionError: 1 != 2 : the second acquire never reached connect
ERROR: test_a_stalled_connect_does_not_block_an_adoption  (TimeoutError)
FAIL: test_boot_warms_both_configurations_when_dual_is_on
  '…language=ru' not found in ['…language=multi'] : boot warmed only the primary reading
FAIL: test_both_configurations_are_warmed_when_the_recording_ends
  '…language=ru' not found in ['…language=multi'] : the second reading's configuration was never warmed
```

B-087 — прямой запуск тестовых модулей (`if __name__ == "__main__"` посреди файла):
```
ДО:   python3 backend/tests/test_deepgram_warm.py           Ran 39 tests
      python3 backend/tests/test_deepgram_coverage_holes.py Ran  8 tests
ПОСЛЕ: …test_deepgram_warm.py            Ran 54 tests   OK
       …test_deepgram_coverage_holes.py  Ran 29 tests   OK
```

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 662 tests in 33.481s
OK
```
(656 → 662.)

**Решения.**

* **B-003.** *Выбрано:* под `self._lock` остаётся только бухгалтерия пула; `connect()` ждётся снаружи через задачу. Та же `_pending`-машинерия схлопывает одновременные коннекты одной конфигурации, поэтому отдельная защита не нужна. `_await_pending` удалён — его роль (снять запись и подождать) теперь разложена по двум сторонам lock'а.
  *Дополнительно:* вызывающий (`_run_deepgram_live_session`) запускает второй `acquire` задачей ДО первого — без этого снятие lock'а само по себе ничего не ускоряет.
  *Отвергнуто:* «оставить lock, но взять для второго чтения отдельный lock по ключу» — два лока вместо одного и та же сериализация для любого третьего потребителя (boot-прогрев, `GET /api/live/warm`).
* **B-003, отмена.** Ждать задачу снаружи lock'а открывает новую дыру: вызывающего могут отменить, пока коннект уже вернул сокет. `_await_connect` вешает `done_callback`, который закрывает такой сокет на луупе. Это единственный реально достижимый случай «cancel проиграл гонку» (см. ниже).
* **B-004.** *Выбрано:* обе точки `rewarm` греют весь набор конфигураций, который использует эта запись/этот boot. На boot решение берётся из того же `dual_stream_enabled(cfg, "auto")`, что и в WS-обработчике, — одно правило, не второе.
* **B-013.** *Выбрано:* `_cancel_pending` больше не глотает собственную отмену пула (`except (CancelledError, Exception): pass` → разбор `task.cancelled()`), и закрывает сессию, если задача всё же вернула её.
  *Уточнение к находке:* описанная в отчёте утечка через `_cancel_pending` **не достижима** на текущем коде, и это измерено: тест `test_a_warm_connect_cancelled_by_a_key_change_closes_its_socket` проходит и ДО правки. Причина — `_warm_connect` ловит `CancelledError` вокруг `connect()` и закрывает сессию, а CPython при `_must_cancel` доставляет отмену именно в эту точку. Достижима **другая** половина того же класса — отменённый `acquire` поверх уже завершившегося коннекта; она закрыта `_await_connect` и закреплена вторым тестом (`test_an_acquire_cancelled_after_its_connect_returned_closes_it`), который ДО правки падает.
* **B-087.** *Выбрано:* охранник `if __name__ == "__main__"` перенесён в конец обоих файлов. *Почему:* `unittest discover` собирал всё и раньше, но прямой запуск модуля (как в этом журнале) молча выполнял треть тестов — то есть инструмент проверки врал.
* *Попутно:* `_WarmFakeUpstream` отвечает на четыре вопроса, которые задаёт `deepgram_recovery.evidence_from_session`. До этого каждый тест обработчика печатал `AttributeError`-трейсбек, а путь восстановления в них не исполнялся вовсе — фейк был не тем, что он изображал.
* *Попутно:* провал первичного коннекта теперь закрывает уже открытый сокет второго чтения (`_discard_secondary_acquire`) — раньше его просто не существовало, потому что второй `acquire` начинался после успеха первого.

**Не сделано:** —

---

## Коммит 5 — отмена, управляющие кадры и порядок стопа

**Заголовок:** «A cancelled stop stops, a control frame is never cancelled mid-write, and a socket swap can no longer be pulled out from under the finalize»

**ID:** B-008 (P1), B-009 (P1), B-011 (P1, «не баг» — см. решения), B-012 (P1), B-083 (P2, вторая половина — импорты посреди модуля).

**Файлы:** `backend/async_tasks.py` (новый), `backend/main.py`, `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_warm.py`, `backend/tests/test_live_teardown.py` (новый), `backend/tests/test_deepgram_warm.py`, `backend/tests/test_deepgram_dual.py`.

**Верификация.**

```
$ grep -rn "except (asyncio.CancelledError, Exception)" backend --include="*.py" | grep -v tests | wc -l
ДО: 11    ПОСЛЕ: 0
```
(в отчёте было 13 — два места закрыты коммитами `3b8f5a8`/`ea25b4f`.)

Новые тесты на коде ДО правки:
```
FAIL: test_a_swap_in_flight_is_waited_for_before_the_drain
AssertionError: True is not false : the stop finalized on the socket the swap was about to discard
```
(проверено на `ea25b4f` c добавленным `_WARM_SWAP_GRACE_SEC = 0.0`, иначе `mock.patch.object` не к чему прицепиться.)

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 675 tests in 36.970s
OK
```
(662 → 675.)

**Решения.**

* **B-008.** *Выбрано:* один помощник `backend/async_tasks.py` (`await_cancelled`, `cancel_and_await`, `cancel_and_collect`) вместо одиннадцати копий идиомы.
  *Важная поправка к предложенному в отчёте коду:* проверки `if not task.cancelled(): raise` **недостаточно**. Отмена корутины, которая ждёт другую задачу, отменяет и ту задачу, поэтому `task.cancelled()` истинно и в «нашем» случае тоже. Тест `test_our_own_cancellation_propagates` падал ровно на этом. Решающий вопрос — `asyncio.current_task().cancelling() > 0` (счётчик запросов отмены на НАС); он задаётся первым, `task.cancelled()` остаётся вторым.
  *Отвергнуто:* `contextlib.suppress(asyncio.CancelledError)` — то же самое подавление, только короче.
* **B-009.** *Выбрано:* `DeepgramLiveSession._send_control` — запись не отменяется никогда; зависшая ограничивается закрытием сокета, что и освобождает запись. Это дословно то правило, которое `send_pcm` уже формулирует и применяет к аудио-пути. Порог — новая именованная `CONTROL_SEND_WEDGE_SEC = 5.0`, те же 5 с, что были у `wait_for`, чтобы момент обнаружения не сдвинулся.
  *Плюс:* при отмене НАС управляющая запись тоже не отменяется — сокет закрывается, запись собирается, отмена пробрасывается.
* **B-012.** *Выбрано:* заявка на замену снимается ПЕРЕД ожиданием sender'а (раньше `warm_probe` отменялся после — слишком поздно, чтобы помешать замене начаться), а уже начатой замене даётся её собственный бюджет коннекта: `_WARM_SWAP_GRACE_SEC = DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC + DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC`.
  *Почему выведено, а не выбрано числом:* замена ждёт коннект, значит её отсрочка — это бюджет коннекта; отдельная константа отстала бы от изменения любой из двух.
  *Отвергнуто:* «блокировать замену флагом и продолжать стоп немедленно» — тогда стоп финализируется на сокете, который замена уже признала мёртвым, то есть тот же потерянный транскрипт другой дорогой.
  *Оставлено:* если замена не уложилась и в grace, это `logger.error` с явным текстом — потеря будет объяснимой, а не загадочной.
* **B-011 — «не баг» (измерено).** `asyncio.wait_for` в Python 3.12 сам отменяет и **дожидается** внутреннюю задачу перед тем, как поднять `TimeoutError` (`_cancel_and_wait`), поэтому к моменту `partial_result()` вторичный drain уже завершён. Написанный по находке тест (`test_a_late_secondary_is_awaited_before_it_is_snapshotted`) проходит и ДО правки. Замена `secondary_task.cancel()` на `cancel_and_await` оставлена: она делает инвариант явным и не зависит от того, останется ли эта деталь `wait_for` в следующей версии Python.
* **B-083 (вторая половина).** Шесть импортов из `remote_deepgram_live` переехали с 1000-й строки в начало файла; `# noqa: E402` больше не нужны. Все шесть — листовые модули, цикла нет (проверено импортом).
* *Попутно:* `_WarmFakeUpstream` дополнен `stream_death_sec`, чтобы путь восстановления в тестах обработчика исполнялся целиком.

**Не сделано:** —

---

## Коммит 6 — числа конверта

**Заголовок:** «`coveredEndSec` stops repeating `durationSec`, so a spliced tail word can no longer make an incomplete envelope look complete»

**ID:** B-006 (P1), B-010 (P1), B-026 (P2).

**Файлы:** `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/audio_constants.py`, `backend/main.py`, `backend/tests/test_deepgram_interim_splice.py`, `backend/tests/test_deepgram_warm.py`, `backend/tests/test_audio.py`.

**Верификация.**

B-006, тот же сеанс, ДО и ПОСЛЕ (финал 0–1 с + вставленное interim-слово 3.0–3.5 с):
```
BEFORE: durationSec=3.5 coveredEndSec=3.5
AFTER:  durationSec=3.5 coveredEndSec=1.0
```

B-010, тест на коде ДО правки:
```
AssertionError: 'streamed_sec=0.0' not found in
  'ws deepgram session complete: bytes=3200 streamed_sec=0.1 …'
```
(запись со сменой сокета: конверт нёс 0.0, лог печатал 0.1 — два разных числа об одном.)

B-026:
```
$ grep -rn "2 \* LIVE_SAMPLE_RATE_HZ\|2 \* max(1" backend/*.py
ДО: 5 совпадений    ПОСЛЕ: 0
```

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 683 tests in 39.007s
OK
```
(675 → 683.)

**Решения.**

* **B-006.** *Выбрано:* `_committed_end_sec()` — максимум по сегментам БЕЗ поля `source`, читается ДО сплайса. Правило «провайдерский финал», а не «не interim»: сегмент от REST-восстановления (`source="recovery"`) тоже не покрытие живого чтения, и тест это фиксирует.
  *Отвергнуто:* фильтровать по конкретной строке `"interim-fallback"` — тогда следующий источник вставки снова врал бы в это поле.
  *Строка `"interim-fallback"` названа константой* `INTERIM_FALLBACK_SOURCE` — её теперь читают два места.
* **B-006, dual.** *Выбрано:* `coveredEndSec` объединённого конверта — максимум из двух `coveredEndSec` чтений, а не конец объединённых слов. *Почему:* объединение включает вставленные interim обеих сторон; каждое чтение уже измеряет своё покрытие правильно, и дальнейшее из двух — это ground, который хотя бы одно чтение зафиксировало.
* **B-010.** *Выбрано:* лог-строка стопа читает `final_payload["streamedSec"]` — то самое число, которое ушло рендереру.
  *Отвергнуто (сначала сделано, потом откачено):* публичный `session.streamed_seconds()`. Он потребовал бы метода на пяти тестовых фейках и на фасаде, а главное — оставил бы ДВА выражения (метод сессии и вызов в main) там, где нужен один источник. Конверт уже содержит ответ.
* **B-026.** *Выбрано:* `LIVE_PCM_BYTES_PER_SEC` в четырёх местах `main.py` с фиксированной частотой и новая `pcm16_bytes_per_sec(rate)` в двух местах, где частота приходит из конфигурации (`_streamed_seconds`, `run_recovery`).
  *Почему функция, а не ещё одна константа:* live-сессия берёт частоту из своего `DeepgramLiveConfig`; константа 16 кГц там была бы неверна, а `2 * rate` — пятой копией правила.
  *Плюс:* `pcm16_bytes_per_sec` не может вернуть 0 (это делитель).
  *Тест* `test_the_expression_is_no_longer_written_out_by_hand` ищет обе формы по всему `backend/*.py`, поэтому шестая копия не появится молча.

**Не сделано:** —

---

## Коммит 7 — конфигурация

**Заголовок:** «Reading the config stops rewriting it, an unusable data dir no longer kills the backend before it starts, and one bad POST can no longer brick Upscale forever»

**ID:** B-018 (P1), B-019 (P1), B-020 (P1), B-021 (P1).

**Файлы:** `backend/config.py`, `backend/tests/test_config.py`.

**Верификация.** Новые тесты на коде ДО правки:
```
FAIL: test_a_newer_config_is_never_rewritten_on_read
  b'{\n  "schema_version": 3, …}' != b'{"schema_version": 3}' : a read rewrote the config file
FAIL: test_a_string_where_the_block_belongs_is_reset
  'oops' is not an instance of <class 'dict'>
FAIL: test_a_non_string_model_falls_back_to_the_default
  42 != 'google/gemini-2.5-flash'
FAIL: test_an_empty_keyfile_is_replaced_and_secrets_work_again
  0 not greater than 0 : the empty keyfile was left in place
ERROR: test_an_unusable_data_dir_degrades_instead_of_raising   (NotADirectoryError на импорте)
```
Полный набор:
```
Ran 692 tests in 36.772s
OK
```
(683 → 692.)

**Решения.**

* **B-018.** *Выбрано:* штамповать только конфиг СТАРЕЕ этой сборки (`original < SCHEMA_VERSION`) или вовсе без поля, и писать именно `SCHEMA_VERSION`, а не то, что пришло из файла. `merged["schema_version"]` обновляется в памяти, чтобы возвращаемый словарь совпадал с диском.
  *Почему это важнее, чем «лишние fsync»:* `.bak` документирован как единственная автоматическая копия настроек; ротация на каждом чтении схлопывала окно восстановления в секунды.
  *Отвергнуто:* «понижать версию к нашей» — `_migrate_schema` специально сохраняет форвард-совместимость и неизвестные поля.
* **B-019.** *Выбрано:* симметричный ремонт `preferences.openrouter` рядом с блоком `deepgram`, по тем же правилам (не объект → дефолтный блок; `model` не строка → дефолтная модель).
  *Почему:* докстринг модуля прямо обещает это поведение для `openrouter`; сделано было только для `deepgram`.
* **B-020.** *Выбрано:* нулевой keyfile удаляется и создаётся заново; правило «никогда не перезаписывать» сохраняется для файла С СОДЕРЖИМЫМ (тест это фиксирует отдельно — испорченный, но непустой ключ не трогают). Ветка `FileExistsError` делает то же и один раз рекурсивно повторяет создание.
  *Почему так:* `main._load_or_create_api_token` для точно такой же ситуации уже перегенерирует файл — политика в проекте есть, здесь её просто не применили.
* **B-021.** *Выбрано:* `_resolve_data_dir()` — предупредить и уйти на `~/.transcriptor`; если и он недоступен, всё равно не падать, а сказать в лог, что конфиг не будет сохраняться.
  *Почему:* политика «warn and default» записана в `deepgram_endpoints` и исполняется `main._env_int`; `TRANSCRIPTOR_DATA_DIR` — единственная документированная настройка, которая ей не следовала, и её цена — «backend did not start» без причины.
  *Тест* подменяет `HOME`, чтобы не создавать каталог в настоящем домашнем.

**Не сделано:** —

**Долг:** первая версия теста B-021 (до подмены `HOME`) один раз создала `~/.transcriptor/.encryption_key` на машине пользователя. Файл пустой смысловой нагрузки не несёт и ничем не читается, пока `TRANSCRIPTOR_DATA_DIR` доступен; удалить его может пользователь — агент чужие файлы не удаляет.

---

## Коммит 8 — файлы, ffmpeg и модели

**Заголовок:** «ffmpeg no longer reads the channel Electron talks on, the heaviest model can finally be unloaded, and a failed save gives the name back»

**ID:** B-014 (P1), B-015 (P1), B-016 (P1), B-017 (P1), B-037 (P2).

**Файлы:** `backend/audio.py`, `backend/transcribe.py`, `backend/transcribe_gigaam.py`, `backend/storage.py`, `backend/main.py`, `backend/tests/test_audio.py`, `backend/tests/test_model_idle_unload.py`, `backend/tests/test_storage.py`, `backend/tests/test_recording_names.py`.

**Верификация.** Новые тесты на коде ДО правки:
```
FAIL: test_every_ffmpeg_process_is_started_with_stdin_closed
  None != -3 : ffmpeg inherited the backend's stdin
FAIL: test_the_conversion_commands_carry_the_flag_too (fn='ensure_wav_16k')          '"-nostdin"' not found
FAIL: test_an_idle_gigaam_model_is_released                 [] != ['gigaam-v3-rnnt']
FAIL: test_release_model_evicts_gigaam_too                  False is not true
FAIL: test_the_two_answers_about_residency_agree            True != False
ERROR: test_the_in_middle_marker_is_swept_whatever_the_name (ImportError: TMP_ORPHAN_RE)
ERROR: test_the_local_conversion_ceiling_is_named_once      (нет _LOCAL_CONVERT_TIMEOUT_SEC)
FAIL: test_a_failed_new_save_releases_the_name_it_reserved
  Lists differ: [PosixPath('…/lecture.txt.tmp-000000.claim')] != []
```
Полный набор:
```
Ran 704 tests in 38.028s
OK
```
(692 → 704.)

**Решения.**

* **B-014.** *Выбрано:* `stdin=subprocess.DEVNULL` в единственном `Popen` — это закрывает все четыре команды и любую пятую. `-nostdin` добавлен и в две команды конверсии, чтобы форма была одинаковой у всех четырёх (её уже проверяют тесты для двух других).
  *Отвергнуто:* только флаг в argv — он покрывает ffmpeg, но не общее правило «дочерний процесс не наследует наш stdio-канал».
* **B-015.** *Выбрано:* точка освобождения `release_gigaam` в адаптере + `resident_gigaam_models()`; `transcribe.release_model` и `release_idle_models` диспетчеризуются по тому же префиксу, что уже использует `model_is_resident`. Использование gigaam отмечается в общем `_MODEL_LAST_USED` (в обеих ветках транскрипции и в `warm_model`), то есть окно простоя одно на оба движка.
  *Важно:* освобождение gigaam выполняется ВНЕ `_MODEL_LOCK` — у чужого кэша свой замок, и брать один под другим значит завести дедлок.
  *Отвергнуто:* импортировать `backend.transcribe_gigaam` в подметальщике — это отменило бы ленивый импорт torch ради вопроса «а есть ли что выгружать»; вместо этого `_gigaam_module()` смотрит в `sys.modules`, и тест это фиксирует.
* **B-016.** *Выбрано:* `_release_recording_text_claim()` в обеих ветках отката. *Почему это не просто мусор:* архив регистрируется только после УСПЕШНОГО сохранения, поэтому подметальщик в эту папку никогда не заглянет, а имя маркера детерминировано — каждая следующая попытка того же заголовка уезжает на timestamp-имя. Тест проверяет обе стороны: два провала подряд не оставляют маркеров, и следующая успешная попытка получает естественное имя `lecture.txt`.
* **B-017.** *Выбрано:* соглашение об имени временного файла (`TMP_ORPHAN_RE`) переехало в `backend/storage.py` — модуль, который его и порождает и чей докстринг объявляет его инвариантом; `main` импортирует, тест импортирует. Группа расширений стала `*` вместо `?`.
  *Почему переезд, а не просто `?`→`*`:* правило было записано трижды (регулярка в `main`, литеральная копия в тесте, докстринг в `storage`), и разошлись именно копии. Тест `test_backend_main_reads_the_same_pattern_rather_than_a_copy` не даёт копии вернуться.
* **B-037.** `_LOCAL_CONVERT_TIMEOUT_SEC = 300` рядом с `_REMOTE_COMPACT_TIMEOUT_SEC`; тест запрещает литерал в обеих функциях.

**Не сделано:** вторая половина B-037 («локальные конверсии не принимают `cancel_event`») — это не дефект, а отсутствующая функция: у локального пути нет вызывающего, который умеет отменять. Записано в долг.

---

## Коммит 9 — зависимости и переменные окружения

**Заголовок:** «The env reference stops describing a mechanism that does not exist, and the package six symbols are imported from is declared»

**ID:** B-022 (P1), B-023 (P1), B-029 (P2), B-044 (P2), B-058 (P2).

**Файлы:** `.env.example`, `requirements.txt`, `backend/transcribe_gigaam.py`, `backend/tests/test_config.py`.

**Верификация.** Новые тесты на файлах ДО правки:
```
FAIL: test_every_backend_variable_is_documented_or_declared_internal
  ['TRANSCRIPTOR_DEEPGRAM_FILLER_WORDS', 'TRANSCRIPTOR_DEEPGRAM_PUNCTUATE',
   'TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT', 'TRANSCRIPTOR_GIGAAM_CACHE_SIZE'] != []
FAIL: test_the_file_does_not_promise_a_dotenv_mechanism
  'Copy to .env' unexpectedly found
FAIL: test_the_clamped_whisper_settings_state_their_range
FAIL: test_every_third_party_module_the_backend_imports_is_declared
  ['huggingface_hub'] != []
```
B-044:
```
$ TRANSCRIPTOR_GIGAAM_CACHE_SIZE=oops python3 -c "import backend.transcribe_gigaam"
ДО:    ValueError: invalid literal for int() with base 10: 'oops'   (движок недоступен)
ПОСЛЕ: invalid integer env TRANSCRIPTOR_GIGAAM_CACHE_SIZE='oops'; using default=1
```
Полный набор:
```
Ran 708 tests in 37.134s
OK
```
(704 → 708.)

**Решения.**

* **B-023.** *Выбрано:* сказать правду в шапке `.env.example` — «reference only, ничего не читает `.env`, экспортируйте в оболочке/CI».
  *Отвергнуто:* добавить `python-dotenv` и `load_dotenv()`. Это новая зависимость и новый порядок разрешения настроек (файл против окружения) на пути старта приложения — продуктовое решение, а не починка расхождения. Записано в долг.
  *Не сделано здесь:* `README.md:127` («`cp .env.example .env`») — README вне периметра бэкенд-агента. В долг.
* **B-022.** *Выбрано:* `huggingface_hub>=0.23,<2` в `requirements.txt` с обоснованием прямо в файле. Нижняя граница — из фактически используемого API, верхняя — потому что мажорная смена ломает листинг/скачивание/удаление локальных моделей, а faster-whisper объявляет только `>=0.13`.
  *Тест* держит список прямых сторонних импортов бэкенда против объявленного, явным перечнем: выведенный автоматически список требовал бы решать, что тут stdlib, и превратил бы тест в шум.
* **B-029.** Четыре переменные добавлены в `.env.example`; сканер в тесте ищет ЛЮБОЙ строковый литерал `"TRANSCRIPTOR_*"` в `backend/**`, а не только аргументы `os.environ`, — три из четырёх пропущенных шли через `_env_flag`, и узкий скан объявил бы файл полным.
* **B-058.** У двух Whisper-настроек указаны их реальные клампы (4–8 и 1–3); тест это фиксирует. Значение вне диапазона молча подтягивается, и пользователь, выставивший 16 потоков, не имеет способа узнать почему ничего не изменилось.
* **B-044.** `int(os.environ...)` → `_env_int` (политика пакета), импортирован из `backend.transcribe`; цикла нет — обратные импорты gigaam там ленивые.

**Не сделано:** —

---

## Коммит 10 — одно правило в одном месте (сохранение записей, пресеты, провайдеры)

**Заголовок:** «One list of built-in presets, one rule for an empty recognition, one way to claim a recording's name, and a duration each provider reports for itself»

**ID:** B-028 (P2), B-030 (P2), B-031 (P2), B-032 (P2), B-073 (P2), B-084 (P2).

**Файлы:** `backend/main.py`, `backend/model_catalog.py`, `backend/config.py`, `backend/remote_deepgram.py`, `backend/remote_openrouter.py`, `backend/tests/test_upscale_presets.py`, `backend/tests/test_recording_names.py`, `backend/tests/test_remote_chunking.py`, `backend/tests/test_remote_openrouter.py`.

**Верификация.**
```
Ran 719 tests in 38.173s
OK
```
(708 → 719.)

**Решения.**

* **B-030.** `UPSCALE_PRESETS` удалён; валидация легаси-поля читает ключи `BUILTIN_UPSCALE_PRESETS`. Тест запрещает второму списку вернуться (`assertFalse(hasattr(main, "UPSCALE_PRESETS"))`).
* **B-028.** `DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER = REMOTE_TRANSCRIPTION_PROVIDERS[0]` в `model_catalog` — той же формы, что рядом стоящий `DEFAULT_LIVE_PREVIEW_LOCAL_MODEL`; `config.DEFAULT_CONFIG` и вызов в `main` читают его.
* **B-031.** `_placeholder_source_text(...)` + `NO_SPEECH_PLACEHOLDER`. Расхождение было содержательным: только один эндпоинт освобождал `provider="none"` — маркер рендерера «сохранить запись, не прося транскрипт», — поэтому одно и то же пустое распознавание давало разные файлы. Правило одно, тест проверяет обе стороны и оба эндпоинта.
* **B-032.** Промоут берёт имя через `_claim_recording_text_path` (O_EXCL), как оба эндпоинта сохранения, и освобождает claim на откате. *Отвергнуто:* оставить `_unique_recording_stem` и «просто добавить лок» — примитив резервирования уже написан, второй механизм не нужен.
* **B-073.** Три функции семейства «проверить-и-использовать» (`_unique_recording_stem`, `_unique_stem_from_base`, `_unique_recording_stem_for_source_file`) после B-032 не имеют ни одного продакшн-вызывающего и удалены. Четыре теста, которые их держали, **перенаправлены на живой путь** — это и был смысл находки: покрытым был мёртвый код, а не тот, по которому ходит приложение.
* **B-084.** `duration` — часть контракта адаптера: `deepgram_transcribe` читает свой `metadata.duration`, `openrouter_transcribe` честно отдаёт 0.0, вызывающий читает один ключ. Раньше вызывающий разбирал форму Deepgram у ответа OpenRouter, и каждая удалённая транскрипция через OpenRouter сообщала нулевую длительность.

**Не сделано:**

* **B-038** (три формы одного wire-типа `final`). Закрыть его — значит поменять форму конверта локального пути и парсер рендерера ОДНИМ коммитом: `frontend/src/main.tsx` читает плоские `complete/coveredSec/totalSec/droppedSec/uncoveredTailSec` и прямо документирует «coverage присутствует только у local-assist». Рендерер в этой сессии ведёт другой агент; менять его отсюда нельзя, а односторонняя правка либо ломает парсер, либо добавляет ЧЕТВЁРТУЮ форму. → долг с готовой рекомендацией.

---

## Коммит 11 — движки, языки и общий словарный API

**Заголовок:** «"auto" means one thing per endpoint and says why, the live config has one builder, and the predicates two modules share stop being private»

**ID:** B-027 (P2), B-033 (P2), B-034 (P2), B-035 (P2), B-036 (P2), B-039 (P2), B-040 (P2), B-041 (P2).

**Файлы:** `backend/deepgram_language.py` (новый), `backend/remote_deepgram.py`, `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/model_catalog.py`, `backend/config.py`, `backend/models_manager.py`, `backend/transcribe.py`, `backend/transcribe_gigaam.py`, `backend/main.py`, `backend/tools/deepgram_live_ab.py`, тесты: `test_deepgram_language.py` (новый), `test_deepgram_dual.py`, `test_transcribe_gigaam.py`, `test_live.py`.

**Верификация.**
```
Ran 742 tests in 54.591s
OK
```
(719 → 742.)

**Решения.**

* **B-039.** *Выбрано:* новый листовой модуль `backend/deepgram_language.py` владеет обоими ответами: `resolve_live_language` (переехал из `remote_deepgram_live`, реэкспортируется оттуда — ни один импортёр не тронут) и новый `rest_language_params`.
  *Поведение НЕ изменено намеренно:* REST по-прежнему шлёт `detect_language=true`. Измерение 2026-09-03 (память проекта) говорит, что `multi` теряет русские клаузы; REST-проход используется как «полное прочтение», и переводить его на `multi` — регрессия качества, а не унификация. Дефект был в том, что расхождение нигде не объяснено; теперь оно записано один раз, с причиной, и обе стороны читают его из одного места.
  *Исключение, которое не исключение:* `deepgram_recovery` намеренно шлёт `resolve_live_language` — она чинит дыру в чтении, сделанном стримом, и дыра не должна вернуться на другом языке, чем текст вокруг.
* **B-041.** `live_config()` переехал к типу конфигурации (`remote_deepgram_live`); `main._live_config` — привязка к нему (тесты зовут по этому имени), A/B-инструмент вызывает его же. Тест проверяет тождество объектов и что инструмент больше не может собрать конфиг сам.
* **B-033.** Пять имён (`_word_core`, `_word_duration`, `_time_overlap`, `_token_stem`, `_segment_words`) и шестое, найденное по ходу (`_as_float`, импортировался в `deepgram_recovery` отдельной строкой с `# noqa`), переименованы в публичные и внесены в `__all__`. Тест сканирует `backend/*.py` и запрещает импорт любого имени с подчёркиванием из этого модуля.
* **B-027.** `DUAL_STREAM_DEFAULT` / `DUAL_SECONDARY_LANGUAGE_DEFAULT` переехали в `model_catalog` — листовой модуль, который уже владеет «чем приложение пользуется по умолчанию» и который импортируют обе стороны.
  *Отвергнуто:* `deepgram_dual` импортирует `config` — тогда импорт модуля слияния создавал бы каталог данных (side effect на импорте) в любом тесте, который его трогает.
  *Не сделано:* третья копия в `frontend/src/deepgram-dual.ts` — фронтенд ведёт другой агент. В долг.
* **B-034/B-035.** `LIVE_SAMPLE_RATE_HZ` в четырёх местах GigaAM-адаптера; `GIGAAM_MODEL_PREFIX` в трёх местах `models_manager` вместо литерала, а неиспользуемый импорт `GIGAAM_MODELS` убран. Оба закреплены тестами, которые ищут литерал в исходнике.
* **B-036.** `_MIN_DECODABLE_WAV_BYTES` + `_undecodable_wav_result(path)`, спрошенный ДО диспетчеризации движка и до загрузки модели. Попутно закрыто названное в находке расхождение: пустой результат файловых входов сообщал жёсткий `0.0`, тогда как `transcribe_audio` считал реальную длительность; теперь считают все.
* **B-040.** Тест читает `main._FINALIZE_DRAIN_CEILING_SEC`, а не помнит `0.24`.

**Не сделано:** —
