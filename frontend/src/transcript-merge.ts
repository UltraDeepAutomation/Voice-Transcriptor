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

import { countWords, normalizeComparable, normalizeTranscriptWhitespace, stemKey } from "./text-match";

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
 * Shortest and longest word anchor used to align two transcripts of the
 * same utterance. Three words is short enough to survive a diverging
 * re-decode and long enough that a common function word cannot anchor on
 * its own; eight is where a longer match stops adding certainty.
 */
const TAIL_ANCHOR_MIN_WORDS = 3;
const TAIL_ANCHOR_MAX_WORDS = 8;

interface AnchorToken {
  /** Stem key — inflection-tolerant, so a re-decode still aligns. */
  key: string;
  /** Index of this token in the original whitespace-split array. */
  index: number;
}

function anchorTokens(tokens: ReadonlyArray<string>): AnchorToken[] {
  const out: AnchorToken[] = [];
  tokens.forEach((token, index) => {
    const key = stemKey(token);
    if (key) out.push({ key, index });
  });
  return out;
}

/**
 * Graft a candidate's trailing words onto the transcript we already hold.
 *
 * ``richerTranscript`` picks a winner, and a pick is the wrong operation
 * when both candidates are partial views of the same utterance. Measured
 * in production, 2026-08-25 13:05 — the live splice and the backend
 * final each held 27 words and each was missing what the other had:
 *
 *   live splice:  …в последних влогах несколько слов. Они иногда до
 *                 самого конца доходят … и у меня обрываются
 *   final:        …в последних влогах до самого конца доходят … и у меня
 *                 обрываются слова. В чём проблема?
 *
 * The live splice carried a phrase no final ever covered; the final
 * carried the closing clause the splice never received. On equal word
 * counts the tie-break went to the longer string, so the user was handed
 * a sentence that stopped mid-thought — the reported "I press stop and my
 * words get cut off". Neither text was the answer; their union was.
 *
 * The alignment is the tail of what we hold, matched against the
 * candidate by stem so a re-decode of the same words still anchors, at
 * the LAST place it occurs so a repeated phrase grafts after its final
 * appearance. Everything past the anchor is appended verbatim. When no
 * anchor holds, the two texts are not continuations of each other and
 * the pick is still the safest answer.
 */
export function mergeTranscriptTail(currentText: string, candidateText: string): string {
  const current = normalizeTranscriptWhitespace(currentText);
  const candidate = normalizeTranscriptWhitespace(candidateText);
  if (!candidate) return current;
  if (!current) return candidate;

  const currentTokens = current.split(" ");
  const candidateTokens = candidate.split(" ");
  const currentAnchors = anchorTokens(currentTokens);
  const candidateAnchors = anchorTokens(candidateTokens);

  const longestAnchor = Math.min(
    TAIL_ANCHOR_MAX_WORDS,
    currentAnchors.length,
    candidateAnchors.length,
  );
  for (let k = longestAnchor; k >= TAIL_ANCHOR_MIN_WORDS; k--) {
    const anchor = currentAnchors.slice(currentAnchors.length - k).map((t) => t.key);
    for (let i = candidateAnchors.length - k; i >= 0; i--) {
      let matched = true;
      for (let j = 0; j < k; j++) {
        if (candidateAnchors[i + j].key !== anchor[j]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const tail = candidateTokens.slice(candidateAnchors[i + k - 1].index + 1);
      // Nothing past the anchor, or nothing but punctuation: the
      // candidate ends where we do and has no tail to contribute.
      if (!tail.some((token) => stemKey(token))) return current;
      return `${current} ${tail.join(" ")}`.trim();
    }
  }
  return richerTranscript(current, candidate);
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
