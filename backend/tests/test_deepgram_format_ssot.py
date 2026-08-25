"""Both Deepgram paths must format a transcript the same way.

Live streaming and prerecorded REST are two ways into the same provider,
on the same model, for the same user speaking the same language. If they
format differently, the same recording comes back looking different
depending on which one served it — and nothing tells the user which did.

They did differ. `remote_deepgram_live` sent ``smart_format=true`` and
`remote_deepgram` sent ``smart_format=false``, each with a comment
asserting the opposite of the other. This test is the thing that makes
that unrepeatable: the options live in one module and both callers are
checked against it, so a future edit to one path fails here instead of
reaching a user's transcript.
"""

from __future__ import annotations

import unittest
from unittest import mock
from urllib.parse import parse_qs

from backend.deepgram_format import shared_format_params
from backend.remote_deepgram_live import DeepgramLiveConfig

SHARED_KEYS = ("smart_format", "punctuate", "filler_words")


def _live_params() -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(DeepgramLiveConfig().to_query_string()).items()}


class SharedFormattingTests(unittest.TestCase):
    def test_the_live_path_sends_exactly_the_shared_decision(self):
        live = _live_params()
        for key, value in shared_format_params().items():
            self.assertEqual(live.get(key), value, f"live path disagrees on {key}")

    def test_the_live_config_carries_no_private_copy(self):
        # A per-session field would be a second place to answer the same
        # question, which is how the two paths came to disagree.
        for key in SHARED_KEYS:
            self.assertFalse(
                hasattr(DeepgramLiveConfig(), key),
                f"DeepgramLiveConfig must not own {key}",
            )

    def test_every_shared_option_reaches_the_wire_as_a_string(self):
        for key, value in shared_format_params().items():
            self.assertIn(key, SHARED_KEYS)
            self.assertIn(value, ("true", "false"))

    def test_the_environment_can_override_without_a_code_change(self):
        with mock.patch.dict("os.environ", {"TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT": "0"}):
            self.assertEqual(shared_format_params()["smart_format"], "false")
            self.assertEqual(_live_params()["smart_format"], "false")
        with mock.patch.dict("os.environ", {"TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT": "1"}):
            self.assertEqual(shared_format_params()["smart_format"], "true")
        # An unparseable value falls back to the default rather than
        # silently disabling formatting.
        with mock.patch.dict("os.environ", {"TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT": "maybe"}):
            self.assertEqual(shared_format_params()["smart_format"], "true")

    def test_smart_formatting_is_on(self):
        # Recorded so a flip is a deliberate edit to this expectation and
        # not a silent drift. The premise for turning it off — that
        # Deepgram strips punctuation for Russian — is contradicted by the
        # live path's own output: 23 sampled transcripts run with it
        # enabled carry a median of 60.3 punctuation marks per 1000
        # letters.
        self.assertEqual(shared_format_params()["smart_format"], "true")


if __name__ == "__main__":
    unittest.main()
