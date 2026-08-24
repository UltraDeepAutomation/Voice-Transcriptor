"""Orphan pool for displaced interim hypotheses (BUG-24).

Live evidence 2026-08-24 session 14:32Z: Deepgram's rolling interims
first decoded a 10.5 s span, then newer hypotheses superseded it, and no
final ever covered it — the supersede rule deleted the only existing
word record and the finalize-time splice had nothing to restore. Words
displaced by a newer hypothesis now move to an orphan pool: still pruned
by finals and by the NEWEST words' coverage, but available to the
finalize splice when nothing better ever arrives.
"""

import unittest

from backend.remote_deepgram_live import DeepgramLiveSession


def _msg(start: float, end: float, text: str, words: list[dict] | None = None) -> dict:
    alt: dict = {"transcript": text}
    if words is not None:
        alt["words"] = [
            {"word": w["word"], "start": w["start"], "end": w["end"]} for w in words
        ]
    return {
        "type": "Results",
        "is_final": False,
        "speech_final": False,
        "start": start,
        "duration": end - start,
        "channel": {"alternatives": [alt]},
    }


def _final_msg(start: float, end: float, text: str) -> dict:
    return {
        "type": "Results",
        "is_final": True,
        "speech_final": True,
        "start": start,
        "duration": end - start,
        "channel": {"alternatives": [{"transcript": text}]},
    }


def _w(word: str, start: float, end: float) -> dict:
    return {"word": word, "start": start, "end": end}


def _finals(session: DeepgramLiveSession) -> list[tuple[float, float, str]]:
    return [
        (float(s.get("start", 0.0)), float(s.get("end", 0.0)), str(s.get("text", "")))
        for s in session._finalized_segments
    ]


class OrphanPoolTests(unittest.TestCase):
    def _session(self) -> DeepgramLiveSession:
        return DeepgramLiveSession(api_key="k")

    def test_superseded_words_survive_to_splice_when_never_confirmed(self):
        s = self._session()
        # Rolling hypothesis #1 decodes a span...
        s._process_deepgram_message(
            _msg(15.0, 31.5, "я не знаю что это за", [_w("что", 30.9, 31.45)])
        )
        # ...a newer hypothesis supersedes it WITHOUT re-decoding that word.
        s._process_deepgram_message(_msg(31.28, 35.0, "добавим ещё", [_w("добавим", 32.0, 33.0)]))
        # And no final ever covers 30.9..31.45; a later final lands beyond it.
        s._process_deepgram_message(_final_msg(41.74, 43.99, "Гигаам."))

        # finalize() is async; exercise the sync splice path directly:
        spliced = s._splice_uncovered_interim_words()
        texts = [str(seg.get("text") or "") for seg in s._finalized_segments]
        self.assertIn("что", " ".join(texts))
        self.assertGreaterEqual(spliced, 1)

    def test_newest_hypothesis_still_wins_no_duplicates(self):
        s = self._session()
        s._process_deepgram_message(_msg(0.0, 2.0, "хеллоу", [_w("хеллоу", 1.0, 1.8)]))
        # Newer interim covers the same ground with its own word record.
        s._process_deepgram_message(_msg(0.5, 3.0, "hello world", [_w("мир", 1.2, 1.6)]))
        self.assertEqual(
            [o["word"] for o in s._orphan_interim_words],
            [],
            "an orphan overlapped by the newest words must be discarded immediately",
        )

    def test_final_confirming_region_clears_orphans(self):
        s = self._session()
        s._process_deepgram_message(_msg(0.0, 2.0, "альфа бета", [_w("бета", 1.0, 1.8)]))
        s._process_deepgram_message(_msg(1.5, 4.0, "гамма", [_w("гамма", 2.2, 3.0)]))
        self.assertEqual(len(s._orphan_interim_words), 1)
        s._process_deepgram_message(_final_msg(0.0, 4.0, "всё подтвердилось"))
        self.assertEqual(s._orphan_interim_words, [])

    def test_splice_dedupes_shifted_orphan_copy_against_new_interim(self):
        # BUG-78: a word displaced to the orphan pool, then re-decoded by
        # a newer interim at SHIFTED times (boundary moved beyond the
        # range-overlap purge), must not be spliced twice.
        s = self._session()
        s._process_deepgram_message(
            _msg(0.0, 2.0, "привет", [_w("привет", 1.0, 1.8)])
        )
        # Newer hypothesis re-decodes the same spoken word at a shifted
        # boundary (1.35..2.05 does not overlap 1.0..1.8 by enough for
        # the interim-handler purge to drop the orphan copy).
        s._process_deepgram_message(
            _msg(0.5, 3.0, "привет мир", [_w("привет", 1.35, 2.05), _w("мир", 2.2, 2.6)])
        )
        spliced = s._splice_uncovered_interim_words()
        texts = [str(seg.get("text") or "") for seg in s._finalized_segments]
        joined = " ".join(texts)
        self.assertEqual(joined.count("привет"), 1, f"word duplicated in splice: {joined!r}")
        # Legit repeat with DISJOINT times is not deduped away.
        self.assertIn("мир", joined)
        self.assertGreaterEqual(spliced, 2)

    def test_splice_keeps_legitimate_disjoint_repeats(self):
        s = self._session()
        s._process_deepgram_message(
            _msg(0.0, 2.0, "да", [_w("да", 1.0, 1.4)])
        )
        s._process_deepgram_message(
            _msg(5.0, 7.0, "да", [_w("да", 6.0, 6.4)])
        )
        s._splice_uncovered_interim_words()
        joined = " ".join(
            str(seg.get("text") or "") for seg in s._finalized_segments
        )
        self.assertEqual(joined.count("да"), 2, "a genuinely repeated word was wrongly deduped")


if __name__ == "__main__":
    unittest.main()
