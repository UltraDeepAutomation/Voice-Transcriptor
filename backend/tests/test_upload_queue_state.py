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


class UploadQueueStateTests(unittest.TestCase):
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

    def test_upload_queue_state_roundtrip_is_backend_owned(self):
        saved = self.main.put_upload_queue_state(
            {
                "hideFinished": True,
                "items": [
                    {
                        "id": "item-1",
                        "displayName": "clip.wav",
                        "sizeBytes": "42",
                        "status": "transcribing",
                        "requestedDiarize": True,
                    },
                    {"displayName": ""},
                ],
            },
            _auth=None,
        )

        self.assertTrue(saved["ok"])
        self.assertEqual(saved["version"], 1)
        self.assertTrue(saved["hideFinished"])
        self.assertEqual(len(saved["items"]), 1)
        self.assertEqual(saved["items"][0]["sizeBytes"], 42)
        self.assertTrue(saved["items"][0]["requestedDiarize"])

        loaded = self.main.get_upload_queue_state(_auth=None)

        self.assertEqual(loaded["items"], saved["items"])
        self.assertTrue(self.main.UPLOAD_QUEUE_STATE_PATH.exists())

    def test_upload_queue_state_rejects_non_object_payload(self):
        with self.assertRaises(self.main.HTTPException) as raised:
            self.main.put_upload_queue_state([], _auth=None)  # type: ignore[arg-type]

        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
