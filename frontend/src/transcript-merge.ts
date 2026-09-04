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
import { mergeInterim } from "./live-source";

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

// ── Seam-time merge ──────────────────────────────────────────────────
//
// Debt registry item (d), BUGS_AUDIT_2026-09-03. ``unionTranscripts``
// above reconciles two readings by TEXT alone, and text alone cannot
// answer the only question that matters when both readings are partial:
// which of them was listening to this second of audio. Aligning by the
// longest common subsequence pairs words that merely look alike, so a
// clause each reading words differently comes back as a sentence that
// neither reading contains ("мы пошли в лавку за молоком и хлебом" out
// of "мы поехали в магазин за молоком и хлебом" and "мы пошли в лавку за
// хлебом"), and a clause one reading restated comes back twice.
//
// Both readings now carry time. The live buffer's committed segments
// have Deepgram's own start/end, and the final envelope's segments carry
// their ``words`` with per-word start/end (``normalize_words`` in
// ``backend/remote_deepgram_live``). One time axis, because both come
// from the same stream and the same clock.
//
// So the merge is decided in time, the way the published two-pass work
// does it. whisper_streaming's ``HypothesisBuffer`` commits on
// LocalAgreement and guards the seam with an n-gram check (i = 1..5)
// inside a one-second window; WhisperX chops its chunks at silence so no
// word ever lands on a boundary. This function does both: it cuts ONCE,
// at the quietest moment inside the region where the two readings
// disagree, gives everything before the cut to the held reading and
// everything after it to the authoritative one, reconciles only the
// ±1 s that straddles the cut by edit distance, and then applies the
// n-gram guard to what it has assembled — with the guard gated on the
// two runs' word times OVERLAPPING, so a phrase the speaker genuinely
// repeated a minute later survives twice.
//
// ``mergeReadings`` is the single entry point. It chooses the strategy
// from the DATA — time-aware when both sides are timed, the text union
// when they are not — so no call site has to know which it has.

/** One word (or one whole segment) of a reading, with its span. */
interface TimedToken {
  raw: string;
  key: string;
  start: number;
  end: number;
}

export interface TimedWordLike {
  word?: unknown;
  punctuated_word?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
}

export interface TimedSegmentLike {
  text?: string;
  start?: unknown;
  end?: unknown;
  words?: ReadonlyArray<TimedWordLike> | null;
}

/**
 * One reading of a recording: its text, and the timed segments it was
 * assembled from when it has any.
 *
 * ``text`` is authoritative for WORDING — the held reading's text
 * carries the uncommitted tail (interim words, the durable recovered
 * tail) that no committed segment accounts for, and that tail is always
 * emitted. ``segments`` are what make the reading placeable in time.
 */
export interface Reading {
  text?: string;
  segments?: ReadonlyArray<TimedSegmentLike> | null;
}

/**
 * The straddling window: how far either side of the seam two readings
 * are reconciled word by word instead of by the cut.
 *
 * A word spoken across the cut appears in both readings with slightly
 * different times, so a bare cut would either keep it twice or lose it.
 * One second is whisper_streaming's own guard window, and it is wide
 * enough for the two clocks to disagree by a word's length without being
 * so wide that it re-opens the text-only alignment across a whole clause.
 */
export const SEAM_STRADDLE_WINDOW_SEC = 1;

/**
 * Longest repeated run the seam guard will collapse.
 *
 * Matches whisper_streaming's i = 1..5. Longer than that at overlapping
 * times is not a seam artefact, and collapsing it would delete content.
 */
export const SEAM_NGRAM_MAX_WORDS = 5;

function finiteTimeOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Attach a token with no alignable key to the word before it. */
function carryPunctuation(out: TimedToken[], raw: string, end: number): void {
  if (!out.length) return;
  const last = out[out.length - 1];
  last.raw += ` ${raw}`;
  last.end = Math.max(last.end, end);
}

/**
 * Per-word tokens for one segment, or null when the word list is not
 * usable (missing text, missing or inverted times) and the segment's own
 * span has to stand in for it.
 */
function tokensFromWords(words: ReadonlyArray<TimedWordLike>): TimedToken[] | null {
  const out: TimedToken[] = [];
  for (const word of words) {
    const raw = normalizeTranscriptWhitespace(
      String(word?.punctuated_word ?? word?.word ?? word?.text ?? ""),
    );
    if (!raw) continue;
    const start = finiteTimeOrNull(word?.start);
    const end = finiteTimeOrNull(word?.end);
    if (start === null || end === null || end < start) return null;
    const key = stemKey(raw);
    if (!key) {
      carryPunctuation(out, raw, end);
      continue;
    }
    out.push({ raw, key, start, end });
  }
  return out.length ? out : null;
}

