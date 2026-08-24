# BUGS_AUDIT — 2026-08-24

Полный аудит после коммитов 10ebfed…7c7bb63 (интеграция GigaAM-v3, релизы
1.3.5–1.3.8) и ревизии последних 30 коммитов. Методика: построчная проверка
нового GigaAM-слоя (transcribe_gigaam.py, dispatch в transcribe.py, маршруты
main.py, models_manager.py), live-трима, config.py (контроль волны W2),
Settings-вёрстки (воспроизведено headless-Electron зондом на собранном
дистрибутиве с замером геометрии карточек), desktop-установщика движка и
ротации логов, requirements-пинов. Плюс целевые проходы: bare-except,
mutable-defaults, TODO/FIXME, innerHTML/XSS, openExternal, LSP-диагностики
по всему бэку (все кандидаты проверены вручную; «contextlib is not defined»
и «out_text possibly unbound» — ложные).

**Честный итог: 14 реальных дефектов** (4×P1, 8×P2, 2×P3). Не 100 — кодовая
база прошла четыре аудиторские волны (VERIFIED_AUDIT 56+, AUDIT_2026-08 30,
BUGS_AUDIT 19+BUG-20…23+W2-01…11), большинство типовых классов закрыто и
подтверждено повторными проходами. W2-05…08 (config.py) на HEAD проверены —
исправлены, не переотчитываются.

---

## P1 — Работоспособность / Функционал

### BUG-24. `transcribe_file` не знает про GigaAM: маршруты файлов/задач принимают gigaam-id и падают

- **Файл:** `backend/transcribe.py:359-389` (+ `backend/main.py:497`, `:1798`)
- **Суть:** единственный вход файловой транскрипции идёт напрямую в
  `_model()` → `WhisperModel(...)`, хотя `ALLOWED_LOCAL_MODELS`
  (`main.py:497` = весь каталог, включая `gigaam-*`) пропускает эти id на
  sync/jobs/re-transcribe маршрутах (`main.py:1798` — единственный вызов
  `transcribe_file`).
- **Последствие:** пользователь выбирает «gigaam-v3-e2e-rnnt» в History →
  Re-transcribe (или queued job) → 500 с бессмысленной ошибкой faster-whisper
  (попытка скачать несуществующий HF-репозиторий `gigaam-v3-e2e-rnnt`).
- **Текущий код:**
  ```python
  def transcribe_file(path: str, model_name: str, *, language: Optional[str] = None,
                      word_timestamps: bool = False) -> Dict[str, Any]:
      segments, info = _model(model_name).transcribe(path, language=language, ...)
  ```
- **Исправленный код:**
  ```python
  def transcribe_file(path: str, model_name: str, *, language: Optional[str] = None,
                      word_timestamps: bool = False) -> Dict[str, Any]:
      if model_name.startswith(GIGAAM_MODEL_PREFIX):
          audio, sr = sf.read(path, dtype="float32", always_2d=True)
          if sr != LIVE_SAMPLE_RATE_HZ:
              raise ValueError(f"expected {LIVE_SAMPLE_RATE_HZ} Hz input, got {sr}")
          return transcribe_gigaam(audio.mean(axis=1), model_name,
                                   word_timestamps=word_timestamps)
      segments, info = _model(model_name).transcribe(path, language=language, ...)
  ```
- **Объяснение:** диспетчинг движка поднимается в оба канонических входа
  (`transcribe_audio` уже ветвит, `transcribe_file` — нет). Файловые маршруты
  отдают 16 kHz mono WAV (контракт пайплайна), поэтому чтение через
  `soundfile` (уже прямая зависимость) — без новых пакетов.

### BUG-25. `warm_model` не знает про GigaAM: /api/transcribe/warmup падает на gigaam-id

- **Файл:** `backend/transcribe.py:188-…` (+ `backend/main.py:1316-1326`)
- **Суть:** маршрут warmup валидирует модель по `ALLOWED_LOCAL_MODELS`
  (gigaam пропускается) и вызывает `warm_model`, который тоже сразу строит
  `WhisperModel`.
