"""Deepgram live A/B tool — reproduce the 2026-09-03 multi-vs-ru measurement.

Streams saved WAV recordings through
``backend.remote_deepgram_live.DeepgramLiveSession`` at real-time
pacing, for one or more ``--language`` values and an optional shared
keyterms list, ``--runs`` times each, and prints one row per run: file,
language, keyterms count, connect ms, finalize ms, final segment count,
word count, char count, and the transcript text.

This is the tool ``BUGS_AUDIT_2026-09-03.md`` §1 and
``backend.remote_deepgram_live.DeepgramLiveConfig.to_query_string``
point at as the way to re-run the measurement that found
``language=multi`` silently dropping Russian clauses
non-deterministically, while ``language=ru`` on the same audio did not.

Usage::

    python -m backend.tools.deepgram_live_ab FILE.wav [FILE2.wav ...] \\
        --language ru --language multi \\
        --keyterms "Sonnet,Opus,Claude,Deepgram,субагент,субагенты" \\
        --runs 2

The Deepgram API key is read from the app's own config
(``backend.config.load_config()``) under ``providers.deepgram.key`` —
never printed or logged. Set ``TRANSCRIPTOR_DATA_DIR`` to point at a
different profile; it defaults to this app's macOS userData directory.

Exit codes: 0 all runs succeeded, 1 at least one run errored (see the
per-row ``ERROR:`` text), 2 no Deepgram API key configured, 3 an input
WAV was missing or not 16 kHz mono.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Set BEFORE importing backend.config, which resolves config.json off
# this env var at first use. Only supplies a default — an operator
# pointing at a different profile via an already-exported
# TRANSCRIPTOR_DATA_DIR is respected.
os.environ.setdefault(
    "TRANSCRIPTOR_DATA_DIR",
    os.path.expanduser("~/Library/Application Support/transcriptor"),
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import soundfile as sf  # noqa: E402

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ  # noqa: E402
from backend.config import load_config  # noqa: E402
from backend.deepgram_keyterms import normalize_keyterms  # noqa: E402
from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL  # noqa: E402
from backend.remote_deepgram_live import (  # noqa: E402
    DeepgramLiveConfig,
    DeepgramLiveError,
    DeepgramLiveSession,
)

DEFAULT_CHUNK_MS = 100
_TEXT_TRUNCATE_CHARS = 200


@dataclass
class RunResult:
    file: str
    language: str
    run: int
    keyterms_count: int
    connect_ms: "float | None"
    finalize_ms: "float | None"
    segments: int
    words: int
    chars: int
    text: str
    error: "str | None" = None


def _load_api_key() -> str:
    cfg = load_config()
    return str(((cfg.get("providers") or {}).get("deepgram") or {}).get("key") or "").strip()


def _load_pcm16_mono(path: Path) -> bytes:
    """Read *path* as 16 kHz mono PCM16, matching what the live WS sends.

    Multi-channel WAVs are downmixed to the first channel (with a
    warning), not averaged — this app's own recordings carry mic audio
    on one channel. A sample rate other than ``LIVE_SAMPLE_RATE_HZ`` is
    a hard error: the real-time pacing below assumes it, and silently
    mis-pacing the wrong rate would make the measurement unfaithful to
    the live capture path rather than merely slower.
    """
    data, sr = sf.read(str(path), dtype="int16", always_2d=False)
    if getattr(data, "ndim", 1) > 1:
        print(
            f"warning: {path.name} has {data.shape[1]} channels; using channel 0",
            file=sys.stderr,
        )
        data = data[:, 0]
    if sr != LIVE_SAMPLE_RATE_HZ:
        raise ValueError(
            f"{path.name}: sample rate {sr} Hz != required {LIVE_SAMPLE_RATE_HZ} Hz "
            "(this tool paces chunks assuming the live capture rate; "
            "resample the file first)"
        )
    return data.tobytes()


async def _run_one(
    *,
    api_key: str,
    model: str,
    pcm: bytes,
    language: str,
    keyterms: "tuple[str, ...]",
    chunk_ms: int,
    speed: float,
    file_label: str,
    run_index: int,
) -> RunResult:
    cfg = DeepgramLiveConfig(model=model, language=language, keyterms=keyterms)
    session = DeepgramLiveSession(api_key, cfg)
    try:
        await session.connect()
    except DeepgramLiveError as e:
        return RunResult(
            file=file_label, language=language, run=run_index,
            keyterms_count=len(keyterms), connect_ms=None, finalize_ms=None,
            segments=0, words=0, chars=0, text="", error=str(e),
        )

    async def _drain() -> None:
        async for _ in session.events():
            pass

    drain_task = asyncio.create_task(_drain())
    chunk_bytes = max(2, int(LIVE_SAMPLE_RATE_HZ * 2 * (chunk_ms / 1000.0)))
    step_sec = (chunk_ms / 1000.0) / max(speed, 1e-6)
    started = time.perf_counter()
    try:
        for i, offset in enumerate(range(0, len(pcm), chunk_bytes)):
            await session.send_pcm(pcm[offset:offset + chunk_bytes])
            target = started + (i + 1) * step_sec
            delay = target - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
        # Let the last chunk actually reach Deepgram before finalizing.
        await asyncio.sleep(0.2)
        result = await session.finalize()
    finally:
        try:
            await asyncio.wait_for(drain_task, timeout=5.0)
        except Exception:
            drain_task.cancel()

    stats = result.get("stats") or {}
    text = str(result.get("text") or "")
    return RunResult(
        file=file_label, language=language, run=run_index,
        keyterms_count=len(keyterms),
        connect_ms=stats.get("connect_ms"), finalize_ms=stats.get("finalize_ms"),
        segments=len(result.get("segments") or []), words=len(text.split()),
        chars=len(text), text=text,
    )


def _format_row(r: RunResult, *, full: bool) -> str:
    if r.error:
        return f"{r.file:<28} lang={r.language:<6} run={r.run} ERROR: {r.error}"
    text = r.text if full or len(r.text) <= _TEXT_TRUNCATE_CHARS else (
        r.text[:_TEXT_TRUNCATE_CHARS] + "…"
    )
    connect = f"{r.connect_ms:6.0f}" if r.connect_ms is not None else "   n/a"
    finalize = f"{r.finalize_ms:6.0f}" if r.finalize_ms is not None else "   n/a"
    return (
        f"{r.file:<28} lang={r.language:<6} kt={r.keyterms_count:<2} run={r.run} "
        f"connect={connect}ms finalize={finalize}ms "
        f"segs={r.segments:<3} words={r.words:<4} chars={r.chars:<5} | {text}"
    )


async def _main_async(args: argparse.Namespace) -> int:
    api_key = _load_api_key()
    if not api_key:
        print(
            "error: no Deepgram API key in config (providers.deepgram.key); "
            "set TRANSCRIPTOR_DATA_DIR to the right profile or configure a key",
            file=sys.stderr,
        )
        return 2

    keyterms = normalize_keyterms(args.keyterms or "")

    paths = [Path(p) for p in args.wavs]
    pcm_by_path: dict[Path, bytes] = {}
    for p in paths:
        if not p.exists():
            print(f"error: file not found: {p}", file=sys.stderr)
            return 3
        try:
            pcm_by_path[p] = _load_pcm16_mono(p)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 3

    tasks = []
    labels: list[tuple[str, str, int]] = []
    for p in paths:
        for lang in args.language:
            for run_index in range(1, args.runs + 1):
                labels.append((p.name, lang, run_index))
                tasks.append(
                    _run_one(
                        api_key=api_key,
                        model=args.model,
                        pcm=pcm_by_path[p],
                        language=lang,
                        keyterms=keyterms,
                        chunk_ms=args.chunk_ms,
                        speed=args.speed,
                        file_label=p.name,
                        run_index=run_index,
                    )
                )

    results = await asyncio.gather(*tasks, return_exceptions=True)

    had_error = False
    rows: list[RunResult] = []
    for label, res in zip(labels, results):
        if isinstance(res, BaseException):
            had_error = True
            rows.append(
                RunResult(
                    file=label[0], language=label[1], run=label[2],
                    keyterms_count=len(keyterms), connect_ms=None, finalize_ms=None,
                    segments=0, words=0, chars=0, text="", error=repr(res),
                )
            )
        else:
            if res.error:
                had_error = True
            rows.append(res)

    rows.sort(key=lambda r: (r.file, r.language, r.run))
    for r in rows:
        print(_format_row(r, full=args.full))

    return 1 if had_error else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deepgram_live_ab",
        description=(
            "Stream saved WAV recordings through Deepgram's live "
            "WebSocket API at real-time pacing, across one or more "
            "--language settings and an optional keyterms list, to "
            "reproduce and re-run the 2026-09-03 multi-vs-ru "
            "measurement (see BUGS_AUDIT_2026-09-03.md §1)."
        ),
    )
    parser.add_argument(
        "wavs", nargs="+",
        help="WAV file(s), 16 kHz mono PCM16 (the app's live capture format)",
    )
    parser.add_argument(
        "--language", "-l", action="append", required=True,
        help="Deepgram language value to test, e.g. 'multi' or 'ru'. "
             "Repeat the flag to compare several in one run.",
    )
    parser.add_argument(
        "--keyterms", default="",
        help="Comma- or newline-separated keyterms, normalised via "
             "backend.deepgram_keyterms.normalize_keyterms and applied "
             "to every language/run in this invocation.",
    )
    parser.add_argument(
        "--runs", type=int, default=1,
        help="Number of repeat runs per file/language combination (default 1).",
    )
    parser.add_argument(
        "--speed", type=float, default=1.0,
        help="Playback speed multiplier; 1.0 = real-time. Values above 1.0 "
             "stream faster than spoken, which changes timing measurements "
             "— use 1.0 for a faithful reproduction of a live session.",
    )
    parser.add_argument(
        "--chunk-ms", type=int, default=DEFAULT_CHUNK_MS,
        help=f"PCM chunk size in milliseconds (default {DEFAULT_CHUNK_MS}).",
    )
    parser.add_argument(
        "--model", default=DEFAULT_DEEPGRAM_AUDIO_MODEL,
        help=f"Deepgram model id (default {DEFAULT_DEEPGRAM_AUDIO_MODEL}).",
    )
    parser.add_argument(
        "--full", action="store_true",
        help=f"Print the full transcript text instead of truncating to "
             f"{_TEXT_TRUNCATE_CHARS} chars.",
    )
    return parser


def main(argv: "list[str] | None" = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
