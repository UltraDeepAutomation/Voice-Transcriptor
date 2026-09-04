/**
 * Word-normalisation primitives shared by every transcript-merging
 * heuristic (canonical live-source composition, adoption policy,
 * coverage confirmation).
 *
 * These were previously re-defined as inline closures inside three
 * different functions of main.tsx. Identical rules that live in N
 * places are N opportunities to silently diverge — e.g. tightening the
 * punctuation-strip regex in one merge path and not the others would
 * make overlap comparisons disagree with each other. This module is
 * the single source of truth; unit-tested in tests/text-match.test.ts.
 *
 * Pure: no DOM, no state.
 */

/** Lowercase, strip everything except letters/numbers/whitespace, split. */
export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** normalizeWords, collapsed back to one comparable string. */
export function normalizeComparable(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(text: string): number {
  const value = String(text || "").trim();
  if (!value) return 0;
  return value.split(/\s+/).filter(Boolean).length;
}

/** Collapse all whitespace runs to single spaces and trim. */
export function normalizeTranscriptWhitespace(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Crude language-agnostic stem key: lowercase alpha core, truncated to
 * its first five letters. Deterministic and dependency-free; its job is
 * only to make inflectional variants collide ("визуальную" /
 * "визуальное" → "визуа"), never to be a real morphological analyzer.
 */
export function stemKey(token: string): string {
  const core = String(token || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return core.slice(0, 5);
}

/**
 * Subsequence containment, anchored at the END of the haystack.
 *
 * True when every element of `needle` occurs in `haystack` in order AND
 * the match reaches the haystack's tail: at most `maxTrailingSlack`
 * haystack tokens may follow the last matched one.
 *
 * Why the anchor matters: an interim hypothesis re-decodes the SEAM —
 * the span the committed text has just ended with. "These words appear
 * somewhere in what we already hold" is a different, much weaker claim,
 * and it is the one that made a deliberately repeated clause disappear
 * (BUGS_AUDIT_2026-09-03 §4.2): the speaker said a phrase again, the
 * words were found scattered earlier in the text, and the repeat was
 * discarded as "already covered". The slack exists because the
 * committed text may end with a word or two the hypothesis re-heard
 * differently — that is a re-decode, not new speech.
 *
 * Inputs should be pre-stemmed via stemKey(normalizeWords(...)).
 * Pure; O(len(haystack)).
 */
export function tokensInOrderAtTail(
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
  maxTrailingSlack: number,
): boolean {
  if (needle.length === 0) return true;
  if (haystack.length < needle.length) return false;
  let n = needle.length - 1;
  let trailing = 0;
  for (let h = haystack.length - 1; h >= 0; h--) {
    if (haystack[h] === needle[n]) {
      n -= 1;
      if (n < 0) return true;
    } else if (n === needle.length - 1) {
      trailing += 1;
      if (trailing > maxTrailingSlack) return false;
    }
  }
  return false;
}
