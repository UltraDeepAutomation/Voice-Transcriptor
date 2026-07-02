"""Deepgram Nova-3 live WebSocket streaming — single source of truth.

Proxies raw PCM16 mono audio from the app's own WebSocket into Deepgram's
real streaming API (wss://api.deepgram.com/v1/listen) and normalizes the
Deepgram ``Results`` events into the app's canonical live protocol:

    {"type": "segments", "segments": [...], "is_final": bool}
    {"type": "interim",  "segment": {...}}
    {"type": "final",    "text": str, "segments": [...], "durationSec": float}
    {"type": "error",    "error": str, "fatal": bool}

Lifecycle is session-scoped: ``connect()`` opens the upstream socket and
starts a background task that drains Deepgram events into an internal
queue. ``send_pcm()`` forwards audio; ``events()`` is the async iterator
consumers iterate to receive normalized events; ``finalize()`` tells
Deepgram to flush and returns the accumulated final transcript.

Production-grade features:

* **KeepAlive frames** — a background task emits ``{"type":"KeepAlive"}``
  on the upstream every ``keepalive_interval_sec`` seconds as long as the
  socket is idle (no audio has been sent recently). This prevents
  Deepgram from auto-closing the connection during prolonged silence.
  Deepgram's documented idle timeout is ~10 s, so we default to 7 s.

* **Structured error classification** — connect failures, send failures,
  recv errors, abnormal closes, and finalize timeouts all go through
  ``_report_error`` so callers see consistent ``{"type":"error","fatal":
  bool}`` events and can decide whether to fall back.

* **Telemetry** — ``stats`` returns ``{bytes_sent, chunks_sent,
  segments_final, segments_interim, connect_ms, finalize_ms}`` so the
  caller can log upstream latency and debug stalls.

* **Single-use safety** — the class is explicitly not reentrant. All
  operations after ``close()`` are no-ops so late cleanup cannot crash
  the event loop.

This module is the ONLY place in the codebase that talks to Deepgram's
live API. Callers should never construct the URL, set headers, or parse
Results messages directly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import AsyncIterator, Optional
from urllib.parse import urlencode

import websockets
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

logger = logging.getLogger(__name__)


DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC = 8.0
DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC = 4.0


# 1.1.25 SSOT: imported from ``backend.deepgram_endpoints``. Same
# centralised host as the REST module so a regional override sets
# both at once via TRANSCRIPTOR_DEEPGRAM_HOST.
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ  # noqa: E402
from backend.deepgram_endpoints import DEEPGRAM_LIVE_URL  # noqa: E402,F401
from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL  # noqa: E402


@dataclass
class DeepgramLiveConfig:
    """Typed configuration for a Deepgram live streaming session.

    Parameter set is restricted to what Nova-3's ``/v1/listen`` live
    endpoint actually accepts. ``detect_language`` is a pre-recorded
    endpoint feature — the live endpoint uses ``language=multi`` for
    multilingual auto-detection instead. ``numerals`` is pre-recorded
    only; ``smart_format`` (which Nova-3 handles safely for the
    multilingual model) covers number formatting at live time.
    """

    model: str = DEFAULT_DEEPGRAM_AUDIO_MODEL
    language: str = "auto"
    # Constrained to ``LIVE_SAMPLE_RATE_HZ`` — the WS announces this
    # rate to Deepgram and the frontend downsampler targets it; any
    # override here MUST come with a matching frontend change.
    sample_rate: int = LIVE_SAMPLE_RATE_HZ
    channels: int = 1
    interim_results: bool = True
    punctuate: bool = True
    smart_format: bool = True
    # Endpointing is the silence threshold (in ms) Deepgram uses to
    # decide a chunk is "complete enough" to seal as is_final=true.
    #
    # 1.1.18 — reverted 700 → 300 ms.
    #
    # The 700 ms bump (from the "грамматически-неточные фрагменты"
    # report) made segments grammatically richer, but the user's
    # 1.1.17 main.log showed Nova-3 multilingual on a Russian uplink
    # returning interim text continuously and NEVER emitting
    # ``is_final`` during a 14-second recording (``segments_final=0``
    # at stop time). The post-CloseStream finalize also failed to
    # arrive in time (envelope timed out at 4 s). Result: every Stop
    # fell through to the on-disk REST recovery path — a 3+ second
    # tax on every recording that the streaming path was supposed to
    # avoid.
    #
    # 300 ms matches typical conversational pause length (250–500 ms),
    # so utterance breaks reliably seal ``is_final`` segments DURING
    # streaming. The "broken fragments" concern is unrelated to this
    # window — ``smart_format=True`` (enabled above) is what handles
    # sentence assembly + punctuation regardless of how often
    # individual segments are sealed. The 700 ms bump was solving the
    # wrong axis.
    endpointing_ms: int = 300
    # Utterance end is the silence threshold that triggers
    # ``speech_final=true`` (end-of-utterance signal used downstream
    # to decide when to emit a period). 1200 ms was too aggressive
    # for conversational pauses (natural "um" breaks). 2000 ms is
    # Deepgram's recommended long-form value and prevents a thought
    # from splitting across two "final" events.
    utterance_end_ms: int = 2000
    filler_words: bool = False
    diarize: bool = False

    def to_query_string(self) -> str:
        params: dict[str, str] = {
            "model": self.model or DEFAULT_DEEPGRAM_AUDIO_MODEL,
            "encoding": "linear16",
            "sample_rate": str(int(self.sample_rate)),
            "channels": str(int(self.channels)),
            "interim_results": _bool(self.interim_results),
            "punctuate": _bool(self.punctuate),
            "smart_format": _bool(self.smart_format),
            "filler_words": _bool(self.filler_words),
            "endpointing": str(int(self.endpointing_ms)),
            "utterance_end_ms": str(int(self.utterance_end_ms)),
        }
        if self.diarize:
            params["diarize"] = "true"
        lang = (self.language or "").strip().lower()
        if not lang or lang in ("auto", "multi"):
            # Nova-3 multilingual mode — the model auto-detects the
            # active language per utterance across 10 supported
            # languages including Russian, Spanish, French, German,
            # Hindi, Portuguese, Italian, Dutch, Japanese, English.
            params["language"] = "multi"
        else:
            params["language"] = lang
        return urlencode(params)


def _bool(value: bool) -> str:
    return "true" if value else "false"


class DeepgramLiveError(Exception):
    """Raised for unrecoverable Deepgram live session failures."""


@dataclass
class DeepgramLiveStats:
    """Telemetry for a single live session."""

    bytes_sent: int = 0
    chunks_sent: int = 0
    segments_final: int = 0
    segments_interim: int = 0
    keepalives_sent: int = 0
    connect_ms: Optional[float] = None
    finalize_ms: Optional[float] = None
    last_send_at: Optional[float] = None
    last_recv_at: Optional[float] = None

    def as_dict(self) -> dict:
        return {
            "bytes_sent": self.bytes_sent,
            "chunks_sent": self.chunks_sent,
            "segments_final": self.segments_final,
            "segments_interim": self.segments_interim,
            "keepalives_sent": self.keepalives_sent,
            "connect_ms": self.connect_ms,
            "finalize_ms": self.finalize_ms,
        }


class DeepgramLiveSession:
    """A single-use Deepgram streaming session.

    Not reentrant. Create one per recording, call ``connect()`` once,
    then ``send_pcm()`` for each audio chunk and iterate ``events()`` from
    a single consumer. Call ``finalize()`` at stop to drain remaining
    results and return the canonical transcript. Always ``close()`` in
    ``finally`` (``finalize()`` closes implicitly on success).
    """

    _QUEUE_SENTINEL = object()

    def __init__(
        self,
        api_key: str,
        config: Optional[DeepgramLiveConfig] = None,
        *,
        keepalive_interval_sec: float = 7.0,
        keepalive_idle_threshold_sec: float = 3.5,
    ):
        if not api_key:
            raise DeepgramLiveError("Deepgram API key is required")
        self._api_key = api_key
        self._cfg = config or DeepgramLiveConfig()
        self._keepalive_interval_sec = max(1.0, float(keepalive_interval_sec))
        self._keepalive_idle_threshold_sec = max(
            0.5, float(keepalive_idle_threshold_sec)
        )
        self._ws: Optional[ClientConnection] = None
        self._recv_task: Optional[asyncio.Task[None]] = None
        self._keepalive_task: Optional[asyncio.Task[None]] = None
        # Bounded queue: a pathological slow consumer (browser throttled,
        # renderer hung) must not be allowed to accumulate interim segments
        # unboundedly at ~15 Hz. On QueueFull, the put path drops the
        # oldest interim entry and re-enqueues; finals and errors are never
        # dropped.  See _enqueue_event below.
        self._event_queue: asyncio.Queue[object] = asyncio.Queue(maxsize=1024)
        self._queue_overflow_warned: bool = False
        self._finalized_segments: list[dict] = []
        self._latest_interim: Optional[dict] = None
        self._closed = False
        # Separate "consumer-visible closed" (self._closed, flipped by
        # recv_loop.finally as soon as the upstream drops so events()
        # consumers see termination) from "close() has been called"
        # (self._close_ran, used as the idempotency guard inside close()).
        # Without this split, when recv_loop sets _closed=True on its
        # exit path and THEN a caller invokes close(), the early-return
        # at the top of close() fired, leaking the upstream WebSocket
        # socket (never sent the WS close frame) and the keepalive task
        # (never cancelled). TCP FIN-WAITs piled up until OS reclaim.
        self._close_ran = False
        self._finalize_sent = False
        self._last_error: Optional[str] = None
        self._last_fatal: bool = False
        self.stats = DeepgramLiveStats()

    # ----- Lifecycle --------------------------------------------------------

    async def connect(self, open_timeout: float = DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC) -> None:
        """Open the upstream Deepgram WebSocket and start the receive loop.

        Raises ``DeepgramLiveError`` on authentication / network failure.
        The session is unusable after a failed connect; construct a new
        one to retry.

        Default ``open_timeout`` is 8s with one 4s retry. Live capture
        cannot benefit from a 20+ second handshake: if Deepgram is not
        reachable quickly, the recording is still saved locally and the
        stop-time recovery path can decide what to do with the durable
        audio.

        On ``asyncio.TimeoutError`` we perform ONE silent retry:
          - DNS miss on attempt 1 → attempt 2 hits a warm cache.
          - Momentary TCP stall → new connection bypasses the stuck
            half-open socket.
          - Permanently dead network → attempt 2 also fails quickly,
            worst-case total 12s.
          - ``InvalidStatus`` (4xx) is NEVER retried: 401 = bad key,
            403 = no streaming entitlement, 429 = rate-limit, all
            permanent within the retry window.
          - Transport errors (OSError / WebSocketException) also not
            retried — the original error message is more actionable
            than a second identical attempt.
        """
        if self._ws is not None:
            raise DeepgramLiveError("session already connected")
        if self._closed:
            raise DeepgramLiveError("session is closed")
        url = f"{DEEPGRAM_LIVE_URL}?{self._cfg.to_query_string()}"
        headers = [("Authorization", f"Token {self._api_key}")]
        logger.info(
            "deepgram-live: connecting model=%s language=%s sr=%s timeout=%.1fs",
            self._cfg.model,
            self._cfg.language,
            self._cfg.sample_rate,
            open_timeout,
        )
        started = time.perf_counter()

        async def _attempt(budget: float):
            return await ws_connect(
                url,
                additional_headers=headers,
                open_timeout=budget,
                close_timeout=2.0,
                max_size=2 * 1024 * 1024,
                ping_interval=None,  # we manage liveness via KeepAlive frames
                ping_timeout=None,
            )

        retry_budget = DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC
        try:
            try:
                self._ws = await _attempt(open_timeout)
            except asyncio.TimeoutError:
                logger.warning(
                    "deepgram-live: connect timeout attempt=1 budget=%.1fs — retrying once with budget=%.1fs",
                    open_timeout,
                    retry_budget,
                )
                self._ws = await _attempt(retry_budget)
                logger.info(
                    "deepgram-live: connected on retry after total_ms=%.0f",
                    (time.perf_counter() - started) * 1000.0,
                )
            except OSError as os_err:
                # 1.1.25: docstring above promised retry on "DNS miss
                # on attempt 1 -> attempt 2 hits a warm cache" but the
                # original code only retried on TimeoutError. A real
                # DNS miss raises OSError (gaierror), and TCP-RST
                # during connect raises ConnectionRefusedError (also
                # OSError). Both are transient on the post-sleep wake
                # / mobile-network-flap paths. Retry once with the
                # budget the docstring already documents.
                logger.warning(
                    "deepgram-live: connect %s on attempt 1 (%s) — retrying once with budget=%.1fs",
                    type(os_err).__name__, os_err, retry_budget,
                )
                self._ws = await _attempt(retry_budget)
                logger.info(
                    "deepgram-live: connected on retry after total_ms=%.0f",
                    (time.perf_counter() - started) * 1000.0,
                )
        except InvalidStatus as e:
            status = getattr(e.response, "status_code", None)
            body_text = ""
            detail = ""
            try:
                body_text = (e.response.body or b"").decode("utf-8", errors="replace")[:600]
            except Exception as body_err:
                logger.debug("deepgram-live: failed to read error body: %s", body_err)
            # Deepgram returns structured JSON on 400: {"err_code": ...,
            # "err_msg": ..., "request_id": ...}. Parse it so the user
            # sees an actionable message instead of raw JSON.
            if body_text:
                try:
                    parsed = json.loads(body_text)
                    if isinstance(parsed, dict):
                        detail = str(
                            parsed.get("err_msg")
                            or parsed.get("message")
                            or parsed.get("reason")
                            or ""
                        ).strip()
                        if not detail and parsed.get("err_code"):
                            detail = f"code={parsed.get('err_code')}"
                        req_id = str(parsed.get("request_id") or "")
                        if req_id:
                            detail = f"{detail} (request_id={req_id[:12]})" if detail else f"request_id={req_id[:12]}"
                except (ValueError, TypeError):
                    detail = body_text
            if status == 400:
                msg = (
                    f"Deepgram rejected the live streaming parameters (HTTP 400): {detail}"
                    if detail
                    else "Deepgram rejected the live streaming parameters (HTTP 400)"
                )
            elif status == 401:
                msg = "Deepgram rejected the API key (HTTP 401)"
            elif status == 402:
                msg = "Deepgram account has insufficient credits (HTTP 402)"
            elif status == 403:
                msg = "Deepgram account does not have access to live streaming (HTTP 403)"
            elif status == 429:
                msg = "Deepgram rate limit exceeded (HTTP 429). Try again in a moment."
            elif status:
                msg = f"Deepgram handshake failed (HTTP {status}): {detail}" if detail else f"Deepgram handshake failed (HTTP {status})"
            else:
                msg = f"Deepgram handshake failed: {e}"
            logger.error("deepgram-live: %s (raw body=%s)", msg, body_text[:200])
            raise DeepgramLiveError(msg) from e
        except asyncio.TimeoutError as e:
            # This branch fires only if BOTH the initial attempt AND the
            # retry timed out. Report the full budget we actually spent
            # so the user knows the network is genuinely unreachable,
            # not just slow.
            total_budget = open_timeout + retry_budget
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            msg = (
                f"Deepgram connect timed out after {total_budget:.1f}s "
                f"(2 attempts, elapsed={elapsed_ms:.0f}ms)"
            )
            logger.error("deepgram-live: %s", msg)
            raise DeepgramLiveError(msg) from e
        except (WebSocketException, OSError) as e:
            msg = f"Deepgram connect failed: {e}"
            logger.error("deepgram-live: %s", msg)
            raise DeepgramLiveError(msg) from e

        self.stats.connect_ms = (time.perf_counter() - started) * 1000.0
        # 1.1.25: socket-open + task-launch is wrapped so a
        # CancelledError fired between the two doesn't leak the open
        # WebSocket. The window is small (synchronous create_task
        # calls) but real — under heavy event-loop pressure or
        # cooperative cancellation from the caller, an open socket
        # with no recv task to drain it accumulates server-side and
        # burns the user's quota.
        try:
            self._recv_task = asyncio.create_task(
                self._recv_loop(), name="deepgram-live-recv"
            )
            self._keepalive_task = asyncio.create_task(
                self._keepalive_loop(), name="deepgram-live-keepalive"
            )
        except BaseException:
            # Cancellation or OOM between socket-open and task-launch:
            # close the orphan socket so the connection doesn't leak.
            try:
                if self._ws is not None:
                    await self._ws.close()
            except Exception:
                pass
            self._ws = None
            raise
        logger.info(
            "deepgram-live: connected in %.0f ms", self.stats.connect_ms
        )

    async def send_pcm(self, chunk: bytes) -> None:
        """Forward a PCM16LE mono chunk to Deepgram.

        Silently no-ops when the session is already closed so callers can
        keep draining the mic until the consumer notices the close.
        Mid-stream send failures are only treated as fatal when NO final
        segments have been received yet — if we already have committed
        text, the caller will use it and a send failure just means we
        stop pushing new audio to an already-dead connection.
        """
        if self._closed or self._ws is None:
            return
        if not chunk:
            return
        try:
            # Hard 5-second send timeout. Without it, a half-open TCP
            # socket (kernel-level hung sendq, network partition with
            # no RST yet) wedges this await for the full system socket
            # timeout (60-300 s on Linux). While hung, the WS receiver
            # in main.py cannot read more frames from the renderer,
            # finalize cannot fire, and the user sees a frozen UI.
            # The websockets library's close_timeout is for the close
            # handshake only, not mid-stream sends — we bound it here.
            await asyncio.wait_for(self._ws.send(chunk), timeout=5.0)
        except asyncio.TimeoutError:
            fatal = self.stats.segments_final == 0
            self._report_error(
                "Deepgram send hung (>5s) — connection wedged", fatal=fatal,
            )
            return
        except ConnectionClosed as e:
            fatal = self.stats.segments_final == 0
            self._report_error(
                f"Deepgram upstream closed while sending: {e}", fatal=fatal
            )
            if not fatal:
                logger.info(
                    "deepgram-live: send after close, degrading gracefully (%d committed segs)",
                    self.stats.segments_final,
                )
            return
        except WebSocketException as e:
            fatal = self.stats.segments_final == 0
            self._report_error(f"Deepgram send failed: {e}", fatal=fatal)
            return
        self.stats.bytes_sent += len(chunk)
        self.stats.chunks_sent += 1
        self.stats.last_send_at = time.monotonic()

    async def events(self) -> AsyncIterator[dict]:
        """Yield normalized events until the session terminates.

        The generator completes when the upstream socket closes or
        ``close()`` is called. Exactly one consumer per session.
        """
        while True:
            item = await self._event_queue.get()
            if item is self._QUEUE_SENTINEL:
                return
            assert isinstance(item, dict)
            yield item

    async def finalize(self, wait_timeout: float = 3.0) -> dict:
        """Flush Deepgram and return the final transcript.

        Sends ``CloseStream`` so Deepgram finalizes any buffered audio,
        waits up to ``wait_timeout`` seconds for the receive loop to drain
        the remaining events, then closes the upstream connection.

        Returns a dict with ``text``, ``segments`` and ``durationSec``.
        """
        started = time.perf_counter()
        logger.info(
            "deepgram-live: finalize ENTER segments_final=%d segments_interim=%d bytes_sent=%d",
            self.stats.segments_final, self.stats.segments_interim, self.stats.bytes_sent,
        )
        if self._ws is not None and not self._finalize_sent:
            # 1.1.25: idempotency flag is set AFTER the Finalize send
            # succeeds, NOT before. Previously a CancelledError fired
            # between the flag-set and the actual ``ws.send`` would
            # leave ``_finalize_sent=True`` even though Deepgram never
            # got the Finalize signal — a follow-up finalize() call
            # then early-returned and the trailing is_final was never
            # flushed. Moving the flag below the send-success makes
            # the flag a faithful witness of "Finalize was actually
            # delivered to Deepgram".
            # ── 1.1.19: send Finalize BEFORE CloseStream ─────────────
            #
            # Deepgram's streaming protocol supports two control msgs:
            #   • Finalize:    flushes buffered audio and emits a
            #                  final ``is_final=true`` Result message
            #                  WITHOUT closing the connection. Designed
            #                  exactly for "user pressed Stop, give me
            #                  the trailing transcript now".
            #   • CloseStream: graceful shutdown — server processes
            #                  remaining audio and closes.
            #
            # In the 1.1.18 user logs, the post-CloseStream is_final
            # was empty for EVERY long recording (env.wordCount=0)
            # despite Deepgram clearly receiving the audio (it had
            # emitted is_final segments mid-stream). Some Deepgram
            # regions appear to skip the trailing-buffer flush on
            # CloseStream alone and only emit it on an explicit
            # Finalize. Sending Finalize first guarantees that flush;
            # CloseStream then closes cleanly with the buffer already
            # emptied.
            try:
                await asyncio.wait_for(
                    self._ws.send(json.dumps({"type": "Finalize"})),
                    timeout=5.0,
                )
                self._finalize_sent = True
                logger.info("deepgram-live: Finalize sent (forces trailing is_final flush)")
            except asyncio.TimeoutError:
                logger.warning("deepgram-live: Finalize send timed out (>5s)")
            except ConnectionClosed:
                # Connection was already closed — treat as "Finalize
                # need not happen", flag accordingly so a second call
                # doesn't try again.
                self._finalize_sent = True
                logger.info("deepgram-live: Finalize skipped (already closed)")
            except WebSocketException as e:
                logger.warning("deepgram-live: Finalize send failed: %s", e)
            try:
                # Same 5-second bound as send_pcm — a wedged TCP socket
                # mustn't hang finalize indefinitely. The CloseStream
                # frame is tiny so the timeout only fires when the
                # underlying socket is genuinely stuck.
                await asyncio.wait_for(
                    self._ws.send(json.dumps({"type": "CloseStream"})),
                    timeout=5.0,
                )
                logger.info("deepgram-live: CloseStream sent")
            except asyncio.TimeoutError:
                logger.warning("deepgram-live: CloseStream send timed out (>5s)")
            except ConnectionClosed:
                logger.info("deepgram-live: CloseStream skipped (already closed)")
            except WebSocketException as e:
                logger.warning("deepgram-live: CloseStream send failed: %s", e)

        if self._keepalive_task is not None and not self._keepalive_task.done():
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):
                pass

        if self._recv_task is not None:
            try:
                await asyncio.wait_for(self._recv_task, timeout=wait_timeout)
            except asyncio.TimeoutError:
                logger.warning(
                    "deepgram-live: recv drain timeout (%.2fs)", wait_timeout
                )
                self._recv_task.cancel()
                try:
                    await self._recv_task
                except (asyncio.CancelledError, Exception):
                    pass

        await self.close()

        self.stats.finalize_ms = (time.perf_counter() - started) * 1000.0
        final_text = self.final_text()
        duration_sec = 0.0
        if self._finalized_segments:
            duration_sec = float(
                max(s.get("end", 0.0) for s in self._finalized_segments)
            )
        # 1.1.19: explicit DELTA logging — segments_final at ENTER vs
        # EXIT shows whether the Finalize+CloseStream sequence
        # actually produced trailing is_final segments. If
        # segments_final didn't increase between ENTER and EXIT, we
        # know the post-CloseStream flush is ineffective for this
        # session (likely region/network) and recovery is the only
        # path to the trailing words.
        logger.info(
            "deepgram-live: finalize EXIT %.0f ms text_len=%d segments_final=%d (delta from ENTER) duration_sec=%.2f bytes_sent=%d",
            self.stats.finalize_ms,
            len(final_text),
            self.stats.segments_final,
            duration_sec,
            self.stats.bytes_sent,
        )
        return {
            "text": final_text,
            "segments": list(self._finalized_segments),
            "durationSec": round(duration_sec, 3),
            "stats": self.stats.as_dict(),
        }

    async def close(self) -> None:
        """Idempotently release the upstream socket and background tasks."""
        if self._close_ran:
            return
        self._close_ran = True
        self._closed = True

        if self._keepalive_task is not None and not self._keepalive_task.done():
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):
                pass

        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception as e:
                logger.debug("deepgram-live: close() ignored: %s", e)

        # Also cancel and await the recv task. Without this, if the
        # upstream TCP connection is wedged such that `ws.close()`
        # returns before the peer actually closes, `_recv_loop`
        # continues running until the OS-level RST eventually lands —
        # potentially seconds. During that window, _recv_task holds
        # references to the socket, queue, and closures, leaking the
        # whole session object well past the caller's lifetime.
        # Mirror finalize()'s bounded cancel pattern.
        if self._recv_task is not None and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await asyncio.wait_for(self._recv_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception as e:
                logger.debug("deepgram-live: close() recv_task await: %s", e)

        # Ensure any consumer blocked on events() unblocks. The sentinel
        # is routed through _enqueue_event so it survives overflow — if
        # the queue is full of interim events, one is evicted to make
        # room, guaranteeing the consumer sees termination.
        self._enqueue_event(self._QUEUE_SENTINEL, is_critical=True)

    # ----- Accessors --------------------------------------------------------

    @property
    def is_closed(self) -> bool:
        return self._closed

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    @property
    def last_fatal(self) -> bool:
        return self._last_fatal

    def final_text(self) -> str:
        parts: list[str] = []
        for seg in self._finalized_segments:
            text = str(seg.get("text") or "").strip()
            if text:
                parts.append(text)
        return " ".join(parts).strip()

    # ----- Internals --------------------------------------------------------

    def _enqueue_event(self, event: object, *, is_critical: bool) -> None:
        """Put an event on the bounded queue with smart overflow handling.

        Priority (highest → lowest):

        1. ``QUEUE_SENTINEL`` — drains the entire queue if necessary to
           land. Its whole purpose is consumer termination, so dropping
           queued data is the correct trade-off; without this guarantee
           ``events()`` would hang on pathological queue saturation.
        2. ``is_critical=True`` (finals, errors) — evicts the oldest
           interim to make room. If no interim exists the critical event
           is unavoidably dropped with an error log.
        3. ``is_critical=False`` (interim segments) — drops on overflow
           and logs a one-shot warning.
        """
        # Fast path: queue has room.
        try:
            self._event_queue.put_nowait(event)
            return
        except asyncio.QueueFull:
            pass
        except RuntimeError as e:
            logger.debug("deepgram-live: enqueue runtime error: %s", e)
            return
        # --- Overflow path ---
        if event is self._QUEUE_SENTINEL:
            # Sentinel MUST land. Drain the queue (up to current size)
            # and re-enqueue. This only fires on close()/recv-exit, so
            # any queued interim or final is being discarded during
            # session-end anyway — consumer termination is paramount.
            for _ in range(self._event_queue.qsize() + 1):
                try:
                    self._event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            try:
                self._event_queue.put_nowait(event)
            except (asyncio.QueueFull, RuntimeError) as e:
                logger.error("deepgram-live: sentinel land failed after drain: %s", e)
            return
        if not is_critical:
            # Slow consumer — drop this interim.
            if not self._queue_overflow_warned:
                self._queue_overflow_warned = True
                logger.warning(
                    "deepgram-live: event queue full (cap=%d); dropping interim segments",
                    self._event_queue.maxsize,
                )
            return
        # Critical (non-sentinel): evict the oldest queued interim, even
        # if earlier queue slots hold final/error events. The previous
        # implementation inspected only one victim, so a queue like
        # [final, interim, ...] dropped the new critical event even
        # though a disposable interim was available.
        preserved = []
        evicted_interim = False
        try:
            while True:
                victim = self._event_queue.get_nowait()
                if isinstance(victim, dict) and victim.get("type") == "interim":
                    evicted_interim = True
                    break
                preserved.append(victim)
        except asyncio.QueueEmpty:
            pass
        except RuntimeError:
            return
        if not evicted_interim:
            for item in preserved:
                try:
                    self._event_queue.put_nowait(item)
                except (asyncio.QueueFull, RuntimeError):
                    break
            logger.error(
                "deepgram-live: queue full with no interim to evict; "
                "critical event dropped: %r",
                event,
            )
            return
        try:
            inserted = False
            for item in preserved:
                if item is self._QUEUE_SENTINEL and not inserted:
                    self._event_queue.put_nowait(event)
                    inserted = True
                self._event_queue.put_nowait(item)
            if not inserted:
                self._event_queue.put_nowait(event)
        except (asyncio.QueueFull, RuntimeError) as e:
            logger.error("deepgram-live: critical event re-enqueue failed: %s", e)

    def _report_error(self, message: str, *, fatal: bool) -> None:
        """Record an error and push a normalized error event to the queue."""
        self._last_error = message
        self._last_fatal = fatal or self._last_fatal
        logger.warning(
            "deepgram-live: error (fatal=%s): %s", fatal, message
        )
        self._enqueue_event(
            {"type": "error", "error": message, "fatal": bool(fatal)},
            is_critical=True,
        )
        if fatal:
            self._closed = True

    async def _recv_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, (bytes, bytearray)):
                    # Deepgram may send keepalive binary frames; ignore.
                    continue
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    logger.debug("deepgram-live: non-json frame ignored")
                    continue
                if not isinstance(msg, dict):
                    continue
                self.stats.last_recv_at = time.monotonic()
                event = self._process_deepgram_message(msg)
                if event is not None:
                    # Finals, errors, and segment events are critical;
                    # interims can be dropped under back-pressure.
                    ev_type = event.get("type") if isinstance(event, dict) else ""
                    is_interim = ev_type == "interim"
                    self._enqueue_event(event, is_critical=not is_interim)
        except ConnectionClosed as e:
            code = getattr(e, "code", None)
            reason = getattr(e, "reason", "") or ""
            logger.info(
                "deepgram-live: upstream closed code=%s reason=%s finalize_sent=%s final_segs=%d",
                code,
                reason,
                self._finalize_sent,
                self.stats.segments_final,
            )
            # Normal closure codes — nothing to report.
            if code in (None, 1000, 1001, 1005) or self._finalize_sent:
                pass
            elif self.stats.segments_final > 0:
                # Stream dropped mid-session, BUT we already committed
                # some final segments. Don't raise a fatal error — the
                # caller will use the committed text as the transcript.
                # This is the common case when Deepgram closes an idle
                # connection that we haven't managed to keep awake.
                logger.warning(
                    "deepgram-live: stream ended early with %d committed segments, using them as transcript",
                    self.stats.segments_final,
                )
                self._last_error = (
                    f"stream ended early (code={code}, reason={reason or 'none'})"
                )
            else:
                # No committed text and the stream dropped — this IS a
                # fatal error the caller must surface.
                self._report_error(
                    f"Deepgram upstream closed unexpectedly (code={code}, reason={reason or 'none'})",
                    fatal=True,
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Same logic: if we have committed segments, don't scream
            # at the user — use what we have.
            if self.stats.segments_final > 0:
                logger.warning(
                    "deepgram-live: recv error after %d committed segments: %s",
                    self.stats.segments_final,
                    e,
                )
                self._last_error = f"recv error: {e}"
            else:
                self._report_error(f"Deepgram recv error: {e}", fatal=True)
                logger.error("deepgram-live: recv_loop exception", exc_info=True)
        finally:
            self._closed = True
            self._enqueue_event(self._QUEUE_SENTINEL, is_critical=True)

    async def _keepalive_loop(self) -> None:
        """Emit ``{"type":"KeepAlive"}`` on prolonged upstream idle.

        Deepgram auto-closes an idle WebSocket after ~10 seconds. During
        quiet moments (long pauses or end-of-sentence silence) the
        frontend still sends PCM frames, but those can shrink below the
        threshold that keeps Deepgram happy. Emitting an explicit
        KeepAlive control message costs nothing and prevents unexpected
        disconnects.
        """
        try:
            while not self._closed and self._ws is not None:
                await asyncio.sleep(self._keepalive_interval_sec)
                # 1.1.25: snapshot ``self._ws`` BEFORE the send. close()
                # on the same event loop can null ``self._ws`` after we
                # passed the guard but before ``self._ws.send(...)``
                # re-reads the attribute, raising AttributeError on
                # ``None.send``. Snapshotting under the no-await window
                # of the guard makes the send a real WebSocket reference
                # whose own send-error semantics we already handle.
                ws = self._ws
                if self._closed or ws is None:
                    return
                last = self.stats.last_send_at or 0.0
                idle_for = time.monotonic() - last if last else float("inf")
                if idle_for < self._keepalive_idle_threshold_sec:
                    continue
                try:
                    await ws.send(json.dumps({"type": "KeepAlive"}))
                    self.stats.keepalives_sent += 1
                    logger.debug(
                        "deepgram-live: sent KeepAlive after %.1fs idle",
                        idle_for,
                    )
                except ConnectionClosed:
                    return
                except WebSocketException as e:
                    logger.debug("deepgram-live: KeepAlive send failed: %s", e)
                    return
                except AttributeError:
                    # Race lost: close() ran between our snapshot and the
                    # send call (rare but observed under heavy load).
                    return
        except asyncio.CancelledError:
            raise

    def _process_deepgram_message(self, msg: dict) -> Optional[dict]:
        mtype = msg.get("type")

        if mtype == "Metadata":
            logger.debug(
                "deepgram-live: metadata request_id=%s",
                str(msg.get("request_id") or "")[:12],
            )
            return None

        if mtype in ("SpeechStarted", "UtteranceEnd"):
            return None

        if mtype == "Error":
            err = str(msg.get("description") or msg.get("message") or msg)[:300]
            self._report_error(f"Deepgram upstream error: {err}", fatal=False)
            return None

        if mtype != "Results":
            logger.debug("deepgram-live: unknown message type=%s", mtype)
            return None

        channel = msg.get("channel")
        if not isinstance(channel, dict):
            return None
        alts = channel.get("alternatives")
        if not isinstance(alts, list) or not alts:
            return None
        alt = alts[0]
        if not isinstance(alt, dict):
            return None
        text = str(alt.get("transcript") or "").strip()
        if not text:
            return None

        # Defensive numeric coercion: a malformed upstream message
        # (non-numeric ``start``/``duration``/``confidence``) must
        # NEVER crash the recv loop, because that would terminate the
        # whole recording session over a single stray frame. Invalid
        # numerics degrade to 0.0 and the segment still renders.
        def _as_float(value: object, default: float = 0.0) -> float:
            try:
                return float(value) if value is not None else default
            except (TypeError, ValueError):
                return default

        start = _as_float(msg.get("start"))
        duration = _as_float(msg.get("duration"))
        end = start + duration
        is_final = bool(msg.get("is_final"))
        speech_final = bool(msg.get("speech_final"))
        confidence = _as_float(alt.get("confidence"))

        # When diarization is enabled, Deepgram populates ``words`` with a
        # per-word ``speaker`` index (0, 1, 2, ...). We expose the
        # dominant speaker for the segment so the frontend can render
        # "Speaker 0: hello world".
        speaker: Optional[int] = None
        if self._cfg.diarize:
            speaker = self._dominant_speaker(alt.get("words"))

        segment = {
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "confidence": round(confidence, 3),
            "is_final": is_final,
            "speech_final": speech_final,
        }
        if speaker is not None:
            segment["speaker"] = speaker

        if is_final:
            self._finalized_segments.append(segment)
            self._latest_interim = None
            self.stats.segments_final += 1
            logger.info(
                "deepgram-live: is_final start=%.2f end=%.2f speech_final=%s textLen=%d text=%r",
                start, end, speech_final, len(text), text[:80],
            )
            out_segment: dict[str, object] = {
                "start": segment["start"],
                "end": segment["end"],
                "text": segment["text"],
            }
            if speaker is not None:
                out_segment["speaker"] = speaker
            return {
                "type": "segments",
                "segments": [out_segment],
                "is_final": True,
                "speech_final": speech_final,
            }

        self._latest_interim = segment
        self.stats.segments_interim += 1
        if self.stats.segments_interim % 5 == 1:
            # Sample 1-in-5 interim emissions to keep log volume bounded
            # while still proving Deepgram is producing output.
            logger.info(
                "deepgram-live: interim #%d start=%.2f end=%.2f textLen=%d",
                self.stats.segments_interim, start, end, len(text),
            )
        interim_segment: dict[str, object] = {
            "start": segment["start"],
            "end": segment["end"],
            "text": segment["text"],
        }
        if speaker is not None:
            interim_segment["speaker"] = speaker
        return {
            "type": "interim",
            "segment": interim_segment,
        }

    @staticmethod
    def _dominant_speaker(words: object) -> Optional[int]:
        """Return the most common speaker index across ``words``.

        Deepgram emits one speaker id per word when ``diarize=true``.
        For a segment that belongs almost entirely to one speaker, the
        dominant index is stable; for mixed segments (rare at sentence
        granularity) we pick whichever speaker spoke most words.
        """
        if not isinstance(words, list) or not words:
            return None
        counts: dict[int, int] = {}
        for w in words:
            if not isinstance(w, dict):
                continue
            sp = w.get("speaker")
            if sp is None:
                continue
            try:
                key = int(sp)
            except (TypeError, ValueError):
                continue
            counts[key] = counts.get(key, 0) + 1
        if not counts:
            return None
        return max(counts.items(), key=lambda kv: kv[1])[0]


__all__ = [
    "DeepgramLiveConfig",
    "DeepgramLiveError",
    "DeepgramLiveSession",
    "DeepgramLiveStats",
]
