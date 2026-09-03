/**
 * Live-transcript adoption policy.
 *
 * At stop, a local-provider recording can either re-transcribe the saved
 * file from scratch or reuse what the live assist already decoded while
 * the user was speaking. Re-transcribing costs time proportional to the
 * recording length — the "sometimes the transcript takes twenty seconds"
 * stall — but reusing is only safe when the live pass provably saw every
 * captured second and ran the same model the final pass would run.
 *
 * The decision is isolated here, as a pure function over primitives, for
 * two reasons: it is the single place the rule is defined, and it can be
 * unit tested (see ``backend/tests/test_live_coverage_policy.py``)
 * without standing up a recording session.
 *
 * Coverage has two halves and both must be clean:
 *
 *  * The **backend** half — ``complete`` — certifies that everything the
 *    server received reached the model. It is computed once, in
 *    ``LiveSession.finalize_envelope``, against the same epsilon the
 *    windowing logic uses. It is never re-derived here: a second
 *    tolerance would silently diverge from the first.
 *  * The **client** half — ``framesNeverSent`` — accounts for audio the
 *    renderer captured but never managed to hand over. The server cannot
 *    see that, so a transcript can be "complete" server-side and still be
 *    missing the words the user spoke during a slow WebSocket handshake.
 *
 * Every rejection carries a reason so the decision is visible in the
 * trace log instead of being an unexplained branch.
 */

/**
 * True when this session dropped captured audio on the client side —
 * discarded at the pending-buffer cap, lost to a failed ``send``, or
 * still queued when the socket went away. This is the client half of
 * the coverage contract (see module doc); the server cannot see this
 * loss, so it must gate adoption independently of whatever the server
 * reports.
 *
 * PROTOCOL CONTRACT R4 (BUGS_AUDIT_2026-09-03 §4.6): this predicate used
 * to be checked only on the local-assist path (``decideLiveTranscriptAdoption``
 * below); the Deepgram streaming path never read it at all, so a cold
 * backend start that silently dropped the renderer's opening frames left
 * Deepgram's live transcript looking "complete" when it was missing
 * audio the server was never given a chance to hear. One definition,
 * used by both paths.
 */
export function hasUnsentFrames(framesNeverSent: number): boolean {
  return framesNeverSent > 0;
}

export type AdoptionRejection =
  | "no-envelope"
  | "envelope-error"
  | "not-local-assist"
  | "frames-never-sent"
  | "no-coverage-report"
  | "incomplete-coverage"
  | "empty-session"
  | "model-mismatch"
  | "empty-transcript";

export interface LiveCoverageReport {
  /** True only when nothing was dropped and no tail went untranscribed. */
  complete: boolean;
  coveredSec: number;
  totalSec: number;
  /** Audio discarded because the assist fell behind its window budget. */
  droppedSec: number;
  /** Audio at the end of the stream that never reached the model. */
  uncoveredTailSec: number;
}

export interface AdoptionInput {
  /** Present only when a final envelope actually arrived. */
  envelope: {
    source: string;
    text: string;
    error?: string;
    coverage?: LiveCoverageReport;
  } | null;
  /** Model the live assist ran. */
  assistModel: string;
  /** Model the full re-transcription would run. */
  finalModel: string;
  /** Captured frames that never reached the backend. */
  framesNeverSent: number;
}

export type AdoptionDecision =
  | { adopt: true; coverage: LiveCoverageReport }
  | { adopt: false; reason: AdoptionRejection };

/**
 * Decide whether a live-assist transcript may stand in for a full
 * re-transcription. Defaults to rejection: anything unproven falls back
 * to the full pass, because not losing words outranks stopping fast.
 */
export function decideLiveTranscriptAdoption(input: AdoptionInput): AdoptionDecision {
  const { envelope } = input;
  if (!envelope) return { adopt: false, reason: "no-envelope" };
  if (envelope.error) return { adopt: false, reason: "envelope-error" };
  if (envelope.source !== "local-assist") {
    return { adopt: false, reason: "not-local-assist" };
  }
  if (hasUnsentFrames(input.framesNeverSent)) {
    return { adopt: false, reason: "frames-never-sent" };
  }
  const coverage = envelope.coverage;
  if (!coverage) return { adopt: false, reason: "no-coverage-report" };
  if (!coverage.complete) return { adopt: false, reason: "incomplete-coverage" };
  if (!(coverage.totalSec > 0)) return { adopt: false, reason: "empty-session" };
  const assistModel = String(input.assistModel || "").trim();
  const finalModel = String(input.finalModel || "").trim();
  if (!assistModel || assistModel !== finalModel) {
    return { adopt: false, reason: "model-mismatch" };
  }
  if (!String(envelope.text || "").trim()) {
    return { adopt: false, reason: "empty-transcript" };
  }
  return { adopt: true, coverage };
}

