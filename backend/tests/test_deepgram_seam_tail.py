"""Two loss-classes from 2026-08-24 live logs, fixed and pinned.

1. Seam severing — Deepgram's periodic forced flushes can cut a word in
   half across consecutive finals ("…раз, два, три, четыре, пя" |
   "ть. …"). ``merge_seam_fragments`` re-joins such fragments in the
   canonical transcript when every guard holds.

2. Silent tail loss — when Deepgram never answers Finalize
   ("no post-Finalize transcript within 3.0s" fired 19× that day), the
   stream used to close blind. Now a retry fires only when streamed
   audio actually runs past the last finalized segment.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from backend.remote_deepgram_live import (
    DeepgramLiveSession,
    merge_seam_fragments,
)


class MergeSeamFragmentsTests(unittest.TestCase):
    def test_rejoins_word_severed_at_flush_boundary(self):
        segs = [
            {"start": 5.94, "end": 17.76, "text": "Вау, раз, два, четыре, пя"},
            {"start": 17.76, "end": 22.22, "text": "ть. Некоторые слова"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "Вау, раз, два, четыре, пять.")
        self.assertEqual(out[1]["text"], "Некоторые слова")

    def test_next_segment_absorbed_entirely_when_only_the_fragment(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "сказал п"},
            {"start": 3.0, "end": 6.0, "text": "ока"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "сказал пока")

    def test_trailing_content_after_the_fragment_stays_its_own_segment(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "сказал п"},
            {"start": 3.0, "end": 6.0, "text": "ока всё"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual([s["text"] for s in out], ["сказал пока", "всё"])

    def test_normal_word_boundary_is_never_merged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "и тут"},
            {"start": 3.0, "end": 6.0, "text": "началось"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "и тут")
        self.assertEqual(out[1]["text"], "началось")

    def test_sentence_boundary_is_never_merged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "Вот конец."},
            {"start": 3.0, "end": 6.0, "text": "дальше новое"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "Вот конец.")

    def test_real_pause_is_never_bridged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "конец п"},
            {"start": 4.5, "end": 6.0, "text": "ока"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(len(out), 2)

    def test_new_sentence_starting_capital_is_never_merged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "вопрос т"},
            {"start": 3.0, "end": 6.0, "text": "Так мы начали"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[1]["text"], "Так мы начали")

    def test_latin_fragment_joins(self):
        segs = [
            {"start": 0.0, "end": 2.0, "text": "say th"},
            {"start": 2.0, "end": 4.0, "text": "ink about it"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "say think")
        self.assertEqual(out[1]["text"], "about it")

    def test_single_segment_passthrough(self):
        segs = [{"start": 0.0, "end": 1.0, "text": "привет"}]
        self.assertEqual(merge_seam_fragments(segs)[0]["text"], "привет")


class _FakeUpstreamWs:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, payload):
        self.sent.append(json.loads(payload).get("type"))

    async def close(self):
        return None

    @property
    def types(self) -> list[str]:
        return list(self.sent)


def _session() -> DeepgramLiveSession:
    session = DeepgramLiveSession(api_key="k")
    session._ws = _FakeUpstreamWs()
    session._keepalive_task = None
    session._recv_task = None
    return session


class TailGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_fires_when_recognised_speech_runs_past_last_final(self):
        session = _session()
        ws = session._ws
        assert ws is not None
        # 11 s of audio streamed, only 10 s finalized, and an interim
        # heard words through 11 s → the trailing second is real speech
        # that never reached a final. This is what the guard is for.
        session._finalized_segments = [
            {"start": 0.0, "end": 10.0, "text": "хвост", "is_final": True},
        ]
        session.stats.bytes_sent = int(11.0 * 2 * session._cfg.sample_rate)
        session._interim_speech_spans = [(10.0, 11.0)]

        async def silent():
            await asyncio.sleep(99)

        blocker = asyncio.create_task(silent())
        try:
            await session.finalize(wait_timeout=0.2)
        finally:
            blocker.cancel()
        finalize_sends = [i for i, t in enumerate(ws.types) if t == "Finalize"]
        self.assertGreaterEqual(
            len(finalize_sends), 2,
            f"tail guard must retry Finalize; frames were {ws.types}",
        )

    async def test_uncovered_audio_retries_even_with_no_interim_speech(self):
        # The regression this pins. The guard briefly closed fast when no
        # interim had heard words in the gap, on the reasoning that a
        # Finalize cannot flush what was never decoded. Measured in
        # production one stop later:
        #
        #   streamed=20.08s covered=16.07s gap=4.01s speech_in_gap=0.00s
        #
        # Four seconds of the user's speech, reported as zero, because
        # Deepgram had stopped emitting interims 3.7 s before Stop and
        # then never flushed the final either. A provider going quiet and
        # a user falling silent are indistinguishable to that signal, and
        # the first is exactly the failure mode the guard exists for.
        session = _session()
        ws = session._ws
        assert ws is not None
        session._finalized_segments = [
            {"start": 0.0, "end": 10.0, "text": "хвост", "is_final": True},
        ]
        session.stats.bytes_sent = int(11.0 * 2 * session._cfg.sample_rate)
        session._interim_speech_spans = []

        async def silent():
            await asyncio.sleep(99)

        blocker = asyncio.create_task(silent())
        try:
            await session.finalize(wait_timeout=0.2)
        finally:
            blocker.cancel()
        self.assertGreaterEqual(
            ws.types.count("Finalize"), 2,
            f"uncovered audio must retry regardless of the speech signal; "
            f"frames were {ws.types}",
        )
        self.assertIn("CloseStream", ws.types)

    async def test_no_retry_when_stream_fully_covered(self):
        session = _session()
        ws = session._ws
        assert ws is not None
        session._finalized_segments = [
            {"start": 0.0, "end": 10.0, "text": "полностью", "is_final": True},
        ]
        session.stats.bytes_sent = int(10.0 * 2 * session._cfg.sample_rate)

        async def silent():
            await asyncio.sleep(99)

        blocker = asyncio.create_task(silent())
        try:
            await session.finalize(wait_timeout=0.2)
        finally:
            blocker.cancel()
        finalize_count = sum(1 for t in ws.types if t == "Finalize")
        self.assertEqual(
            finalize_count, 1,
            f"fully-covered stream must not pay the retry; frames {ws.types}",
        )


if __name__ == "__main__":
    unittest.main()
