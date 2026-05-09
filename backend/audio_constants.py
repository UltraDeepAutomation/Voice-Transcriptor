"""SSOT for audio-pipeline constants used by multiple backend modules.

Previously the literal ``16000`` (live sample rate, Hz) was duplicated
across ``audio.py``, ``main.py``, ``remote_deepgram_live.py`` and the
live-recovery PCM math. Same with the bytes/sec value (16000 × 2 =
32000) which appeared at four different sites in ``main.py`` alone.
Drift between any two breaks the pipeline silently — Deepgram
``encoding=linear16&sample_rate=16000`` gets fed audio at a different
rate, or the live-recovery duration calculation reports wrong wall-clock.

This module is the single source. Add NEW audio constants here if more
than one module needs them.
"""

# Live streaming sample rate. Constrained by:
#   • Deepgram WS announces ``sample_rate=16000`` in the upgrade query
#     string; we MUST send PCM at this rate.
#   • Whisper expects 16 kHz mono PCM as its native input.
#   • PCM sink writes a WAV header with this rate.
# Changing this requires coordinated updates to the frontend
# downsample target, every Deepgram query, the WAV writer, and
# Whisper input contract — DO NOT do that without a migration plan.
LIVE_SAMPLE_RATE_HZ: int = 16_000

# 16 kHz × 16 bit (2 bytes/sample) × 1 channel (mono) = bytes/sec for
# the canonical live PCM stream. Used by retention / duration math
# in live-recovery.
LIVE_PCM_BYTES_PER_SEC: int = LIVE_SAMPLE_RATE_HZ * 2

# Minimum bytes for a live recovery to be considered "had real audio"
# rather than a session that started + immediately stopped. ~1 second
# at the canonical rate. Drives the prune-on-finalize threshold.
LIVE_RECOVERY_MIN_BYTES: int = LIVE_PCM_BYTES_PER_SEC
