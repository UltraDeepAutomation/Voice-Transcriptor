"""Tests for backend.storage — SSOT atomic-write primitives.

Every persistent file the backend writes (config, upscale presets,
archive registry, API token, encryption key, recording transcripts)
routes through this module. Correctness is shipping-critical:

  * A non-atomic write can leave a half-written file at the target
    path, corrupting the user's config / API keys / transcripts.
  * A write without fsync can lose the full payload on kernel crash
    despite the rename having landed.
  * A failed write that leaks its tmp file pollutes the data dir
    (and the `_sweep_orphan_tmp_files` housekeeper relies on a
    specific tmp-name convention; a mismatched convention means
    the sweep never cleans up).

These tests exercise every invariant in isolation. Run with:

    python -m unittest backend.tests.test_storage -v

No backend.main import — storage.py stands alone, so we avoid the
parent-death watchdog that otherwise kills subprocess test runners.
"""

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.storage import (
    atomic_copy_file,
    atomic_promote_file,
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
    rotate_backup,
)


class TestAtomicWriteBytes(unittest.TestCase):
    def test_roundtrip(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "binary.bin"
            atomic_write_bytes(p, b"hello world")
            self.assertEqual(p.read_bytes(), b"hello world")

    def test_overwrite(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "file.bin"
            atomic_write_bytes(p, b"v1")
            atomic_write_bytes(p, b"v2")
            atomic_write_bytes(p, b"v3")
            self.assertEqual(p.read_bytes(), b"v3")

    def test_creates_parent_dir(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "nested" / "deep" / "file.bin"
            atomic_write_bytes(p, b"x")
            self.assertTrue(p.exists())
            self.assertEqual(p.read_bytes(), b"x")

    def test_no_stale_tmp_on_success(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "file.bin"
            atomic_write_bytes(p, b"payload")
            stale = list(Path(td).glob("*.tmp-*"))
            self.assertEqual(stale, [], f"stale tmps: {stale}")

    def test_cleanup_on_write_failure(self):
        """A RO parent dir makes the tmp write fail; the tmp must be
        cleaned up anyway so the data dir stays tidy."""
        with TemporaryDirectory() as td:
            ro = Path(td) / "ro"
            ro.mkdir()
            os.chmod(ro, 0o500)  # r-x, no write
            try:
                with self.assertRaises(OSError):
                    atomic_write_bytes(ro / "file.bin", b"will fail")
            finally:
                os.chmod(ro, 0o755)
            stale = list(ro.glob("*.tmp-*"))
            self.assertEqual(stale, [], f"tmp left on failure: {stale}")


class TestAtomicPromoteFile(unittest.TestCase):
    def test_promotes_existing_tmp_file_durably(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            tmp = root / "recording.wav.tmp-abcdef"
            target = root / "recording.wav"
            tmp.write_bytes(b"audio-payload")

            atomic_promote_file(tmp, target)

            self.assertEqual(target.read_bytes(), b"audio-payload")
            self.assertFalse(tmp.exists())
            self.assertEqual(list(root.glob("*.tmp-*")), [])

    def test_cleanup_on_missing_tmp_failure(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            tmp = root / "missing.wav.tmp-abcdef"
            target = root / "missing.wav"

            with self.assertRaises(OSError):
                atomic_promote_file(tmp, target)

            self.assertFalse(target.exists())
            self.assertFalse(tmp.exists())


class TestAtomicCopyFile(unittest.TestCase):
    def test_copies_source_to_nested_target_atomically(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            src = root / "legacy.json"
            target = root / "new" / "config.json"
            src.write_bytes(b'{"v":1}')

            atomic_copy_file(src, target)

            self.assertEqual(target.read_bytes(), b'{"v":1}')
            self.assertEqual(list(target.parent.glob("*.tmp-*")), [])

    def test_cleanup_on_missing_source_failure(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            src = root / "missing.json"
            target = root / "target.json"

            with self.assertRaises(OSError):
                atomic_copy_file(src, target)

            self.assertFalse(target.exists())
            self.assertEqual(list(root.glob("*.tmp-*")), [])


class TestAtomicWriteText(unittest.TestCase):
    def test_utf8(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "text.txt"
            atomic_write_text(p, "привет мир 日本語 🚀")
            self.assertEqual(p.read_text(encoding="utf-8"), "привет мир 日本語 🚀")

    def test_empty(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "empty.txt"
            atomic_write_text(p, "")
            self.assertEqual(p.read_text(encoding="utf-8"), "")

    def test_mode_applied_for_secret_file(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "secret.txt"
            atomic_write_text(p, "token", mode=0o600)
            self.assertEqual(p.read_text(encoding="utf-8"), "token")
            if os.name != "nt":
                self.assertEqual(p.stat().st_mode & 0o777, 0o600)


class TestAtomicWriteJson(unittest.TestCase):
    def test_dict_payload(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "data.json"
            payload = {"key": "value", "nested": {"a": [1, 2, 3]}}
            atomic_write_json(p, payload)
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), payload)

    def test_list_payload(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "list.json"
            atomic_write_json(p, ["a", "b", "c"])
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), ["a", "b", "c"])

    def test_unicode_preserved(self):
        """Must use ensure_ascii=False so Cyrillic / CJK readable in
        on-disk config without escape sequences."""
        with TemporaryDirectory() as td:
            p = Path(td) / "unicode.json"
            atomic_write_json(p, {"title": "Транскрипция"})
            raw = p.read_text(encoding="utf-8")
            self.assertIn("Транскрипция", raw)
            self.assertNotIn("\\u", raw)

    def test_indent(self):
        with TemporaryDirectory() as td:
            p = Path(td) / "indented.json"
            atomic_write_json(p, {"a": 1, "b": 2}, indent=4)
            raw = p.read_text(encoding="utf-8")
            self.assertIn('    "a"', raw)  # 4-space indent


class TestRotateBackup(unittest.TestCase):
    def test_copies_source_to_backup(self):
        with TemporaryDirectory() as td:
            src = Path(td) / "src.json"
            bak = Path(td) / "src.json.bak"
            atomic_write_json(src, {"v": 1})
            rotate_backup(src, bak)
            self.assertTrue(bak.exists())
            self.assertEqual(json.loads(bak.read_text(encoding="utf-8")), {"v": 1})

    def test_noop_on_missing_source(self):
        with TemporaryDirectory() as td:
            src = Path(td) / "nope.json"
            bak = Path(td) / "nope.json.bak"
            rotate_backup(src, bak)
            self.assertFalse(bak.exists())

    def test_overwrites_existing_backup(self):
        """Second rotation should overwrite the old backup — the
        backup reflects the most-recent pre-save state, not the
        oldest ever seen."""
        with TemporaryDirectory() as td:
            src = Path(td) / "src.json"
            bak = Path(td) / "src.json.bak"
            atomic_write_json(src, {"v": 1})
            rotate_backup(src, bak)
            atomic_write_json(src, {"v": 2})
            rotate_backup(src, bak)
            self.assertEqual(json.loads(bak.read_text(encoding="utf-8")), {"v": 2})


class TestTmpNameConvention(unittest.TestCase):
    """Every tmp name this project produces is one the sweeper deletes.

    ``_sweep_orphan_tmp_files`` in backend.main deletes what a crashed
    writer left behind, and a name it does not recognise accumulates
    forever in the user's recordings folder. This test used to restate
    the pattern as a literal — a second copy of the rule, which is
    exactly how the two drifted (B-017): the copy in main allowed ONE
    trailing extension group, while ``_atomic_temp_path`` inserts the
    marker before EVERY suffix and so produces two of them for any name
    with more than one dot.
    """

    def test_tmp_name_matches_the_sweep_pattern(self):
        from backend.storage import TMP_ORPHAN_RE, _tmp_path_for
        for target_name in ["config.json", "recording.txt", "binary.bin", "preset.json"]:
            tmp = _tmp_path_for(Path("/tmp") / target_name)
            self.assertTrue(
                TMP_ORPHAN_RE.search(tmp.name),
                f"tmp name {tmp.name!r} does not match the sweep pattern",
            )

    def test_the_in_middle_marker_is_swept_whatever_the_name(self):
        # The shape ``backend.main._atomic_temp_path`` produces. The
        # third case is what EVERY live-recovery promote writes: the
        # title carries ``datetime.now().isoformat()``, which always has
        # microseconds and therefore always a second dot — so a promote
        # interrupted mid-write left a partial WAV, up to 4 GB, among
        # the user's recordings permanently.
        from backend.storage import TMP_ORPHAN_RE
        hex32 = "a" * 32
        for name in (
            f"rec.tmp-{hex32}.wav",
            f"my.tmp-{hex32}.file.wav",
            f"2026-09-04__Recovered 2026-09-04T19_37_12.tmp-{hex32}.123456.wav",
        ):
            with self.subTest(name=name):
                self.assertTrue(TMP_ORPHAN_RE.search(name), name)

    def test_a_user_file_that_merely_mentions_tmp_is_left_alone(self):
        from backend.storage import TMP_ORPHAN_RE
        for name in (
            "notes about .tmp-files.txt",
            "backup.tmp-x.wav",
            "meeting.wav",
        ):
            with self.subTest(name=name):
                self.assertIsNone(TMP_ORPHAN_RE.search(name), name)

    def test_backend_main_reads_the_same_pattern_rather_than_a_copy(self):
        import re

        from backend.storage import TMP_ORPHAN_RE
        source = (Path(__file__).resolve().parents[1] / "main.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn(
            "_TMP_ORPHAN_RE = re.compile(",
            source,
            "main.py restated the tmp-name pattern instead of importing it",
        )
        self.assertIsInstance(TMP_ORPHAN_RE, re.Pattern)


if __name__ == "__main__":
    unittest.main()
