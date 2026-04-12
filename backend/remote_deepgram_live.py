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
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional
from urllib.parse import urlencode

import websockets
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

logger = logging.getLogger(__name__)


DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen"


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

    model: str = "nova-3"
    language: str = "auto"
    sample_rate: int = 16000
    channels: int = 1
    interim_results: bool = True
    punctuate: bool = True
    smart_format: bool = True
    # Endpointing is the silence threshold (in ms) Deepgram uses to
    # decide a chunk is "complete enough" to seal as is_final=true.
    # The old value (300 ms) was tuned for very short commands and
    # produced grammatically-broken fragments for conversational
    # speech — the user's "по чанкам не всегда грамотно отрабатывает"
    # report. 700 ms matches Deepgram's own recommendation for
    # dictation / long-form and lets Nova-3 build a full clause
    # before finalizing, so segments land as proper sentences with
    # punctuation instead of fragments like "I think that" → "we
    # should do" → "this thing".
    endpointing_ms: int = 700
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
            "model": self.model or "nova-3",
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
        self._event_queue: asyncio.Queue[object] = asyncio.Queue()
        self._finalized_segments: list[dict] = []
        self._latest_interim: Optional[dict] = None
        self._closed = False
        self._finalize_sent = False
        self._last_error: Optional[str] = None
        self._last_fatal: bool = False
        self.stats = DeepgramLiveStats()

    # ----- Lifecycle --------------------------------------------------------

    async def connect(self, open_timeout: float = 10.0) -> None:
        """Open the upstream Deepgram WebSocket and start the receive loop.

        Raises ``DeepgramLiveError`` on authentication / network failure.
        The session is unusable after a failed connect; construct a new
        one to retry.
        """
        if self._ws is not None:
            raise DeepgramLiveError("session already connected")
        if self._closed:
            raise DeepgramLiveError("session is closed")
        url = f"{DEEPGRAM_LIVE_URL}?{self._cfg.to_query_string()}"
        headers = [("Authorization", f"Token {self._api_key}")]
        logger.info(
            "deepgram-live: connecting model=%s language=%s sr=%s",
            self._cfg.model,
            self._cfg.language,
            self._cfg.sample_rate,
        )
        started = time.perf_counter()
        try:
            self._ws = await ws_connect(
                url,
                additional_headers=headers,
                open_timeout=open_timeout,
                close_timeout=2.0,
                max_size=2 * 1024 * 1024,
                ping_interval=None,  # we manage liveness via KeepAlive frames
                ping_timeout=None,
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
            msg = f"Deepgram connect timed out after {open_timeout:.1f}s"
            logger.error("deepgram-live: %s", msg)
            raise DeepgramLiveError(msg) from e
        except (WebSocketException, OSError) as e:
            msg = f"Deepgram connect failed: {e}"
            logger.error("deepgram-live: %s", msg)
            raise DeepgramLiveError(msg) from e

        self.stats.connect_ms = (time.perf_counter() - started) * 1000.0
        self._recv_task = asyncio.create_task(
            self._recv_loop(), name="deepgram-live-recv"
        )
        self._keepalive_task = asyncio.create_task(
            self._keepalive_loop(), name="deepgram-live-keepalive"
        )
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
            await self._ws.send(chunk)
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
        except WebSocketException as e:
            fatal = self.stats.segments_final == 0
            self._report_error(f"Deepgram send failed: {e}", fatal=fatal)
        else:
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
        if self._ws is not None and not self._finalize_sent:
            self._finalize_sent = True
            try:
                await self._ws.send(json.dumps({"type": "CloseStream"}))
                logger.debug("deepgram-live: CloseStream sent")
            except ConnectionClosed:
                logger.debug("deepgram-live: CloseStream skipped (already closed)")
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
        logger.info(
            "deepgram-live: finalized in %.0f ms text_len=%d segments=%d bytes_sent=%d",
            self.stats.finalize_ms,
            len(final_text),
            self.stats.segments_final,
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
        if self._closed:
            return
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

        # Ensure any consumer blocked on events() unblocks. The queue
        # is unbounded (``asyncio.Queue()`` default ``maxsize=0``), so
        # ``put_nowait`` cannot raise ``QueueFull``. We still use a
        # narrow catch for truly unexpected runtime state — e.g., the
        # event loop is already shut down during interpreter exit.
        try:
            self._event_queue.put_nowait(self._QUEUE_SENTINEL)
        except RuntimeError as e:
            logger.debug("deepgram-live: close sentinel put failed: %s", e)

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

    def _report_error(self, message: str, *, fatal: bool) -> None:
        """Record an error and push a normalized error event to the queue.

        The queue is unbounded so ``put_nowait`` cannot raise
        ``QueueFull`` in normal operation. The narrow ``RuntimeError``
        catch handles the edge case where the event loop is already
        shut down (interpreter exit, CancelledError re-entry).
        """
        self._last_error = message
        self._last_fatal = fatal or self._last_fatal
        logger.warning(
            "deepgram-live: error (fatal=%s): %s", fatal, message
        )
        try:
            self._event_queue.put_nowait(
                {"type": "error", "error": message, "fatal": bool(fatal)}
            )
        except RuntimeError as e:
            logger.debug("deepgram-live: report_error put failed: %s", e)
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
                    self._event_queue.put_nowait(event)
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
            try:
                self._event_queue.put_nowait(self._QUEUE_SENTINEL)
            except RuntimeError as e:
                logger.debug("deepgram-live: recv finally sentinel failed: %s", e)

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
                if self._closed or self._ws is None:
                    return
                last = self.stats.last_send_at or 0.0
                idle_for = time.monotonic() - last if last else float("inf")
                if idle_for < self._keepalive_idle_threshold_sec:
                    continue
                try:
                    await self._ws.send(json.dumps({"type": "KeepAlive"}))
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