- **Последствие:** выбор gigaam-модели в UI (подгрузка превью/health-цикл)
  может уронить warmup-запрос; та же бессмысленная ошибка HF.
- **Текущий код:**
  ```python
  def warm_model(model_name: str, *, probe: bool = False):
      m = _model(model_name)
  ```
- **Исправленный код:**
  ```python
  def warm_model(model_name: str, *, probe: bool = False):
      if model_name.startswith(GIGAAM_MODEL_PREFIX):
          from backend.transcribe_gigaam import warm_gigaam
          warm_gigaam(model_name)
          return
      m = _model(model_name)
  ```
  (+ `warm_gigaam()` в адаптере: `_load_model(model_id)` под уже существующим
  локом кэша.)
- **Объяснение:** прогрев — часть публичного контракта каталога моделей;
  движок-специфика не должна протекать в маршрут.

### BUG-26. Live-trim склеивает слова GigaAM: адаптер нарушает собственный контракт формата слов

- **Файл:** `backend/transcribe_gigaam.py:101,106` (+ `backend/live.py:370-377`)
- **Суть:** адаптер обещает «тот же segment/word shape, что faster-whisper,
  чтобы downstream работал без изменений», но `.strip()` у слов убирает
  ведущие пробелы — а `live.py` восстанавливает текст обрезанного сегмента
  конкатенацией `"".join`, рассчитанной на faster-whisper-конвенцию
  («пробел-в-начале-токена»).
- **Последствие:** live-диктовка на `gigaam-v3-e2e-rnnt` после КАЖДОГО
  word-trim выдаёт склеенный текст («приветкакделасторона») — прямой
  потеря-качества класс на главном сценарии приложения.
- **Текущий код:**
  ```python
  text = str(getattr(w, "text", "") or "").strip()          # адаптер
  out.append({"word": text, ...})
  ...
  text = "".join(str(w.get("word") or "") for w in kept_words).strip()  # live.py
  ```
- **Исправленный код (в адаптере, единственное место):**
  ```python
  first = not out
  token = [secret redacted], "text", "") or "").strip()
  if not token or w_end <= w_start:
      continue
  out.append({"word": token if first else f" {token}",
              "start": round(w_start, 3), "end": round(w_end, 3)})
  ```
- **Объяснение:** SSOT-фикс в точке адаптации: все потребители (live-trim,
  фронтовый merge, text-match) продолжают работать по одной конвенции
  faster-whisper, вместо того чтобы учить каждый из них о втором движке.

### BUG-38. Результат адаптера GigaAM без `text`/`language_probability`: sync-маршрут теряет текст

- **Файл:** `backend/transcribe_gigaam.py:185` (найден при фиксе Группы A)
- **Суть:** адаптер обещает «shape как `transcribe_audio`», но возвращает
  только `{segments, language, duration}` — без `text` и
  `language_probability`, которые потребители читают напрямую
  (`main.py:4405` `result.get("text")`).
- **Последствие:** gigaam-транскрипция через sync-путь (numpy-вход) даёт
  ПУСТОЙ текст при непустых сегментах — тихая потеря результата.
- **Исправление:** вернуть полный контракт: `text` = join сегментных
  текстов, `language_probability` = 1.0 (движок детерминированно ru).


### BUG-27. Settings: поля вылезают из карточек и наезжают на соседнюю карточку (воспроизведено)

- **Файл:** `frontend/src/styles.css:2255-2258`
- **Суть:** `.card .field-stack { flex: 1 1 auto; min-height: 0 }` —
  `min-height: 0` позволяет стеку сжаться ниже контента внутри
  stretch-карточки, а грид-ряд при этом сайзится по МЕНЬШЕЙ соседней
  карточке (вклад flex-контейнера в intrinsic-высоту схлопывается).
