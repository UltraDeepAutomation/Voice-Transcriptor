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

/**
 * Longest run of words either side may contribute on its own, and the
 * smallest share of shared words two texts must have before they are
 * treated as two readings of the same speech.
 *
 * Below the ratio they are not the same utterance in different words —
 * they are different content — and aligning them would interleave two
 * unrelated transcripts. The word cap keeps the alignment cost bounded
 * on very long recordings.
 */
const UNION_MIN_SHARED_RATIO = 0.35;
const UNION_MAX_WORDS = 600;

interface AlignedToken {
  raw: string;
  key: string;
}

function alignedTokens(text: string): AlignedToken[] {
  return normalizeTranscriptWhitespace(text)
    .split(" ")
    .filter(Boolean)
    .map((raw) => ({ raw, key: stemKey(raw) }))
    .filter((t) => t.key);
}

/** Indices of the longest common subsequence of two key arrays. */
function commonSubsequence(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // Row-by-row DP; only the lengths are needed to walk the path back, so
  // the full table is kept (n, m are capped by the caller).
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * The union of two readings of the same recording.
 *
 * Both the live splice and the backend's final envelope are partial, and
 * each loses something the other keeps. Measured over 69 stops on
 * 2026-08-25, eight delivered LESS text than the provider had returned,
 * and the missing part was mid-sentence, not at the tail:
 *
 *   final:     …старая база данных отклоняет пароли. Я ж тебе скинул.
 *   delivered: …старая база данных Я ж тебе скинул.
 *
 * `mergeTranscriptTail` cannot help — the loss is not at a seam — and
 * `richerTranscript` picks the splice because it has more words overall.
 * Aligning the two by their longest common subsequence puts every word
 * of both in one order: shared runs keep `authoritative`'s wording (it
 * decoded the whole recording with full context), and a run only one
 * side has is inserted where the alignment places it.
 *
 * Falls back to the pick when the two texts do not look like the same
 * speech, or when either is long enough that alignment would cost more
 * than the stop path can spend.
 */
export function unionTranscripts(heldText: string, authoritativeText: string): string {
  const held = normalizeTranscriptWhitespace(heldText);
  const authoritative = normalizeTranscriptWhitespace(authoritativeText);
  if (!held) return authoritative;
  if (!authoritative) return held;

  const a = alignedTokens(held);
  const b = alignedTokens(authoritative);
  if (!a.length || !b.length) return richerTranscript(held, authoritative);
  if (a.length > UNION_MAX_WORDS || b.length > UNION_MAX_WORDS) {
    return richerTranscript(held, authoritative);
  }

  const pairs = commonSubsequence(a.map((t) => t.key), b.map((t) => t.key));
  const shared = pairs.length / Math.min(a.length, b.length);
  if (shared < UNION_MIN_SHARED_RATIO) {
    return richerTranscript(held, authoritative);
  }

  const out: string[] = [];
  let ai = 0;
  let bi = 0;
  const flushGap = (aEnd: number, bEnd: number): void => {
    const aRun = a.slice(ai, aEnd);
    const bRun = b.slice(bi, bEnd);
    if (aRun.length && bRun.length) {
      // Both sides decoded this span differently. The authoritative
      // reading had the whole recording for context; take it.
      out.push(...bRun.map((t) => t.raw));
    } else if (aRun.length) {
      out.push(...aRun.map((t) => t.raw));
    } else if (bRun.length) {
      out.push(...bRun.map((t) => t.raw));
    }
  };
  for (const [pa, pb] of pairs) {
    flushGap(pa, pb);
    out.push(b[pb].raw);
    ai = pa + 1;
    bi = pb + 1;
  }
  flushGap(a.length, b.length);
  return out.join(" ").trim();
}
