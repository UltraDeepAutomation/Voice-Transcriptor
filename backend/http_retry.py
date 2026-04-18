"""Shared HTTP request helpers for remote transcription providers.

Centralised retry logic with exponential backoff — used by both
``remote_openrouter`` and ``remote_deepgram`` modules.
"""

import datetime as _dt
import time
from email.utils import parsedate_to_datetime
from typing import Optional

import requests
from requests import RequestException
from requests.adapters import HTTPAdapter


class RemoteError(RuntimeError):
    """Raised when a remote API call fails irrecoverably."""
    pass


_SESSION = requests.Session()
# pool_maxsize=64 comfortably covers FastAPI's default 40-thread executor
# plus burst; pool_block=True makes high-concurrency uploaders wait for a
# free slot instead of silently discarding and re-handshaking TLS (the
# default behaviour emits "Connection pool is full" warnings and adds
# 100-300 ms per call for the fresh handshake).
_SESSION.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=64, max_retries=0, pool_block=True))
_SESSION.mount("http://", HTTPAdapter(pool_connections=4, pool_maxsize=64, max_retries=0, pool_block=True))


# Max seconds we will honour from a Retry-After header before capping.
# A hostile or buggy upstream could otherwise stall a user request for
# hours with a malicious Retry-After value.
_RETRY_AFTER_CAP_SEC = 30.0


def _parse_retry_after(raw: Optional[str]) -> float:
    """Parse a ``Retry-After`` header to delta-seconds.

    RFC 7231 allows either an integer delta-seconds or an HTTP-date.
    Returns 0.0 for missing / unparseable values.
    """
    if not raw:
        return 0.0
    raw = raw.strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(raw)
        if dt is None:
            return 0.0
        now = _dt.datetime.now(dt.tzinfo) if dt.tzinfo else _dt.datetime.now()
        return max(0.0, (dt - now).total_seconds())
    except (TypeError, ValueError):
        return 0.0


# HTTP status codes that indicate a transient upstream condition where
# retrying after a short delay is the correct behaviour.  4xx codes are
# excluded — they are caller errors (bad API key, malformed body, etc.)
# that no amount of retry will fix.
_TRANSIENT_HTTP_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def request_with_retry(
    method: str,
    url: str,
    *,
    retries: int = 3,
    backoff_base: float = 0.3,
    timeout: Optional[int] = 60,
    **kwargs,
) -> requests.Response:
    """Send an HTTP request with automatic retry on transient failures.

    Retries use exponential backoff: first retry at *backoff_base* seconds,
    subsequent retries multiply the backoff.  Retries fire on:

    * ``RequestException`` — transport-level failures (connection reset,
      DNS error, read timeout).
    * HTTP status codes in :data:`_TRANSIENT_HTTP_STATUS` (408, 425, 429,
      500, 502, 503, 504) — upstream indicated a transient condition.
      Deepgram cloud returns 502/503/504 during edge restarts, and
      OpenRouter returns 429/503 during provider throttling; failing
      without retry surfaces a hard error to the user when the next
      attempt would have succeeded.

    4xx codes other than 408/425/429 are returned as-is — they are caller
    errors (bad API key, malformed body, unsupported audio) that no
    amount of retry will fix.
    """
    last_err: Optional[Exception] = None
    last_resp: Optional[requests.Response] = None
    for attempt in range(retries):
        try:
            resp = _SESSION.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code in _TRANSIENT_HTTP_STATUS and attempt < retries - 1:
                last_resp = resp
                delay = backoff_base if attempt == 0 else backoff_base * (attempt + 1)
                # Honour Retry-After per RFC 7231. Providers
                # (OpenRouter, Deepgram) emit this on 429/503 to signal
                # the correct wait time; ignoring it hammers the
                # provider, gets throttled harder, and reports a false
                # hard failure when 5 seconds would have recovered.
                ra_sec = _parse_retry_after(resp.headers.get("Retry-After"))
                if ra_sec > 0:
                    delay = max(delay, min(ra_sec, _RETRY_AFTER_CAP_SEC))
                time.sleep(delay)
                continue
            return resp
        except RequestException as e:
            last_err = e
            if attempt == retries - 1:
                break
            time.sleep(backoff_base if attempt == 0 else backoff_base * (attempt + 1))
    if last_err is not None:
        raise RemoteError(f"network error after {retries} attempts: {last_err}")
    # All attempts returned a transient HTTP status — return the last
    # response so the caller surfaces the exact upstream error.
    assert last_resp is not None
    return last_resp
