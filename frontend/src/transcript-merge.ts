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
 * The two functions that remain are read by the preview only:
 *
 *   ``joinTranscriptSegments`` — the committed finals, as one string;
 *   ``richerTranscript``       — the preview's monotonic display floor,
 *                                so a Deepgram interim that resets at an
 *                                utterance boundary cannot make the pane
 *                                visibly lose words the user just saw.
 *
 * Neither one can reach the delivered text.
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
