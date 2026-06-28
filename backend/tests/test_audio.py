import tempfile
import unittest
import io
import numpy as np
import soundfile as sf
from pathlib import Path
from unittest import mock

from backend.audio import (
    AudioError,
    _compact_audio_chunks_for_remote_cmd,
    _compact_audio_for_remote_cmd,
    _ffmpeg_stderr_has_decode_error,
    _run_ffmpeg,
    compact_audio_chunks_for_remote,
    ensure_wav_16k,
    ensure_wav_16k_preserve_channels,
)
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ


class AudioCommandTests(unittest.TestCase):
    def test_remote_compaction_extracts_audio_only_from_video_inputs(self):
        cmd = _compact_audio_for_remote_cmd("/tmp/input.mp4", "/tmp/output.webm")

        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-nostdin", cmd)
        self.assertEqual(cmd[cmd.index("-i") + 1], "/tmp/input.mp4")
        self.assertEqual(cmd[cmd.index("-map") + 1], "0:a:0")
        self.assertIn("-vn", cmd)
        self.assertIn("-sn", cmd)
        self.assertIn("-dn", cmd)
        self.assertEqual(cmd[cmd.index("-map_metadata") + 1], "-1")
        self.assertEqual(cmd[cmd.index("-ar") + 1], str(LIVE_SAMPLE_RATE_HZ))
        self.assertEqual(cmd[cmd.index("-ac") + 1], "1")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "libopus")
        self.assertEqual(cmd[cmd.index("-f") + 1], "webm")
        self.assertEqual(cmd[-1], "/tmp/output.webm")

    def test_remote_compaction_command_has_no_video_encoder(self):
        cmd = _compact_audio_for_remote_cmd("/tmp/input.mov", "/tmp/output.webm")

        self.assertNotIn("-c:v", cmd)
        self.assertNotIn("-vcodec", cmd)

    def test_remote_chunk_compaction_segments_audio_only(self):
        cmd = _compact_audio_chunks_for_remote_cmd(
            "/tmp/input.mp4",
            "/tmp/chunk_%05d.webm",
            900,
        )

        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-nostdin", cmd)
        self.assertEqual(cmd[cmd.index("-i") + 1], "/tmp/input.mp4")
        self.assertEqual(cmd[cmd.index("-map") + 1], "0:a:0")
        self.assertIn("-vn", cmd)
        self.assertIn("-sn", cmd)
        self.assertIn("-dn", cmd)
        self.assertEqual(cmd[cmd.index("-ar") + 1], str(LIVE_SAMPLE_RATE_HZ))
        self.assertEqual(cmd[cmd.index("-ac") + 1], "1")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "libopus")
        self.assertEqual(cmd[cmd.index("-f") + 1], "segment")
        self.assertEqual(cmd[cmd.index("-segment_time") + 1], "900")
        self.assertEqual(cmd[cmd.index("-segment_format") + 1], "webm")
        self.assertEqual(cmd[-1], "/tmp/chunk_%05d.webm")

    def test_remote_chunk_compaction_rejects_empty_ffmpeg_output(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                 mock.patch("backend.audio._run_ffmpeg", return_value=None):
                with self.assertRaisesRegex(AudioError, "no audio chunks"):
                    compact_audio_chunks_for_remote(
                        "/tmp/input.mp4",
                        td,
                        chunk_sec=900,
                    )

    def test_ffmpeg_decode_error_stderr_is_detected_even_when_rc_is_zero(self):
        stderr = (
            "[mov,mp4,m4a,3gp,3g2,mj2] stream 0, offset 0x40013a: partial file\n"
            "[aac] decode_band_types: Input buffer exhausted before END element found\n"
            "Error submitting packet to decoder: Invalid data found when processing input"
        )

        self.assertTrue(_ffmpeg_stderr_has_decode_error(stderr))

    def test_run_ffmpeg_fails_on_decode_error_stderr_even_when_rc_is_zero(self):
        proc = mock.Mock()
        proc.stderr = io.StringIO(
            "stream 0, offset 0x40013a: partial file\n"
            "Error submitting packet to decoder: Invalid data found when processing input\n"
        )
        proc.returncode = 0
        proc.wait.return_value = None

        with mock.patch("backend.audio.subprocess.Popen", return_value=proc):
            with self.assertRaisesRegex(AudioError, "decoded only part"):
                _run_ffmpeg(["ffmpeg", "-i", "broken.m4a", "out.wav"], timeout_sec=1, fail_on_decode_error=True)

    def test_remote_chunk_compaction_enables_decode_error_failure(self):
        with tempfile.TemporaryDirectory() as td:
            def fake_run_ffmpeg(_cmd, **kwargs):
                self.assertTrue(kwargs.get("fail_on_decode_error"))
                Path(td, "chunk_00000.webm").write_bytes(b"ok")

            with mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                 mock.patch("backend.audio._run_ffmpeg", side_effect=fake_run_ffmpeg):
                chunks = compact_audio_chunks_for_remote(
                    "/tmp/input.mp4",
                    td,
                    chunk_sec=900,
                )

        self.assertEqual(len(chunks), 1)

    def test_local_wav_conversion_enables_decode_error_failure(self):
        calls = []

        def fake_run_ffmpeg(_cmd, **kwargs):
            calls.append(kwargs)

        with tempfile.TemporaryDirectory() as td:
            mono_out = str(Path(td) / "mono.wav")
            stereo_out = str(Path(td) / "stereo.wav")
            with mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                 mock.patch("backend.audio._run_ffmpeg", side_effect=fake_run_ffmpeg):
                ensure_wav_16k("/tmp/input.m4a", mono_out, channels=1)
                ensure_wav_16k_preserve_channels("/tmp/input.m4a", stereo_out)

        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call.get("fail_on_decode_error") for call in calls))

    def test_no_ffmpeg_fallback_rejects_non_pcm16_wav_instead_of_copying(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "float.wav"
            dst = Path(td) / "out.wav"
            sf.write(
                src,
                np.zeros((LIVE_SAMPLE_RATE_HZ, 1), dtype=np.float32),
                LIVE_SAMPLE_RATE_HZ,
                subtype="FLOAT",
            )

            with mock.patch("backend.audio._has_ffmpeg", return_value=False):
                with self.assertRaisesRegex(AudioError, "PCM_16"):
                    ensure_wav_16k(str(src), str(dst), channels=1)

            self.assertFalse(dst.exists())

    def test_no_ffmpeg_preserve_channels_rejects_non_pcm16_wav(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "float-stereo.wav"
            dst = Path(td) / "out.wav"
            sf.write(
                src,
                np.zeros((LIVE_SAMPLE_RATE_HZ, 2), dtype=np.float32),
                LIVE_SAMPLE_RATE_HZ,
                subtype="FLOAT",
            )

            with mock.patch("backend.audio._has_ffmpeg", return_value=False):
                with self.assertRaisesRegex(AudioError, "PCM_16"):
                    ensure_wav_16k_preserve_channels(str(src), str(dst))

            self.assertFalse(dst.exists())


if __name__ == "__main__":
    unittest.main()
