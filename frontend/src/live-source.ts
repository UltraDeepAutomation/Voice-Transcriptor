/**
 * Canonical live-source composition — the single source of truth for
 * turning what the streaming provider has said so far into the one text
 * the stop path delivers.
 *
 * Four inputs, none of which is complete on its own:
 *
 *   committed     — the finalized segments, authoritative but always
 *                 behind the speaker;
 *   recoveredTail — what earlier finals dropped from their own
 *                 interims, reconciled at the moment of each commit
 *                 and kept in a durable field instead of a register
 *                 the next final overwrites;
 *   interim       — the current hypothesis for the tail;
 *   snapshot      — the hypothesis that was on screen just before the last
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
  tokensInOrderAtTail,
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
export const REDECODE_MAX_WINDOW_WORDS = 40;

/**
 * Most committed words a hypothesis may supersede WITHOUT restating
 * them.
 *
 * A stem-aligned re-decode replaces a committed run with the
 * hypothesis's reading of it; the words at the end of that run which
 * the hypothesis does not restate are dropped on the theory that they
 * are the final's mis-hearing of what the hypothesis says next ("за"
 * for "заебись"). That theory holds for a word or two at the seam. Past
 * that, the run being dropped is content, not a mis-hearing — a clause
 * the speaker deliberately said twice is exactly the shape that used to
 * be eaten this way (BUGS_AUDIT_2026-09-03 §4.2). The share rule alone
 * allowed up to 30% of a 40-word window, i.e. twelve committed words,
 * to vanish without any hypothesis word standing in for them.
 *
 * Past the bound the alignment is still used — it is the only thing
 * that knows where the hypothesis stops restating and starts saying
 * something new — but the committed words are kept and only the
 * hypothesis's continuation is appended.
 */
const REDECODE_MAX_SUPERSEDED_WORDS = 2;

/**
 * The seam window: how much of the committed tail a single hypothesis
 * is compared against.
 *
 * Every "is this hypothesis already covered?" guard reads THIS window
 * and nothing else. Searching the whole committed text (what the
 * containment guard used to do) answers a different question — "did
 * these words ever occur?" — and threw away a word the speaker
 * repeated thirty seconds later. The window is the length of the
 * hypothesis plus a small slack, because a hypothesis restates the
 * span it overlaps, not an arbitrary earlier one; the floor keeps a
 * one- or two-word hypothesis from being compared against a window too
 * short to contain the phrase it re-decodes.
 */
const SEAM_WINDOW_MIN_WORDS = 10;
const SEAM_WINDOW_SLACK_WORDS = 2;

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
 * Returns where that run starts in `baseWords` and how many of its
 * words the hypothesis restates, or `null`.
 *
 * The case this answers, measured in production 2026-08-25 14:19:55:
 *
 *   committed: …сообщение записывается за
 *   interim:   …сообщение записывается, заебись, довольно быстро
 *
 * Six words agree and the seventh does not, because the final simply
 * mis-heard it. The exact overlap rule needs the whole window to match,
 * so a single divergent word at the seam defeats it at every window
 * length — and the hypothesis is appended whole, repeating the opening
 * of the sentence in the text the user receives.
 *
 * Alignment is by stem, so an inflected re-decode still lines up. The
 * run must be long enough, complete enough, and must not ask to drop
 * more committed words than a seam mis-hearing can account for (see
 * the three constants) before anything committed is superseded.
 */
function redecodedTailAlignment(
  baseWords: ReadonlyArray<string>,
  interimStems: ReadonlyArray<string>,
): { start: number; overlap: number } | null {
  // Only the window can be superseded, so only the window is stemmed —
  // this runs on every committed segment, and stemming a whole
  // recording's committed text per commit is work that grows with the
  // recording for an answer that cannot.
  const earliest = Math.max(0, baseWords.length - REDECODE_MAX_WINDOW_WORDS);
  const windowStems = baseWords.slice(earliest).map(stemKey);
  let best: { start: number; overlap: number } | null = null;
  for (let i = 0; i < windowStems.length; i++) {
    const run = windowStems.slice(i);
    const overlap = commonPrefixLength(run, interimStems);
    if (overlap < REDECODE_MIN_WORDS) continue;
    if (overlap < Math.ceil(run.length * REDECODE_MIN_SHARE)) continue;
    // Nothing to gain: the hypothesis says exactly what is already there.
    if (interimStems.length <= overlap) continue;
    if (!best || overlap > best.overlap) {
      best = { start: earliest + i, overlap };
    }
  }
  return best;
}

