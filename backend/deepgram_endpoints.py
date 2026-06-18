"""SSOT for Deepgram endpoint URLs.

Single source of truth for the Deepgram REST + WebSocket URLs used
by ``backend.remote_deepgram`` (batch) and ``backend.remote_deepgram_live``
(streaming). Previously each module hardcoded its own URL constant
which meant:

  • A regional override (e.g. shifting to ``api-eu.deepgram.com``)
    required two file edits.
  • A staging/canary endpoint had to be wired through both modules
    independently.
  • A typo in one was undetectable until that module's calls failed
    in production.

Centralised here. Both modules import ``DEEPGRAM_REST_BASE`` and
``DEEPGRAM_LIVE_URL`` from this module. The host can be overridden
with ``TRANSCRIPTOR_DEEPGRAM_HOST`` for testing / regional routing
without code changes.
"""

import os

# ``api.deepgram.com`` is the canonical production host. The env
# override exists so an operator can point a deployment at a
# regional endpoint (e.g. ``api-eu.deepgram.com``) or a mock
# server during integration tests, without touching the code.
_DEFAULT_HOST = "api.deepgram.com"


def _deepgram_host_from_env() -> str:
    host = (os.environ.get("TRANSCRIPTOR_DEEPGRAM_HOST") or "").strip() or _DEFAULT_HOST
    if (
        "://" in host
        or "/" in host
        or "?" in host
        or "#" in host
        or any(ch.isspace() for ch in host)
    ):
        raise ValueError("TRANSCRIPTOR_DEEPGRAM_HOST must be a host[:port] value without scheme or path")
    return host


_HOST = _deepgram_host_from_env()

DEEPGRAM_REST_BASE = f"https://{_HOST}/v1"
DEEPGRAM_LIVE_URL = f"wss://{_HOST}/v1/listen"
