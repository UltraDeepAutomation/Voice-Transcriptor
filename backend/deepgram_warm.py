"""One warm Deepgram live socket, opened before the user needs it.

Why
---
``BUGS_AUDIT_2026-09-03.md`` §2.4 measured the Deepgram connect on the
user's own log: **p50 880 ms, p90 1.2 s, max 9.7 s**, plus one 12 s
timeout during which 126 s of dictation went into a stream that never
existed (§3.7). That cost sits at the very start of every recording —
the renderer opens the microphone and streams immediately, so the first
second of speech is buffered instead of transcribed, and the whole stop
chain inherits the delay. Opening the socket ahead of time removes it
from the critical path entirely.

Keeping it warm: ``KeepAlive``, not silence
-------------------------------------------
The two candidate mechanisms are a text ``KeepAlive`` control frame and
a trickle of silent PCM. Deepgram's documentation settles it — from
https://developers.deepgram.com/docs/keep-alive:

    "If no audio data or ``KeepAlive`` messages are sent within a
    10-second window, the connection will close with a ``NET-0001``
    error."

    "Send a ``KeepAlive`` message every 3-5 seconds to prevent the
    10-second timeout that triggers a ``NET-0001`` error and closes the
    connection."

and from https://developers.deepgram.com/docs/audio-keep-alive:

    "Ensure the message is sent as a text WebSocket frame—sending it as
    binary may result in incorrect handling."

So the idle timeout is reset by *either* audio *or* a ``KeepAlive``
text frame; silence frames are not required. ``KeepAlive`` is therefore
the mechanism used here, and no new machinery is needed for it:
``DeepgramLiveSession._keepalive_loop`` already sends exactly that frame.
The only adjustment is cadence — a warm socket sends no audio at all, so
it is opened with ``WARM_KEEPALIVE_INTERVAL_SEC`` (4 s, inside the
documented 3-5 s window) rather than the 7 s that suffices for a session
with audio already flowing.

Timestamps: why there is no warm-time offset
--------------------------------------------
Deepgram's ``Results`` carry ``start``/``duration`` as offsets into the
**audio it has received**, not into the lifetime of the socket. Choosing
``KeepAlive`` over silence frames means a warm socket receives zero
audio bytes before it is adopted, so the adopted recording still starts
at t=0 and ``_process_deepgram_message`` — the single normaliser that
turns those numbers into segments, interim words, ``coveredEndSec`` and
``streamedSec`` — needs no offset subtraction at all.

That is enforced rather than assumed: ``acquire()`` refuses to adopt a
socket whose ``stats.bytes_sent`` is non-zero. If a future change ever
starts warming with audio, every session on that socket would be shifted
by the warm duration; the guard turns that into a loud discard and a
fresh connect instead of a silent, whole-transcript timing error.

Cost
----
Deepgram bills streaming by the audio it processes and a ``KeepAlive``
frame carries no audio — the documentation files the message under
"preventing timeouts and optimizing costs". A warm socket is still a
real connection holding a slot against the account's concurrency limit,
so its lifetime is bounded: ``WARM_IDLE_TTL_SEC`` after it goes warm it
is closed, and the next recording pays the connect it would have paid
anyway. Warming is demand-driven — backend start and the end of each
recording — never a timer, so an app left open overnight ends up
holding nothing.
"""

from __future__ import annotations

import array
import asyncio
import logging
import sys
import time
from dataclasses import dataclass
from typing import Callable, Optional

from backend.remote_deepgram_live import (
    DeepgramLiveConfig,
    DeepgramLiveError,
    DeepgramLiveSession,
)

logger = logging.getLogger("transcriptor.deepgram_warm")


# Cadence for a socket that sends no audio. Inside Deepgram's documented
# 3-5 s window (see the module docstring); the session default of 7 s is
# for a stream that is already carrying audio, where every frame resets
# the same 10 s timer.
WARM_KEEPALIVE_INTERVAL_SEC = 4.0

# How long a warm socket may sit unused before it is closed. Bounds the
# concurrency slot it occupies; the next recording simply pays the
# connect it would have paid without any warm pool at all.
WARM_IDLE_TTL_SEC = 300.0

# A warm socket proves it is alive by getting its KeepAlive frames onto
# the wire. Two missed cadences (plus slack) means the send path is no
# longer working even though nothing raised — discard rather than adopt.
WARM_KEEPALIVE_STALE_SEC = 12.0

# Peak sample (of int16 full scale) above which a PCM frame counts as
# speech rather than room noise. ≈0.02 FS: comfortably above a quiet
# room and far below any voiced audio, especially given that Chromium's
# AGC starts a capture near full scale (audit §4.3). Used only to decide
# WHEN to start the liveness clock on an adopted socket, never to drop
# audio.
WARM_VOICE_PEAK = 655


