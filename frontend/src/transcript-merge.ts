/**
 * Live-preview text helpers.
 *
 * What is left here serves the LIVE PREVIEW and nothing else. The stop
 * path used to own a second transcript-assembly machine in this module
 * — ``chooseStopTranscript``, ``mergeReadings``, ``unionTranscripts``
 * and the timed-token seam merge underneath them — whose job was to
 * reconcile the backend's ``final`` envelope with the renderer's own
 * reading of the same speech. That job no longer exists: the envelope
 * is complete by construction and is delivered verbatim (see
 * ./envelope-deadline), so there is one owner of the delivered
 * transcript and nothing to reconcile it against. Every duplication
 * defect of 2026-09-03/04 (sessions 8c12d76e, ed79f04a, 521f9788) came
 * out of that reconciliation, and it is gone rather than merely
 * unused.
 *
 * The functions that remain are read by the preview only:
 *
 *   ``joinTranscriptSegments``   — the committed finals, as one string;
 *   ``richerTranscript``         — the preview's monotonic display floor,
 *                                  so a Deepgram interim that resets at
 *                                  an utterance boundary cannot make the
 *                                  pane visibly lose words the user just
 *                                  saw;
 *   ``composeLivePreviewText``   — the ONE rule for what the preview
 *                                  shows once a session's stop envelope
 *                                  has resolved (see its own doc comment
 *                                  — B-041, 2026-09-05).
 *
 * None of them can reach the delivered text.
 *
 * Pure: no DOM, no state. Unit-tested in tests/transcript-merge.test.ts
 */

import { countWords, normalizeComparable, normalizeTranscriptWhitespace } from "./text-match";

interface TranscriptSegmentLike {
  text?: string;
}

/** Join segment texts with single-space normalization. */
export function joinTranscriptSegments(
  segments: ReadonlyArray<TranscriptSegmentLike>,
): string {
  return segments
    .map((segment) => normalizeTranscriptWhitespace(String(segment?.text || "")))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Return whichever transcript carries strictly more content. */
export function richerTranscript(currentText: string, candidateText: string): string {
  const current = normalizeTranscriptWhitespace(currentText);
  const candidate = normalizeTranscriptWhitespace(candidateText);
  if (!candidate) return current;
  if (!current) return candidate;
  const currentWords = countWords(current);
  const candidateWords = countWords(candidate);
  if (candidateWords > currentWords) return candidate;
  if (candidateWords === currentWords && candidate.length > current.length) {
    const currentNorm = normalizeComparable(current);
    const candidateNorm = normalizeComparable(candidate);
    if (candidateNorm.startsWith(currentNorm) || candidateNorm.endsWith(currentNorm)) {
      return candidate;
    }
  }
  return current;
}

/**
 * The live preview's ONE rule for what to show (B-041, 2026-09-05).
 *
 * Before a session's stop envelope has resolved, the preview shows the
 * committed-plus-interim reading of the session — the ``richerTranscript``
 * floor over ``getVisibleLivePreviewText()``. Once the envelope
 * resolves, the envelope IS the text: verbatim, never unioned with the
 * committed/interim reading it replaces.
 *
 * A session (2026-09-05, ~05:5x local) showed why "union" is wrong even
 * though it sounds safer: the WS ``final`` message's segments are the
 * backend's own re-merge of the whole recording (Deepgram finals + its
 * word-level splice + the dual-stream merge), not a delta to append.
 * Their timings don't line up with the segments the renderer already
 * buffered from mid-session ``segments``/``interim`` events, so the
 * epsilon-based segment dedup (``mergeTranscriptSegments``) cannot tell
 * the two readings are the same speech — the LIVE PREVIEW pane showed
 * the whole transcript twice while the TRANSCRIBE pane, which only ever
 * reads ``envelope.text`` verbatim (see ``stopLive`` in main.tsx),
 * showed it once. The fix is not a better dedup: a resolved envelope is
 * the ONE authoritative reading of the session from that point on, and
 * nothing else contributes to the display again.
 *
 * ``envelopeText`` is ``null``/``undefined`` exactly while no envelope
 * has resolved for the session — never as a stand-in for "resolved but
 * empty". An envelope that resolved with NO speech is not "missing": it
 * is the backend's own verdict, and it wins outright over stale
 * committed/interim text exactly like a non-empty one does.
 */
export function composeLivePreviewText(
  committedAndInterim: string,
  envelopeText: string | null | undefined,
): string {
  if (envelopeText === null || envelopeText === undefined) {
    return normalizeTranscriptWhitespace(committedAndInterim);
  }
  return normalizeTranscriptWhitespace(envelopeText);
}
