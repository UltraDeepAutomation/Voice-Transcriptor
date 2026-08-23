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
