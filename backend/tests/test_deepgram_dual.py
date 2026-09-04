"""Two readings of one recording, merged by word timestamps.

Covers the three things ``backend.deepgram_dual`` owns (see its module
docstring for the measurement this is built on):

* the DECISION — when a second reading is worth opening at all;
* the MERGE — pairing, hole-filling, provenance, and the "без без"
  defect the 2026-09-04 measurement found and named;
* the FACADE — fan-out to two sockets behind the interface of one.
"""

from __future__ import annotations

import asyncio
import unittest
from dataclasses import dataclass, field
from typing import Optional

from backend.config import DEFAULT_CONFIG, _validate_config_shape
from backend.deepgram_dual import (
    ADJACENT_SAME_STEM_MAX_GAP_SEC,
    DUAL_SECONDARY_LANGUAGE_DEFAULT,
    DUAL_STREAM_DEFAULT,
    DualLiveSession,
    dual_secondary_language,
    dual_stream_enabled,
    flatten_words,
    merge_readings,
    secondary_config,
)
from backend.remote_deepgram_live import DeepgramLiveConfig, DeepgramLiveSession


def _cfg(**over) -> dict:
    cfg = {"preferences": {"deepgram": {}}}
    cfg["preferences"]["deepgram"].update(over)
    return cfg


def _w(word: str, start: float, end: float) -> dict:
    return {"word": word, "start": start, "end": end}


def _segment(words: list[dict], text: Optional[str] = None) -> dict:
    return {
        "start": words[0]["start"] if words else 0.0,
        "end": words[-1]["end"] if words else 0.0,
        "text": text if text is not None else " ".join(w["word"] for w in words),
        "words": words,
    }


# ---------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------


class DualStreamEnabledTests(unittest.TestCase):
    def test_on_by_default_when_the_recording_is_multilingual(self):
        self.assertTrue(dual_stream_enabled({}, "auto"))
        self.assertTrue(dual_stream_enabled({}, "multi"))
        self.assertTrue(dual_stream_enabled({}, ""))

    def test_off_for_a_monolingual_recording_regardless_of_the_preference(self):
        # A user who already picked "ru" is getting the reading the
        # merge would add; a second identical reading buys nothing for
        # double the money.
        self.assertFalse(dual_stream_enabled({}, "ru"))
        self.assertFalse(dual_stream_enabled(_cfg(dual_stream=True), "ru"))
        self.assertFalse(dual_stream_enabled(_cfg(dual_stream=True), "en"))

    def test_the_preference_can_turn_it_off(self):
        self.assertFalse(dual_stream_enabled(_cfg(dual_stream=False), "multi"))

    def test_the_preference_can_turn_it_on_explicitly(self):
        self.assertTrue(dual_stream_enabled(_cfg(dual_stream=True), "auto"))

    def test_a_non_dict_config_does_not_raise_and_reads_as_default(self):
        self.assertEqual(dual_stream_enabled(None, "multi"), DUAL_STREAM_DEFAULT)
        self.assertEqual(dual_stream_enabled("oops", "multi"), DUAL_STREAM_DEFAULT)


class DualSecondaryLanguageTests(unittest.TestCase):
    def test_defaults_to_ru(self):
        self.assertEqual(dual_secondary_language({}), DUAL_SECONDARY_LANGUAGE_DEFAULT)
        self.assertEqual(DUAL_SECONDARY_LANGUAGE_DEFAULT, "ru")

    def test_reads_and_normalizes_the_configured_value(self):
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="ES")), "es")
        self.assertEqual(
            dual_secondary_language(_cfg(dual_secondary_language="  fr  ")), "fr"
        )

    def test_a_blank_or_wrong_typed_value_falls_back_to_the_default(self):
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="")), "ru")
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language=3)), "ru")


