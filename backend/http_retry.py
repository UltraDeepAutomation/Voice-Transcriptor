"""Shared HTTP request helpers for remote transcription providers.

Centralised retry logic with exponential backoff — used by both
``remote_openrouter`` and ``remote_deepgram`` modules.
"""

import time
from typing import Optional

import requests
from requests import RequestException
from requests.adapters import HTTPAdapter


class RemoteError(RuntimeError):
    """Raised when a remote API call fails irrecoverably."""
    pass


_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(pool_connections=16, pool_maxsize=32, max_retries=0))
_SESSION.mount("http://", HTTPAdapter(pool_connections=16, pool_maxsize=32, max_retries=0))


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
                time.sleep(backoff_base if attempt == 0 else backoff_base * (attempt + 1))
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
