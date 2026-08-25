"""Deleting a downloaded local model.

Settings → Local models can download multi-gigabyte weights; without a
delete path the only way to reclaim that space is to hunt through
~/.cache/huggingface by hand. These tests pin the refusal reasons and the
cache-eviction contract rather than the huggingface_hub call itself.
"""

import sys
import unittest
from unittest import mock

from backend import models_manager
from backend.models_manager import ModelDeleteError, delete_model


class DeleteModelGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        with models_manager._lock:
            models_manager._state.clear()

    def tearDown(self) -> None:
        with models_manager._lock:
            models_manager._state.clear()

    def test_unknown_model_raises_key_error(self) -> None:
        with self.assertRaises(KeyError):
            delete_model("not-a-model")

    def test_gigaam_is_refused_as_an_engine_not_a_model(self) -> None:
        # GigaAM is a Python engine installed by the desktop layer into
        # userData/engine-site. Deleting an HF cache entry for it would
        # leave the engine installed while the UI claimed it was gone.
        with self.assertRaises(ModelDeleteError) as ctx:
            delete_model("gigaam-v3-rnnt")
        self.assertIn("engine", str(ctx.exception).lower())

    def test_in_flight_download_is_refused(self) -> None:
        # Deleting the cache under a running hf_hub_download leaves a
        # half-written repo that presence detection reports as absent
        # while the worker keeps writing into it.
        models_manager._set_state("small", status="downloading", progress=40.0)
        with self.assertRaises(ModelDeleteError) as ctx:
            delete_model("small")
        self.assertIn("downloading", str(ctx.exception).lower())

    def test_absent_model_reports_success_without_deleting(self) -> None:
        # The user's intent ("this should not be stored") already holds;
        # an error here would be unactionable.
        fake_cache = mock.Mock()
        fake_cache.repos = []
        with mock.patch.dict(
            sys.modules,
            {"huggingface_hub": mock.Mock(scan_cache_dir=lambda: fake_cache)},
        ):
            result = delete_model("small")
        self.assertEqual(result, {"deleted": False, "freed_bytes": 0})

    def test_delete_executes_the_revision_strategy_and_reports_bytes(self) -> None:
        revision = mock.Mock(commit_hash="abc123")
        cached_repo = mock.Mock(repo_id="Systran/faster-whisper-small")
        cached_repo.revisions = [revision]
        strategy = mock.Mock(expected_freed_size=484_000_000)
        fake_cache = mock.Mock(repos=[cached_repo])
        fake_cache.delete_revisions.return_value = strategy

        with mock.patch.dict(
            sys.modules,
            {"huggingface_hub": mock.Mock(scan_cache_dir=lambda: fake_cache)},
        ):
            result = delete_model("small")

        fake_cache.delete_revisions.assert_called_once_with("abc123")
        strategy.execute.assert_called_once_with()
        self.assertTrue(result["deleted"])
        self.assertEqual(result["freed_bytes"], 484_000_000)

    def test_delete_resets_transient_state(self) -> None:
        models_manager._set_state("small", status="error", error="boom", progress=12.0)
        fake_cache = mock.Mock(repos=[])
        with mock.patch.dict(
            sys.modules,
            {"huggingface_hub": mock.Mock(scan_cache_dir=lambda: fake_cache)},
        ):
            delete_model("small")
        state = models_manager._get_state("small")
        self.assertEqual(state["status"], "idle")
        self.assertIsNone(state["error"])
        self.assertEqual(state["progress"], 0.0)


class EvictionContractTests(unittest.TestCase):
    def test_eviction_does_not_import_transcribe(self) -> None:
        # Importing backend.transcribe here would drag faster-whisper
        # into a process that may never transcribe locally, undoing the
        # lazy import that keeps an API-only session at ~60 MB.
        saved = sys.modules.pop("backend.transcribe", None)
        try:
            models_manager._evict_from_transcription_cache("small")
            self.assertNotIn("backend.transcribe", sys.modules)
        finally:
            if saved is not None:
                sys.modules["backend.transcribe"] = saved

    def test_eviction_releases_a_resident_model(self) -> None:
        from backend import transcribe

        transcribe._MODEL_CACHE["small"] = object()
        transcribe._MODEL_WARM_STATE["small"] = {"loaded_ms": 1.0}
        try:
            models_manager._evict_from_transcription_cache("small")
            self.assertNotIn("small", transcribe._MODEL_CACHE)
            self.assertEqual(transcribe.warm_state("small"), {})
        finally:
            transcribe._MODEL_CACHE.pop("small", None)
            transcribe._MODEL_WARM_STATE.pop("small", None)

    def test_release_model_reports_whether_it_was_resident(self) -> None:
        from backend import transcribe

        self.assertFalse(transcribe.release_model("medium"))
        transcribe._MODEL_CACHE["medium"] = object()
        try:
            self.assertTrue(transcribe.release_model("medium"))
        finally:
            transcribe._MODEL_CACHE.pop("medium", None)


if __name__ == "__main__":
    unittest.main()
