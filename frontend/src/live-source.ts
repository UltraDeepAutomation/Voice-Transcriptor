/**
 * Canonical live-source composition — the single source of truth for
 * turning what the streaming provider has said so far into the text the
 * live preview shows and the draft autosave stores.
 *
 * Two inputs:
 *
 *   committed — the finalized segments, authoritative but always behind
 *               the speaker;
 *   interim   — the current hypothesis for the tail.
 *
 * The hard part is that an interim is a ROLLING RE-DECODE: it restates
 * ground the committed text already covers, in different words, and
 * appending it duplicates a clause. Every guard in `mergeInterim` exists
 * because a specific duplication reached a user's transcript.
 *
 * This module used to compose a third and fourth input as well — the
 * hypothesis that the last final displaced (`lastInterimText`) and a
 * durable `recoveredTailText` accumulated from every earlier final —
 * because the stop path read this text and delivered it. It no longer
 * does: the backend's `final` envelope is the only source of the
 * delivered transcript, and recovering a word the provider's finals
 * dropped is the backend's word-level splice's job, where the word can
 * be put back in the PLACE it was spoken instead of glued onto the end
 * (the "трёх в" defect of session a9fd3fd9). What is left here is
 * display and draft state only, and it can no longer reach the text the
 * user is handed.
 *
 * Pure: no DOM, no state. Unit-tested in tests/live-source.test.ts.
 */

import {
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
const REDECODE_MAX_WINDOW_WORDS = 40;

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
 * Fold one hypothesis into the text we already hold, without repeating
 * ground it re-states.
 *
 * Every guard below reads ONE seam window — the tail of the committed
 * text, sized to the hypothesis — computed once at the top. They are
 * ordered from the strongest claim to the weakest: the hypothesis is
 * literally the committed tail; it is the committed tail re-worded; it
 * overlaps the tail exactly; it re-decodes the tail with a divergent
 * seam; it is new speech.
 *
 * This is the whole of the live composition: preview text and draft
 * autosave text are `mergeInterim(committed, interim)` and nothing else.
 */
export function mergeInterim(baseRaw: string, interimRaw: string): string {
  const base = normalizeTranscriptWhitespace(baseRaw);
  const interim = normalizeTranscriptWhitespace(interimRaw);
  if (!interim) return base;
  if (!base) return interim;
  const interimWords = normalizeWords(interim);
  if (interimWords.length === 0) return base;

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
    return base;
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
    return base;
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
    return remainder ? `${base} ${remainder}` : base;
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
      return kept ? `${kept} ${interim}` : interim;
    }
    // Too much committed text would go with it. Keep every committed
    // word and append only what the hypothesis adds past the run it
    // restates — appending the hypothesis whole would repeat the run.
    return continuation ? `${base} ${continuation}` : base;
  }

  // 5. New speech.
  return `${base} ${interim}`;
}
