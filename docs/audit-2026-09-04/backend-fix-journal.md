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
