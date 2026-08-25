"""Idle-unload policy for the local Whisper model cache.

Root cause covered here: a loaded `small` model pinned ~700 MB for the
whole process lifetime because the LRU cap only evicts on *insert*.
Nothing released memory when the user simply stopped transcribing, so
the app carried the footprint until quit.
"""

import unittest

from backend import transcribe


class _FakeModel:
    """Stand-in for WhisperModel — the cache never inspects it."""


class TestIdleModelUnload(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_idle = transcribe._MODEL_IDLE_UNLOAD_SEC
        transcribe._MODEL_CACHE.clear()
        transcribe._MODEL_LAST_USED.clear()
        transcribe._MODEL_WARM_STATE.clear()

    def tearDown(self) -> None:
        transcribe._MODEL_IDLE_UNLOAD_SEC = self._saved_idle
        transcribe._MODEL_CACHE.clear()
        transcribe._MODEL_LAST_USED.clear()
        transcribe._MODEL_WARM_STATE.clear()

    def _seed(self, name: str, last_used: float) -> None:
        transcribe._MODEL_CACHE[name] = _FakeModel()
        transcribe._MODEL_LAST_USED[name] = last_used
        transcribe._MODEL_WARM_STATE[name] = {"loaded_ms": 1.0, "probe_ms": 1.0}

    def test_releases_model_idle_past_the_window(self) -> None:
        transcribe._MODEL_IDLE_UNLOAD_SEC = 600
        self._seed("small", last_used=0.0)

        released = transcribe.release_idle_models(now=601.0)

        self.assertEqual(released, ["small"])
        self.assertNotIn("small", transcribe._MODEL_CACHE)
        # Warm state must go with it: a stale warm record would let the
        # warmup endpoint short-circuit for a model that is no longer
        # resident, and the user's next transcription would pay the
        # cold load on the interactive path.
        self.assertEqual(transcribe.warm_state("small"), {})
        self.assertFalse(transcribe.model_is_resident("small"))

    def test_keeps_model_used_within_the_window(self) -> None:
        transcribe._MODEL_IDLE_UNLOAD_SEC = 600
        self._seed("small", last_used=100.0)

        self.assertEqual(transcribe.release_idle_models(now=500.0), [])
        self.assertIn("small", transcribe._MODEL_CACHE)
        self.assertTrue(transcribe.model_is_resident("small"))

    def test_touch_resets_the_idle_clock(self) -> None:
        transcribe._MODEL_IDLE_UNLOAD_SEC = 600
        self._seed("small", last_used=0.0)

        transcribe._touch_model("small")

        # The touch stamped monotonic() "now", so a sweep at a small
        # absolute timestamp must not consider the model idle.
        self.assertEqual(transcribe.release_idle_models(now=601.0), [])
        self.assertIn("small", transcribe._MODEL_CACHE)

    def test_touch_ignores_models_not_in_cache(self) -> None:
        transcribe._touch_model("medium")
        self.assertNotIn("medium", transcribe._MODEL_LAST_USED)

    def test_sweeper_disabled_by_non_positive_window(self) -> None:
        transcribe._MODEL_IDLE_UNLOAD_SEC = 0
        self._seed("small", last_used=0.0)

        self.assertEqual(transcribe.release_idle_models(now=1e9), [])
        self.assertIn("small", transcribe._MODEL_CACHE)

    def test_untimed_entry_is_stamped_not_released(self) -> None:
        # An entry inserted without a timestamp cannot be aged. The
        # sweep must adopt it rather than drop a model that may be in
        # active use.
        transcribe._MODEL_IDLE_UNLOAD_SEC = 600
        transcribe._MODEL_CACHE["small"] = _FakeModel()

        self.assertEqual(transcribe.release_idle_models(now=42.0), [])
        self.assertEqual(transcribe._MODEL_LAST_USED["small"], 42.0)

    def test_model_is_resident_false_when_gigaam_never_imported(self) -> None:
        # Residency for a gigaam id must never import the optional
        # engine — that would undo the lazy-import saving the whole
        # change exists to protect.
        import sys

        saved = sys.modules.pop("backend.transcribe_gigaam", None)
        try:
            self.assertFalse(transcribe.model_is_resident("gigaam-v3-rnnt"))
        finally:
            if saved is not None:
                sys.modules["backend.transcribe_gigaam"] = saved


if __name__ == "__main__":
    unittest.main()
