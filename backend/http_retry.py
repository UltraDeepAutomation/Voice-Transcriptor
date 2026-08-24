"""Shared HTTP request helpers for remote transcription providers.

Centralised retry logic with exponential backoff — used by both
``remote_openrouter`` and ``remote_deepgram`` modules.
"""

import datetime as _dt
import random
import time
from email.utils import parsedate_to_datetime
from typing import Optional, Tuple

import requests
from requests import RequestException
from requests.adapters import HTTPAdapter


def _exponential_backoff(attempt: int, base: float) -> float:
    """Return the wait-time for retry attempt N with jitter.

    1.1.25: previous logic was ``base if attempt == 0 else base *
    (attempt + 1)`` which produced LINEAR backoff (base, 2·base,
    3·base, ...) despite the docstring promising exponential. Linear
    retries under sustained throttling continue hammering the
    provider; exponential gives the upstream time to recover.

    Adds 10% jitter so concurrent clients don't synchronise their
    retry waves into a thundering herd.
    """
    delay = base * (2 ** attempt)
    return delay + random.uniform(0, delay * 0.1)


class RemoteError(RuntimeError):
    """Raised when a remote API call fails irrecoverably."""
    pass


_SESSION = requests.Session()
# pool_maxsize=64 comfortably covers FastAPI's default 40-thread executor
# plus burst.
#
# pool_block=False (non-blocking overflow): when all 64 slots are in use
# a new request transparently opens a fresh short-lived connection
# rather than WAITING for a slot to free. The previous ``block=True``
# stance looked reasonable ("avoid TLS re-handshake overhead") but had
# a pathological failure mode: if a remote provider stalls (Deepgram
# cloud freeze, OpenRouter slow chunk, corporate proxy holding a
# read), each stalled call pins its pool slot for the full ``timeout``
# (60 s) while holding one of FastAPI's 40 executor threads. 64 stalled
# provider calls therefore FREEZE the whole backend threadpool — new
# requests for /api/health, /api/recordings etc. cannot schedule and
# users see the UI hang. The 100–300 ms TLS-handshake cost for overflow
# connections is orders of magnitude cheaper than the minute-long
# backend stall we trade it for, and in practice urllib3 does not emit
# warnings for non-blocking overflow.
_SESSION.mount("https://", HTTPAdapter(pool_connections=8, pool_maxsize=64, max_retries=0, pool_block=False))
_SESSION.mount("http://", HTTPAdapter(pool_connections=8, pool_maxsize=64, max_retries=0, pool_block=False))


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
    timeout: Optional["Tuple[float, float] | float"] = 60.0,
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
    # A caller passing retries<=0 would skip the loop entirely and trip
    # the `assert last_resp is not None` below with an AssertionError —
    # an opaque HTTP 500 with no provider context. Treat it as "one
    # attempt, no retry", which is what such a caller means.
    attempts = max(1, int(retries or 0))
    # Idempotency gate (BUG-53): a read timeout on a POST means the
    # provider MAY have already processed (and billed) the request —
    # blind retrying double-charges the user. Non-idempotent methods
    # retry only on connect-phase failures, where the request provably
    # never reached the server; read timeouts are terminal for them.
    _http_method = str(method or "GET").upper()
    _idempotent = _http_method in {"GET", "HEAD", "OPTIONS", "PUT", "DELETE"}
    for attempt in range(attempts):
        try:
            resp = _SESSION.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code in _TRANSIENT_HTTP_STATUS and attempt < attempts - 1:
                last_resp = resp
                delay = _exponential_backoff(attempt, backoff_base)
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
            if not _idempotent and isinstance(e, requests.ReadTimeout):
                # The request was sent and the response never came back:
                # the provider may have completed the work. Retrying a
                # paid transcription risks double billing — fail loudly
                # instead (BUG-53). ConnectTimeout is NOT here: it fires
                # before the request reaches the server, so a retry is
                # safe even for POST.
                break
            if attempt == attempts - 1:
                break
            time.sleep(_exponential_backoff(attempt, backoff_base))
    if last_err is not None:
        # Translate common low-level error patterns into actionable
        # messages. The raw form the user previously saw —
        #   "network error after 3 attempts: ('Connection aborted.',
        #    TimeoutError('The write operation timed out'))"
        # — is unhelpful: it doesn't explain what to DO. Map the most
        # common patterns to a one-liner that names the likely cause
        # (slow upload, DNS unreachable, TLS issue) so the user can
        # decide between retry, smaller file, VPN, or local Whisper.
        err_text = str(last_err)
        err_lower = err_text.lower()
        hint = ""
        if (
            "write operation timed out" in err_lower
            or "writetimeout" in err_lower
            or ("connection aborted" in err_lower and "timed out" in err_lower)
        ):
            hint = (
                " — upload timed out. Audio file likely too large for the current "
                "upload speed; try a smaller file, a faster connection, or switch "
                'Provider to "local" in Settings.'
            )
        elif "name resolution" in err_lower or "nodename nor servname" in err_lower or "name or service not known" in err_lower:
            hint = (
                " — DNS could not resolve the provider's hostname. Check internet "
                "connection or DNS settings."
            )
        elif "ssl" in err_lower or "certificate" in err_lower or "tls" in err_lower:
            hint = (
                " — TLS handshake failed. Check system clock, corporate proxy, "
                "or antivirus that intercepts HTTPS."
            )
        elif "connection refused" in err_lower:
            hint = " — provider refused the connection (maintenance / region block)."
        elif "read timed out" in err_lower:
            hint = (
                " — provider took too long to respond. Retry, or switch Provider "
                'to "local" in Settings if the link is consistently slow.'
            )
        raise RemoteError(f"network error after {attempts} attempts: {err_text}{hint}")
    # All attempts returned a transient HTTP status — return the last
    # response so the caller surfaces the exact upstream error.
    assert last_resp is not None
    return last_resp
