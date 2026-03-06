# Call Transcriptor (MVP)

Локальное веб-приложение для транскрипции записей звонков через Whisper (faster-whisper).

## Возможности

- Загрузка аудиофайла и получение текста
- Лайв транскрипция с микрофона во время записи (псевдо-стриминг через WebSocket)
- Удаленная транскрипция через OpenRouter
- Desktop-обертка для macOS/Windows (Electron)
- Режим для стерео-записей звонков: разделение каналов и маркировка A/B
- Выгрузка результата в TXT и JSON

## Установка

Рекомендуется поставить ffmpeg (для MP3/M4A и для ресемплинга в 16kHz):

```bash
brew install ffmpeg
```

Python-зависимости:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Запуск

```bash
npm --prefix frontend install
npm --prefix frontend run build
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8321
```

Открыть: http://127.0.0.1:8321

## Примечания

- Если `ffmpeg` не установлен, загрузите WAV 16kHz (иначе конвертация/ресемплинг не сработает).
- Модель `large-v3` на CPU может быть очень медленной; для начала используйте `small`.