/**
 * A reading's segments as timed tokens, or null when it cannot be placed
 * on the time axis at all — which is the signal to fall back to the text
 * union.
 *
 * A segment with per-word times becomes one token per word at those
 * times. A segment without them — every segment of the live buffer,
 * which the ``segments`` message sends without its word list — has its
 * words spread evenly across its own span.
 *
 * That spread is an approximation of POSITION, not an invention of
 * content, and it is sound here for the reason it is NOT sound for an
 * interim (see ``retiredInterimTailBeyondCoverage``, which deliberately
 * refuses to do this): a final segment's start/end bound the words it
 * contains, whereas a rolling interim's span is the window it was
 * decoded over and can carry two words at the end of five seconds. The
 * error a spread can introduce is under a word's length inside one
 * segment, which is precisely the tolerance the ±1 s straddling window
 * exists to absorb — and the seam itself lands in a silence, which in
 * practice is a segment boundary, where the spread is exact.
 */
function timedTokens(segments: ReadonlyArray<TimedSegmentLike> | null | undefined): TimedToken[] | null {
  if (!segments || !segments.length) return null;
  const out: TimedToken[] = [];
  for (const segment of segments) {
    const words = Array.isArray(segment?.words) ? segment.words : null;
    if (words && words.length) {
      const fromWords = tokensFromWords(words);
      if (fromWords) {
        out.push(...fromWords);
        continue;
      }
    }
    const text = normalizeTranscriptWhitespace(String(segment?.text || ""));
    if (!text) continue;
    const start = finiteTimeOrNull(segment?.start);
    const end = finiteTimeOrNull(segment?.end);
    if (start === null || end === null || end < start) return null;
    const spread = alignedTokens(text);
    const step = spread.length ? (end - start) / spread.length : 0;
    spread.forEach((token, i) => {
      out.push({
        raw: token.raw,
        key: token.key,
        start: start + step * i,
        end: start + step * (i + 1),
      });
    });
  }
  return out.length ? out : null;
}

/** Busy spans of both readings, merged and ordered. */
function busyIntervals(a: ReadonlyArray<TimedToken>, b: ReadonlyArray<TimedToken>): Array<[number, number]> {
  const spans = [...a, ...b]
    .map((t): [number, number] => [t.start, t.end])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}

/** Widest silence inside ``[from, to]``, or null when there is none. */
function widestGap(
  intervals: ReadonlyArray<[number, number]>,
  from: number,
  to: number,
): [number, number] | null {
  let best: [number, number] | null = null;
  for (let i = 1; i < intervals.length; i++) {
    const gapStart = Math.max(from, intervals[i - 1][1]);
    const gapEnd = Math.min(to, intervals[i][0]);
    if (gapEnd <= gapStart) continue;
    if (!best || gapEnd - gapStart > best[1] - best[0]) best = [gapStart, gapEnd];
  }
  return best;
}

/**
 * The moment the authoritative reading takes over.
 *
 * Inside the divergence region first, because that is the span the two
 * readings actually disagree about; failing that, the nearest silence
 * just outside it (a divergence that is one continuous run of speech has
 * no silence of its own to cut at); failing that, the start of the
 * divergence itself, which hands the whole disagreement to the
 * authoritative reading — the one that decoded the recording with full
 * context.
 */
function pickSeamTime(
  held: ReadonlyArray<TimedToken>,
  authoritative: ReadonlyArray<TimedToken>,
  divergenceStart: number,
  divergenceEnd: number,
): number {
  const intervals = busyIntervals(held, authoritative);
  const inner = widestGap(intervals, divergenceStart, divergenceEnd);
  if (inner) return (inner[0] + inner[1]) / 2;
  const near = widestGap(
    intervals,
    divergenceStart - SEAM_STRADDLE_WINDOW_SEC,
    divergenceEnd + SEAM_STRADDLE_WINDOW_SEC,
  );
  if (near) return (near[0] + near[1]) / 2;
  return divergenceStart;
}

/**
 * Reconcile the ±1 s that straddles the seam, word by word.
 *
 * The two runs are aligned by the same longest-common-subsequence engine
 * the text union uses, and the opcodes are read with a different policy:
 * a span both readings have (`replace`) goes to the authoritative one, a
 * span only one has is kept, and a matched word is emitted in the
 * authoritative reading's spelling. That is what resolves a word spoken
 * across the cut — it is one word, present on both sides, and it comes
 * out once, spelled the way the full-context decode spelled it.
 */
