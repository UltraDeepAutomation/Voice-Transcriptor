/**
 * Canonical live-source composition — the single source of truth for
 * turning what the streaming provider has said so far into the one text
 * the stop path delivers.
 *
 * Three inputs, none of which is complete on its own:
 *
 *   committed   — the finalized segments, authoritative but always
 *                 behind the speaker;
 *   interim     — the current hypothesis for the tail;
 *   snapshot    — the hypothesis that was on screen just before the last
 *                 `is_final` replaced it. A final that covers only PART
 *                 of what its own interim heard ("последние" out of
 *                 "последние слова") loses the rest, and by the time the
 *                 stop path reads this the tail word is gone.
 *
 * The hard part is that an interim is a ROLLING RE-DECODE: it restates
 * ground the committed text already covers, in different words, and
 * appending it duplicates a clause. Every guard in `mergeInterim` exists
 * because a specific duplication reached a user's transcript.
 *
 * Pure: no DOM, no state. Unit-tested in tests/live-source.test.ts.
 */

import {
  countWords,
  normalizeComparable,
  normalizeTranscriptWhitespace,
  normalizeWords,
  stemKey,
  tokensInOrder,
} from "./text-match";

/**
 * Shortest re-decode overlap that may supersede committed words, and the
 * share of the superseded run the overlap must cover.
 *
 * Three words is short enough to catch a clause and long enough that a
 * common opening ("ну вот", "так и") cannot trigger a replacement on its
 * own. The 0.7 share is what separates "this hypothesis re-decodes that
 * whole run" from "this hypothesis happens to start with words that also
 * appear there".
 */
const REDECODE_MIN_WORDS = 3;
const REDECODE_MIN_SHARE = 0.7;

/** Longest committed tail a single hypothesis may be allowed to supersede. */
const REDECODE_MAX_WINDOW_WORDS = 40;

function pickRicher(a: string, b: string): string {
  const left = normalizeTranscriptWhitespace(a);
  const right = normalizeTranscriptWhitespace(b);
  if (!left) return right;
  if (!right) return left;
  const leftWords = countWords(left);
  const rightWords = countWords(right);
  if (rightWords > leftWords) return right;
  if (rightWords === leftWords && right.length > left.length) return right;
  return left;
}

/** Length of the common leading run of two stem sequences. */
function commonPrefixLength(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Does `interim` re-decode a run at the end of `base`?
 *
 * Returns the index in `baseWords` where that run starts, or -1.
 *
 * The case this answers, measured in production 2026-08-25 14:19:55:
 *
 *   committed: …сообщение записывается за
 *   interim:   …сообщение записывается, заебись, довольно быстро
 *
 * Six words agree and the seventh does not, because the final simply
 * mis-heard it. The exact suffix/prefix rule below requires the whole
 * window to match, so a single divergent word at the seam defeats it at
 * every window length — and the hypothesis is appended whole, repeating
 * the opening of the sentence in the text the user receives.
 *
 * Alignment is by stem, so an inflected re-decode still lines up, and
 * the run must be both long enough and complete enough (see the two
 * constants) before anything committed is allowed to be superseded.
 */
function redecodedTailStart(
  baseWords: ReadonlyArray<string>,
  interimStems: ReadonlyArray<string>,
): number {
  const baseStems = baseWords.map(stemKey);
  const earliest = Math.max(0, baseWords.length - REDECODE_MAX_WINDOW_WORDS);
  let bestStart = -1;
  let bestOverlap = 0;
  for (let start = earliest; start < baseWords.length; start++) {
    const run = baseStems.slice(start);
    const overlap = commonPrefixLength(run, interimStems);
    if (overlap < REDECODE_MIN_WORDS) continue;
    if (overlap < Math.ceil(run.length * REDECODE_MIN_SHARE)) continue;
    // Nothing to gain: the hypothesis says exactly what is already there.
    if (interimStems.length <= overlap) continue;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestStart = start;
    }
  }
  return bestStart;
}

