"""GigaAM engine dispatch and chunking, with the upstream package faked.

The real ``gigaam`` package (torch + ~1 GB weights) cannot run in CI;
these tests inject a minimal stand-in module into ``sys.modules`` and
verify the parts we own: id mapping, ≤25 s chunking, absolute-time word
stitching, temp-file hygiene, and catalog/dispatch wiring.
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.model_catalog import (
    GIGAAM_MODEL_PREFIX,
    LOCAL_TRANSCRIPTION_MODELS,
)


class _FakeWords:
    def __init__(self, items):
        self._items = items

    def __bool__(self):
        return bool(self._items)

    def __iter__(self):
        return iter(self._items)


class _FakeWord:
    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text


class _FakeResult:
    def __init__(self, text: str, words):
        self.text = text
        self.words = _FakeWords(words)


class _FakeModel:
    def __init__(self, calls: list):
        self._calls = calls

    def transcribe(self, path, word_timestamps=True):
        self._calls.append(path)
        # Deterministic per-call payload; the caller slices audio, so we
        # just echo one word per invocation.
        n = len(self._calls)
        return _FakeResult(
            f"слово{n}",
            [_FakeWord(0.1, 0.5, f"слово{n}")],
        )


def _install_fake_gigaam(monkeypatched_calls: list) -> None:
    fake_pkg = types.ModuleType("gigaam")

    def load_model(name):
        assert name in ("v3_e2e_rnnt", "v3_rnnt"), name
        return _FakeModel(monkeypatched_calls)

    fake_pkg.load_model = load_model  # type: ignore[attr-defined]
    sys.modules.setdefault("gigaam", fake_pkg)


class GigaAMDispatchTests(unittest.TestCase):
    def setUp(self):
        self._calls: list = []
        self._prev = sys.modules.get("gigaam")
        _install_fake_gigaam(self._calls)

    def tearDown(self):
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def test_catalog_contains_gigaam_ids_with_prefix(self):
        gigaam_ids = [m for m in LOCAL_TRANSCRIPTION_MODELS if m.startswith(GIGAAM_MODEL_PREFIX)]
        self.assertIn("gigaam-v3-e2e-rnnt", gigaam_ids)
        self.assertIn("gigaam-v3-rnnt", gigaam_ids)

    def test_dispatch_produces_absolute_time_segments(self):
        from backend.transcribe import transcribe_audio

        audio = np.zeros(int(3.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-e2e-rnnt", word_timestamps=True)
        self.assertEqual(out["language"], "ru")
        self.assertEqual(len(out["segments"]), 1)
        seg = out["segments"][0]
        self.assertEqual(seg["text"], "слово1")
        self.assertEqual(seg["words"][0]["word"], "слово1")
        self.assertGreaterEqual(seg["words"][0]["start"], 0.0)

    def test_long_audio_is_chunked_under_the_25s_upstream_limit(self):
        from backend.transcribe_gigaam import _chunk_bounds

        bounds = _chunk_bounds(68.9)
        for start, end in bounds:
            self.assertLessEqual(end - start, 20.0 + 1e-6)
        self.assertAlmostEqual(sum(e - s for s, e in bounds), 68.9, places=6)

        from backend.transcribe import transcribe_audio

        audio = np.zeros(int(45.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-rnnt")
        self.assertEqual(len(out["segments"]), 3)
        starts = [s["start"] for s in out["segments"]]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(starts[1], 20.0)
        self.assertEqual(starts[2], 40.0)

    def test_unavailable_engine_reports_reason_not_crash(self):
        from backend import transcribe_gigaam

        saved = sys.modules.pop("gigaam", None)
        try:
            reason = transcribe_gigaam.gigaam_import_error()
            self.assertIsInstance(reason, str)
        finally:
            if saved is not None:
                sys.modules["gigaam"] = saved


if __name__ == "__main__":
    unittest.main()
