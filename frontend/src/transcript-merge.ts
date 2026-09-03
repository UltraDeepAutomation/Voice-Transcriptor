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

import { countWords, normalizeComparable, normalizeTranscriptWhitespace, stemKey, tokensInOrder } from "./text-match";

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
 * Smallest share of shared words two texts must have — against the
 * LARGER side's word count — before they are treated as two readings
 * of the same speech, and the smallest number of aligned tokens each
 * side must offer before that ratio itself is trusted.
 *
 * Below the ratio they are not the same utterance in different words —
 * they are different content — and aligning them would interleave two
 * unrelated transcripts. The floor exists because the ratio alone is
 * gameable on short inputs: a one-word candidate that happens to match
 * trivially clears any ratio threshold, so it used to align (and get
 * spliced) instead of falling back to a plain pick. Denominator is
 * `max`, not `min` — with `min`, a short candidate needs to share only
 * a fraction of ITS OWN small vocabulary to pass, even when it barely
 * dents the larger side.
 */
const UNION_MIN_SHARED_RATIO = 0.35;
const UNION_MIN_ALIGNED_TOKENS = 5;

/**
 * A one-sided run may restate content the alignment already placed
 * just before it — the longest common subsequence gives each shared
 * word to only ONE occurrence, so when a clause is present twice in
 * one reading and once in the other (a live re-decode that restated
 * the clause), the un-matched occurrence surfaces as a one-sided run
 * right next to the wording it repeats.
 *
 * `UNION_ECHO_MIN_WORDS` is the shortest run treated as an echo rather
 * than a coincidental shared word. The window the echo must be found
 * in is RELATIVE to the run: an echo restates wording that was just
 * emitted, so its target lies within roughly its own length plus the
 * few words the alignment placed in between. A flat window would let a
 * short run be swallowed by words scattered over a much longer stretch
 * of output, which is the opposite of the invariant this file has to
 * hold ("every word of the held reading survives unless the other side
 * covers that span at least as well"). The absolute cap bounds the
 * scan on a very long one-sided run.
 */
const UNION_ECHO_MIN_WORDS = 3;
const UNION_ECHO_WINDOW_FACTOR = 2;
const UNION_ECHO_WINDOW_SLACK_WORDS = 6;
const UNION_ECHO_MAX_WINDOW_WORDS = 40;

/**
 * Safety limits for the O(n*m) alignment DP.
 *
 * Measured on this machine (Node 22, `Uint32Array` rows, one row per
 * left-hand token): 600x600 — 1.4 MB, 14 ms; 3000x3000 — 34 MB, 70 ms;
 * 5000x5000 — 95 MB, 203 ms. The cell cap therefore stops the table
 * before it can cost more than ~48 MB, and the wall-clock budget —
 * checked while the table is being filled — stops a merely large input
 * from stalling the stop path even when the cap would have allowed it.
 * Either bound falls back to `richerTranscript`; the alignment is never
 * partial.
 *
 * The cap is not the old 600-word cutoff in disguise. It applies to the
 * DIVERGENT MIDDLE only: `commonSubsequence` strips the shared head and
 * tail first, and two readings of the same recording agree almost
 * everywhere, so a 40-minute dictation whose two readings differ in a
 * few clauses aligns in microseconds. Reaching 3460 divergent words per
 * side means the two texts are not the same speech at all — and the
 * similarity gate above has already sent that case to the pick.
 */
const UNION_MAX_CELLS = 12_000_000;
const UNION_TIME_BUDGET_MS = 300;
const UNION_TIME_CHECK_EVERY_ROWS = 128;

interface AlignedToken {
  raw: string;
  key: string;
}

/**
 * Split into alignment units, one per real word. A token with no
 * alignable key (standalone punctuation — "!", "…", a lone dash) has
 * nothing to line up against, so it is glued onto the neighbouring
 * word's `raw` text instead of becoming a unit of its own: as its own
 * unit it would need pairing to survive, and punctuation practically
 * never lines up between two independent readings, so it was silently
 * dropped by every prior version of this function.
 */
function alignedTokens(text: string): AlignedToken[] {
  const words = normalizeTranscriptWhitespace(text).split(" ").filter(Boolean);
  const out: AlignedToken[] = [];
  let carry = "";
  for (const raw of words) {
    const key = stemKey(raw);
    if (!key) {
      if (out.length) {
        out[out.length - 1].raw += ` ${raw}`;
      } else {
        // Leading punctuation with no earlier word to attach to yet —
        // carry it forward onto the next real word.
        carry = carry ? `${carry} ${raw}` : raw;
      }
      continue;
    }
    out.push({ raw: carry ? `${carry} ${raw}` : raw, key });
    carry = "";
  }
  if (carry && out.length) {
    // All-punctuation tail — glue onto the last real word instead of
    // losing it.
    out[out.length - 1].raw += ` ${carry}`;
  }
  return out;
}

/**
 * Indices of the longest common subsequence of two key arrays, or
 * `null` when the divergent middle is too large to align within the
 * time/memory budget (see the constants above) — the caller falls back
 * to a plain pick rather than aligning partially.
 *
 * The shared head and tail are matched directly and excluded from the
 * table. A common prefix (or suffix) always belongs to SOME longest
 * common subsequence, so skipping it is exact, not an approximation —
 * and it is what makes the table small enough for the alignment to
 * survive on a long recording, where the two readings agree on
 * everything but a few clauses.
 */
