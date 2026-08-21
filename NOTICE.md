# Notices

Transcriptor is licensed under the MIT License — see [LICENSE](LICENSE).
This file carries the notices that used to be appended to it, which stopped
GitHub from recognising the licence at all.

---

## Third-party components

This software bundles and uses the following open-source third-party components:

* **Python 3.12.13** (Python Software Foundation License) — distributed via
  python-build-standalone (Astral / indygreg) as the bundled runtime for
  Windows x64, macOS arm64, and Linux x64 installers.
* **FFmpeg** (LGPL 2.1 / GPL 2.0 for the ``gpl`` build) — bundled as a static
  binary for Windows x64, macOS arm64, and Linux x64. Source:
  github.com/BtbN/FFmpeg-Builds (Windows), osxexperts.net (macOS), and
  johnvansickle.com (Linux).
* **faster-whisper** (MIT) — speech-to-text inference runtime.
* **ctranslate2** (MIT) — neural machine translation runtime used by
  faster-whisper.
* **FastAPI** (MIT) — Python web framework.
* **Electron** (MIT) — desktop application shell.
* **Deepgram Nova-3** — commercial STT API, optional remote provider.
  Users supply their own API key. Deepgram's terms apply to API usage.
* **OpenRouter** — commercial LLM aggregator, optional remote provider for
  AI Upscale. Users supply their own API key. OpenRouter's terms apply
  to API usage.

Full dependency list: see ``requirements.txt`` and ``desktop/package.json``.

---

## Privacy

Transcriptor runs entirely on your machine by default. Audio never leaves
your device unless you explicitly configure a remote provider (Deepgram or
OpenRouter) and provide your own API key for that provider. When a remote
provider is selected, the audio (for transcription) or transcript text (for
AI Upscale) is sent directly to that provider's API — Transcriptor does not
proxy or log the content.

The app does not collect telemetry. Logs are written to your local userData
directory (``%APPDATA%\Transcriptor\main.log`` on Windows,
``~/Library/Application Support/Transcriptor/main.log`` on macOS,
``~/.config/Transcriptor/main.log`` on Linux) and are never transmitted
anywhere.