- **Последствие (замер зонда на собранном dist, 2000×1160):** карточка
  Defaults получает 279px при контенте 296px; инпут Threshold рисуется
  18px ниже границы карточки (bottom 714 против card 696) и перекрывает
  заголовок Shortcuts (ряд 3 начинается на 710). Тот же класс — любая
  карточка, чей контент выше соседа по ряду.
- **Текущий код:**
  ```css
  .card .field-stack {
    flex: 1 1 auto;
    min-height: 0;
  }
  ```
- **Исправленный код:**
  ```css
  .card .field-stack {
    flex: 1 1 auto;
    /* Без min-height:0: он позволял стеку сжиматься ниже контента внутри
       stretch-карточки — грид-ряд сайзился по соседней карточке, и поля
       рисовались поверх следующего ряда. Ряд теперь растёт до самого
       высокого контента; .settings (overflow-y:auto) скроллит страницу. */
  }
  ```
- **Объяснение:** корень — конфликт «stretch-выравнивание карточек» ×
  «shrinkable flex-стек». Убираем shrink ниже контента: ряды грида снова
  обязаны вмещать самый высокий контент (это и есть контракт
  «карточки в ряду одной высоты» из комментария у `.card`).

---

## P2 — Функционал / Производительность / UX

### BUG-28. Чанкер GigaAM режет слова на границах 20-секундных кусков

- **Файл:** `backend/transcribe_gigaam.py:80-89,132-142`
- **Суть:** последовательные чанки [0,20],[20,40]… режут аудио в произвольной
  точке: слово на границе даёт огрызок в обоих чанках (дубль/мусор в тексте).
- **Последствие:** ~1 битое слово на каждые 20 секунд файла; десятиминутная
  запись ≈ 30 дефектов текста.
- **Исправление:** перекрытие чанков (1.2 c) + дедупликация слов по
  абсолютному времени при сшивке (предпочтение полному вхождению); для
  бессловесного режима — сшивка текста с отбрасыванием хвостового огрызка.
  Детерминированно, покрывается тестами с фейковой моделью.

### BUG-29. Upload игнорирует выбранную локальную модель

- **Файл:** `frontend/src/main.tsx:11723`
- **Суть:** локальная ветка аплоада хардкодит `DEFAULT_LOCAL_TRANSCRIPTION_MODEL`,
  тогда как Live и Re-transcribe берут выбор из `#model`.
- **Последствие:** выбрал large-v3 — аплоад всё равно гоняет small; тихое
  расхождение качества между вкладками.
- **Исправление:** `modelLabel = getLocalModelValue();` (тот же SSOT-геттер,
  что у остальных путей) с фолбэком на дефолт при пустом выборе.

### BUG-30. Авто-применение выбора модели после загрузки — мёртвый код

- **Файл:** `frontend/src/main.tsx:838-848`
- **Суть:** условие `!findLocalModelRow(id)?.status` никогда не истинно —
  бэкенд всегда присылает truthy `status` («idle» → «done»).
- **Последствие:** пообещали «выбор станет активным, когда модель скачается» —
  обещание не выполняется, селектор остаётся на старой модели.
- **Исправление:** `findLocalModelRow(pendingModelSelection)?.status === "done"`.

### BUG-31. Карточка «Local models» без loading/empty-состояния выглядит сломанной

- **Файл:** `frontend/src/main.tsx:772-774` (`renderLocalModels`)
- **Суть:** при пустом кэше таблица не рендерит ничего (зонд: `children: 0`),
  карточка стоит пустая — пользователь читает это как «не работает».
- **Исправление:** плейсхолдер-строка: «Loading models…» до первого ответа,
  «Model list unavailable — backend offline» при ошибке; исчезает при
  появлении строк.

### BUG-32. Диагностика провала установки GigaAM пуста: `res.details` не существует

- **Файл:** `desktop/main.js:5299`
- **Суть:** `runCommand()` возвращает `{ok, code, stdout, stderr}` — поля
  `.details` нет, в лог провала установки пишется пустая строка.