def pcm_has_voice(data: bytes) -> bool:
    """Does this PCM16LE frame carry anything louder than room noise?

    The warm-socket liveness check (``main._run_deepgram_live_session``)
    measures "no results within 2.5 s of the first non-silent audio". It
    has to be the first *non-silent* frame: a user who presses the
    hotkey and then thinks for three seconds sends only silence, and
    Deepgram is entitled to answer silence with nothing at all — timing
    the probe from the first frame instead would throw away a perfectly
    healthy socket on every slow start.
    """
    usable = len(data) - (len(data) % 2)
    if usable < 2:
        return False
    samples = array.array("h")
    samples.frombytes(bytes(data[:usable]))
    if sys.byteorder != "little":
        samples.byteswap()
    return max(max(samples), -min(samples)) >= WARM_VOICE_PEAK


@dataclass(frozen=True)
class WarmAcquisition:
    """What ``DeepgramWarmPool.acquire()`` handed back.

    ``connect_ms`` is the measured connect time of THIS socket, whether
    it was paid now (``adopted`` false) or ahead of time (``adopted``
    true, in which case it is the latency the recording did not pay).
    """

    session: DeepgramLiveSession
    adopted: bool
    warm_age_sec: float
    connect_ms: Optional[float]


def _default_factory(
    api_key: str, cfg: DeepgramLiveConfig
) -> DeepgramLiveSession:
    return DeepgramLiveSession(
        api_key=api_key,
        config=cfg,
        keepalive_interval_sec=WARM_KEEPALIVE_INTERVAL_SEC,
    )


