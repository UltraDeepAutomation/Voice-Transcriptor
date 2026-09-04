"""Tests for backend.deepgram_keyterms — Nova-3 Keyterm Prompting SSOT.

Covers term normalisation (separators, whitespace, dedupe, casing), the
500-token conservative cap, model-family gating (``keyterms_supported``),
and that the live query builder emits one repeated ``keyterm=`` pair per
term while never dropping any key the pre-keyterms suite
(``test_deepgram_format_ssot.py``) already pins.
"""

from __future__ import annotations

import unittest
from urllib.parse import parse_qs, parse_qsl

from backend.config import DEFAULT_CONFIG, _validate_config_shape
from backend.deepgram_keyterms import (
    configured_keyterms,
    keyterm_query_pairs,
    keyterms_supported,
    normalize_keyterms,
)
from backend.remote_deepgram_live import DeepgramLiveConfig

# Every key the live query string carried before keyterms existed
# (base params ``to_query_string`` has always emitted, plus the shared
# formatting keys pinned by test_deepgram_format_ssot.SHARED_KEYS).
BASE_LIVE_KEYS = (
    "model", "encoding", "sample_rate", "channels", "interim_results",
    "smart_format", "punctuate", "filler_words",
    "endpointing", "utterance_end_ms", "language",
)


class NormalizeKeytermsTests(unittest.TestCase):
    def test_comma_separated(self):
        self.assertEqual(
            normalize_keyterms("Sonnet, Opus, Claude"), ("Sonnet", "Opus", "Claude")
        )

    def test_newline_separated(self):
        self.assertEqual(
            normalize_keyterms("Sonnet\nOpus\nClaude"), ("Sonnet", "Opus", "Claude")
        )

    def test_mixed_separators_and_whitespace(self):
        raw = "  Sonnet ,\nOpus\n , Claude  \n\n Deepgram "
        self.assertEqual(
            normalize_keyterms(raw), ("Sonnet", "Opus", "Claude", "Deepgram")
        )

    def test_empty_pieces_dropped(self):
        self.assertEqual(normalize_keyterms("Sonnet,,  ,\n\nOpus"), ("Sonnet", "Opus"))

    def test_duplicates_removed_case_insensitively_keeping_first_spelling(self):
        self.assertEqual(
            normalize_keyterms("Sonnet, sonnet, SONNET, Opus"), ("Sonnet", "Opus")
        )

    def test_empty_and_non_string_input(self):
        self.assertEqual(normalize_keyterms(""), ())
        self.assertEqual(normalize_keyterms(None), ())  # type: ignore[arg-type]

    def test_order_preserved(self):
        self.assertEqual(normalize_keyterms("z, a, m"), ("z", "a", "m"))


class TokenCapTests(unittest.TestCase):
    def test_within_budget_keeps_everything(self):
        terms = ", ".join(f"term{i}" for i in range(50))
        result = normalize_keyterms(terms)
        self.assertEqual(len(result), 50)

    def test_over_budget_truncates_and_keeps_original_order_prefix(self):
        # Each term is one word -> ceil(1 * 1.3) = 2 estimated tokens;
        # a 500-token budget fits at most 250 single-word terms.
        many = ", ".join(f"term{i}" for i in range(400))
        result = normalize_keyterms(many)
        self.assertLess(len(result), 400)
        self.assertEqual(result, tuple(f"term{i}" for i in range(len(result))))

    def test_a_pathologically_long_single_term_is_dropped_not_truncated(self):
        huge_term = " ".join(f"w{i}" for i in range(1000))
        self.assertEqual(normalize_keyterms(huge_term), ())


class KeytermsSupportedTests(unittest.TestCase):
    def test_nova3_supported(self):
        self.assertTrue(keyterms_supported("nova-3"))
        self.assertTrue(keyterms_supported("Nova-3"))

    def test_nova2_not_supported(self):
        self.assertFalse(keyterms_supported("nova-2"))

    def test_empty_or_none_not_supported(self):
        self.assertFalse(keyterms_supported(""))
        self.assertFalse(keyterms_supported(None))  # type: ignore[arg-type]


