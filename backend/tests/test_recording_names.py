import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class RecordingNameTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.main = _fresh_main_module(self._tmp.name)

    def tearDown(self):
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        self._tmp.cleanup()

    def test_upload_source_filename_is_unicode_safe_display_ssot(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()

        source_name = self.main._normalize_filename(r"C:\input\2 Эфир - Часть 2.mp4")
        self.assertEqual(source_name, "2 Эфир - Часть 2.mp4")

        stem = self.main._unique_recording_stem_for_source_file(
            target,
            source_name,
            "fallback title",
        )
        self.assertEqual(stem, "2 Эфир - Часть 2")

        out = target / f"{stem}.txt"
        self.main._write_recording_text_file(
            out=out,
            title="2 Эфир - Часть 2",
            source_file=source_name,
            source_text="исходный текст",
            transcript_text="готовая транскрипция",
            provider="deepgram",
            model="nova-3",
            language="ru",
        )

        payload = self.main._build_recordings_list_payload(target)
        self.assertEqual(len(payload["items"]), 1)
        item = payload["items"][0]
        self.assertEqual(item["name"], "2 Эфир - Часть 2.txt")
        self.assertEqual(item["display_name"], source_name)
        self.assertEqual(item["source_file"], source_name)

    def test_upload_source_filename_collision_appends_metadata_after_original_name(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        (target / "demo.txt").write_text("existing", encoding="utf-8")

        stem = self.main._unique_recording_stem_for_source_file(
            target,
            "demo.mp4",
            "fallback title",
        )

        self.assertRegex(stem, r"^demo__\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{6}$")

    def test_generic_live_capture_filename_keeps_title_based_recording_stem(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()

        stem = self.main._unique_recording_stem_for_source_file(
            target,
            "live-1780752285796.webm",
            "spoken title",
        )

        self.assertRegex(stem, r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{6}__spoken title$")


if __name__ == "__main__":
    unittest.main()