- **Последствие:** многогигабайтная установка падает (диск, прокси, Xcode
  CLT) — и в логе нет ни строчки причины; поддержка слепая.
- **Исправление:** `` `(res.stderr || res.stdout || "").slice(0, 400) ``.

### BUG-33. Нет проверки свободного места перед ~6 GB установкой движка

- **Файл:** `desktop/main.js:5283-5320`
- **Суть:** `pip install --target userData/engine-site` стартует без проверки
  диска; ENOSPC посреди установки оставляет полумёртвый engine-site.
- **Последствие:** `import gigaam` ломается НА КАЖДЫЙ запуск → 30-минутная
  блокирующая переустановка при каждом старте, пока пользователь не чистит
  руками.
- **Исправление:** перед установкой `fs.statfsSync(engineSiteRoot)` (Node 18.15+):
  требуется `free > 8 GB` (download + unpack + pip-cache), иначе внятная
  ошибка в лог и статус инсталлятора, без запуска pip.

### BUG-34. Архивы ротации main.log не подрезаются — безграничный рост userData

- **Файл:** `desktop/main.js:323-381`
- **Суть:** каждая ротация создаёт `main.log.archive-<stamp>` (до 5 MB);
  удалять их «при ротации» нельзя по дизайну, но и boot-retention нет.
- **Последствие:** месяцы использования = сотни мегабайт логов на диске
  пользователя без его ведома.
- **Исправление:** boot-sweep (рядом с `recoverOrphanRotatingLogs`):
  сохранить последние N=10 архивов и ≤50 MB суммарно, старшие удалить —
  политика ретенции в одном месте, ротация по-прежнему ничего не удаляет.

### BUG-35. requirements-gigaam.txt: непинутый git HEAD + устаревший комментарий

- **Файл:** `requirements-gigaam.txt:1-3`
- **Суть:** `gigaam[torch] @ git+https://github.com/salute-developers/GigaAM.git`
  плавает за upstream main (не воспроизводимая установка; любой push в
  upstream ломает установку приложения), комментарий говорит про
  «APP VENV (userData/.venv)» — установка давно идёт в engine-site.
- **Исправление:** пин на конкретный коммит
  `@ git+https://github.com/salute-developers/GigaAM.git@<sha>` + правка
  комментария (engine-site, ENABLE_GIGAAM-маркер).

---

## P3 — Совместимость / Мелочи / SSOT

### BUG-36. `pip install --upgrade --target` накапливает мусор прошлых версий

- **Файл:** `desktop/main.js:5289-5290` (+ точечный prune numpy 7c7bb63)
- **Суть:** `--upgrade` с `--target` перезаписывает, но НЕ удаляет файлы
  предыдущей версии пакета; сейчас зачищается только numpy/ml_dtypes.
- **Последствие:** после обновления upstream в engine-site остаются старые
  модули, которые могут теневыполняться; каталог растёт с каждой установкой.
- **Исправление:** канонический паттерн pip для --target: установка в
  свежий `engine-site.staging`, точечный prune, атомарный rename-обмен с
  текущим каталогом, удаление старого. Заодно закрывает класс целиком.

### BUG-37. PROJECT_STRUCTURE.md дрейфовал от реальной структуры (SSOT-док)

- **Файл:** `PROJECT_STRUCTURE.md:14,22` (и схема backend/)
- **Суть:** ссылки на `VERIFIED_AUDIT.md` и `INSTALL_OTHER_MAC.md` «в корне» —
  оба файла в `docs/`; в схеме backend/ нет models_manager.py и
  transcribe_gigaam.py.
- **Исправление:** синхронизировать дерево и пути с фактическим состоянием.

---

## Проверено и НЕ дефект (чтобы не реаудитили)

- `config.py`: W2-05…08 подтверждено исправлены на HEAD (RuntimeError в
  `encrypt_value`, O_EXCL-хелпер ключа, .bak-ветка чтения, providers из
  SSOT-кортежа).