function resolveStraddle(
  held: ReadonlyArray<TimedToken>,
  authoritative: ReadonlyArray<TimedToken>,
): TimedToken[] {
  if (!held.length) return [...authoritative];
  if (!authoritative.length) return [...held];
  const pairs = commonSubsequence(held.map((t) => t.key), authoritative.map((t) => t.key));
  // A window that cannot be aligned within the budget is a window we
  // cannot reason about; the authoritative reading owns it.
  if (!pairs) return [...authoritative];
  const out: TimedToken[] = [];
  let ai = 0;
  let bi = 0;
  const flushGap = (aEnd: number, bEnd: number): void => {
    const aRun = held.slice(ai, aEnd);
    const bRun = authoritative.slice(bi, bEnd);
    if (aRun.length && bRun.length) {
      // Two runs the alignment could not pair. If they cover the same
      // seconds they are two readings of one span and the authoritative
      // one wins (`replace`); if they do not, they are different audio
      // that merely failed to align — one reading's last words before
      // the cut against the other's first words after it — and dropping
      // either would lose speech. Emit both, in the order they were
      // spoken.
      if (runsOverlapInTime(aRun, bRun)) {
        out.push(...bRun);
      } else if (aRun[0].start <= bRun[0].start) {
        out.push(...aRun, ...bRun);
      } else {
        out.push(...bRun, ...aRun);
      }
      return;
    }
    out.push(...(aRun.length ? aRun : bRun));
  };
  for (const [pa, pb] of pairs) {
    flushGap(pa, pb);
    out.push(authoritative[pb]);
    ai = pa + 1;
    bi = pb + 1;
  }
  flushGap(held.length, authoritative.length);
  return out;
}