class KeytermQueryPairsTests(unittest.TestCase):
    def test_pairs_for_supported_model(self):
        pairs = keyterm_query_pairs(("Sonnet", "Opus"), "nova-3")
        self.assertEqual(pairs, [("keyterm", "Sonnet"), ("keyterm", "Opus")])

    def test_empty_for_unsupported_model(self):
        self.assertEqual(keyterm_query_pairs(("Sonnet",), "nova-2"), [])

    def test_empty_for_no_terms(self):
        self.assertEqual(keyterm_query_pairs((), "nova-3"), [])


class LiveConfigKeytermQueryStringTests(unittest.TestCase):
    def test_repeated_keyterm_pairs_present_for_nova3(self):
        cfg = DeepgramLiveConfig(model="nova-3", keyterms=("Sonnet", "Opus", "Claude"))
        pairs = parse_qsl(cfg.to_query_string())
        keyterm_values = [v for k, v in pairs if k == "keyterm"]
        self.assertEqual(keyterm_values, ["Sonnet", "Opus", "Claude"])

    def test_no_keyterm_pairs_for_non_nova3_model(self):
        cfg = DeepgramLiveConfig(model="nova-2", keyterms=("Sonnet", "Opus"))
        pairs = parse_qsl(cfg.to_query_string())
        self.assertNotIn("keyterm", [k for k, _ in pairs])

    def test_no_keyterm_pairs_when_no_terms_configured(self):
        cfg = DeepgramLiveConfig(model="nova-3")
        pairs = parse_qsl(cfg.to_query_string())
        self.assertNotIn("keyterm", [k for k, _ in pairs])

    def test_every_previously_emitted_key_still_present(self):
        # Pins the query string against the pre-keyterms shape (see
        # test_deepgram_format_ssot.py) so adding keyterms can never
        # silently drop an existing parameter.
        cfg = DeepgramLiveConfig(model="nova-3", keyterms=("Sonnet",))
        params = parse_qs(cfg.to_query_string())
        for key in BASE_LIVE_KEYS:
            self.assertIn(key, params, f"missing pre-existing key {key!r}")

    def test_language_multi_branch_unaffected_by_keyterms(self):
        cfg = DeepgramLiveConfig(model="nova-3", language="auto", keyterms=("Sonnet",))
        params = {k: v[0] for k, v in parse_qs(cfg.to_query_string()).items()}
        self.assertEqual(params["language"], "multi")


class ConfiguredKeytermsTests(unittest.TestCase):
    def test_missing_preferences_block_returns_empty(self):
        self.assertEqual(configured_keyterms({}), ())

    def test_missing_deepgram_block_returns_empty(self):
        self.assertEqual(configured_keyterms({"preferences": {}}), ())

    def test_non_dict_cfg_returns_empty(self):
        self.assertEqual(configured_keyterms("not-a-dict"), ())  # type: ignore[arg-type]
        self.assertEqual(configured_keyterms(None), ())  # type: ignore[arg-type]

    def test_non_dict_preferences_or_deepgram_block_returns_empty(self):
        self.assertEqual(configured_keyterms({"preferences": "oops"}), ())
        self.assertEqual(
            configured_keyterms({"preferences": {"deepgram": "oops"}}), ()
        )

    def test_string_value_is_normalised(self):
        cfg = {"preferences": {"deepgram": {"keyterms": "Sonnet, sonnet,  Opus "}}}
        self.assertEqual(configured_keyterms(cfg), ("Sonnet", "Opus"))


class ConfigDefaultAndValidationTests(unittest.TestCase):
    def test_default_config_has_empty_keyterms(self):
        self.assertEqual(DEFAULT_CONFIG["preferences"]["deepgram"]["keyterms"], "")

    def test_non_string_keyterms_value_resets_to_empty(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {"keyterms": 12345}}}
        )
        self.assertEqual(fixed["preferences"]["deepgram"]["keyterms"], "")

    def test_non_dict_deepgram_block_resets_to_default(self):
        # Reads the defaults rather than restating them: this block has
        # grown a second setting (dual_stream) and will grow more, and a
        # test that lists them by hand only ever fails for that.
        from backend.config import DEFAULT_CONFIG

        fixed = _validate_config_shape({"preferences": {"deepgram": "oops-a-string"}})
        self.assertEqual(
            fixed["preferences"]["deepgram"],
            DEFAULT_CONFIG["preferences"]["deepgram"],
        )
        self.assertEqual(fixed["preferences"]["deepgram"]["keyterms"], "")


if __name__ == "__main__":
    unittest.main()