class ConfigDefaultsTests(unittest.TestCase):
    """SSOT: the renderer's autosave sends exactly these keys (deepgram-dual.ts)."""

    def test_default_config_declares_both_keys(self):
        dg = DEFAULT_CONFIG["preferences"]["deepgram"]
        self.assertIs(dg["dual_stream"], True)
        self.assertEqual(dg["dual_secondary_language"], "ru")

    def test_validation_repairs_a_non_boolean_dual_stream(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {"dual_stream": "yes"}}}
        )
        self.assertIs(fixed["preferences"]["deepgram"]["dual_stream"], True)

    def test_validation_repairs_a_blank_secondary_language(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {"dual_secondary_language": "   "}}}
        )
        self.assertEqual(
            fixed["preferences"]["deepgram"]["dual_secondary_language"], "ru"
        )

    def test_validation_leaves_a_well_typed_block_untouched(self):
        fixed = _validate_config_shape(
            {
                "preferences": {
                    "deepgram": {"dual_stream": False, "dual_secondary_language": "es"}
                }
            }
        )
        self.assertIs(fixed["preferences"]["deepgram"]["dual_stream"], False)
        self.assertEqual(fixed["preferences"]["deepgram"]["dual_secondary_language"], "es")


class SecondaryConfigTests(unittest.TestCase):
    def test_only_the_language_changes(self):
        cfg = DeepgramLiveConfig(
            model="nova-3", language="multi", keyterms=("foo",), diarize=True,
            sample_rate=16000,
        )
        secondary = secondary_config(cfg, "ru")
        self.assertEqual(secondary.language, "ru")
        self.assertEqual(secondary.model, cfg.model)
        self.assertEqual(secondary.keyterms, cfg.keyterms)
        self.assertEqual(secondary.diarize, cfg.diarize)
        self.assertEqual(secondary.sample_rate, cfg.sample_rate)


# ---------------------------------------------------------------------
# The merge
# ---------------------------------------------------------------------


class FlattenWordsTests(unittest.TestCase):
    def test_words_are_tagged_with_their_source_and_time_ordered(self):
        segs = [
            _segment([_w("two", 2.0, 2.5)]),
            _segment([_w("one", 0.0, 0.5)]),
        ]
        out = flatten_words(segs, "primary")
        self.assertEqual([w["word"] for w in out], ["one", "two"])
        self.assertTrue(all(w["source"] == "primary" for w in out))

    def test_a_wordless_segment_contributes_nothing(self):
        self.assertEqual(flatten_words([{"text": "hi", "start": 0, "end": 1}], "primary"), [])


