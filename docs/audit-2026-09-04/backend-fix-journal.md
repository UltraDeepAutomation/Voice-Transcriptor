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