/**
 * What one hypothesis adds to the text we already hold.
 *
 * `text` is the merged result; `added` is the part of the hypothesis
 * that was genuinely new — empty when the committed text already
 * covered the whole hypothesis. Callers that only need the merged text
 * use `mergeInterim`; the commit-time reconciliation in the renderer
 * needs `added` on its own, and deriving it by slicing the merged
 * string apart would be a second, drifting definition of the same
 * decision.
 */
export interface InterimFold {
  text: string;
  added: string;
}

/**
 * Fold one hypothesis into the text we already hold, without repeating
 * ground it re-states.
 *
 * Every guard below reads ONE seam window — the tail of the committed
 * text, sized to the hypothesis — computed once at the top. They are
 * ordered from the strongest claim to the weakest: the hypothesis is
 * literally the committed tail; it is the committed tail re-worded; it
 * overlaps the tail exactly; it re-decodes the tail with a divergent
 * seam; it is new speech.
 */
export function foldInterim(baseRaw: string, interimRaw: string): InterimFold {
  const base = normalizeTranscriptWhitespace(baseRaw);
  const interim = normalizeTranscriptWhitespace(interimRaw);
  if (!interim) return { text: base, added: "" };
  if (!base) return { text: interim, added: interim };
  const interimWords = normalizeWords(interim);
  if (interimWords.length === 0) return { text: base, added: "" };

  const baseRawWords = base.split(/\s+/).filter(Boolean);
  const seamWindowWords = Math.max(SEAM_WINDOW_MIN_WORDS, interimWords.length + SEAM_WINDOW_SLACK_WORDS);
  const seamRaw = baseRawWords.slice(-seamWindowWords).join(" ");
  const seamWords = normalizeWords(seamRaw);

  // 1. The committed tail already ENDS with this hypothesis. Anchored
  //    at the seam on purpose: the same words occurring earlier in the
  //    recording say nothing about whether the speaker just said them
  //    again.
  const interimComparable = normalizeComparable(interim);
  if (interimComparable && normalizeComparable(seamRaw).endsWith(interimComparable)) {
    return { text: base, added: "" };
  }

  // 2. The committed tail ends with a RE-WORDING of this hypothesis —
  //    same words in the same order, different inflection or word count
  //    ("…на визуальную часть" against "…на визуальное"). Exact
  //    matching can never align those; stem-normalized subsequence
  //    containment, anchored at the seam, recognises the re-statement
  //    as ground already covered (seen live 2026-08-24, session
  //    20-32-21).
  const interimStems = interimWords.map(stemKey);
  const seamStems = seamWords.map(stemKey);
  if (tokensInOrderAtTail(seamStems, interimStems, REDECODE_MAX_SUPERSEDED_WORDS)) {
    return { text: base, added: "" };
  }

  // 3. Exact overlap with a shifted boundary, e.g. committed "... сказал
  //    больше" and interim "больше завершил": keep the tail without
  //    duplicating the overlap.
  const baseNormWords = normalizeWords(base);
  const interimRawWords = interim.split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(baseNormWords.length, interimWords.length);
  for (let n = maxOverlap; n > 0; n--) {
    const baseSuffix = baseNormWords.slice(-n).join(" ");
    const interimPrefix = interimWords.slice(0, n).join(" ");
    if (baseSuffix !== interimPrefix) continue;
    const remainder = interimRawWords.slice(n).join(" ").trim();
    return { text: remainder ? `${base} ${remainder}` : base, added: remainder };
  }

  // 4. Re-decode of a committed run whose seam diverges. Rule 3 needs
  //    the overlap to be exact end-to-end; one mis-heard word breaks it,
  //    and the whole hypothesis — opening words and all — gets appended.
  const redecode = redecodedTailAlignment(baseRawWords, interimStems);
  if (redecode) {
    const continuation = interimRawWords.slice(redecode.overlap).join(" ").trim();
    const superseded = baseRawWords.length - redecode.start - redecode.overlap;
    if (superseded <= REDECODE_MAX_SUPERSEDED_WORDS) {
      // A mis-heard word or two at the seam: the hypothesis's reading
      // of the whole run wins.
      const kept = baseRawWords.slice(0, redecode.start).join(" ").trim();
      return { text: kept ? `${kept} ${interim}` : interim, added: continuation };
    }
    // Too much committed text would go with it. Keep every committed
    // word and append only what the hypothesis adds past the run it
    // restates — appending the hypothesis whole would repeat the run.
    return { text: continuation ? `${base} ${continuation}` : base, added: continuation };
  }

  // 5. New speech.
  return { text: `${base} ${interim}`, added: interim };
}

