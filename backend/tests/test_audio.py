import tempfile
import unittest
from unittest import mock

from backend.audio import (
    AudioError,
    _compact_audio_chunks_for_remote_cmd,
    _compact_audio_for_remote_cmd,
    compact_audio_chunks_for_remote,
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


if __name__ == "__main__":
    unittest.main()
