/**
 * The stop-path envelope decision — the single place that answers the
 * two questions a stop has to ask about the backend's ``final``
 * envelope: how long may we wait for it, and did one arrive at all.
 *
 * The envelope is the ONLY source of the delivered transcript. The
 * backend builds it complete by construction (Deepgram finals +
 * word-level interim splice + dual-stream merge + REST re-decode of any
 * uncovered span from its own audio spool, all before it is sent), so
 * the renderer neither assembles nor improves on it: it delivers
 * ``envelope.text`` verbatim, and the one thing it still has to decide
 * is what to do when no envelope exists.
 *
 * ── How long to wait (``computeEnvelopeDeadlineMs``) ─────────────────
 *
 * BUGS_AUDIT_2026-09-03 §2.1, PROTOCOL CONTRACT C3. The previous
 * version read the announcement out of a plain ``Map`` exactly once,
 * synchronously, right as the fast path entered — before the backend's
 * ``finalizing`` message could possibly have arrived (median +126ms,
 * p90 +186ms after the read). 312 of 479 measured stops picked a budget
 * the backend had already told them was wrong, because nothing about
 * the read could ever see a message that showed up later.
 *
 * The fix in main.tsx is a real race: the wait starts with a deadline of
 * ``confirmMs`` (the same ceiling as before an announcement exists), and
 * if a ``finalizing`` announcement arrives WHILE the wait is still
 * running, this function recomputes the deadline and the wait keeps
 * going instead of having already given up. Deadlines are always
 * measured from when the wait started (``tEnv``), never from when the
 * announcement happened to arrive — an announcement 125ms late does not
 * mean the caller only gets 125ms less consideration, it means the
 * caller now knows the real number and can act on it for whatever time
 * is left.
 *
 * ── Did one arrive (``envelopeMissing``) ─────────────────────────────
 *
 * One predicate, one fallback. Everything the stop path used to do when
 * the envelope looked thin — union it with the live preview, race it
 * against a REST re-decode, graft a renderer-side "recovered tail" onto
 * it — was a second owner of the transcript competing with the first,
 * and every duplication defect of 2026-09-03/04 came out of that
 * competition. There is now exactly one question left, and exactly one
 * thing to do when the answer is yes.
 *
 * Pure: no DOM, no state. Unit-tested in tests/envelope-deadline.test.ts.
 */

/** The backend's ``{type:"finalizing", budgetMs, expectsMore}`` message. */
export interface FinalizeBudgetAnnouncement {
  /** Worst case, in ms, the backend may spend flushing the provider. */
  budgetMs: number;
  /**
   * The backend's coverage verdict: is this wait expected to add words
   * we do not already have? Not a guess — computed from the same tail-
   * coverage arithmetic the backend uses everywhere else.
   */
  expectsMore: boolean;
}

export interface EnvelopeDeadlineConfig {
  /**
   * Window kept when the backend does not expect the wait to add
   * anything (``expectsMore: false``) — waiting longer for a message
   * the producer says is not coming is pure latency. Also the deadline
   * in effect before any announcement has arrived.
   */
  confirmMs: number;
  /** Delivery slack added on top of the announced budget: one WS hop plus the backend's own close. */
  marginMs: number;
  /** Hard ceiling regardless of what was announced — a stop must end. */
  maxWaitMs: number;
}

/**
 * Recompute the envelope-wait deadline (in ms since the wait started)
 * for a ``finalizing`` announcement.
 *
 * When ``expectsMore`` is true, the deadline extends to cover the
 * announced budget plus delivery slack, clamped to
 * ``[confirmMs, maxWaitMs]`` — never shorter than the confirmation
 * window already in effect, never longer than the hard ceiling.
 *
 * When ``expectsMore`` is false, the deadline stays at ``confirmMs``:
 * the announcement confirms there is nothing more to wait for, so the
 * wait is not extended past the window it already had.
 */
export function computeEnvelopeDeadlineMs(
  announcement: FinalizeBudgetAnnouncement,
  config: EnvelopeDeadlineConfig,
): number {
  const { confirmMs, marginMs, maxWaitMs } = config;
  if (!announcement.expectsMore) {
    return confirmMs;
  }
  const extended = Math.max(0, announcement.budgetMs) + marginMs;
  return Math.min(Math.max(extended, confirmMs), maxWaitMs);
}

/**
 * What the stop path reads off a ``final`` envelope in order to decide
 * whether one arrived. Deliberately narrow: the coverage numbers the
 * envelope also carries (``uncoveredSpeechSec``, ``coveredEndSec``, …)
 * are diagnostics now, not inputs — the backend closes its own holes
 * before it sends, so a renderer that re-derived "is this complete
 * enough" from them would be second-guessing the only owner there is.
 */
export interface StopEnvelopeLike {
  /** The delivered transcript. Empty is a legitimate answer: silence. */
  text?: string;
  /**
   * Set when the session failed instead of finishing — the backend's
   * own error, or the synthetic envelope ``ws.onclose`` resolves the
   * slot with when the socket dies mid-stop.
   */
  error?: string;
}

/** Where the delivered transcript came from — printed on the FINAL trace line. */
export type StopTranscriptSource =
  /** The backend's ``final`` envelope, delivered verbatim. */
  | "envelope"
  /** Full-audio decode of the saved recording (``transcribe-on-disk``). */
  | "ondisk-fallback"
  /** A non-streaming remote provider's own full-audio pass. */
  | "remote"
  /** Nothing was delivered. */
  | "none";

/**
 * Is the envelope absent?
 *
 * Two ways, and only two: nothing resolved the session's final slot
 * before the deadline expired (or the socket never existed), or what
 * resolved it is an error rather than a transcript. Either one means
 * the backend produced no reading of this recording at all, which is
 * the single condition under which the renderer falls back to decoding
 * the saved audio itself.
 *
 * An envelope with EMPTY text and no error is not missing — it is the
 * backend saying the recording holds no speech, and re-decoding it
 * would cost the user seconds to be told the same thing again.
 */
export function envelopeMissing(envelope: StopEnvelopeLike | null | undefined): boolean {
  if (!envelope) return true;
  return !!String(envelope.error || "").trim();
}

/**
 * The delivered transcript when an envelope IS present: its own text,
 * verbatim.
 *
 * Verbatim is the whole point. Sessions 521f9788 and 8c12d76e
 * (2026-09-04) were pasted with whole clauses twice because the stop
 * path merged the live preview's reading of the same speech into the
 * envelope's; the preview restates ground the envelope already covers,
 * in slightly different words, and no alignment can reliably tell that
 * apart from new speech. Only the surrounding whitespace is trimmed —
 * every character the backend chose is delivered as it chose it.
 */
export function envelopeTranscript(envelope: StopEnvelopeLike | null | undefined): string {
  return String(envelope?.text ?? "").trim();
}
