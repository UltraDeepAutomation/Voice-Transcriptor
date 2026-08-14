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
  if (input.framesNeverSent > 0) {
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
