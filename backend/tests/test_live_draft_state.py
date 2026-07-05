import importlib
import os
import sys
import tempfile
import unittest


def _reload_backend_main(data_dir: str):
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for module_name in ("backend.main", "backend.config", "backend.storage"):
        sys.modules.pop(module_name, None)
    return importlib.import_module("backend.main")


class LiveDraftStateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self.main = _reload_backend_main(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        for module_name in ("backend.main", "backend.config", "backend.storage"):
            sys.modules.pop(module_name, None)

    def test_live_draft_roundtrip_and_owner_scoped_clear(self):
        saved = self.main.put_live_draft_state(
            {
                "session_id": "session-1",
                "source_text": "draft text",
                "provider": "deepgram",
                "updated_at": "42",
            },
            _auth=None,
        )

        self.assertTrue(saved["ok"])
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["draft"]["session_id"], "session-1")
        self.assertEqual(saved["draft"]["source_text"], "draft text")
        self.assertEqual(saved["draft"]["updated_at"], 42)
        self.assertTrue(self.main.LIVE_DRAFT_STATE_PATH.exists())

        retained = self.main.delete_live_draft_state("different-session", _auth=None)

        self.assertEqual(retained["draft"]["session_id"], "session-1")

        cleared = self.main.delete_live_draft_state("session-1", _auth=None)

        self.assertIsNone(cleared["draft"])
        self.assertIsNone(self.main.get_live_draft_state(_auth=None)["draft"])

    def test_live_draft_rejects_non_object_payload(self):
        with self.assertRaises(self.main.HTTPException) as raised:
            self.main.put_live_draft_state([], _auth=None)  # type: ignore[arg-type]

        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
