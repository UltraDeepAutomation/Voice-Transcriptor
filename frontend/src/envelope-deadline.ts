/**
 * The stop-path envelope wait's deadline decision — the single place
 * that turns a backend ``finalizing`` announcement into "how much longer
 * do we wait for the final envelope".
 *
 * Extracted as a pure function (BUGS_AUDIT_2026-09-03 §2.1, PROTOCOL
 * CONTRACT C3) because the previous version read the announcement out
 * of a plain ``Map`` exactly once, synchronously, right as the fast path
 * entered — before the backend's ``finalizing`` message could possibly
 * have arrived (median +126ms, p90 +186ms after the read). 312 of 479
 * measured stops picked a budget the backend had already told them was
 * wrong, because nothing about the read could ever see a message that
 * showed up later.
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
