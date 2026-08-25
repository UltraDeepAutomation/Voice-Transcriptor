"""SSOT for reading a word out of a Deepgram response.

Deepgram returns two spellings for every word:

    {"word": "четыре", "punctuated_word": "Четыре,", ...}

``word`` is the raw recognition; ``punctuated_word`` is the same word
after the ``smart_format`` / ``punctuate`` options we request (and pay
for) have applied capitalisation and punctuation. Which one a caller
picks is a transcript-quality decision, and it was being made twice,
differently:

    remote_deepgram.py       punctuated_word or word     (correct)
    remote_deepgram_live.py  word or punctuated_word     (backwards)

The live form is not a fallback chain at all — ``word`` is populated on
every word Deepgram returns, so ``punctuated_word`` was unreachable and
the formatting was discarded.

That mattered on the one path that exists to *improve* quality. The live
provider keeps interim words so ``_splice_uncovered_interim_words`` can
fold back speech that no final ever covered; measured across the shipped
logs, 43 such repairs. Each rescued word was spliced into the committed
transcript in its raw form — unpunctuated, uncapitalised — sitting
inside otherwise punctuated prose, so the repair announced itself.

One function, imported by both providers, so the precedence cannot
diverge again.
"""

from __future__ import annotations

from typing import Any, Mapping


def deepgram_word_text(word: Mapping[str, Any]) -> str:
    """Return the display spelling of a Deepgram word.

    ``punctuated_word`` wins whenever it carries anything: it is the
    same token with the formatting we asked for. ``word`` is the
    fallback for responses that omit it (options disabled, or a
    provider-side shape change), and an empty string is returned for
    anything that is not a word object — callers skip falsy tokens.
    """
    if not isinstance(word, Mapping):
        return ""
    punctuated = word.get("punctuated_word")
    if isinstance(punctuated, str) and punctuated.strip():
        return punctuated.strip()
    raw = word.get("word")
    if isinstance(raw, str):
        return raw.strip()
    return ""
