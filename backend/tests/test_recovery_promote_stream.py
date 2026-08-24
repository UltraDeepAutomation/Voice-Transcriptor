"""Regression tests for the streaming PCM16→WAV recovery converter.

BUG-01: the recovery-promote path read the whole spool into RAM
(float32 ≈ 3x file size) and its 500 MB ceiling never scaled with the
4 GB spool ceiling, so crash-recovery of long dictations answered 413.
Promotion now streams through ``write_wav_from_pcm16_stream`` at
constant memory with a ceiling DERIVED from the spool ceiling.
"""

import os
import tempfile
import unittest

import numpy as np
import soundfile as sf

from backend import main as backend_main
from backend.audio import write_wav_from_pcm16_stream


class Pcm16StreamConverterTests(unittest.TestCase):
    def _tmp(self, td: str, name: str) -> str:
        return os.path.join(td, name)

    def test_roundtrip_is_sample_exact(self):
        rng = np.random.default_rng(7)
        src = rng.integers(-32768, 32767, size=16000 * 3, dtype=np.int16)
        with tempfile.TemporaryDirectory() as td:
            pcm = self._tmp(td, "spool.pcm")
            wav = self._tmp(td, "out.wav")
            src.tofile(pcm)
            frames = write_wav_from_pcm16_stream(pcm, wav, 16000)
            data, sr = sf.read(wav, dtype="int16")
        self.assertEqual(sr, 16000)
        self.assertEqual(frames, src.size)
        np.testing.assert_array_equal(data, src)

    def test_multi_chunk_file_spans_chunk_boundary(self):
        # >2 MiB of int16 forces several 1 MiB chunk iterations.
        src = np.arange(3_000_000, dtype=np.int32).astype(np.int16)
        with tempfile.TemporaryDirectory() as td:
            pcm = self._tmp(td, "big.pcm")
            wav = self._tmp(td, "big.wav")
            src.tofile(pcm)
            frames = write_wav_from_pcm16_stream(pcm, wav, 16000)
            data, _sr = sf.read(wav, dtype="int16")
        self.assertEqual(frames, src.size)
        np.testing.assert_array_equal(data, src)

    def test_trailing_odd_byte_is_dropped_not_fatal(self):
        src = np.array([100, -200, 300], dtype=np.int16)
        with tempfile.TemporaryDirectory() as td:
            pcm = self._tmp(td, "odd.pcm")
            wav = self._tmp(td, "odd.wav")
            with open(pcm, "wb") as f:
                f.write(src.tobytes())
                f.write(b"\x7f")  # stray trailing byte
            frames = write_wav_from_pcm16_stream(pcm, wav, 16000)
            data, _sr = sf.read(wav, dtype="int16")
        self.assertEqual(frames, 3)
        np.testing.assert_array_equal(data, src)

    def test_empty_spool_produces_empty_valid_wav(self):
        with tempfile.TemporaryDirectory() as td:
            pcm = self._tmp(td, "empty.pcm")
            wav = self._tmp(td, "empty.wav")
            open(pcm, "wb").close()
            frames = write_wav_from_pcm16_stream(pcm, wav, 16000)
            info = sf.info(wav)
        self.assertEqual(frames, 0)
        self.assertEqual(info.frames, 0)
        self.assertEqual(info.samplerate, 16000)

    def test_promote_ceiling_is_derived_from_spool_ceiling(self):
        """The two ceilings must never drift apart again (BUG-01 root)."""
        self.assertEqual(
            backend_main.MAX_RECOVERY_PROMOTE_BYTES,
            backend_main.MAX_LIVE_RECOVERY_BYTES,
        )


class RecoverySessionIdFromStemTests(unittest.TestCase):
    """BUG-52: session ids may contain underscores.

    ``LIVE_SESSION_ID_RE`` allows ``_`` inside an id, so the meta-less
    fallback must recover the LONGEST valid suffix of
    ``<prefix>_<session_id>``, not blindly take the last segment.
    """

    def test_underscore_inside_id_is_kept(self):
        self.assertEqual(
            backend_main._session_id_from_recovery_stem("20260824T1200_session_a_b"),
            "session_a_b",
        )

    def test_plain_id_still_resolves(self):
        self.assertEqual(
            backend_main._session_id_from_recovery_stem("prefix_abc123"),
            "abc123",
        )

    def test_invalid_tail_falls_back_to_last_segment(self):
        # No suffix matches the id grammar (e.g. contains "/") — the
        # last segment is returned and downstream validation decides.
        self.assertEqual(
            backend_main._session_id_from_recovery_stem("a_b/c"),
            "b/c",
        )


if __name__ == "__main__":
    unittest.main()
