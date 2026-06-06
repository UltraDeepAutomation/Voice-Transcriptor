"""Audio conversion utilities: WAV normalization, channel splitting, and format detection.

Uses ffmpeg for format conversion when available, with a fallback to soundfile
for WAV files that are already in the expected format (16kHz PCM_16 mono).
"""

import logging
import glob
import os
import shutil
import subprocess
import threading
import time
import uuid
from typing import Optional, Tuple

import numpy as np
import soundfile as sf

# 1.1.25: SSOT for the canonical live-streaming sample rate.
# Replaces in-file literals at the validation, write_wav default,
# split_channels resample, and conversion paths so the Deepgram
# announces / Whisper input contract / WAV writer rate stay in
# lock-step from a single source.
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ

logger = logging.getLogger(__name__)


# Hard cap on ffmpeg stderr retained in memory. ffmpeg is normally
# quiet under ``-loglevel error``, but on a corrupt input ("malformed
# sample rate in moov", "Invalid data found when processing input")
# it can emit a multi-MB stderr that we DON'T need beyond the first
# few hundred bytes for diagnostics. Without this cap, a crash-loop
# upload could OOM the backend.
_FFMPEG_STDERR_CAP_BYTES = 64 * 1024
_REMOTE_COMPACT_TIMEOUT_SEC = 1800


class AudioError(RuntimeError):
    pass


def _bounded_stderr_reader(pipe, cap: int) -> list[str]:
    """Read lines off *pipe* until EOF, keeping at most *cap* bytes.

    Continues consuming past the cap so the writer (ffmpeg) is not
    blocked on a full OS pipe buffer — dropping beyond-cap bytes
    silently. Returned list preserves original ordering of the
    retained prefix.

    Runs on a helper thread because the main thread needs to
    ``proc.wait(timeout=...)`` concurrently; calling ``proc.stderr.read()``
    directly would dead-lock a chatty ffmpeg against the OS pipe
    buffer limit (~64 KB on Linux, ~4 KB on some Windows versions).
    """
    collected: list[str] = []
    size = 0
    try:
        for line in pipe:
            if size < cap:
                if size + len(line) > cap:
                    remaining = cap - size
                    collected.append(line[:remaining])
                    size = cap
                else:
                    collected.append(line)
                    size += len(line)
            # Past the cap: keep reading so ffmpeg isn't blocked on
            # a full pipe, but drop the content.
    except ValueError:
        # Pipe closed mid-read (proc killed); benign.
        pass
    return collected


