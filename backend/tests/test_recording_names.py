import importlib
import asyncio
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class RecordingNameTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(dir=str(Path.home()))
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

    def test_recording_collections_save_into_source_specific_folders(self):
        live = self.main.save_recording({
            "title": "Live note",
            "source_text": "live source",
            "transcript_text": "live transcript",
            "provider": "local",
            "model": "small",
            "language": "ru",
            "recording_collection": "live",
        })
        upload = self.main.save_recording({
            "title": "Upload note",
            "source_text": "upload source",
            "transcript_text": "upload transcript",
            "provider": "deepgram",
            "model": "nova-3",
            "language": "ru",
            "recording_collection": "uploads",
        })

        root = (Path(self._tmp.name) / "recordings").resolve()
        live_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_LIVE]
        uploads_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS]

        self.assertTrue((live_dir / live["name"]).exists())
        self.assertTrue((uploads_dir / upload["name"]).exists())
        self.assertEqual(Path(live["archive_dir"]), live_dir)
        self.assertEqual(Path(upload["archive_dir"]), uploads_dir)

        payload = self.main._build_recordings_list_payload(root)
        by_name = {item["name"]: item for item in payload["items"]}
        self.assertEqual(by_name[live["name"]]["recording_collection"], "live")
        self.assertEqual(by_name[upload["name"]]["recording_collection"], "uploads")
        self.assertEqual(Path(by_name[live["name"]]["archive_dir"]), live_dir)
        self.assertEqual(Path(by_name[upload["name"]]["archive_dir"]), uploads_dir)

        stats = self.main._build_recordings_stats_payload(root)
        self.assertEqual(stats["total_recordings"], 2)

    def test_json_boolean_parser_matches_form_semantics(self):
        self.assertFalse(self.main._payload_bool({"enabled": "false"}, "enabled", True))
        self.assertFalse(self.main._payload_bool({"enabled": "0"}, "enabled", True))
        self.assertTrue(self.main._payload_bool({"enabled": "true"}, "enabled", False))
        self.assertTrue(self.main._payload_bool({}, "enabled", True))
        with self.assertRaises(self.main.HTTPException):
            self.main._payload_bool({"enabled": "definitely"}, "enabled", False)

    def test_save_recording_accepts_case_insensitive_txt_extension(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        (target / "Existing.TXT").write_text("old", encoding="utf-8")

        result = self.main.save_recording({
            "name": "Existing.TXT",
            "archive_dir": str(target),
            "require_existing": "true",
            "title": "Existing",
            "source_text": "source",
            "transcript_text": "updated",
        })

        self.assertEqual(result["name"], "Existing.TXT")
        self.assertIn("updated", (target / "Existing.TXT").read_text(encoding="utf-8"))

    def test_get_recording_uses_archive_dir_for_duplicate_names(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        live_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_LIVE]
        uploads_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS]
        live_dir.mkdir(parents=True)
        uploads_dir.mkdir(parents=True)
        self.main._write_recording_text_file(
            out=live_dir / "same.txt",
            title="same",
            source_text="live source",
            transcript_text="live transcript",
            provider="local",
            model="small",
            language="ru",
        )
        self.main._write_recording_text_file(
            out=uploads_dir / "same.txt",
            title="same",
            source_text="upload source",
            transcript_text="upload transcript",
            provider="deepgram",
            model="nova-3",
            language="ru",
        )

        payload = asyncio.run(
            self.main.get_recording("same.txt", archive_dir=str(uploads_dir))
        )

        self.assertIn("upload transcript", payload["content"])
        self.assertEqual(Path(payload["archive_dir"]), uploads_dir)
        self.assertEqual(payload["recording_collection"], "uploads")

    def test_recordings_cache_key_changes_when_existing_file_changes(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "note.txt"
        recording.write_text("Title: note\nTranscription:\none\n", encoding="utf-8")
        os.utime(recording, (1_700_000_000, 1_700_000_000))

        first_key = self.main._recordings_scan_cache_key(root)

        recording.write_text("Title: note\nTranscription:\ntwo changed\n", encoding="utf-8")
        os.utime(recording, (1_700_000_010, 1_700_000_010))
        second_key = self.main._recordings_scan_cache_key(root)

        self.assertNotEqual(first_key, second_key)

    def test_recordings_cache_key_tracks_audio_sidecars_and_uppercase_txt(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        recording.write_text("Title: Existing\nTranscription:\none\n", encoding="utf-8")
        os.utime(recording, (1_700_000_000, 1_700_000_000))

        first_key = self.main._recordings_scan_cache_key(root)

        audio = root / "Existing.webm"
        audio.write_bytes(b"audio-v1")
        os.utime(audio, (1_700_000_010, 1_700_000_010))
        second_key = self.main._recordings_scan_cache_key(root)

        audio.write_bytes(b"audio-v2-longer")
        os.utime(audio, (1_700_000_020, 1_700_000_020))
        third_key = self.main._recordings_scan_cache_key(root)

        self.assertNotEqual(first_key, second_key)
        self.assertNotEqual(second_key, third_key)

    def test_uppercase_txt_recording_is_visible_in_history_and_stats(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        self.main._write_recording_text_file(
            out=recording,
            title="Existing",
            source_text="source words",
            transcript_text="visible transcript",
            provider="local",
            model="small",
            language="ru",
        )

        list_payload = self.main._build_recordings_list_payload(root)
        stats_payload = self.main._build_recordings_stats_payload(root)

        self.assertEqual([item["name"] for item in list_payload["items"]], ["Existing.TXT"])
        self.assertEqual(stats_payload["total_recordings"], 1)

    def test_delete_all_removes_uppercase_txt_recordings(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        audio = root / "Existing.webm"
        recording.write_text("Title: Existing\nTranscription:\none\n", encoding="utf-8")
        audio.write_bytes(b"audio")

        result = self.main._delete_all_recordings_sync()

        self.assertEqual(result["deleted"], 1)
        self.assertFalse(recording.exists())
        self.assertFalse(audio.exists())

    def test_audio_retention_matches_uppercase_txt_siblings(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        (root / "Keep.TXT").write_text("keep", encoding="utf-8")
        keep_audio = root / "Keep.webm"
        keep_audio.write_bytes(b"keep")
        (root / "Old.TXT").write_text("old", encoding="utf-8")
        old_audio = root / "Old.webm"
        old_audio.write_bytes(b"old")

        pruned = self.main._prune_old_recording_audio(root, "Keep")

        self.assertEqual(pruned, 1)
        self.assertTrue(keep_audio.exists())
        self.assertFalse(old_audio.exists())

    def test_save_with_audio_upload_collection_writes_uploaded_media_folder(self):
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny mp3 payload"),
            filename="lecture.mp3",
            size=len(b"tiny mp3 payload"),
        )

        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name="",
            archive_dir="",
            require_existing=False,
            title="Lecture",
            source_text="source",
            transcript_text="transcript",
            provider="deepgram",
            model="nova-3",
            language="ru",
            recording_collection="uploads",
            live_session_id="",
        ))

        target_dir = Path(result["archive_dir"])
        self.assertEqual(
            target_dir.name,
            self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS],
        )
        self.assertTrue((target_dir / result["name"]).exists())
        self.assertTrue((target_dir / result["audio_name"]).exists())

    def test_save_with_audio_preserves_existing_txt_extension_casing(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.TXT"
        existing.write_text("old", encoding="utf-8")
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny wav payload"),
            filename="replacement.wav",
            size=len(b"tiny wav payload"),
        )

        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name="Existing.TXT",
            archive_dir=str(target),
            require_existing=True,
            title="Existing",
            source_text="source",
            transcript_text="updated",
            provider="local",
            model="small",
            language="ru",
            recording_collection="",
            live_session_id="",
        ))

        self.assertEqual(result["name"], "Existing.TXT")
        self.assertTrue(existing.exists())
        self.assertIn("Existing.TXT", {p.name for p in target.iterdir()})
        self.assertEqual(
            sum(1 for p in target.iterdir() if p.name.lower() == "existing.txt"),
            1,
        )
        self.assertIn("updated", existing.read_text(encoding="utf-8"))

    def test_save_with_audio_restores_existing_audio_when_new_upload_fails(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.txt"
        existing.write_text("old", encoding="utf-8")
        old_audio = target / "Existing.wav"
        old_audio.write_bytes(b"old audio")

        async def failing_writer(_tmp_audio: Path) -> None:
            raise OSError("simulated write failure")

        with self.assertRaises(OSError):
            asyncio.run(self.main._save_recording_audio_source(
                orig_name="replacement.wav",
                write_tmp_audio=failing_writer,
                name="Existing.txt",
                archive_dir=str(target),
                require_existing=True,
                title="Existing",
                source_text="source",
                transcript_text="updated",
                provider="local",
                model="small",
                language="ru",
                recording_collection="",
                live_session_id="",
            ))

        self.assertEqual(old_audio.read_bytes(), b"old audio")
        self.assertEqual(existing.read_text(encoding="utf-8"), "old")

    def test_claim_recording_text_path_is_atomic_for_parallel_new_saves(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        barrier = threading.Barrier(2)
        results: list[str] = []
        errors: list[BaseException] = []

        def claim() -> None:
            try:
                barrier.wait(timeout=2)
                _stem, out = self.main._claim_recording_text_path(
                    target,
                    self.main._recording_stem_candidates_from_base("lecture", collision_suffix="timestamp"),
                )
                results.append(out.name)
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=claim) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)

        self.assertFalse(errors)
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 2)
        self.assertEqual(len(list(target.glob("*.txt"))), 2)

    def test_failed_upload_validation_does_not_leave_queued_jobs(self):
        before = set(self.main.jobs._jobs)
        bad_file = self.main.UploadFile(
            io.BytesIO(b"not audio"),
            filename="bad.exe",
            size=len(b"not audio"),
        )

        with self.assertRaises(self.main.HTTPException):
            asyncio.run(self.main.create_job(file=bad_file))

        bad_remote = self.main.UploadFile(
            io.BytesIO(b"not audio"),
            filename="bad.exe",
            size=len(b"not audio"),
        )
        with self.assertRaises(self.main.HTTPException):
            asyncio.run(self.main.create_remote_job(file=bad_remote))

        self.assertEqual(set(self.main.jobs._jobs), before)

    def test_delete_all_recordings_removes_uppercase_txt_and_audio(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        recording.write_text("old", encoding="utf-8")
        audio = root / "Existing.wav"
        audio.write_bytes(b"old audio")

        result = self.main._delete_all_recordings_sync()

        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["deleted"], 1)
        self.assertFalse(recording.exists())
        self.assertFalse(audio.exists())

    def test_save_from_path_upload_collection_copies_source_without_deleting_it(self):
        source = Path(self._tmp.name) / "lecture source.mp3"
        payload = b"tiny mp3 payload"
        source.write_bytes(payload)

        result = asyncio.run(self.main.save_recording_from_path({
            "source_path": str(source),
            "title": "Lecture",
            "source_text": "source",
            "transcript_text": "transcript",
            "provider": "deepgram",
            "model": "nova-3",
            "language": "ru",
            "recording_collection": "uploads",
        }))

        target_dir = Path(result["archive_dir"])
        self.assertTrue(source.exists())
        self.assertEqual(source.read_bytes(), payload)
        self.assertEqual(
            target_dir.name,
            self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS],
        )
        self.assertEqual((target_dir / result["audio_name"]).read_bytes(), payload)
        raw = (target_dir / result["name"]).read_text(encoding="utf-8")
        self.assertIn("Source file: lecture source.mp3", raw)

    def test_local_job_from_path_does_not_delete_source_file(self):
        source = Path(self._tmp.name) / "source.mp3"
        source.write_bytes(b"tiny mp3 payload")

        with mock.patch.object(
            self.main,
            "_run_local_transcribe_once",
            return_value={"text": "ok", "duration": 0, "segments": []},
        ) as run_once:
            created = asyncio.run(self.main.create_job_from_path({
                "source_path": str(source),
                "language": "ru",
                "model": "small",
                "split_stereo": True,
                "word_timestamps": False,
            }))
            job_id = created["job_id"]
            deadline = time.time() + 5
            job = None
            while time.time() < deadline:
                job = self.main.jobs.get(job_id)
                if job and job.status in {"done", "error", "cancelled"}:
                    break
                time.sleep(0.02)

        self.assertIsNotNone(job)
        self.assertEqual(job.status, "done")
        self.assertTrue(source.exists())
        run_once.assert_called_once()


if __name__ == "__main__":
    unittest.main()