/**
 * Fold one hypothesis into the text we already hold, without repeating
 * ground it re-states.
 */
export function mergeInterim(baseRaw: string, interimRaw: string): string {
  const base = normalizeTranscriptWhitespace(baseRaw);
  const interim = normalizeTranscriptWhitespace(interimRaw);
  if (!interim) return base;
  if (!base) return interim;
  if (base.endsWith(interim)) return base;
  const interimWords = normalizeWords(interim);
  if (interimWords.length === 0) return base;
  const baseComparable = normalizeComparable(base);
  const interimComparable = normalizeComparable(interim);
  if (interimComparable && baseComparable.includes(interimComparable)) {
    return base;
  }
  const lastBaseWords = base.split(/\s+/).slice(-Math.max(10, interimWords.length + 2)).join(" ");
  const lastBaseNorm = normalizeWords(lastBaseWords).join(" ");
  const interimNorm = interimWords.join(" ");
  if (lastBaseNorm.endsWith(interimNorm)) return base;

  // Re-statement guard: a fresh hypothesis often restates its own span
  // with different word forms/counts ("…на визуальную часть" →
  // "…на визуальное"). Exact suffix matching above can never align
  // those; without this check the hypothesis would be appended as new
  // content and the phrase duplicated (seen live 2026-08-24, session
  // 20-32-21). Stem-normalized subsequence containment means "same
  // words in the same order, different rendering" — the committed
  // text already covers it.
  const baseStems = normalizeWords(lastBaseWords).map(stemKey);
  const interimStems = interimWords.map(stemKey);
  if (tokensInOrder(baseStems, interimStems)) return base;

  // Interim hypotheses can overlap committed text with a shifted
  // boundary, e.g. committed="... сказал больше" and interim="больше
  // завершил". Merge the longest normalized suffix/prefix overlap so
  // the fast stop path keeps the tail without duplicating the overlap.
  const baseNormWords = normalizeWords(base);
  const interimRawWords = interim.split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(baseNormWords.length, interimWords.length);
  for (let n = maxOverlap; n > 0; n--) {
    const baseSuffix = baseNormWords.slice(-n).join(" ");
    const interimPrefix = interimWords.slice(0, n).join(" ");
    if (baseSuffix !== interimPrefix) continue;
    const remainder = interimRawWords.slice(n).join(" ").trim();
    return remainder ? `${base} ${remainder}` : base;
  }

  // Re-decode of a committed run whose seam diverges. The rule above
  // needs the overlap to be exact end-to-end; one mis-heard word breaks
  // it, and the whole hypothesis — opening words and all — gets appended.
  const baseRawWords = base.split(/\s+/).filter(Boolean);
  const redecodeStart = redecodedTailStart(baseRawWords, interimStems);
  if (redecodeStart >= 0) {
    const kept = baseRawWords.slice(0, redecodeStart).join(" ").trim();
    return kept ? `${kept} ${interim}` : interim;
  }

  return `${base} ${interim}`;
}

/**
 * The one text the stop path delivers, from the three partial views.
 *
 * Each candidate is built and the richest wins, because which view holds
 * the tail depends on where the provider stopped finalizing.
 */
export function composeCanonicalLiveSourceText(
  committedRaw: string,
  currentInterimRaw: string,
  snapshotInterimRaw: string,
): string {
  const committed = normalizeTranscriptWhitespace(committedRaw);
  const currentInterim = normalizeTranscriptWhitespace(currentInterimRaw);
  const snapshotInterim = normalizeTranscriptWhitespace(snapshotInterimRaw);

  const withSnapshot = mergeInterim(committed, snapshotInterim);
  const withCurrent = mergeInterim(committed, currentInterim);
  const snapshotThenCurrent = mergeInterim(withSnapshot, currentInterim);
  return [committed, withSnapshot, withCurrent, snapshotThenCurrent]
    .reduce((best, candidate) => pickRicher(best, candidate), "");
}