function timesOverlap(a: TimedToken, b: TimedToken): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Do two runs of tokens cover any of the same audio? */
function runsOverlapInTime(a: ReadonlyArray<TimedToken>, b: ReadonlyArray<TimedToken>): boolean {
  // Folded rather than spread: a run is bounded by the window, but a
  // segment with hundreds of words inside it is not something to hand to
  // ``Math.min(...)`` and its argument limit.
  const span = (run: ReadonlyArray<TimedToken>): [number, number] =>
    run.reduce<[number, number]>(
      ([lo, hi], t) => [Math.min(lo, t.start), Math.max(hi, t.end)],
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    );
  const [aStart, aEnd] = span(a);
  const [bStart, bEnd] = span(b);
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The n-gram guard: collapse a run the assembled text says twice AT THE
 * SAME TIME.
 *
 * Two readings of one recording can both carry the words around the
 * seam, and a live re-decode can restate a clause the authoritative
 * reading has once. Both look identical in text — and so does a phrase
 * the speaker really did say twice. The time is what separates them: a
 * duplicate is the SAME seconds of audio written down twice, a genuine
 * repetition is two different seconds. Only the first is dropped, and
 * the copy that goes is the earlier one, so the authoritative reading's
 * wording is what survives.
 */
function collapseOverlappingRepeats(tokens: ReadonlyArray<TimedToken>): TimedToken[] {
  const out = [...tokens];
  let k = 1;
  while (k < out.length) {
    const maxRun = Math.min(SEAM_NGRAM_MAX_WORDS, k, out.length - k);
    let collapsed = 0;
    for (let i = maxRun; i >= 1; i--) {
      let same = true;
      for (let j = 0; j < i; j++) {
        const left = out[k - i + j];
        const right = out[k + j];
        if (left.key !== right.key || !timesOverlap(left, right)) {
          same = false;
          break;
        }
      }
      if (same) {
        out.splice(k - i, i);
        collapsed = i;
        break;
      }
    }
    k = collapsed ? Math.max(1, k - collapsed) : k + 1;
  }
  return out;
}

/**
 * The words of ``heldText`` that follow everything the committed tokens
 * account for.
 *
 * Found by alignment, not by string prefix, because the held text is not
 * always its committed text plus a suffix: by the time the stop path
 * composes it, it can carry words an earlier envelope merge placed in
 * the MIDDLE. A prefix rule breaks on those and reports the entire text
 * as "the tail" — which would append the whole transcript to itself.
 * The last aligned position is the honest boundary: everything after it
 * is what no committed segment has an account of.
 */
function uncommittedTail(committed: ReadonlyArray<TimedToken>, heldText: string): string {
  const words = alignedTokens(heldText);
  if (!words.length) return "";
  const pairs = commonSubsequence(words.map((t) => t.key), committed.map((t) => t.key));
  if (!pairs || !pairs.length) return "";
  const lastAligned = pairs[pairs.length - 1][0];
  return words.slice(lastAligned + 1).map((t) => t.raw).join(" ").trim();
}

function readingText(reading: Reading | null | undefined): string {
  if (!reading) return "";
  const text = normalizeTranscriptWhitespace(reading.text || "");
  if (text) return text;
  return joinTranscriptSegments((reading.segments || []) as ReadonlyArray<TranscriptSegmentLike>);
}

function tokenText(tokens: ReadonlyArray<TimedToken>): string {
  return tokens.map((t) => t.raw).join(" ").trim();
}

/**
 * Merge two readings of one recording into the text to deliver.
 *
 * ONE entry point, and the strategy is chosen by the data: when both
 * readings can be placed on the time axis the seam-time merge above
 * runs; when either cannot — an older backend with no word times, a
 * candidate that is a plain string, a recovery decode of the file — the
 * text union does, exactly as it did before. Everything the held reading
 * holds that its own segments do not account for (the interim tail, the
 * durable recovered tail) is emitted either way.
 */
export function mergeReadings(held: Reading, authoritative: Reading): string {
  const heldText = readingText(held);
  const authoritativeText = readingText(authoritative);
  if (!heldText) return authoritativeText;
  if (!authoritativeText) return heldText;

  const heldTokens = timedTokens(held.segments);
  const authoritativeTokens = timedTokens(authoritative.segments);
  if (
    !heldTokens ||
    !authoritativeTokens ||
    heldTokens.length < UNION_MIN_ALIGNED_TOKENS ||
    authoritativeTokens.length < UNION_MIN_ALIGNED_TOKENS
  ) {
    return unionTranscripts(heldText, authoritativeText);
  }

  const pairs = commonSubsequence(
    heldTokens.map((t) => t.key),
    authoritativeTokens.map((t) => t.key),
  );
  if (!pairs) return unionTranscripts(heldText, authoritativeText);
  const shared = pairs.length / Math.max(heldTokens.length, authoritativeTokens.length);
  if (shared < UNION_MIN_SHARED_RATIO) {
    // Not two readings of the same speech. Cutting them together in time
    // would splice two different recordings.
    return unionTranscripts(heldText, authoritativeText);
  }

  // The uncommitted tail: what the held reading says AFTER everything
  // its own committed segments account for. It has no place on the time
  // axis by definition — it is the hypothesis for audio nothing has
  // finalized — so the seam never cuts it, and it is folded onto the end
  // with the same seam rules every other merge uses.
  const heldUncommittedTail = uncommittedTail(heldTokens, heldText);

  const heldMatched = new Set(pairs.map(([a]) => a));
  const authoritativeMatched = new Set(pairs.map(([, b]) => b));
  let divergenceStart = Number.POSITIVE_INFINITY;
  let divergenceEnd = Number.NEGATIVE_INFINITY;
  const noteDivergence = (token: TimedToken): void => {
    if (token.start < divergenceStart) divergenceStart = token.start;
    if (token.end > divergenceEnd) divergenceEnd = token.end;
  };
  heldTokens.forEach((token, i) => { if (!heldMatched.has(i)) noteDivergence(token); });
  authoritativeTokens.forEach((token, i) => { if (!authoritativeMatched.has(i)) noteDivergence(token); });
  if (divergenceStart > divergenceEnd) {
    // The two readings say the same words in the same order. Nothing to
    // cut: the authoritative spelling wins, plus the tail.
    return mergeInterim(authoritativeText, heldUncommittedTail);
  }

  const seamSec = pickSeamTime(heldTokens, authoritativeTokens, divergenceStart, divergenceEnd);
  const windowStart = seamSec - SEAM_STRADDLE_WINDOW_SEC;
  const windowEnd = seamSec + SEAM_STRADDLE_WINDOW_SEC;

  // The cut, and then the window.
  //
  // The cut is absolute: every held word that ENDS at or before the seam
  // is kept, every authoritative word that STARTS at or after it is
  // kept, and each reading's words in the other's region are dropped.
  // That is what stops two readings of one span from being interleaved
  // into a sentence neither of them contains.
  //
  // The window is the tolerance around it. The two clocks disagree by up
  // to a word near the cut, and a word actually spoken ACROSS the cut
  // (start before, end after) belongs to neither region by the rule
  // above — so the words within ±1 s of the seam, plus every straddling
  // word from both readings, are handed to the edit distance instead of
  // to the cut. Nothing outside the window is re-decided by it.
  const straddlesSeam = (token: TimedToken): boolean =>
    token.start < seamSec && token.end > seamSec;
  const head: TimedToken[] = [];
  const heldWindow: TimedToken[] = [];
  for (const token of heldTokens) {
    if (straddlesSeam(token)) heldWindow.push(token);
    else if (token.end > seamSec) continue;
    else if (token.end > windowStart) heldWindow.push(token);
    else head.push(token);
  }
  const tail: TimedToken[] = [];
  const authoritativeWindow: TimedToken[] = [];
  for (const token of authoritativeTokens) {
    if (straddlesSeam(token)) authoritativeWindow.push(token);
    else if (token.start < seamSec) continue;
    else if (token.start < windowEnd) authoritativeWindow.push(token);
    else tail.push(token);
  }

  const merged = collapseOverlappingRepeats([
    ...head,
    ...resolveStraddle(heldWindow, authoritativeWindow),
    ...tail,
  ]);
  return mergeInterim(tokenText(merged), heldUncommittedTail);
}