function commonSubsequence(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head += 1;
  let tail = 0;
  while (head + tail < n && head + tail < m && a[n - 1 - tail] === b[m - 1 - tail]) tail += 1;

  const midN = n - head - tail;
  const midM = m - head - tail;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < head; i++) pairs.push([i, i]);

  if (midN > 0 && midM > 0) {
    if ((midN + 1) * (midM + 1) > UNION_MAX_CELLS) return null;
    // Row-by-row DP over the divergent middle; only the lengths are
    // needed to walk the path back.
    const table: Uint32Array[] = Array.from({ length: midN + 1 }, () => new Uint32Array(midM + 1));
    const startedAt = Date.now();
    for (let i = midN - 1; i >= 0; i--) {
      if (i % UNION_TIME_CHECK_EVERY_ROWS === 0 && Date.now() - startedAt > UNION_TIME_BUDGET_MS) {
        return null;
      }
      const row = table[i];
      const below = table[i + 1];
      const ai = a[head + i];
      for (let j = midM - 1; j >= 0; j--) {
        row[j] = ai === b[head + j]
          ? below[j + 1] + 1
          : Math.max(below[j], row[j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midN && j < midM) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j]);
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  for (let k = 0; k < tail; k++) pairs.push([n - tail + k, m - tail + k]);
  return pairs;
}

/**
 * Does `run` merely restate wording the output has just emitted?
 *
 * The production case this exists for (stop of 2026-09-03 23:49:57):
 * the live splice held its own re-decode of the last clause, so
 * "prompt я наговорил, можешь посмотреть WAV" appeared in it twice
 * while the envelope had it once. The alignment can pair each shared
 * word with only one occurrence, so the surplus copy surfaced as a
 * one-sided run and was appended whole — the delivered transcript
 * carried the clause twice.
 *
 * Below `UNION_ECHO_MIN_WORDS` a run is always kept: a shared
 * connective word or two is coincidence, not an echo, and dropping it
 * would lose real content. The search window is bounded relative to the
 * run so a clause genuinely repeated later in the recording (a
 * deliberate "да, да", a restated instruction) is still kept twice.
 */
function isRedundantEcho(run: ReadonlyArray<AlignedToken>, emittedKeys: ReadonlyArray<string>): boolean {
  if (run.length < UNION_ECHO_MIN_WORDS) return false;
  const windowWords = Math.min(
    UNION_ECHO_MAX_WINDOW_WORDS,
    run.length * UNION_ECHO_WINDOW_FACTOR + UNION_ECHO_WINDOW_SLACK_WORDS,
  );
  const window = emittedKeys.slice(-windowWords);
  return tokensInOrder(window, run.map((t) => t.key));
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
 * speech, when either side is too thin to trust a ratio on, or when
 * the alignment would cost more time/memory than the budget allows.
 *
 * A two-sided gap (both sides decoded the same span differently) keeps
 * exactly one reading — the longer of the two, authoritative on a tie
 * — never both. A one-sided gap is kept unless it merely echoes
 * wording the alignment already placed just before it: a real stop on
 * 2026-09-03 had a live splice whose own re-decode had restated
 * "prompt я наговорил, можешь посмотреть WAV" a few words after the
 * authoritative reading's only copy of that clause, and because the
 * longest-common-subsequence match gives a repeated word to only one
 * occurrence, the un-matched restatement surfaced as a one-sided run
 * that got appended whole, duplicating the clause in what was
 * delivered.
 */
export function unionTranscripts(heldText: string, authoritativeText: string): string {
  const held = normalizeTranscriptWhitespace(heldText);
  const authoritative = normalizeTranscriptWhitespace(authoritativeText);
  if (!held) return authoritative;
  if (!authoritative) return held;

  const a = alignedTokens(held);
  const b = alignedTokens(authoritative);
  if (!a.length || !b.length) return richerTranscript(held, authoritative);
  if (a.length < UNION_MIN_ALIGNED_TOKENS || b.length < UNION_MIN_ALIGNED_TOKENS) {
    return richerTranscript(held, authoritative);
  }

  const pairs = commonSubsequence(a.map((t) => t.key), b.map((t) => t.key));
  if (!pairs) return richerTranscript(held, authoritative);
  const shared = pairs.length / Math.max(a.length, b.length);
  if (shared < UNION_MIN_SHARED_RATIO) {
    return richerTranscript(held, authoritative);
  }

  const out: string[] = [];
  const emittedKeys: string[] = [];
  const emit = (tokens: ReadonlyArray<AlignedToken>): void => {
    for (const t of tokens) {
      out.push(t.raw);
      emittedKeys.push(t.key);
    }
  };
  let ai = 0;
  let bi = 0;
  const flushGap = (aEnd: number, bEnd: number): void => {
    const aRun = a.slice(ai, aEnd);
    const bRun = b.slice(bi, bEnd);
    if (aRun.length && bRun.length) {
      // Both sides decoded this span differently — the same words,
      // shifted. Keep exactly one reading, never both: the
      // authoritative one (it decoded the whole recording with full
      // context), unless it is the thinner of the two, in which case
      // the held reading — the one that actually has more of the
      // words — wins instead.
      emit(bRun.length >= aRun.length ? bRun : aRun);
      return;
    }
    // One-sided: only one reading has anything here. Keep it, unless
    // it merely echoes wording the output just emitted for an
    // adjacent, better-matched pair (see isRedundantEcho) — that is
    // the same content the alignment already placed, not new content.
    const run = aRun.length ? aRun : bRun;
    if (run.length && !isRedundantEcho(run, emittedKeys)) {
      emit(run);
    }
  };
  for (const [pa, pb] of pairs) {
    flushGap(pa, pb);
    emit([b[pb]]);
    ai = pa + 1;
    bi = pb + 1;
  }
  flushGap(a.length, b.length);
  return out.join(" ").trim();
}
