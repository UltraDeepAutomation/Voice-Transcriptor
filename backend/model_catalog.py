"""Backend-owned provider and model catalog.

This module is the SSOT for model identifiers that affect runtime
provider calls. The backend injects this catalog into the HTML bootstrap
for first render and repeats it through /api/health for refreshes.
"""

from __future__ import annotations

from importlib.util import find_spec


def gigaam_available() -> bool:
    """True when the GigaAM engine can be imported in this runtime."""
    return find_spec("gigaam") is not None and find_spec("torch") is not None


# Three sizes, not five. `tiny` and `base` were listed as choices but
# were never a reason to choose them: on this app's workload they are
# fast in exchange for a transcript the user has to correct, and the
# only thing five near-duplicate entries bought was a longer menu.
# `small` is the default and the floor; `medium` and `large-v3` are the
# accuracy steps above it.
# Ordered CHEAPEST FIRST. The order is load-bearing: the live-preview cap
# below is the first entry, and a test pins the order against the size
# hints so a reorder cannot silently make the preview heavier.
WHISPER_LOCAL_MODELS: tuple[str, ...] = (
    "small",
    "medium",
    "large-v3",
)
# Sber GigaAM-v3 line: Russian-only ASR, state-of-the-art WER for ru.
# Engine prefix "gigaam-" dispatches to backend/transcribe_gigaam.py;
# availability depends on the `gigaam` package being installed in the
# app venv (see requirements-gigaam.txt) — surfaced via /api/health.
# One variant. The two differ by their decoding head, not by quality of
# hearing: `e2e-rnnt` is trained end to end over a 1024-piece
# SentencePiece vocabulary and emits punctuated, normalised text
# directly, and it is the faster decode. Plain `rnnt` has a 33-character
# vocabulary (space + а-я) and emits lowercase text with no punctuation —
# it exists so word-error rate can be scored without case and punctuation
# absorbing the errors. That is a benchmarking tool, not a dictation
# engine, and offering it as a peer choice only invited picking it.
GIGAAM_MODELS: tuple[str, ...] = ("gigaam-v3-e2e-rnnt",)
GIGAAM_MODEL_PREFIX = "gigaam-"

LOCAL_TRANSCRIPTION_MODELS: tuple[str, ...] = WHISPER_LOCAL_MODELS + GIGAAM_MODELS
DEFAULT_LOCAL_TRANSCRIPTION_MODEL = "small"
# Live preview follows the transcription model (no separate preview
# choice in the UI): every local model the user can select for
# transcription is also a valid live-assist engine. The windowing in
# backend/live.py adapts to slow models via the catch-up ring, and the
# 60 s inference ceiling bounds worst-case latency.
LOCAL_LIVE_ASSIST_MODELS: tuple[str, ...] = LOCAL_TRANSCRIPTION_MODELS
# The live preview's ceiling, when transcription itself runs through a
# REMOTE provider.
#
# This is a CAP, not a menu. The preview decodes continuously while the
# user speaks, next to whatever the remote provider is doing, so it must
# not be the user's heavy transcription choice: someone who picked
# ``large-v3`` for final quality should not have it running live for a
# Deepgram session too.
#
# DERIVED from the catalog rather than listed beside it. It used to be
# ("tiny", "base"); when those two were retired the list pointed at
# models the app no longer shipped, and nothing failed — the resolver
# just fell through. ``WHISPER_LOCAL_MODELS`` is ordered cheapest-first
# and ``test_models_manager`` holds that ordering against the size
# hints, so "the cheapest model we ship" has exactly one meaning and one
# place to change.
LOCAL_LIVE_PREVIEW_MODELS: tuple[str, ...] = (WHISPER_LOCAL_MODELS[0],)
DEFAULT_LIVE_PREVIEW_LOCAL_MODEL = LOCAL_LIVE_PREVIEW_MODELS[0]

REMOTE_TRANSCRIPTION_PROVIDERS: tuple[str, ...] = ("openrouter", "deepgram")
#: The provider a request that names none is served by. First of the
#: tuple above, in the same shape ``DEFAULT_LIVE_PREVIEW_LOCAL_MODEL``
#: uses a few lines up — so "which provider is the default" has one
#: answer rather than one here, one in ``config.DEFAULT_CONFIG`` and one
#: written out again as ``or "openrouter"`` at the call site.
DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER = REMOTE_TRANSCRIPTION_PROVIDERS[0]

OPENROUTER_AUDIO_MODELS: tuple[str, ...] = (
    "google/gemini-2.5-flash",
    "google/gemini-2.0-flash-lite",
    "openai/gpt-4o-audio-preview",
)
DEFAULT_OPENROUTER_AUDIO_MODEL = OPENROUTER_AUDIO_MODELS[0]

DEEPGRAM_AUDIO_MODELS: tuple[str, ...] = ("nova-3",)
DEFAULT_DEEPGRAM_AUDIO_MODEL = DEEPGRAM_AUDIO_MODELS[0]

OPENROUTER_UPSCALE_MODELS: tuple[tuple[str, str], ...] = (
    ("google/gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("openai/gpt-4o-mini", "GPT-4o mini"),
    ("openai/gpt-4o", "GPT-4o"),
    ("anthropic/claude-3.5-sonnet", "Claude 3.5 Sonnet"),
    ("anthropic/claude-haiku-4.5", "Claude Haiku 4.5"),
)
DEFAULT_OPENROUTER_UPSCALE_MODEL = OPENROUTER_UPSCALE_MODELS[0][0]
OPENROUTER_UPSCALE_FALLBACK_MODELS: tuple[str, ...] = (
    DEFAULT_OPENROUTER_UPSCALE_MODEL,
    "openai/gpt-4o-mini",
)


def health_model_catalog() -> dict[str, object]:
    """Return the JSON-safe model catalog surfaced by /api/health."""
    return {
        "local": {
            "models": list(LOCAL_TRANSCRIPTION_MODELS),
            # Explicit engine taxonomy (SSOT for the UI's provider groups):
            # the UI renders "Local Whisper" and "GigaAM" as separate
            # provider groups from THESE lists, never by prefix-sniffing
            # the merged `models` list.
            "whisper_models": list(WHISPER_LOCAL_MODELS),
            "gigaam_models": list(GIGAAM_MODELS),
            "default_model": DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
            "live_assist_models": list(LOCAL_LIVE_ASSIST_MODELS),
            "live_preview_models": list(LOCAL_LIVE_PREVIEW_MODELS),
            "default_live_preview_model": DEFAULT_LIVE_PREVIEW_LOCAL_MODEL,
            # Engine id -> availability right now. The UI uses this to
            # disable entries whose package the runtime does not carry.
            "engines": {"whisper": True, "gigaam": gigaam_available()},
        },
        "remote": {
            "providers": list(REMOTE_TRANSCRIPTION_PROVIDERS),
            "openrouter": {
                "audio_models": list(OPENROUTER_AUDIO_MODELS),
                "default_audio_model": DEFAULT_OPENROUTER_AUDIO_MODEL,
            },
            "deepgram": {
                "audio_models": list(DEEPGRAM_AUDIO_MODELS),
                "default_audio_model": DEFAULT_DEEPGRAM_AUDIO_MODEL,
            },
        },
        "upscale": {
            "openrouter_models": [
                {"id": model_id, "label": label}
                for model_id, label in OPENROUTER_UPSCALE_MODELS
            ],
            "default_model": DEFAULT_OPENROUTER_UPSCALE_MODEL,
            "fallback_models": list(OPENROUTER_UPSCALE_FALLBACK_MODELS),
        },
    }