/**
 * Fold one hypothesis into the text we already hold, without repeating
 * ground it re-states.
 */
export function mergeInterim(baseRaw: string, interimRaw: string): string {
  return foldInterim(baseRaw, interimRaw).text;
}

/**
 * The part of `interim` the committed text does not cover.
 *
 * This is the commit-time half of the §4.1 fix: when a final clears the
 * interim that produced it, whatever the final did not carry over is
 * gone from every live view of the session, and the stop path — which
 * reads those views minutes later — can no longer see it. Asking the
 * question at the moment of the commit, with the same rules that decide
 * every other merge, is what makes the answer durable.
 */
export function uncoveredInterimTail(baseRaw: string, interimRaw: string): string {
  return foldInterim(baseRaw, interimRaw).added;
}

/**
 * Keep the recovered tail bounded by the same window that bounds every
 * other seam decision: words older than the re-decode window can no
 * longer be placed by any of the rules above, so carrying them would
 * only grow the field without ever changing an outcome.
 */
export function boundRecoveredTail(textRaw: string): string {
  const words = normalizeTranscriptWhitespace(textRaw).split(" ").filter(Boolean);
  if (words.length <= REDECODE_MAX_WINDOW_WORDS) return words.join(" ");
  return words.slice(-REDECODE_MAX_WINDOW_WORDS).join(" ");
}

/**
 * The one text the stop path delivers, from the four partial views.
 *
 * Each candidate is built and the richest wins, because which view
 * holds the tail depends on where the provider stopped finalizing.
 *
 * `recoveredTail` is the durable one: the current and snapshot
 * hypotheses only ever describe the LAST final, while the recovered
 * tail carries what earlier finals cut from their own interims and
 * would otherwise have been overwritten (BUGS_AUDIT_2026-09-03 §4.1).
 * It is folded in first so the hypotheses are merged against a base
 * that already contains it, and never appended twice.
 */
export function composeCanonicalLiveSourceText(
  committedRaw: string,
  recoveredTailRaw: string,
  currentInterimRaw: string,
  snapshotInterimRaw: string,
): string {
  const committed = normalizeTranscriptWhitespace(committedRaw);
  const currentInterim = normalizeTranscriptWhitespace(currentInterimRaw);
  const snapshotInterim = normalizeTranscriptWhitespace(snapshotInterimRaw);

  const withRecovered = mergeInterim(committed, recoveredTailRaw);
  const withSnapshot = mergeInterim(withRecovered, snapshotInterim);
  const withCurrent = mergeInterim(withRecovered, currentInterim);
  const snapshotThenCurrent = mergeInterim(withSnapshot, currentInterim);
  return [committed, withRecovered, withSnapshot, withCurrent, snapshotThenCurrent]
    .reduce((best, candidate) => pickRicher(best, candidate), "");
}