class MergeReadingsTests(unittest.TestCase):
    def test_the_bez_bez_case_is_not_duplicated(self):
        # Reproduces the measured defect verbatim (REPORT.md, the
        # "single source of truth, без без костылей" file): multi's
        # "без" sits at 7.75-7.99 because the preceding word swallowed
        # the pause; ru's "без" sits at 7.11-7.59. The two spans do not
        # overlap at all (gap 0.16s), so a pure-overlap rule sees two
        # different words and both survive as hole-fills — the visible
        # duplicate. Isolated from any neighbouring word so only the
        # без/без pairing is under test.
        primary = [_segment([_w("без", 7.75, 7.99)])]
        secondary = [_segment([_w("без", 7.11, 7.59)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["без"])
        self.assertEqual(merged.filled_from_primary, 0)
        self.assertEqual(merged.filled_from_secondary, 0)

    def test_the_gap_bound_is_load_bearing(self):
        # Same shape, but push the gap just past the bound: now they are
        # two different spoken words and must NOT merge into one.
        gap = ADJACENT_SAME_STEM_MAX_GAP_SEC + 0.2
        primary = [_segment([_w("без", 7.75, 7.99)])]
        secondary = [_segment([_w("без", 7.75 - gap - 0.24, 7.99 - gap - 0.24)])]
        merged = merge_readings(primary, secondary)
        bez_count = sum(1 for w in merged.words if w["word"] == "без")
        self.assertEqual(bez_count, 2)

    def test_a_hole_in_the_primary_is_filled_from_the_secondary(self):
        # The measured 21.82-25.99s hole: multi has nothing there, ru
        # has every word of it. Both readings agree on the surrounding
        # words (so those pair off cleanly) and only the hole words are
        # unpaired secondary — an unambiguous "filled from ru".
        primary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        secondary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment(
                [_w("говорю", 2.0, 2.5), _w("просто", 2.6, 3.0), _w("кучу", 3.1, 3.5)]
            ),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        merged = merge_readings(primary, secondary)
        words = [w["word"] for w in merged.words]
        self.assertEqual(words, ["before", "говорю", "просто", "кучу", "after"])
        self.assertEqual(merged.filled_from_secondary, 3)
        self.assertEqual(merged.filled_from_primary, 0)
        filled = [w for w in merged.words if w["word"] == "говорю"][0]
        self.assertEqual(filled["source"], "ru")

    def test_a_hole_in_the_secondary_is_filled_from_the_primary(self):
        # Mirror: ru skipped a French clause entirely, multi had it.
        primary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment([_w("lab", 5.0, 5.3), _w("de", 5.3, 5.5), _w("la", 5.5, 5.7)]),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        secondary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        merged = merge_readings(primary, secondary)
        words = [w["word"] for w in merged.words]
        self.assertEqual(words, ["before", "lab", "de", "la", "after"])
        self.assertEqual(merged.filled_from_primary, 3)
        self.assertEqual(merged.filled_from_secondary, 0)
        filled = [w for w in merged.words if w["word"] == "lab"][0]
        self.assertEqual(filled["source"], "multi")

    def test_every_merged_word_carries_provenance(self):
        primary = [_segment([_w("hello", 0.0, 0.5)])]
        secondary = [_segment([_w("мир", 5.0, 5.5)])]
        merged = merge_readings(primary, secondary)
        self.assertTrue(all("source" in w for w in merged.words))
        sources = {w["word"]: w["source"] for w in merged.words}
        self.assertEqual(sources["hello"], "multi")
        self.assertEqual(sources["мир"], "ru")

    def test_same_core_overlap_prefers_the_primarys_spelling(self):
        primary = [_segment([_w("Sonnet,", 1.0, 1.5)])]
        secondary = [_segment([_w("sonnet", 1.05, 1.45)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["Sonnet,"])

    def test_different_core_overlap_with_latin_prefers_multi(self):
        # A monolingual Russian reading transliterates "Sonnet"; the
        # multilingual reading keeps it as written.
        primary = [_segment([_w("Sonnet", 1.0, 1.5)])]
        secondary = [_segment([_w("Соннет", 1.05, 1.45)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["Sonnet"])

    def test_different_core_both_cyrillic_prefers_the_secondary(self):
        # The measured stronger reading on Cyrillic content.
        primary = [_segment([_w("Локи", 1.0, 1.5)])]
        secondary = [_segment([_w("который", 1.05, 1.45)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["который"])

    def test_ngram_guard_keeps_a_genuine_disjoint_time_repeat(self):
        # "subagents, subagents" — spoken twice, far apart in time. Must
        # survive as two words, not be halved by the seam de-duplicator.
        primary = [
            _segment([_w("subagents,", 1.0, 1.5)]),
            _segment([_w("subagents", 40.0, 40.6)]),
        ]
        secondary = [
            _segment([_w("субагенты,", 1.0, 1.5)]),
            _segment([_w("субагенты", 40.0, 40.6)]),
        ]
        merged = merge_readings(primary, secondary)
        count = sum(1 for w in merged.words if w["word"].lower().startswith("subagents"))
        self.assertEqual(count, 2)
        self.assertEqual(merged.duplicates_removed, 0)

    def test_no_secondary_words_degrades_to_the_primary_reading_unchanged(self):
        primary = [_segment([_w("only", 0.0, 0.5), _w("primary", 0.6, 1.0)])]
        merged = merge_readings(primary, [])
        self.assertEqual([w["word"] for w in merged.words], ["only", "primary"])
        self.assertEqual(merged.secondary_word_count, 0)
        self.assertEqual(merged.filled_from_secondary, 0)
        self.assertEqual(merged.filled_from_primary, 0)
        self.assertTrue(all(w["source"] == "multi" for w in merged.words))

    def test_covered_end_sec_and_text_reflect_the_merge(self):
        primary = [_segment([_w("a", 0.0, 1.0)])]
        secondary = [_segment([_w("b", 5.0, 6.0)])]
        merged = merge_readings(primary, secondary)
        self.assertAlmostEqual(merged.covered_end_sec(), 6.0)
        self.assertEqual(merged.text, "a b")


class ForwardedSegmentWireShapeTests(unittest.TestCase):
    """Pin the wire shape a final ``segments`` frame sends the renderer.

    ``backend.deepgram_dual`` merges two readings by word time, and the
    words it needs are exactly the ones a final segment frame already
    carries (``remote_deepgram_live.py``, the ``out_segment["words"]``
    comment). If that ever grows extra keys or loses ``start``/``end``,
    the merge silently loses its only join key — pinned here so a
    refactor of the single-stream forwarding path cannot drift out from
    under the dual-stream feature that depends on it.
    """

    def test_a_final_segment_carries_exactly_word_start_end_per_word(self):
        session = DeepgramLiveSession(api_key="k")
        msg = {
            "type": "Results",
            "is_final": True,
            "speech_final": True,
            "start": 1.0,
            "duration": 1.5,
            "channel": {
                "alternatives": [
                    {
                        "transcript": "hello world",
                        "confidence": 0.9,
                        "words": [
                            {
                                "word": "hello",
                                "start": 1.0,
                                "end": 1.4,
                                "confidence": 0.95,
                                "punctuated_word": "Hello",
                            },
                            {
                                "word": "world",
                                "start": 1.4,
                                "end": 2.5,
                                "confidence": 0.88,
                                "punctuated_word": "world.",
                            },
                        ],
                    }
                ]
            },
        }
        event = session._process_deepgram_message(msg)
        self.assertEqual(event["type"], "segments")
        self.assertEqual(len(event["segments"]), 1)
        words = event["segments"][0]["words"]
        self.assertEqual(
            words,
            [
                {"word": "Hello", "start": 1.0, "end": 1.4},
                {"word": "world.", "start": 1.4, "end": 2.5},
            ],
        )
        for w in words:
            self.assertEqual(set(w.keys()), {"word", "start", "end"})

    def test_a_final_with_no_word_list_omits_the_key_entirely(self):
        # An empty list would read as "no words here"; omitting the key
        # is the only honest way to say "not known" (module comment).
        session = DeepgramLiveSession(api_key="k")
        msg = {
            "type": "Results",
            "is_final": True,
            "speech_final": True,
            "start": 0.0,
            "duration": 1.0,
            "channel": {"alternatives": [{"transcript": "hi", "confidence": 0.5}]},
        }
        event = session._process_deepgram_message(msg)
        self.assertNotIn("words", event["segments"][0])


# ---------------------------------------------------------------------
# The facade
# ---------------------------------------------------------------------


@dataclass
class _FakeStats:
    connect_ms: Optional[float] = 50.0


@dataclass
class _FakeLiveSession:
    """The surface ``DualLiveSession`` actually touches, and nothing else."""

    name: str
    drain_result: dict = field(default_factory=dict)
    holes: list = field(default_factory=list)
    sent: list = field(default_factory=list)
    send_error: Optional[Exception] = None
    drain_error: Optional[Exception] = None
    drain_delay: float = 0.0
    stats: _FakeStats = field(default_factory=_FakeStats)
    is_closed: bool = False
    last_error: Optional[str] = None
    last_fatal: bool = False
    shutdown_called: bool = False
    close_called: bool = False
    discard_called: bool = False
    undelivered: list = field(default_factory=list)

    async def send_pcm(self, chunk: bytes) -> None:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append(chunk)

    async def drain_transcript(self, on_budget=None) -> dict:
        if on_budget is not None:
            on_budget(2.0, False)
        if self.drain_delay:
            await asyncio.sleep(self.drain_delay)
        if self.drain_error is not None:
            raise self.drain_error
        return dict(self.drain_result)

    def coverage_hole_spans(self):
        return list(self.holes)

    def report_fatal(self, message: str) -> None:
        self.last_fatal = True
        self.last_error = message

    def note_undelivered_audio(self, nbytes: int) -> None:
        self.undelivered.append(nbytes)

    def events(self):
        async def _gen():
            yield {"type": "marker", "from": self.name}
        return _gen()

    def final_text(self) -> str:
        return str(self.drain_result.get("text") or "")

    async def shutdown(self, wait_timeout: float = 3.0) -> None:
        self.shutdown_called = True

    async def close(self) -> None:
        self.close_called = True

    async def discard(self) -> None:
        self.discard_called = True


def _primary(**over) -> _FakeLiveSession:
    base = dict(
        name="primary",
        drain_result={
            "text": "before after",
            "segments": [_segment([_w("before", 0.0, 1.0), _w("after", 10.0, 11.0)])],
            "streamedSec": 11.0,
        },
    )
    base.update(over)
    return _FakeLiveSession(**base)


def _secondary(**over) -> _FakeLiveSession:
    # Agrees with ``_primary``'s "before"/"after" (so those pair off
    # cleanly) and additionally caught the word in the gap between them
    # that the primary reading missed — the one thing this fixture
    # exists to test: a hole filled from the secondary.
    base = dict(
        name="secondary",
        drain_result={
            "text": "before hole after",
            "segments": [
                _segment(
                    [_w("before", 0.0, 1.0), _w("hole", 2.0, 2.5), _w("after", 10.0, 11.0)]
                )
            ],
            "streamedSec": 11.0,
        },
    )
    base.update(over)
    return _FakeLiveSession(**base)


class DualLiveSessionFanOutTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_pcm_reaches_both_sockets(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        await dual.send_pcm(b"abc")
        self.assertEqual(primary.sent, [b"abc"])
        self.assertEqual(secondary.sent, [b"abc"])

    async def test_events_come_only_from_the_primary(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        events = [e async for e in dual.events()]
        self.assertEqual(events, [{"type": "marker", "from": "primary"}])

    async def test_events_follow_a_primary_replacement(self):
        # The warm-socket liveness path (``backend.main``) replaces the
        # primary mid-recording without ever handing out a new facade —
        # ``replace_primary`` mutates ``dual.primary`` in place. A
        # consumer that started iterating ``dual.events()`` before the
        # swap must keep receiving events from the NEW primary
        # afterward, never see the secondary's, and must not be cut off
        # just because the old primary's own generator ended.
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        fresh = _primary(name="fresh-primary")
        collected = []
        async for event in dual.events():
            collected.append(event)
            if event["from"] == "primary":
                old = dual.replace_primary(fresh)
                self.assertIs(old, primary)
        self.assertEqual(
            collected,
            [
                {"type": "marker", "from": "primary"},
                {"type": "marker", "from": "fresh-primary"},
            ],
        )
        self.assertTrue(all(e["from"] != "secondary" for e in collected))

    async def test_a_secondary_send_failure_degrades_without_touching_the_primary(self):
        primary = _primary()
        secondary = _secondary(send_error=RuntimeError("boom"))
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING") as logs:
            await dual.send_pcm(b"xyz")
        self.assertEqual(primary.sent, [b"xyz"])
        self.assertTrue(dual.secondary_failed)
        self.assertEqual(len(logs.output), 1, "logged once")
        # A second failing send does not log again.
        await dual.send_pcm(b"more")
        self.assertEqual(primary.sent, [b"xyz", b"more"])

    async def test_note_undelivered_audio_reaches_both(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        dual.note_undelivered_audio(42)
        self.assertEqual(primary.undelivered, [42])
        self.assertEqual(secondary.undelivered, [42])

    async def test_shutdown_close_discard_reach_both_sockets(self):
        for method in ("shutdown", "close", "discard"):
            primary, secondary = _primary(), _secondary()
            dual = DualLiveSession(primary, secondary, secondary_language="ru")
            await getattr(dual, method)()
            self.assertTrue(getattr(primary, f"{method}_called"))
            self.assertTrue(getattr(secondary, f"{method}_called"))

    async def test_replace_primary_swaps_only_the_primary(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        fresh = _primary(name="fresh-primary")
        old = dual.replace_primary(fresh)
        self.assertIs(old, primary)
        self.assertIs(dual.primary, fresh)
        self.assertIs(dual.secondary, secondary)


class DualLiveSessionDrainTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_merged_envelope_carries_the_dual_stats(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(
            primary, secondary,
            secondary_language="ru", primary_language="multi",
        )
        envelope = await dual.drain_transcript()
        self.assertEqual(envelope["text"], "before hole after")
        self.assertEqual(envelope["stats"]["dual_stream"], True)
        self.assertIs(envelope["stats"]["dual_stream"], True, "must be a bool")
        self.assertEqual(envelope["stats"]["dual_secondary_language"], "ru")
        self.assertEqual(envelope["stats"]["dual_filled_from_secondary"], 1)
        self.assertEqual(envelope["stats"]["dual_filled_from_primary"], 0)
        words = envelope["words"]
        self.assertEqual([w["word"] for w in words], ["before", "hole", "after"])
        self.assertTrue(all({"word", "start", "end", "source"} <= w.keys() for w in words))
        for seg in envelope["segments"]:
            self.assertIn("words", seg)

    async def test_one_budget_is_announced_and_forwarded(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        seen = []
        await dual.drain_transcript(on_budget=lambda b, more: seen.append((b, more)))
        self.assertEqual(seen, [(2.0, False)])

    async def test_a_dead_secondary_degrades_to_single_stream(self):
        primary = _primary()
        secondary = _secondary(drain_error=RuntimeError("socket dropped"))
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING"):
            envelope = await dual.drain_transcript()
        self.assertEqual(envelope["text"], "before after")
        self.assertIs(envelope["stats"]["dual_stream"], False)
        self.assertTrue(dual.secondary_failed)

    async def test_a_secondary_that_blows_the_budget_degrades_to_single_stream(self):
        primary = _primary()
        secondary = _secondary(drain_delay=10.0)
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING"):
            envelope = await dual.drain_transcript(
                on_budget=lambda b, more: None
            )
        self.assertEqual(envelope["text"], "before after")
        self.assertIs(envelope["stats"]["dual_stream"], False)

    async def test_uncovered_speech_is_measured_on_the_merged_words(self):
        primary = _primary(holes=[(2.0, 2.5)])
        secondary = _secondary(holes=[])
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        envelope = await dual.drain_transcript()
        # The secondary's "hole" word fills exactly the primary's
        # reported hole span, so nothing should remain uncovered.
        self.assertAlmostEqual(envelope["uncoveredSpeechSec"], 0.0, places=3)

    async def test_finalize_drains_then_shuts_down_both_sockets(self):
        # The single-session back-compat convenience
        # (DeepgramLiveSession.finalize) — a caller that only knows that
        # API (the A/B tool) must get it here too, not an
        # AttributeError, or the facade is not really "one interface
        # either way".
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(
            primary, secondary,
            secondary_language="ru", primary_language="multi",
        )
        envelope = await dual.finalize()
        self.assertEqual(envelope["text"], "before hole after")
        self.assertTrue(primary.shutdown_called)
        self.assertTrue(secondary.shutdown_called)

    async def test_the_stop_line_reports_both_word_counts(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(
            primary, secondary,
            secondary_language="ru", primary_language="multi",
        )
        with self.assertLogs("backend.deepgram_dual", level="INFO") as logs:
            await dual.drain_transcript()
        line = next(m for m in logs.output if "dual-stream merge" in m)
        self.assertIn("multi=2 words", line)
        self.assertIn("ru=3 words", line)
        self.assertIn("merged=3", line)
        self.assertIn("filled_from_ru=1", line)
        self.assertIn("filled_from_multi=0", line)
        self.assertIn("dups_removed=0", line)


if __name__ == "__main__":
    unittest.main()