class DeepgramWarmPool:
    """At most one warm ``DeepgramLiveSession``, keyed by its config.

    The key is ``DeepgramLiveConfig.to_query_string()`` — the exact
    string that goes on the wire. Model, language, keyterms, diarize,
    endpointing and the shared formatting flags all feed it, so a
    configuration change invalidates the warm socket by construction
    rather than by anyone remembering to list the fields that matter.
    The API key is compared alongside it: rotating the key must not
    hand a recording a socket authenticated with the old one.

    One slot, not one per key: every warm socket is a live connection
    against the user's Deepgram concurrency limit, and the app records
    with one configuration at a time. A mismatch is self-correcting —
    ``acquire()`` closes the stale socket and connects fresh, and the
    re-warm that follows the recording uses the configuration that was
    actually used.

    Bound to the app lifespan: ``start()`` arms it, ``close_all()``
    releases it. Un-armed, ``rewarm()`` is a no-op and ``acquire()``
    degrades to exactly what the caller did before this module existed
    — construct a session and connect it — so nothing retains a socket
    outside a running application.
    """

    def __init__(
        self,
        *,
        session_factory: Callable[
            [str, DeepgramLiveConfig], DeepgramLiveSession
        ] = _default_factory,
        idle_ttl_sec: float = WARM_IDLE_TTL_SEC,
        keepalive_stale_sec: float = WARM_KEEPALIVE_STALE_SEC,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = session_factory
        self._idle_ttl_sec = float(idle_ttl_sec)
        self._keepalive_stale_sec = float(keepalive_stale_sec)
        self._clock = clock
        self._lock = asyncio.Lock()
        self._armed = False
        self._warm: Optional[DeepgramLiveSession] = None
        self._warm_key: Optional[str] = None
        self._warm_api_key: Optional[str] = None
        self._warmed_at: float = 0.0
        self._reaper: Optional[asyncio.Task] = None
        self._connecting: Optional[asyncio.Task] = None
        self._pending_key: Optional[str] = None
        self._pending_api_key: Optional[str] = None

    # ----- Lifecycle --------------------------------------------------

    def start(self) -> None:
        """Arm the pool. Called once, from the app lifespan."""
        self._armed = True

    @property
    def armed(self) -> bool:
        return self._armed

    async def close_all(self) -> None:
        """Release the warm socket and every task the pool owns."""
        self._armed = False
        async with self._lock:
            await self._cancel_pending()
            await self._drop_warm("pool closed")

    # ----- Acquisition ------------------------------------------------

    async def acquire(
        self, api_key: str, cfg: DeepgramLiveConfig
    ) -> WarmAcquisition:
        """Return a connected session for ``cfg``.

        Adopts the warm socket when it matches and is healthy; otherwise
        discards whatever is warm (saying why) and connects a fresh one.
        Raises ``DeepgramLiveError`` exactly where a plain
        ``DeepgramLiveSession.connect()`` would — the caller's failure
        path is unchanged.
        """
        key = cfg.to_query_string()
        async with self._lock:
            pending = self._connecting
            if pending is not None:
                if self._pending_key == key and self._pending_api_key == api_key:
                    # A re-warm for exactly this configuration is already
                    # in flight and is, at worst, as far along as a fresh
                    # connect started now. Awaiting it also keeps the
                    # worst case at ONE connect budget: a failure is
                    # raised, not retried behind a second 12 s attempt.
                    session = await self._await_pending()
                    if session is not None:
                        return self._adopt(session, key, api_key, from_pending=True)
                    raise DeepgramLiveError(
                        "Deepgram connect failed (warm connect in flight)"
                    )
                await self._cancel_pending()

            warm = self._warm
            if warm is not None:
                reason = self._unfit_reason(warm, key, api_key)
                if reason is None:
                    self._cancel_reaper()
                    self._warm = None
                    self._warm_key = None
                    self._warm_api_key = None
                    return self._adopt(warm, key, api_key, from_pending=False)
                await self._drop_warm(reason)

            session = self._factory(api_key, cfg)
            await session.connect()
            return WarmAcquisition(
                session=session,
                adopted=False,
                warm_age_sec=0.0,
                connect_ms=getattr(session.stats, "connect_ms", None),
            )

    def _adopt(
        self,
        session: DeepgramLiveSession,
        key: str,
        api_key: str,
        *,
        from_pending: bool,
    ) -> WarmAcquisition:
        age = max(0.0, self._clock() - self._warmed_at) if not from_pending else 0.0
        connect_ms = getattr(session.stats, "connect_ms", None)
        logger.info(
            "deepgram-live: adopted warm socket age=%.1fs (saved ~%sms connect)",
            age,
            f"{connect_ms:.0f}" if connect_ms is not None else "?",
        )
        return WarmAcquisition(
            session=session,
            adopted=True,
            warm_age_sec=age,
            connect_ms=connect_ms,
        )

    # ----- Warming ----------------------------------------------------

    def rewarm(self, api_key: str, cfg: DeepgramLiveConfig) -> None:
        """Start connecting a warm socket for ``cfg`` in the background.

        Never awaits and never raises: a failed pre-warm must not be
        visible to the recording that triggered it. The next
        ``acquire()`` simply connects and surfaces its own error, as it
        did before this pool existed.
        """
        if not self._armed or not api_key:
            return
        key = cfg.to_query_string()
        if (
            self._warm is not None
            and self._warm_key == key
            and self._warm_api_key == api_key
        ):
            return
        if self._connecting is not None:
            # One connect in flight at a time. If it is for a stale
            # configuration it lands, fails ``_unfit_reason`` at the next
            # ``acquire()`` and is closed there — cheaper than cancelling
            # a half-open handshake from a synchronous caller.
            return
        self._pending_key = key
        self._pending_api_key = api_key
        self._connecting = asyncio.get_running_loop().create_task(
            self._warm_connect(api_key, cfg, key), name="deepgram-warm-connect"
        )

    async def _warm_connect(
        self, api_key: str, cfg: DeepgramLiveConfig, key: str
    ) -> Optional[DeepgramLiveSession]:
        session = self._factory(api_key, cfg)
        try:
            await session.connect()
        except asyncio.CancelledError:
            await _quiet_close(session)
            raise
        except Exception as e:
            logger.info("deepgram-live: pre-warm connect failed: %s", e)
            await _quiet_close(session)
            self._forget_pending(key)
            return None
        # ``acquire()`` may already have taken the pending task's result
        # (``_await_pending``); it clears ``_connecting`` itself and this
        # store then simply does not happen.
        if self._connecting is not None and self._pending_key == key:
            await self._store_warm(session, key, api_key)
            self._forget_pending(key)
            return session
        return session

    async def _store_warm(
        self, session: DeepgramLiveSession, key: str, api_key: str
    ) -> None:
        # Every mutation happens before the first await, so a concurrent
        # ``acquire()`` can never observe a half-swapped slot. This runs
        # WITHOUT the pool lock on purpose: ``acquire()`` may be awaiting
        # this very task (``_await_pending``) while holding it.
        previous = self._warm
        previous_at = self._warmed_at
        self._cancel_reaper()
        self._warm = session
        self._warm_key = key
        self._warm_api_key = api_key
        self._warmed_at = self._clock()
        connect_ms = getattr(session.stats, "connect_ms", None)
        logger.info(
            "deepgram-live: warm socket ready in %sms (ttl=%.0fs)",
            f"{connect_ms:.0f}" if connect_ms is not None else "?",
            self._idle_ttl_sec,
        )
        self._reaper = asyncio.get_running_loop().create_task(
            self._expire_when_idle(session), name="deepgram-warm-ttl"
        )
        if previous is not None and previous is not session:
            logger.info(
                "deepgram-live: discarded warm socket age=%.1fs reason=%s",
                max(0.0, self._clock() - previous_at),
                "replaced by a newer warm socket",
            )
            await _quiet_close(previous)

    async def _expire_when_idle(self, session: DeepgramLiveSession) -> None:
        try:
            await asyncio.sleep(self._idle_ttl_sec)
        except asyncio.CancelledError:
            return
        async with self._lock:
            if self._warm is not session:
                return
            await self._drop_warm(
                f"idle for {self._idle_ttl_sec:.0f}s (billing/concurrency bound)"
            )

    # ----- Internals --------------------------------------------------

    def _unfit_reason(
        self, session: DeepgramLiveSession, key: str, api_key: str
    ) -> Optional[str]:
        """Why this warm socket must NOT be adopted, or ``None``."""
        if self._warm_key != key:
            return "configuration changed"
        if self._warm_api_key != api_key:
            return "API key changed"
        if session.is_closed:
            return "socket already closed"
        if session.last_fatal:
            return f"socket reported a fatal error ({session.last_error})"
        if getattr(session.stats, "bytes_sent", 0):
            # The invariant that makes a warm socket timestamp-safe:
            # Deepgram counts from the audio it has received, so a warm
            # socket that carried audio would shift every timestamp of
            # the adopted recording. See the module docstring.
            return "socket already carried audio (timestamps would be shifted)"
        now = self._clock()
        age = now - self._warmed_at
        if age > self._idle_ttl_sec:
            return f"warm for {age:.0f}s, past the {self._idle_ttl_sec:.0f}s bound"
        last_ka = getattr(session.stats, "last_keepalive_at", None)
        if last_ka is None:
            if age > self._keepalive_stale_sec:
                return f"no KeepAlive has landed in {age:.0f}s"
        elif now - last_ka > self._keepalive_stale_sec:
            return f"last KeepAlive was {now - last_ka:.0f}s ago"
        return None

    async def _drop_warm(self, reason: str) -> None:
        self._cancel_reaper()
        session = self._warm
        self._warm = None
        self._warm_key = None
        self._warm_api_key = None
        if session is None:
            return
        age = max(0.0, self._clock() - self._warmed_at)
        logger.info(
            "deepgram-live: discarded warm socket age=%.1fs reason=%s", age, reason
        )
        await _quiet_close(session)

    def _cancel_reaper(self) -> None:
        if self._reaper is not None and not self._reaper.done():
            self._reaper.cancel()
        self._reaper = None

    def _forget_pending(self, key: str) -> None:
        if self._pending_key == key:
            self._connecting = None
            self._pending_key = None
            self._pending_api_key = None

    async def _await_pending(self) -> Optional[DeepgramLiveSession]:
        task = self._connecting
        self._connecting = None
        self._pending_key = None
        self._pending_api_key = None
        if task is None:
            return None
        try:
            return await task
        except asyncio.CancelledError:
            raise
        except Exception:
            return None

    async def _cancel_pending(self) -> None:
        task = self._connecting
        self._connecting = None
        self._pending_key = None
        self._pending_api_key = None
        if task is None:
            return
        if task.done():
            session = None
            try:
                session = task.result()
            except Exception:
                session = None
            if session is not None:
                await _quiet_close(session)
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    # ----- Introspection ----------------------------------------------

    def status(self) -> dict:
        """Debug snapshot for ``GET /api/live/warm``."""
        session = self._warm
        state = "idle"
        if session is not None:
            state = "warm"
        elif self._connecting is not None:
            state = "connecting"
        age = (
            round(max(0.0, self._clock() - self._warmed_at), 3)
            if session is not None
            else None
        )
        healthy = None
        reason = None
        if session is not None:
            reason = self._unfit_reason(
                session, self._warm_key or "", self._warm_api_key or ""
            )
            healthy = reason is None
        return {
            "armed": self._armed,
            "state": state,
            "configKey": self._warm_key or self._pending_key,
            "ageSec": age,
            "healthy": healthy,
            "unfitReason": reason,
            "connectMs": (
                getattr(session.stats, "connect_ms", None)
                if session is not None
                else None
            ),
            "idleTtlSec": self._idle_ttl_sec,
            "keepalivesSent": (
                getattr(session.stats, "keepalives_sent", 0)
                if session is not None
                else None
            ),
        }


async def _quiet_close(session: DeepgramLiveSession) -> None:
    """Close a session nobody is listening to, swallowing teardown noise."""
    try:
        discard = getattr(session, "discard", None)
        if discard is not None:
            await discard()
        else:
            await session.close()
    except Exception as e:  # pragma: no cover - teardown is best-effort
        logger.debug("deepgram-live: warm socket close ignored: %s", e)


__all__ = [
    "DeepgramWarmPool",
    "WarmAcquisition",
    "WARM_IDLE_TTL_SEC",
    "WARM_KEEPALIVE_INTERVAL_SEC",
    "WARM_KEEPALIVE_STALE_SEC",
    "WARM_VOICE_PEAK",
    "pcm_has_voice",
]
