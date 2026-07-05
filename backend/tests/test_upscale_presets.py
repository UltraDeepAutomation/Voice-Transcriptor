import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from unittest import mock


def _reload_backend_main(data_dir: str):
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for module_name in ("backend.main", "backend.config", "backend.storage"):
        sys.modules.pop(module_name, None)
    return importlib.import_module("backend.main")


class UpscalePresetContractTests(unittest.TestCase):
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

    def test_presets_endpoint_exposes_backend_default_preset(self):
        response = self.main.list_upscale_presets(_auth=None)

        self.assertEqual(response["default_preset_id"], self.main.DEFAULT_UPSCALE_PRESET_ID)
        self.assertIn(
            self.main.DEFAULT_UPSCALE_PRESET_ID,
            {item["id"] for item in response["items"]},
        )

    def test_empty_upscale_preset_uses_backend_default(self):
        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {},
        })

        with mock.patch.object(
            self.main,
            "openrouter_upscale_text",
            return_value={"text": "Improved transcript"},
        ) as upscale:
            response = asyncio.run(self.main.upscale_text({"text": "raw transcript"}, _auth=None))

        self.assertTrue(response["ok"])
        self.assertEqual(response["preset_id"], self.main.DEFAULT_UPSCALE_PRESET_ID)
        self.assertEqual(response["text"], "Improved transcript")
        self.assertIn("Improve transcript readability", upscale.call_args.kwargs["instruction"])

    def test_upscale_trims_oversized_input_in_backend(self):
        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {},
        })
        oversized = "a" * (self.main.MAX_UPSCALE_INPUT_CHARS + 11)

        with mock.patch.object(
            self.main,
            "openrouter_upscale_text",
            return_value={"text": "Trimmed transcript"},
        ) as upscale:
            response = asyncio.run(self.main.upscale_text({"text": oversized}, _auth=None))

        self.assertEqual(response["trimmed_chars"], 11)
        self.assertEqual(len(upscale.call_args.kwargs["text"]), self.main.MAX_UPSCALE_INPUT_CHARS)
        self.assertEqual(upscale.call_args.kwargs["text"], oversized[11:])


if __name__ == "__main__":
    unittest.main()
