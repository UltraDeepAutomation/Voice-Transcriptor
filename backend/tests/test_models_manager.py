"""Settings→Models backend: presence detection, downloads, gating."""

from __future__ import annotations

import time
import unittest
from unittest import mock

from backend import models_manager
from backend.model_catalog import GIGAAM_MODELS, WHISPER_LOCAL_MODELS


class ModelsManagerTests(unittest.TestCase):
    def tearDown(self):
        with models_manager._lock:
            models_manager._state.clear()

    def test_whisper_presence_via_hf_cache(self):
        with mock.patch(
            "huggingface_hub.try_to_load_from_cache", return_value="/cache/model.bin"
        ):
            self.assertTrue(models_manager.whisper_downloaded("small"))
        with mock.patch(
            "huggingface_hub.try_to_load_from_cache",
            side_effect=Exception("no cache dir"),
        ):
            self.assertFalse(models_manager.whisper_downloaded("small"))

    def test_list_rows_shape_and_gigaam_engine_note(self):
        with (
            mock.patch("huggingface_hub.try_to_load_from_cache", return_value=None),
            mock.patch("backend.model_catalog.gigaam_available", return_value=False),
        ):
            rows = models_manager.list_local_models()
        by_id = {r["id"]: r for r in rows}
        self.assertIn("small", by_id)
        self.assertFalse(by_id["small"]["downloaded"])
        # Read the id from the catalog: hardcoding one pinned this test
        # to a variant the catalog later stopped offering.
        gigaam_id = GIGAAM_MODELS[0]
        self.assertEqual(by_id[gigaam_id]["engine"], "gigaam")
        self.assertIn("engine not installed", by_id[gigaam_id]["note"])

    def test_start_download_unknown_id_raises(self):
        with self.assertRaises(KeyError):
            models_manager.start_download("nonexistent-model")

    def test_start_download_gigaam_without_engine_is_409_style(self):
        with mock.patch("backend.model_catalog.gigaam_available", return_value=False):
            with self.assertRaises(RuntimeError):
                models_manager.start_download(GIGAAM_MODELS[0])

    def test_start_download_runs_worker_to_done(self):
        # One model id for the whole test, taken from the catalog: the
        # three hardcoded copies of "tiny" disagreed with each other the
        # moment the catalog stopped offering it.
        model_id = WHISPER_LOCAL_MODELS[0]
        files = ["model.bin", "config.json"]
        dl_calls: list[str] = []

        def fake_list_repo_files(repo):
            assert repo == models_manager.WHISPER_REPOS[model_id]
            return files

        def fake_hf_download(repo_id, filename):
            dl_calls.append(filename)
            return f"/cache/{filename}"

        with (
            mock.patch("huggingface_hub.try_to_load_from_cache", return_value=None),
            mock.patch("huggingface_hub.list_repo_files", side_effect=fake_list_repo_files),
            mock.patch("huggingface_hub.hf_hub_download", side_effect=fake_hf_download),
        ):
            state = models_manager.start_download(model_id)
            # Mocked downloads can outrun the return; both are valid.
            self.assertIn(state["status"], ("downloading", "done"))
            deadline = time.time() + 5
            while time.time() < deadline:
                if models_manager._get_state(model_id)["status"] == "done":
                    break
                time.sleep(0.02)
            final = models_manager._get_state(model_id)
        self.assertEqual(final["status"], "done")
        self.assertEqual(final["progress"], 100.0)
        self.assertEqual(sorted(dl_calls), sorted(files))

    def test_already_downloaded_short_circuits_without_thread(self):
        with mock.patch(
            "backend.models_manager.whisper_downloaded", return_value=True
        ) as probe:
            state = models_manager.start_download("medium")
            self.assertEqual(state["status"], "done")
            probe.assert_called_once_with("medium")


if __name__ == "__main__":
    unittest.main()
