/**
 * Transcript merge policy — the single source of truth for deciding
 * which of two candidate transcripts wins and when a candidate merely
 * confirms coverage.
 *
 * Consumers: the Deepgram stop path in main.tsx (instant buffer text
 * vs the awaited backend final envelope — the fix for tail truncation,
 * where the server-side interim splice and post-CloseStream is_final
 * messages used to be fire-and-forget), and the adoption heuristics.
 *
 * Pure: no DOM, no state. Unit-tested in tests/transcript-merge.test.ts
 */

import { countWords, normalizeComparable, normalizeTranscriptWhitespace } from "./text-match";

export interface Segmented {
  text?: string;
  segments?: Array<{ text?: string }>;
}

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

/** Best text representable by an envelope: field text vs joined segments. */
export function textFromEnvelope(envelope: Segmented | null | undefined): string {
  if (!envelope) return "";
  const text = normalizeTranscriptWhitespace(envelope.text || "");
  const segmentsText = joinTranscriptSegments(envelope.segments || []);
  return countWords(text) >= countWords(segmentsText) ? text : segmentsText;
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
 * True when ``candidateText`` plausibly confirms what we already have
 * (same length or a prefix/suffix extension within tolerance) — used
 * to accept cheap confirmations without a full re-transcription.
 */
export function candidateConfirmsTranscriptCoverage(
  currentText: string,
  candidateText: string,
): boolean {
  const current = normalizeTranscriptWhitespace(currentText);
  const candidate = normalizeTranscriptWhitespace(candidateText);
  if (!current || !candidate) return false;
  const currentWords = countWords(current);
  const candidateWords = countWords(candidate);
  if (currentWords <= 0 || candidateWords <= 0) return false;
  if (candidateWords >= currentWords) return true;
  if (candidateWords < Math.max(1, Math.floor(currentWords * 0.9))) return false;

  const currentSet = new Set(normalizeWordsCompat(current));
  const candidateNormWords = normalizeWordsCompat(candidate);
  if (!candidateNormWords.length) return false;
  const overlap = candidateNormWords.filter((w) => currentSet.has(w)).length;
  return overlap / candidateNormWords.length >= 0.85;
}

function normalizeWordsCompat(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}