/**
 * Dead-stream / low-coverage rule for the Deepgram streaming path.
 *
 * PROTOCOL CONTRACT R2 (BUGS_AUDIT_2026-09-03, catastrophic-stop class:
 * 2026-08-27 12:09, 2026-09-02 17:52). The Deepgram socket died mid-
 * recording, the instant transcript was 2-12 characters of an 81s
 * recording, and the old code pasted that fragment because it decided
 * from the PRESENCE of a non-empty instant transcript rather than from
 * proof that the transcript is complete. Both existing recovery
 * branches were gated on ``!liveStreamErrorAtStop``, so the one signal
 * that most strongly proves the transcript is unreliable — a fatal
 * stream error — was exactly the signal that disabled recovery.
 *
 * This function decides from data, never from whether the transcript
 * happens to be non-empty:
 *
 *  - a fatal stream error at stop (the strongest signal — the provider
 *    connection is gone, nothing more will ever arrive on it);
 *  - the socket was not OPEN at the moment of stop (same failure, seen
 *    from the transport instead of from an error event);
 *  - captured audio the client never managed to hand to the socket
 *    (``hasUnsentFrames`` — the R4 predicate, shared with the
 *    local-assist adoption policy above so a cold-start frame drop is
 *    caught on both providers, not just one);
 *  - the envelope itself proves a hole (``uncoveredSpeechSec > 0`` —
 *    the backend's own interims recognised speech that no final segment
 *    covers; only knowable once the envelope has arrived, so callers
 *    that learn this after already deciding must re-run the check);
 *  - the tail-gap arithmetic used everywhere else in the stop path
 *    (recorded audio with captured activity extending past the last
 *    committed/interim speech end) says the tail was never processed.
 *
 * Any one of these is sufficient. When it fires, the caller MUST run
 * the full-audio decode of the saved recording (the existing
 * transcribe-on-disk path) and deliver the union/richer result — the
 * instant fragment must never be pasted on its own.
 */
export type LowCoverageReason =
  | "stream-error"
  | "socket-not-open"
  | "frames-never-sent"
  | "uncovered-speech"
  | "tail-gap"
  | "none";

export interface LowCoverageInput {
  /** The live-stream error snapshot taken at stop, if any (fatal). */
  liveStreamErrorAtStop: boolean;
  /** Was the WebSocket in the OPEN state at the moment of stop? */
  wsOpenAtStop: boolean;
  /** Captured frames that never reached the backend (the R4 predicate's input). */
  framesNeverSent: number;
  /**
   * Seconds of recognised speech no final segment covers. Pass 0 (not
   * yet known) before the envelope has arrived — this alone will never
   * trigger recovery; re-run the check once the envelope's real value
   * is known so a hole discovered mid-wait still escalates.
   */
  uncoveredSpeechSec: number;
  recordedSec: number;
  /** True once at least one committed/interim segment has a timestamp — the tail-gap arithmetic is meaningless without one. */
  hasTimestampedLiveCoverage: boolean;
  /** Recording duration minus the last committed/interim speech end. */
  tailGapSec: number;
  /** Captured PCM activity extends past the last speech end by a meaningful margin. */
  tailHasCapturedActivity: boolean;
  /** An interim (uncommitted) segment holds speech at the tail. */
  tailHasInterimSpeechEvidence: boolean;
}

export interface LowCoverageDecision {
  recover: boolean;
  reason: LowCoverageReason;
}

/**
 * Below this, a gap between the recording's end and the last
 * recognised speech is ordinary trailing silence (endpointing latency,
 * the pause before the user hit Stop), not evidence of missing words.
 * Matches the threshold the tail-gap trace log has used since it was
 * introduced — kept as one constant rather than a second copy so the
 * two never drift.
 */
export const TAIL_GAP_THRESHOLD_SEC = 0.6;

export function decideDeadStreamRecovery(input: LowCoverageInput): LowCoverageDecision {
  if (input.liveStreamErrorAtStop) return { recover: true, reason: "stream-error" };
  if (!input.wsOpenAtStop) return { recover: true, reason: "socket-not-open" };
  if (hasUnsentFrames(input.framesNeverSent)) return { recover: true, reason: "frames-never-sent" };
  if (input.uncoveredSpeechSec > 0) return { recover: true, reason: "uncovered-speech" };
  const tailLikelyMissing =
    input.recordedSec > 1.0 &&
    input.hasTimestampedLiveCoverage &&
    input.tailGapSec > TAIL_GAP_THRESHOLD_SEC &&
    (input.tailHasCapturedActivity || input.tailHasInterimSpeechEvidence);
  if (tailLikelyMissing) return { recover: true, reason: "tail-gap" };
  return { recover: false, reason: "none" };
}
