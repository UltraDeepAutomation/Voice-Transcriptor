"""SSOT for the Deepgram formatting options both transcription paths send.

Live streaming and prerecorded REST are two ways into the same provider,
on the same model family, for the same user speaking the same language.
Anything that changes how the returned text is FORMATTED has to be one
decision, or the same recording comes back looking different depending
on which path served it — and the user has no way to know which did.

It was not one decision. `remote_deepgram_live` sent
``smart_format=true`` and `remote_deepgram` sent ``smart_format=false``,
each carrying a comment asserting the opposite of the other's belief.
The stated reason for disabling it was that Deepgram applies a "basic
formatting" pass to Russian which STRIPS punctuation.

That premise is false, and the live path is the proof. It has run
``smart_format=true`` on Russian for 3646 recorded sessions; sampling 23
recent transcripts from that path gives a median of **60.3 punctuation
marks per 1000 letters**, with two unpunctuated outliers. A pass that
strips punctuation does not produce that. An earlier measurement over a
3084-transcript archive found the same direction — 50.7 marks per 1000
letters on the live path against 36.6 on the batch path, i.e. the side
that disabled the flag to protect punctuation had ~39 % less of it.

What remains genuinely unproven is the narrower question of whether
enabling it makes the BATCH path better, which only a same-audio A/B can
answer, and that costs live API calls against the user's key. So the
value is set from the evidence that exists and is overridable without a
code change: set ``TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT=0`` to disable it
on both paths, ``=1`` to force it on. The point of this module is not the
value — it is that there is now one value.

Options that only one endpoint accepts (``paragraphs``, ``numerals`` are
prerecorded-only; ``endpointing``, ``utterance_end_ms`` are live-only)
stay with their path. This module owns only what both can send.
"""

from __future__ import annotations

import os


def _env_flag(name: str, default: bool) -> bool:
    raw = str(os.environ.get(name, "") or "").strip().lower()
    if not raw:
        return default
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


#: Deepgram's combined formatting pass (capitalisation, punctuation,
#: number and entity formatting). See the module docstring for why this
#: is on and what would change it.
SMART_FORMAT_DEFAULT = True

#: Explicit sentence punctuation. Requested alongside smart_format on
#: both paths — Deepgram treats them as independent options and the
#: transcript is the poorer for dropping either.
PUNCTUATE_DEFAULT = True

#: Filler words ("um", "uh"). Dictation is pasted into other people's
#: chats, so they are noise on every path.
FILLER_WORDS_DEFAULT = False


def smart_format_enabled() -> bool:
    """Whether to request Deepgram's smart formatting pass."""
    return _env_flag("TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT", SMART_FORMAT_DEFAULT)


def punctuate_enabled() -> bool:
    """Whether to request explicit sentence punctuation."""
    return _env_flag("TRANSCRIPTOR_DEEPGRAM_PUNCTUATE", PUNCTUATE_DEFAULT)


def filler_words_enabled() -> bool:
    """Whether to keep filler words in the transcript."""
    return _env_flag("TRANSCRIPTOR_DEEPGRAM_FILLER_WORDS", FILLER_WORDS_DEFAULT)


def shared_format_params() -> dict[str, str]:
    """The formatting options every Deepgram request carries, as strings.

    One builder so a path cannot accidentally send a subset: the query
    string is assembled from this dict plus whatever that endpoint alone
    accepts.
    """
    return {
        "smart_format": "true" if smart_format_enabled() else "false",
        "punctuate": "true" if punctuate_enabled() else "false",
        "filler_words": "true" if filler_words_enabled() else "false",
    }
