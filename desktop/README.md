# Desktop (macOS/Windows)

Electron-обертка над локальным backend (`FastAPI`) и UI.

Dev запуск:

```bash
cd desktop
npm install
npm run dev
```

Сборка:

```bash
cd desktop
npm run dist:mac
```

Важно: пока что backend запускается через системный `python3` (и требует установленных зависимостей из `requirements.txt`).
Следующий шаг - упаковать Python + модели внутрь сборки.
