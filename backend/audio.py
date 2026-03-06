import os
import shutil
import subprocess
from typing import Optional, Tuple

import numpy as np
import soundfile as sf


class AudioError(RuntimeError):
    pass


def _has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


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
            if info.samplerate == 16000 and info.channels == channels and info.subtype == "PCM_16":
                # Already perfect — just copy (or symlink) to output path.
                if os.path.abspath(path_in) != os.path.abspath(path_out):
                    shutil.copyfile(path_in, path_out)
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
            "16000",
            "-ac",
            str(int(channels)),
            "-c:a",
            "pcm_s16le",
            path_out,
        ]
        try:
            subprocess.run(cmd, check=True, timeout=300, capture_output=True, text=True)
        except subprocess.CalledProcessError as e:
            msg = (e.stderr or e.stdout or str(e)).strip()
            raise AudioError(f"ffmpeg failed to convert audio: {msg}")
        except subprocess.TimeoutExpired:
            raise AudioError("ffmpeg conversion timed out")
        return path_out

    if ext != ".wav":
        raise AudioError(
            "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg`) or upload a WAV file."
        )

    data, sr = sf.read(path_in, always_2d=True)
    if sr != 16000:
        raise AudioError(
            "ffmpeg is not installed. Please upload a 16kHz WAV (or install ffmpeg for auto-convert)."
        )
    if data.shape[1] != channels:
        raise AudioError(
            f"Audio has {data.shape[1]} channel(s), but {channels} required (install ffmpeg to convert)."
        )
    # Copy as-is
    shutil.copyfile(path_in, path_out)
    return path_out


def load_wav(path_wav: str) -> Tuple[np.ndarray, int]:
    data, sr = sf.read(path_wav, always_2d=True, dtype="float32")
    return data, int(sr)


def write_wav(path_wav: str, data: np.ndarray, sr: int = 16000) -> None:
    sf.write(path_wav, data, sr, subtype="PCM_16")


def split_channels(path_wav_16k: str) -> Tuple[Optional[str], Optional[str]]:
    """Split a 16k WAV into per-channel mono wav files.

    Returns (ch1_path, ch2_path). If mono, returns (mono_path, None) with mono_path=None (caller can use original).
    """
    data, sr = load_wav(path_wav_16k)
    if sr != 16000:
        raise AudioError("Expected 16k WAV input")
    ch = data.shape[1]
    if ch == 1:
        return None, None
    if ch < 2:
        return None, None

    base, _ = os.path.splitext(path_wav_16k)
    ch1 = base + ".ch1.wav"
    ch2 = base + ".ch2.wav"
    write_wav(ch1, data[:, 0:1], 16000)
    write_wav(ch2, data[:, 1:2], 16000)
    return ch1, ch2
