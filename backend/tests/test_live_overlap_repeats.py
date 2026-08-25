"""A re-decoded window overlap must not reach the transcript twice.

The local live path decodes a rolling 8 s window and re-feeds 1 s of
already-committed audio at its head, so the model has context on both
sides of a word that falls on a boundary. The head of every pass is
therefore a SECOND reading of speech that was already emitted, and it has
to be removed.

Removing it by time alone does not work. Both engines re-estimate word
timestamps on every pass, and the drift is larger than
``emit_epsilon_sec``; a word whose second reading lands past the
watermark passes the trim and is emitted again. Reported by the user
against both engines, 2026-08-25 — the fixtures below are verbatim from
those transcripts:

    "…насколько он хорошо. хорошо работает…"
    "…какие-то проблемы. проблемы, может быть…"
    "…у этих чуваков чуваков еще Чанкова…"

Both readings are equally plausible as timestamps. As text they are the
same words in the same order, and that is decidable.
"""

from __future__ import annotations

import unittest

from backend.live import REPEAT_TRIM_MAX_WORDS, trim_repeated_prefix


class ReDecodedOverlapTests(unittest.TestCase):
    def test_the_reported_duplications(self):
        cases = [
            ("насколько он хорошо.", "хорошо работает, может быть у него",
             "работает, может быть у него"),
            ("может быть у него...", "него есть какие-то проблемы.",
             "есть какие-то проблемы."),
            ("какие-то проблемы.", "проблемы, может быть у него нет проблем",
             "может быть у него нет проблем"),
            ("и так далее", "далее. Дипграмм работает", "Дипграмм работает"),
            ("у этих чуваков", "чуваков еще Чанкова", "еще Чанкова"),
            ("они тоже по идее достаточно...",
             "идее достаточно быстро должны транскребировать.",
             "быстро должны транскребировать."),
        ]
        for previous, new, expected in cases:
            with self.subTest(new=new):
                self.assertEqual(trim_repeated_prefix(previous, new), expected)

    def test_a_multi_word_overlap_is_matched_whole(self):
        self.assertEqual(
            trim_repeated_prefix("это сейчас будет работать", "сейчас будет работать нормально"),
            "нормально",
        )

    def test_unrelated_speech_is_untouched(self):
        self.assertEqual(
            trim_repeated_prefix("совсем другая фраза", "новое предложение целиком"),
            "новое предложение целиком",
        )

    def test_a_repeat_that_does_not_start_at_the_head_is_real_speech(self):
        # The overlap is always at the head of the window. A phrase that
        # echoes something earlier from the middle of the new text is the
        # user saying it again.
        self.assertEqual(
            trim_repeated_prefix("я сказал привет", "потом снова сказал привет"),
            "потом снова сказал привет",
        )

    def test_a_segment_that_is_entirely_overlap_becomes_empty(self):
        self.assertEqual(trim_repeated_prefix("уже сказанные слова", "уже сказанные слова"), "")

    def test_punctuation_and_case_do_not_block_the_match(self):
        self.assertEqual(
            trim_repeated_prefix("и так далее…", "Далее, дальше поехали"),
            "дальше поехали",
        )

    def test_an_overlap_at_the_limit_is_still_matched(self):
        words = [f"w{i}" for i in range(12)]
        previous = " ".join(words)
        new = " ".join(words[2:] + ["хвост"])   # 10 words of overlap
        self.assertEqual(len(words[2:]), REPEAT_TRIM_MAX_WORDS)
        self.assertEqual(trim_repeated_prefix(previous, new), "хвост")

    def test_beyond_the_limit_nothing_is_removed(self):
        # The bound is deliberate: matching an arbitrarily long run would
        # let a genuine repetition swallow real speech. One second of
        # re-fed audio cannot carry more than a handful of words, so an
        # overlap this long is not the overlap. Nothing is trimmed rather
        # than something being trimmed wrongly.
        words = [f"w{i}" for i in range(12)]
        previous = " ".join(words)
        new = " ".join(words[1:] + ["хвост"])   # 11 words of overlap
        self.assertEqual(trim_repeated_prefix(previous, new), new)

    def test_empty_inputs(self):
        self.assertEqual(trim_repeated_prefix("", "новый текст"), "новый текст")
        self.assertEqual(trim_repeated_prefix("что-то", ""), "")


if __name__ == "__main__":
    unittest.main()