def _has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _run_ffmpeg(
    cmd: list[str],
    timeout_sec: int,
    cancel_event: Optional[threading.Event] = None,
) -> None:
    """Run ffmpeg with bounded stderr + hard timeout.

    Shared between every ffmpeg invocation in this module so the
    bounded-memory stderr handling, kill-on-timeout, and AudioError
    surface stay uniform.

    Raises AudioError on non-zero return or timeout.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    collected: list[str] = []
    reader = threading.Thread(
        target=lambda: collected.extend(
            _bounded_stderr_reader(proc.stderr, _FFMPEG_STDERR_CAP_BYTES)
        ),
        name="ffmpeg-stderr-reader",
        daemon=True,
    )
    reader.start()
    try:
        try:
            deadline = time.monotonic() + timeout_sec
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    raise AudioError("ffmpeg conversion cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(cmd, timeout_sec)
                try:
                    proc.wait(timeout=min(0.25, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise AudioError(f"ffmpeg conversion timed out after {timeout_sec}s")
        reader.join(timeout=5)
    finally:
        try:
            if proc.stderr is not None and not proc.stderr.closed:
                proc.stderr.close()
        except Exception:
            pass
    if proc.returncode != 0:
        msg = "".join(collected).strip() or f"ffmpeg exited with code {proc.returncode}"
        logger.warning("ffmpeg failed (rc=%d): %s", proc.returncode, msg)
        raise AudioError(f"ffmpeg failed to convert audio: {msg[:4000]}")


def _compact_audio_for_remote_cmd(path_in: str, path_out: str) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", path_in,
        # Remote uploads may be full video files. Select exactly one audio
        # stream and disable every non-audio stream so ffmpeg never spends
        # minutes transcoding video into the WebM output.
        "-map", "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata", "-1",
        # Resample to LIVE_SAMPLE_RATE_HZ mono — Whisper / Deepgram both
        # target this rate; anything higher is wasted bandwidth.
        "-ar", str(LIVE_SAMPLE_RATE_HZ),
        "-ac", "1",
        # Opus encoder. ``-b:a 24k`` is the sweet spot for speech: still
        # intelligible at 24 kbit/s, indistinguishable from 64 kbit/s
        # WAV PCM at the Whisper / Deepgram model's input granularity.
        "-c:a", "libopus",
        "-b:a", "24k",
        # ``-application voip`` tunes the Opus encoder for speech
        # rather than music — better intelligibility at low bitrates.
        "-application", "voip",
        # Force WebM container output regardless of ``path_out`` ext.
        "-f", "webm",
        path_out,
    ]


def _compact_audio_chunks_for_remote_cmd(
    path_in: str,
    segment_pattern: str,
    chunk_sec: int,
) -> list[str]:
    sec = max(1, int(chunk_sec or 1))
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", path_in,
        "-map", "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata", "-1",
        "-ar", str(LIVE_SAMPLE_RATE_HZ),
        "-ac", "1",
        "-c:a", "libopus",
        "-b:a", "24k",
        "-application", "voip",
        "-f", "segment",
        "-segment_time", str(sec),
        "-reset_timestamps", "1",
        "-segment_format", "webm",
        segment_pattern,
    ]


def compact_audio_for_remote(
    path_in: str,
    path_out: str,
    cancel_event: Optional[threading.Event] = None,
) -> str:
    """Compress arbitrary audio/video to a Deepgram-friendly compact form.

    Output: 16 kHz mono Opus in WebM container at ~24 kbit/s. This
    cuts a typical 128 kbit/s stereo m4a / mp3 down by 5-10× — for
    a 26.6 MB / ~28 min file, the encoded WebM is ~5 MB. Smaller
    upload = far less likely to trip a write-timeout on slow or
    cross-region links (RU → us-east Deepgram is the documented
    failure mode), and Deepgram natively understands webm/opus so
    container-sniffing edge cases for m4a / mp4 / mkv go away too.

    Why ALWAYS convert (vs. "convert only when >5 MB"):
      * Tiny files (<2 MB): ffmpeg overhead is ~1-3 s; upload savings
        are smaller but the codec normalization still buys reliability
        on Deepgram's container parser.
      * Container quirks (mp4 with multiple audio tracks, m4a with
        unusual moov-atom placement): provider-side decode failures
        are far rarer with a clean Opus/WebM stream.
      * Cost / latency / failure profile is BOUNDED — the worst case
        is a tiny CPU spike, no risk of bandwidth blow-up.

    Output extension is enforced as ``.webm``; callers should pass
    a path ending in ``.webm`` so MIME sniffing on the receiving
    side aligns. ``ensure_wav_16k`` is unchanged — local Whisper
    still receives PCM WAV (Whisper expects raw waveform input,
    not a compressed container).

    Raises AudioError if ffmpeg isn't installed or the conversion fails.
    """
    if not _has_ffmpeg():
        raise AudioError(
            "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg` "
            "or `winget install Gyan.FFmpeg`) — required for remote-provider "
            "audio compression."
        )
    cmd = _compact_audio_for_remote_cmd(path_in, path_out)
    # 1.1.25: clean up partial output on ffmpeg failure. ffmpeg's
    # ``-y`` flag truncates the output up front, so a non-zero exit
    # leaves a 0-byte (or partially-written) file at ``path_out``.
    # A subsequent transcribe call that doesn't size-check would
    # then read the fragment and produce garbage. Belt-and-braces
    # cleanup keeps the contract "either path_out is a complete
    # encoded file or it doesn't exist".
    try:
        _run_ffmpeg(
            cmd,
            timeout_sec=_REMOTE_COMPACT_TIMEOUT_SEC,
            cancel_event=cancel_event,
        )
    except AudioError:
        try:
            os.unlink(path_out)
        except OSError:
            pass
        raise
    return path_out


def compact_audio_chunks_for_remote(
    path_in: str,
    output_dir: str,
    *,
    chunk_sec: int,
    cancel_event: Optional[threading.Event] = None,
) -> list[str]:
    """Compress arbitrary audio/video into bounded remote-upload chunks.

    Each output chunk is a standalone 16 kHz mono Opus/WebM file. The
    remote transcription layer sends those chunks sequentially and
    merges text afterward, so long videos never depend on one large
    socket write succeeding. This is the long-form counterpart to
    :func:`compact_audio_for_remote` and intentionally uses the same
    codec/rate/container settings.
    """
    if not _has_ffmpeg():
        raise AudioError(
            "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg` "
            "or `winget install Gyan.FFmpeg`) — required for remote-provider "
            "audio compression."
        )
    os.makedirs(output_dir, exist_ok=True)
    pattern = os.path.join(output_dir, "chunk_%05d.webm")
    cmd = _compact_audio_chunks_for_remote_cmd(path_in, pattern, chunk_sec)
    try:
        _run_ffmpeg(
            cmd,
            timeout_sec=_REMOTE_COMPACT_TIMEOUT_SEC,
            cancel_event=cancel_event,
        )
    except AudioError:
        for p in glob.glob(os.path.join(output_dir, "chunk_*.webm")):
            try:
                os.unlink(p)
            except OSError:
                pass
        raise

    chunks = sorted(glob.glob(os.path.join(output_dir, "chunk_*.webm")))
    chunks = [p for p in chunks if os.path.getsize(p) > 0]
    if not chunks:
        raise AudioError("ffmpeg produced no audio chunks")
    return chunks


def ensure_wav_16k(path_in: str, path_out: str, channels: int = 1) -> str:
    """Ensure 16k WAV PCM output using ffmpeg when needed.

    Fast-path: if input is already a WAV at 16kHz with the right channel count,
    skip ffmpeg entirely (saves ~200-500ms subprocess overhead).
    """
    ext = os.path.splitext(path_in)[1].lower()

    # Fast-path: check if WAV is already in the right format.
    if ext == ".wav":
        try:
            info = sf.info(path_in)
            if info.samplerate == LIVE_SAMPLE_RATE_HZ and info.channels == channels and info.subtype == "PCM_16":
                # Already perfect — copy atomically via tmp+rename so a
                # disk-full mid-copy leaves the destination untouched
                # (the fallback path below already does this; symmetry
                # prevents truncated-WAV transcribe silently succeeding
                # with garbage audio).
                if os.path.abspath(path_in) != os.path.abspath(path_out):
                    # Match the .tmp-<hex> convention used by every other
                    # atomic writer in the project so _sweep_orphan_tmp_files
                    # can clean it up after a crash. The uuid4-hex is
                    # already globally unique; a pid prefix would break
                    # the `_TMP_ORPHAN_RE = \.tmp-[0-9a-f]{6,}...` pattern
                    # in backend/main.py.
                    tmp_out = f"{path_out}.tmp-{uuid.uuid4().hex}"
                    try:
                        shutil.copyfile(path_in, tmp_out)
                        os.replace(tmp_out, path_out)
                    except Exception:
                        try:
                            os.unlink(tmp_out)
                        except OSError:
                            pass
                        raise
                return path_out
        except Exception:
            pass  # Fall through to ffmpeg conversion

    if _has_ffmpeg():
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path_in,
            "-ar",
            str(LIVE_SAMPLE_RATE_HZ),
            "-ac",
            str(int(channels)),
            "-c:a",
            "pcm_s16le",
            path_out,
        ]
        # Bounded-memory ffmpeg call: stderr routed through a helper
        # thread that caps the retained prefix at _FFMPEG_STDERR_CAP_BYTES
        # while continuing to drain the OS pipe so ffmpeg is never blocked
        # on a full pipe buffer. The previous `subprocess.run(...
        # capture_output=True)` implementation buffered unbounded stderr
        # into a Python string; a crash-loop ffmpeg (malformed container,
        # missing codec) could fill gigabytes of RAM before the 5-minute
        # timeout fired.
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        collected: list[str] = []
        reader = threading.Thread(
            target=lambda: collected.extend(
                _bounded_stderr_reader(proc.stderr, _FFMPEG_STDERR_CAP_BYTES)
            ),
            name="ffmpeg-stderr-reader",
            daemon=True,
        )
        reader.start()
        try:
            try:
                proc.wait(timeout=300)
            except subprocess.TimeoutExpired:
                proc.kill()
                # Give the kill a moment to propagate before giving up;
                # the reader thread will exit when the pipe closes.
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                raise AudioError("ffmpeg conversion timed out")
            reader.join(timeout=5)
        finally:
            # Defensive close in case the reader thread already drained
            # the pipe — Popen's stderr remains open until explicitly closed.
            try:
                if proc.stderr is not None and not proc.stderr.closed:
                    proc.stderr.close()
            except Exception:
                pass
        if proc.returncode != 0:
            msg = "".join(collected).strip() or f"ffmpeg exited with code {proc.returncode}"
            # Log the full (capped) stderr locally for operator
            # debugging; surface only a compact prefix in the
            # exception that callers may echo back over HTTP.
            logger.warning("ffmpeg failed (rc=%d): %s", proc.returncode, msg)
            # 1.1.25: clean up partial output. ffmpeg's ``-y`` flag
            # truncates the output up front, so a non-zero exit
            # leaves a 0-byte (or torn) WAV at ``path_out`` that
            # downstream transcribe calls would otherwise consume
            # as if it were a real recording.
            try:
                os.unlink(path_out)
            except OSError:
                pass
            raise AudioError(f"ffmpeg failed to convert audio: {msg[:4000]}")
        return path_out

    if ext != ".wav":
        raise AudioError(
            "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg`) or upload a WAV file."
        )

    data, sr = sf.read(path_in, always_2d=True)
    if sr != LIVE_SAMPLE_RATE_HZ:
        raise AudioError(
            f"ffmpeg is not installed. Please upload a {LIVE_SAMPLE_RATE_HZ} Hz WAV "
            "(or install ffmpeg for auto-convert)."
        )
    if data.shape[1] != channels:
        raise AudioError(
            f"Audio has {data.shape[1]} channel(s), but {channels} required (install ffmpeg to convert)."
        )
    # Copy atomically: write to tmp then rename. A raw copyfile()
    # leaves the destination truncated on ENOSPC, and a subsequent
    # transcribe would silently use the fragment.
    # Tmp name MUST match the hex-only convention `\.tmp-[0-9a-f]{6,}`
    # used by `_sweep_orphan_tmp_files` in backend/main.py. The old
    # `{os.getpid()}-{uuid}` form contained decimal PID digits and
    # broke the sweep regex, so crashed writers left permanent
    # orphan tmps in DATA_DIR. uuid4.hex alone is already globally
    # unique (128-bit space); the PID prefix bought nothing.
    tmp_out = f"{path_out}.tmp-{uuid.uuid4().hex}"
    try:
        shutil.copyfile(path_in, tmp_out)
        os.replace(tmp_out, path_out)
    except Exception:
        try:
            os.unlink(tmp_out)
        except OSError:
            pass
        raise
    return path_out


def load_wav(path_wav: str) -> Tuple[np.ndarray, int]:
    data, sr = sf.read(path_wav, always_2d=True, dtype="float32")
    return data, int(sr)


def write_wav(path_wav: str, data: np.ndarray, sr: int = LIVE_SAMPLE_RATE_HZ) -> None:
    sf.write(path_wav, data, sr, subtype="PCM_16")


def split_channels(path_wav_16k: str) -> Tuple[Optional[str], Optional[str]]:
    """Split a 16k WAV into per-channel mono wav files.

    Returns (ch1_path, ch2_path). If mono, returns (mono_path, None) with mono_path=None (caller can use original).
    """
    data, sr = load_wav(path_wav_16k)
    if sr != LIVE_SAMPLE_RATE_HZ:
        raise AudioError(f"Expected {LIVE_SAMPLE_RATE_HZ} Hz WAV input")
    ch = data.shape[1]
    if ch == 1:
        return None, None
    if ch < 2:
        return None, None

    base, _ = os.path.splitext(path_wav_16k)
    ch1 = base + ".ch1.wav"
    ch2 = base + ".ch2.wav"
    write_wav(ch1, data[:, 0:1], LIVE_SAMPLE_RATE_HZ)
    write_wav(ch2, data[:, 1:2], LIVE_SAMPLE_RATE_HZ)
    return ch1, ch2
