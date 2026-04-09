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
    subsequent retries multiply the backoff.  Only ``RequestException``
    (connection errors, timeouts) triggers a retry — HTTP 4xx/5xx status
    codes do **not** (those are returned normally for the caller to handle).
    """
    last_err: Optional[Exception] = None
    for attempt in range(retries):
        try:
            return _SESSION.request(method, url, timeout=timeout, **kwargs)
        except RequestException as e:
            last_err = e
            if attempt == retries - 1:
                break
            # First retry is fast, subsequent retries use longer backoff.
            time.sleep(backoff_base if attempt == 0 else backoff_base * (attempt + 1))
    raise RemoteError(f"network error after {retries} attempts: {last_err}")