- LSP-кандидаты `live.py:185 contextlib` (импорт есть, :2) и
  `main.py:5711 out_text` (ветки взаимоисключающие, обе присваивают) — ложные.
- XSS: все `innerHTML` во фронте — очистки `= ""`; внешний браузер через
  `setWindowOpenHandler` с origin-парсингом и http/https-фильтром.
- `gigaam_available()` через `find_spec` — дешёвый sys.path-скан, ок для
  /api/health.
- Фронтовый gating `local.engines` (main.tsx:940-943) присутствует.

## План фиксов (исполняется сразу за этим коммитом)

1. Группа A (backend SSOT-диспетчинг): BUG-24, BUG-25, BUG-26 + тесты.
2. Группа B (качество GigaAM): BUG-28 + тесты чанкера.
3. Группа C (фронт): BUG-27 (CSS + повторный зонд), BUG-29, BUG-30, BUG-31.
4. Группа D (desktop): BUG-32, BUG-33, BUG-34, BUG-35, BUG-36.
5. Группа E (доки): BUG-37.

---

## Статус исправлений (обновлено 2026-08-24, все группы выполнены)

| Баг | Статус |
|-----|--------|
| BUG-24 | ✅ ИСПРАВЛЕН — `transcribe_file` диспетчит gigaam в адаптер (16 kHz mono WAV → float32 PCM), офф-контракт sample rate валится с понятной ошибкой; +2 теста |
| BUG-25 | ✅ ИСПРАВЛЕН — `warm_model` диспетчит в новый `warm_gigaam()`; +1 тест |
| BUG-26 | ✅ ИСПРАВЛЕН — адаптер эмитит faster-whisper конвенцию слов (первый токен без пробела, далее с ведущим); live-trim склейка корректна; +1 тест |
| BUG-38 | ✅ ИСПРАВЛЕН — результат адаптера несёт `text` и `language_probability` (полный контракт `transcribe_audio`); покрыт тестом |
| BUG-27 | ✅ ИСПРАВЛЕН — `grid-auto-rows: max-content` (корень: Chromium занижает intrinsic-оценку flex-карточки в auto-треке); верифицировано headless-зондом: ряд 314.3px, overflowов нет |
| BUG-28 | ✅ ИСПРАВЛЕН — чанкеры перекрываются на 1.2 c; time-based ститчер оставляет полную копию слова, отбрасывая обрубки; +3 теста |
| BUG-29 | ✅ ИСПРАВЛЕН — аплоад использует `selectedLocalModel()` (новый SSOT-геттер выбора) |
| BUG-30 | ✅ ИСПРАВЛЕН — авто-применение ждёт `status === "done"` |
| BUG-31 | ✅ ИСПРАВЛЕН — плейсхолдер «Loading models…» / «Model list unavailable — backend offline» (рендерится и на ошибке fetch) |
| BUG-32 | ✅ ИСПРАВЛЕН — диагностика провала установки читает `stderr`/`stdout` |
| BUG-33 | ✅ ИСПРАВЛЕН — гейт 8 GB через `fs.statfsSync`; при нехватке — внятный статус, установка не стартует |
| BUG-34 | ✅ ИСПРАВЛЕН — boot-retention архивов лога: ≤10 штук и ≤50 MB, свежей архив не удаляется никогда |
| BUG-35 | ✅ ИСПРАВЛЕН — пин `@7447938d…` + актуальный комментарий (engine-site) |
| BUG-36 | ✅ ИСПРАВЛЕН — установка в свежий `engine-site.staging` → prune → атомарный rename-обмен; `--upgrade`-мусор невозможен структурно |
| BUG-37 | ✅ ИСПРАВЛЕН — PROJECT_STRUCTURE.md синхронизирован (docs/, models_manager.py, transcribe_gigaam.py, requirements-gigaam.txt) |

Верификация: backend 242 теста (unittest, bundled runtime), frontend tsc + ESLint
+ 60 тестов (vitest), desktop 15 тестов (node --test), headless-Electron зонд
раскладки — всё зелёное.

