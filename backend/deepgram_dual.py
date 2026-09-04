"""Two readings of one recording, merged by word timestamps.

Why
---
``BUGS_AUDIT_2026-09-03.md`` §1 measured ``language=multi`` dropping
whole clauses of Russian speech, non-deterministically, on this app's
own recordings — and ``language=ru`` on the identical audio keeping
every one of them while losing the French and English ones instead.
Neither reading is complete on a recording that switches language, and
no Deepgram parameter fixes either: the two fail in DIFFERENT places.

The dual-stream measurement (2026-09-04, 11 files x 2 languages x 2
repeats = 44 sessions; report and prototype under
``evidence-2026-09-03/session-2026-09-04-dual-stream/``) ran both
readings on the same audio and merged their FINAL segments by word
time. On the 72.7 s trilingual recording that closed both holes,
verbatim and in both directions:

* ``multi`` emitted nothing at all between 21.82 s and 25.99 s — 4.17 s
  of speech — and ``ru`` had every word of it ("говорю просто большую
  кучу разных слов, довольно долго. И ты можешь detect and find"),
  code-switch included;
* ``ru`` skipped the French clause entirely, and ``multi`` had it
  ("lab de la capitale de la France.").

9 of 11 merged transcripts were byte-identical across repeat runs; the
other 2 differed only in punctuation and capitalisation, with no word
added or lost. Two concurrent sockets did not slow the connect (p50
871 ms across 44 sessions, against 880 ms measured single-stream in
production) — the cost is money, not latency: twice the Deepgram
streaming seconds.

What this module owns
---------------------
1. The DECISION (``dual_stream_enabled``): one preference, and the one
   condition that makes it meaningful — the recording must actually be
   running multilingual, because a second reading in the language the
   user already chose reads the same audio the same way and buys
   nothing for double the money.
2. The MERGE (``merge_readings``): the rules the measurement validated,
   with the one defect it found closed (see ``_pairs``).
3. The FACADE (``DualLiveSession``): two sessions behind the interface
   of one, so the WebSocket handler drives the same object either way.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field, replace
from typing import Any, Iterable, Optional

from backend.remote_deepgram_live import (
    CROSS_FINAL_NGRAM_MAX_WORDS,
    INTERIM_WORD_GAP_SPLIT_SEC,
    SPLICE_COVERAGE_OVERLAP_FRACTION,
    DeepgramLiveConfig,
    DeepgramLiveSession,
    DeepgramLiveStats,
    resolve_live_language,
    subtract_spans,
    union_spans,
)
# The merge has to answer the same questions the single-stream splice
# already answers — "are these two records the same spoken word?", "how
# much of this word's time does that one occupy?" — and answering them
# a second way is how two parts of one product come to disagree about
# what a duplicate is. These are that module's own rules, imported
# rather than restated.
from backend.remote_deepgram_live import (  # noqa: E402  (deliberate reuse)
    _segment_words,
    _time_overlap,
    _token_stem,
    _word_core,
    _word_duration,
)

logger = logging.getLogger(__name__)


# The user pays twice the Deepgram seconds for this, so it is a
# preference — but it defaults ON because what it buys is the words the
# user actually said, and the failure it fixes is silent: a dropped
# clause looks exactly like a clause that was never spoken.
DUAL_STREAM_DEFAULT = True

# The second reading's language. Russian is what the measurement was
# made on and what this user dictates; a different primary language
# would want a different partner, which is why it is configurable rather
# than hard-coded — and why it is read from ONE place.
DUAL_SECONDARY_LANGUAGE_DEFAULT = "ru"

# Two words with the same stem, this close in time, are one spoken word
# whose boundaries the two decoders placed differently.
#
# This is the defect the measurement found and named. On the 10.6 s
# recording "Очень важно починить", ``multi``'s word "truth," swallowed
# the pause after it (ending at 7.35 s where ``ru``'s "truth" ended at
# 7.11 s), which pushed ``multi``'s next word "без" to 7.75-7.99 while
# ``ru``'s "без" sat at 7.11-7.59. The two do not overlap AT ALL — the
# gap is 0.16 s — so a rule that only knows about overlap saw two
# different words and shipped "без без" to the user. Reproducible in
# both repeat runs.
#
# 0.3 s is a pause a decoder can absorb into the preceding word without
# the next word being a different utterance; it is well under the
# 0.75 s this codebase already treats as a real gap
# (``TAIL_GUARD_MIN_SEC``) and comfortably over the few tens of ms a
# re-decode normally shifts a boundary by.
ADJACENT_SAME_STEM_MAX_GAP_SEC = 0.3

# Merged words further apart than ``INTERIM_WORD_GAP_SPLIT_SEC`` start a
# new segment — deliberately the same number the single-stream splice
# uses to group recovered words into fallback segments, so "these words
# belong to one clause" means one thing in this product.

_LATIN = set("abcdefghijklmnopqrstuvwxyz")


def _has_latin(token: str) -> bool:
    return any(ch in _LATIN for ch in token.casefold())


# ---------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------


def _deepgram_prefs(cfg: Any) -> dict:
    prefs = cfg.get("preferences") if isinstance(cfg, dict) else None
    dg = prefs.get("deepgram") if isinstance(prefs, dict) else None
    return dg if isinstance(dg, dict) else {}


def dual_stream_enabled(cfg: Any, language: str) -> bool:
    """Should this recording open a second Deepgram reading?

    Two conditions, and both are load-bearing:

    * the preference is on (``preferences.deepgram.dual_stream``,
      default ``True``); and
    * the recording resolves to Deepgram's multilingual mode
      (``resolve_live_language`` — the same function that decides what
      goes on the wire, so the two cannot disagree).

    The second is what keeps the cost honest. A user who has chosen
    ``ru`` is already getting the reading the merge would add; running
    it twice would double the bill for an identical transcript.
    """
    if resolve_live_language(language) != "multi":
        return False
    value = _deepgram_prefs(cfg).get("dual_stream")
    if value is None:
        return DUAL_STREAM_DEFAULT
    return bool(value)


def dual_secondary_language(cfg: Any) -> str:
    """The language of the second reading — one place, one answer."""
    value = _deepgram_prefs(cfg).get("dual_secondary_language")
    if isinstance(value, str) and value.strip():
        return value.strip().lower()
    return DUAL_SECONDARY_LANGUAGE_DEFAULT


def secondary_config(cfg: DeepgramLiveConfig, language: str) -> DeepgramLiveConfig:
    """The primary config, re-read in another language.

    Everything else — model, keyterms, sample rate, endpointing — is
    deliberately identical: the merge pairs words by TIME, and two
    readings decoded with different endpointing would place their
    boundaries differently for reasons that have nothing to do with
    what was said.
    """
    return replace(cfg, language=language)


# ---------------------------------------------------------------------
# The merge
# ---------------------------------------------------------------------


@dataclass
class MergedReading:
    """One transcript assembled from two readings of the same audio."""

    words: list[dict] = field(default_factory=list)
    segments: list[dict] = field(default_factory=list)
    text: str = ""
    primary_word_count: int = 0
    secondary_word_count: int = 0
    filled_from_secondary: int = 0
    filled_from_primary: int = 0
    duplicates_removed: int = 0

    def covered_end_sec(self) -> float:
        return max((float(w["end"]) for w in self.words), default=0.0)

    def covered_spans(self) -> list[tuple[float, float]]:
        return union_spans((float(w["start"]), float(w["end"])) for w in self.words)


def flatten_words(segments: Iterable[dict], source: str) -> list[dict]:
    """Finalized segments to one time-ordered word list, tagged."""
    out: list[dict] = []
    for seg in segments or []:
        for w in _segment_words(seg):
            token = str(w.get("word") or "")
            if not token:
                continue
            out.append(
                {
                    "word": token,
                    "start": float(w.get("start") or 0.0),
                    "end": float(w.get("end") or 0.0),
                    "source": source,
                }
            )
    out.sort(key=lambda w: (w["start"], w["end"]))
    return out


def _same_audio(a: dict, b: dict) -> bool:
    """Do these two words describe the same moment of the recording?

    Overlap first — the measured rule, ``SPLICE_COVERAGE_OVERLAP_FRACTION``
    of EITHER word, the same threshold the single-stream splice uses.

    Then the fix for the "без без" case: two words whose stems match and
    which sit within ``ADJACENT_SAME_STEM_MAX_GAP_SEC`` of each other
    are the same word even with no overlap at all, because one decoder
    let the previous word swallow the pause and pushed this one late.
    Requiring the STEM to match is what keeps this from merging genuine
    consecutive words: "да да" said twice stays two words only if the
    times really are disjoint by more than the gap, and a real repeat
    ("subagents, subagents") is spoken over a longer span than 0.3 s.
    """
    overlap = _time_overlap(a, b)
    if overlap > 0 and (
        overlap >= SPLICE_COVERAGE_OVERLAP_FRACTION * _word_duration(a)
        or overlap >= SPLICE_COVERAGE_OVERLAP_FRACTION * _word_duration(b)
    ):
        return True
    stem = _token_stem(a["word"])
    if not stem or stem != _token_stem(b["word"]):
        return False
    gap = max(a["start"], b["start"]) - min(a["end"], b["end"])
    return gap <= ADJACENT_SAME_STEM_MAX_GAP_SEC


def _pairs(
    primary: list[dict], secondary: list[dict]
) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """Pair words across readings, greedily, strongest evidence first.

    Ranked by time overlap so the best-matching pair claims each word
    before a weaker candidate can. Pairs accepted with no overlap at all
    (the same-stem neighbour rule) rank last, which is right: they are
    the weakest evidence of sameness and must not outbid a real overlap.
    """
    candidates: list[tuple[float, int, int]] = []
    for pi, pw in enumerate(primary):
        for si, sw in enumerate(secondary):
            if sw["start"] > pw["end"] + ADJACENT_SAME_STEM_MAX_GAP_SEC:
                break
            if _same_audio(pw, sw):
                candidates.append((_time_overlap(pw, sw), pi, si))
    candidates.sort(key=lambda t: -t[0])
    used_p: set[int] = set()
    used_s: set[int] = set()
    paired: list[tuple[dict, dict]] = []
    for _overlap, pi, si in candidates:
        if pi in used_p or si in used_s:
            continue
        used_p.add(pi)
        used_s.add(si)
        paired.append((primary[pi], secondary[si]))
    return (
        paired,
        [w for i, w in enumerate(primary) if i not in used_p],
        [w for i, w in enumerate(secondary) if i not in used_s],
    )


def _resolve(primary_word: dict, secondary_word: dict) -> dict:
    """Which spelling wins when both readings heard the same moment.

    * Same alpha core — no disagreement at all. The primary's token
      carries the formatting the app renders, so it wins.
    * Different cores, and either token has Latin letters — the
      multilingual reading wins: it keeps "Sonnet" as "Sonnet" where a
      monolingual Russian reading transliterates it.
    * Different cores, both Cyrillic — the secondary wins, because that
      is the measured stronger reading on Cyrillic content (audit §1).
      Measured side effect: this is what deleted the documented "Локи"
      hallucination from the 83 s recording.
    """
    core_p = _word_core(primary_word)
    if core_p and core_p == _word_core(secondary_word):
        return dict(primary_word)
    if _has_latin(primary_word["word"]) or _has_latin(secondary_word["word"]):
        winner = (
            primary_word
            if _has_latin(primary_word["word"])
            else secondary_word
        )
        return dict(winner)
    return dict(secondary_word)


def _drop_duplicate_runs(words: list[dict]) -> tuple[list[dict], int]:
    """Remove a run transcribed twice across a provenance junction.

    Where the merged sequence switches from one reading to the other, up
    to ``CROSS_FINAL_NGRAM_MAX_WORDS`` words on each side are compared by
    stem; a match counts as a duplicate only when every matched pair also
    describes the same audio (``_same_audio``). Without that second test
    a deliberate repeat — "subagents, subagents", confirmed by listening
    — would be silently halved.

    Mirrors ``drop_repeated_seam_ngrams``, which does the same job for
    the seam between two finals of ONE reading.
    """
    out = list(words)
    dropped = 0
    i = 1
    while i < len(out):
        if out[i]["source"] == out[i - 1]["source"]:
            i += 1
            continue
        matched = 0
        for n in range(min(CROSS_FINAL_NGRAM_MAX_WORDS, i, len(out) - i), 0, -1):
            tail = out[i - n:i]
            head = out[i:i + n]
            tail_stems = [_token_stem(w["word"]) for w in tail]
            head_stems = [_token_stem(w["word"]) for w in head]
            if not all(tail_stems) or tail_stems != head_stems:
                continue
            if all(_same_audio(t, h) for t, h in zip(tail, head)):
                matched = n
                break
        if not matched:
            i += 1
            continue
        tail = out[i - matched:i]
        head = out[i:i + matched]
        dropped += matched
        if tail[0]["start"] <= head[0]["start"]:
            del out[i:i + matched]
        else:
            del out[i - matched:i]
            i -= matched
        i += 1
    return out, dropped


def _segments_from_words(words: list[dict]) -> list[dict]:
    """Group merged words into segments at clause-length silences."""
    segments: list[dict] = []
    for word in words:
        if segments and word["start"] - segments[-1]["end"] <= INTERIM_WORD_GAP_SPLIT_SEC:
            segment = segments[-1]
            segment["end"] = round(max(segment["end"], word["end"]), 3)
            segment["words"].append(word)
            continue
        segments.append(
            {
                "start": round(word["start"], 3),
                "end": round(word["end"], 3),
                "text": "",
                "confidence": 0.0,
                "is_final": True,
                "speech_final": False,
                "words": [word],
                "source": "dual-merge",
            }
        )
    for segment in segments:
        segment["text"] = " ".join(w["word"] for w in segment["words"])
        segment["words"] = [dict(w) for w in segment["words"]]
    return segments


def merge_readings(
    primary_segments: Iterable[dict],
    secondary_segments: Iterable[dict],
    *,
    primary_source: str = "multi",
    secondary_source: str = "ru",
) -> MergedReading:
    """Merge two readings of one recording into one transcript.

    Pure: takes the two finalized segment lists, returns the merged
    words (each carrying the ``source`` it came from), the segments they
    group into, and the counts the stop line reports.
    """
    primary = flatten_words(primary_segments, primary_source)
    secondary = flatten_words(secondary_segments, secondary_source)
    if not secondary:
        # Single-stream degradation, and the common case when the
        # secondary socket failed: the primary reading, untouched.
        merged = [dict(w) for w in primary]
        return MergedReading(
            words=merged,
            segments=_segments_from_words(merged),
            text=" ".join(w["word"] for w in merged),
            primary_word_count=len(primary),
            secondary_word_count=0,
        )

    paired, only_primary, only_secondary = _pairs(primary, secondary)
    merged = [_resolve(pw, sw) for pw, sw in paired]
    merged.extend(dict(w) for w in only_primary)
    merged.extend(dict(w) for w in only_secondary)
    merged.sort(key=lambda w: (w["start"], w["end"]))
    merged, duplicates = _drop_duplicate_runs(merged)
    return MergedReading(
        words=merged,
        segments=_segments_from_words(merged),
        text=" ".join(w["word"] for w in merged),
        primary_word_count=len(primary),
        secondary_word_count=len(secondary),
        filled_from_secondary=len(only_secondary),
        filled_from_primary=len(only_primary),
        duplicates_removed=duplicates,
    )


# ---------------------------------------------------------------------
# The facade
# ---------------------------------------------------------------------


class DualLiveSession:
    """Two ``DeepgramLiveSession``s behind the interface of one.

    The WebSocket handler drives this exactly as it drives a single
    session — one ``send_pcm``, one ``events()``, one
    ``drain_transcript``, one envelope — so there is one stop chain in
    this product, not two.

    Three asymmetries, all deliberate:

    * EVENTS come only from the primary. The live preview and every
      renderer buffer downstream of it are built for one stream of
      interims and finals; two would interleave into nonsense, and the
      secondary's value is in the merge at stop, not on screen.
    * ERRORS are the primary's alone. A secondary that dies takes the
      recording's completeness back to where it was without this
      feature, which is not a failure worth aborting a recording for —
      it is logged once and the merge sees an empty reading.
    * AUDIO goes to both, awaited in order. A send is never cancelled
      (cancelling one mid-frame leaves that connection undefined), and
      the secondary's failure to accept a frame is swallowed after the
      first warning.
    """

    def __init__(
        self,
        primary: DeepgramLiveSession,
        secondary: DeepgramLiveSession,
        *,
        secondary_language: str = DUAL_SECONDARY_LANGUAGE_DEFAULT,
        primary_language: str = "multi",
    ) -> None:
        self.primary = primary
        self.secondary: Optional[DeepgramLiveSession] = secondary
        self._secondary_language = secondary_language
        self._primary_language = primary_language
        self._secondary_failed = False

    # ----- The single-session interface --------------------------------

    @property
    def stats(self) -> DeepgramLiveStats:
        return self.primary.stats

    @property
    def is_closed(self) -> bool:
        return self.primary.is_closed

    @property
    def last_error(self) -> Optional[str]:
        return self.primary.last_error

    @property
    def last_fatal(self) -> bool:
        return self.primary.last_fatal

    def report_fatal(self, message: str) -> None:
        self.primary.report_fatal(message)

    def note_undelivered_audio(self, nbytes: int) -> None:
        self.primary.note_undelivered_audio(nbytes)
        if self.secondary is not None:
            self.secondary.note_undelivered_audio(nbytes)

    def events(self):
        return self.primary.events()

    def final_text(self) -> str:
        return self.primary.final_text()

    async def send_pcm(self, chunk: bytes) -> None:
        # The primary's exception is the caller's, unchanged: it owns
        # the recording. The secondary's is swallowed after one warning
        # — it owns nothing the user would notice losing.
        await self.primary.send_pcm(chunk)
        await self._feed_secondary(chunk)

    async def _feed_secondary(self, chunk: bytes) -> None:
        secondary = self.secondary
        if secondary is None:
            return
        try:
            await secondary.send_pcm(chunk)
        except Exception as e:
            self._fail_secondary(f"send failed: {e}")

    def _fail_secondary(self, reason: str) -> None:
        """Drop to one reading, once, loudly enough to find later."""
        if self._secondary_failed:
            return
        self._secondary_failed = True
        logger.warning(
            "dual-stream: secondary reading (%s) dropped, continuing "
            "single-stream: %s",
            self._secondary_language,
            reason,
        )

    @property
    def secondary_failed(self) -> bool:
        return self._secondary_failed

    def replace_primary(self, fresh: DeepgramLiveSession) -> DeepgramLiveSession:
        """Swap the primary socket, returning the one replaced.

        The warm-socket liveness path in ``backend.main`` replaces a
        socket that never answered. Only the primary is probed — it is
        the one whose silence the user would notice — so this is where
        that swap lands when the recording is running two readings.
        """
        old = self.primary
        self.primary = fresh
        return old

    # ----- Stop --------------------------------------------------------

    async def finalize(
        self,
        wait_timeout: float = 3.0,
        on_budget=None,
    ) -> dict:
        """Back-compat convenience: ``drain_transcript()`` then ``shutdown()``.

        Mirrors ``DeepgramLiveSession.finalize`` (see its docstring) —
        the same "one interface either way" promise this class exists
        for means a caller that only knows the single-session API (the
        A/B tool; any future non-WS caller) must not have to special
        case a dual recording to get its transcript and clean up.
        """
        result = await self.drain_transcript(on_budget=on_budget)
        await self.shutdown(wait_timeout=wait_timeout)
        return result

    async def drain_transcript(self, on_budget=None) -> dict:
        """Drain both readings under ONE budget and merge them.

        The budget is announced by the PRIMARY, once — it is the same
        recording, the same stop, and the renderer is owed one deadline.
        The secondary is drained concurrently so it costs no extra wall
        time, and is given the primary's own budget as a hard ceiling:
        it must never be the reason a stop runs long.
        """
        secondary = self.secondary
        secondary_task: Optional[asyncio.Task] = None
        announced: list[float] = []

        def _on_budget(budget_sec: float, expects_more: bool) -> None:
            announced.append(budget_sec)
            if on_budget is not None:
                on_budget(budget_sec, expects_more)

        if secondary is not None:
            secondary_task = asyncio.get_running_loop().create_task(
                secondary.drain_transcript(), name="deepgram-dual-secondary-drain",
            )
        primary_result = await self.primary.drain_transcript(on_budget=_on_budget)

        secondary_result: Optional[dict] = None
        if secondary_task is not None:
            # The primary's own announced budget, again: whatever the
            # secondary still owes, the user has already been told how
            # long this stop may take.
            ceiling = announced[0] if announced else 3.0
            try:
                secondary_result = await asyncio.wait_for(
                    secondary_task, timeout=max(0.1, ceiling)
                )
            except asyncio.TimeoutError:
                secondary_task.cancel()
                self._fail_secondary("drain exceeded the announced stop budget")
            except Exception as e:
                self._fail_secondary(f"drain failed: {e}")

        return self._merged_envelope(primary_result, secondary_result)

    def _merged_envelope(
        self, primary_result: dict, secondary_result: Optional[dict]
    ) -> dict:
        secondary_segments = (secondary_result or {}).get("segments") or []
        merged = merge_readings(
            primary_result.get("segments") or [],
            secondary_segments,
            primary_source=self._primary_language,
            secondary_source=self._secondary_language,
        )
        logger.info(
            "dual-stream merge: %s=%d words %s=%d words merged=%d "
            "filled_from_%s=%d filled_from_%s=%d dups_removed=%d",
            self._primary_language,
            merged.primary_word_count,
            self._secondary_language,
            merged.secondary_word_count,
            len(merged.words),
            self._secondary_language,
            merged.filled_from_secondary,
            self._primary_language,
            merged.filled_from_primary,
            merged.duplicates_removed,
        )
        streamed_sec = max(
            float(primary_result.get("streamedSec") or 0.0),
            float((secondary_result or {}).get("streamedSec") or 0.0),
        )
        envelope = dict(primary_result)
        envelope["text"] = merged.text
        # ``words`` is the merged list; ``segments`` is that same list
        # grouped at clause-length silences, built from it in one place
        # (``_segments_from_words``) so the two are views of one
        # transcript rather than two transcripts. Every word carries the
        # ``source`` it came from, which is what makes a merge auditable
        # after the fact.
        envelope["segments"] = merged.segments
        envelope["words"] = merged.words
        envelope["durationSec"] = round(merged.covered_end_sec(), 3)
        envelope["coveredEndSec"] = round(merged.covered_end_sec(), 3)
        envelope["streamedSec"] = round(streamed_sec, 3)
        envelope["uncoveredSpeechSec"] = round(
            self._merged_uncovered_speech_sec(merged), 3
        )
        # Wire contract with the renderer: ``stats.dual_stream`` is the
        # boolean it reads to know this envelope came from the merged
        # path. It is FALSE when the secondary reading failed or timed
        # out, because then the text is a single reading and saying
        # otherwise would misdescribe what the user received.
        merged_path = secondary_result is not None and not self._secondary_failed
        stats = dict(primary_result.get("stats") or {})
        stats["dual_stream"] = bool(merged_path)
        stats["dual_secondary_language"] = self._secondary_language
        stats["dual_filled_from_secondary"] = merged.filled_from_secondary
        stats["dual_filled_from_primary"] = merged.filled_from_primary
        stats["dual_duplicates_removed"] = merged.duplicates_removed
        envelope["stats"] = stats
        return envelope

    def _merged_uncovered_speech_sec(self, merged: MergedReading) -> float:
        """Seconds neither reading committed and the merge could not fill.

        Computed on the MERGED list, which is the only honest place: a
        hole the primary reported is not a hole in what the user
        receives if the secondary's words went into it. Both readings'
        hole spans are taken together, and whatever the merged words
        cover is subtracted.
        """
        holes = list(self.primary.coverage_hole_spans())
        if self.secondary is not None:
            holes.extend(self.secondary.coverage_hole_spans())
        residual = subtract_spans(holes, merged.covered_spans())
        return sum(end - start for start, end in residual)

    async def shutdown(self, wait_timeout: float = 3.0) -> None:
        await self._both("shutdown", wait_timeout=wait_timeout)

    async def close(self) -> None:
        await self._both("close")

    async def discard(self) -> None:
        await self._both("discard")

    async def _both(self, method: str, **kwargs) -> None:
        secondary = self.secondary
        if secondary is not None:
            try:
                await getattr(secondary, method)(**kwargs)
            except Exception as e:
                logger.debug("dual-stream: secondary %s ignored: %s", method, e)
        await getattr(self.primary, method)(**kwargs)


__all__ = [
    "ADJACENT_SAME_STEM_MAX_GAP_SEC",
    "DUAL_SECONDARY_LANGUAGE_DEFAULT",
    "DUAL_STREAM_DEFAULT",
    "DualLiveSession",
    "MergedReading",
    "dual_secondary_language",
    "dual_stream_enabled",
    "flatten_words",
    "merge_readings",
    "secondary_config",
]
