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

import logging
import os

logger = logging.getLogger(__name__)

# ``api.deepgram.com`` is the canonical production host. The env
# override exists so an operator can point a deployment at a
# regional endpoint (e.g. ``api-eu.deepgram.com``) or a mock
# server during integration tests, without touching the code.
_DEFAULT_HOST = "api.deepgram.com"


def _deepgram_host_from_env() -> str:
    """Resolve the Deepgram host, degrading to the default on bad input.

    This runs at MODULE IMPORT time, transitively from ``backend.main``.
    Raising here (the previous behaviour) killed the backend process
    before uvicorn ever started, so Electron saw the child exit
    immediately, retried eight times, and surfaced a generic "backend
    did not start" with no hint that one env var was the cause.

    ``backend.main._env_int`` already established the house policy for
    malformed env input — warn and use the documented default so the
    app boots and the misconfiguration is visible in the log. Match it.
    """
    raw = (os.environ.get("TRANSCRIPTOR_DEEPGRAM_HOST") or "").strip()
    host = raw or _DEFAULT_HOST
    if (
        "://" in host
        or "/" in host
        or "?" in host
        or "#" in host
        or any(ch.isspace() for ch in host)
    ):
        logger.warning(
            "invalid TRANSCRIPTOR_DEEPGRAM_HOST=%r (expected host[:port] with no "
            "scheme or path); using default %s",
            raw, _DEFAULT_HOST,
        )
        return _DEFAULT_HOST
    return host


_HOST = _deepgram_host_from_env()

DEEPGRAM_REST_BASE = f"https://{_HOST}/v1"
DEEPGRAM_LIVE_URL = f"wss://{_HOST}/v1/listen"
