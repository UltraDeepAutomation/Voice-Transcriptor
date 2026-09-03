import { describe, it, expect } from "vitest";

import {
  decideDeadStreamRecovery,
  decideLiveTranscriptAdoption,
  hasUnsentFrames,
  TAIL_GAP_THRESHOLD_SEC,
  type LowCoverageInput,
} from "../src/live-coverage";

const baseInput: LowCoverageInput = {
  liveStreamErrorAtStop: false,
  wsOpenAtStop: true,
  framesNeverSent: 0,
  uncoveredSpeechSec: 0,
  recordedSec: 30,
  hasTimestampedLiveCoverage: true,
  tailGapSec: 0.1,
  tailHasCapturedActivity: false,
  tailHasInterimSpeechEvidence: false,
};

describe("hasUnsentFrames — R4", () => {
  it("is false for zero", () => {
    expect(hasUnsentFrames(0)).toBe(false);
  });
  it("is true for any positive count", () => {
    expect(hasUnsentFrames(1)).toBe(true);
  });
});

describe("decideDeadStreamRecovery — R2 (dead-stream / low-coverage rule)", () => {
  it("recovers on a fatal stream error even though the instant transcript is non-empty", () => {
    // BUGS_AUDIT_2026-09-03 catastrophic class (2026-08-27 12:09,
    // 2026-09-02 17:52): a 2-12 character fragment of an 81s recording
    // used to get pasted because the old code decided from "is there
    // text" rather than "is the stream provably dead". A fatal error is
    // the STRONGEST reason to recover, not a reason to skip it.
    const decision = decideDeadStreamRecovery({
      ...baseInput,
      liveStreamErrorAtStop: true,
      tailGapSec: 0, // even with no measurable tail gap at all
    });
    expect(decision).toEqual({ recover: true, reason: "stream-error" });
  });

  it("recovers when the socket was not OPEN at stop", () => {
    const decision = decideDeadStreamRecovery({ ...baseInput, wsOpenAtStop: false });
    expect(decision).toEqual({ recover: true, reason: "socket-not-open" });
  });

  it("recovers when captured frames never reached the transport", () => {
    const decision = decideDeadStreamRecovery({ ...baseInput, framesNeverSent: 3 });
    expect(decision).toEqual({ recover: true, reason: "frames-never-sent" });
  });

  it("recovers when the envelope proves uncovered speech", () => {
    const decision = decideDeadStreamRecovery({ ...baseInput, uncoveredSpeechSec: 1.2 });
    expect(decision).toEqual({ recover: true, reason: "uncovered-speech" });
  });

  it("recovers on an implausible tail gap with captured activity", () => {
    const decision = decideDeadStreamRecovery({
      ...baseInput,
      tailGapSec: TAIL_GAP_THRESHOLD_SEC + 0.1,
      tailHasCapturedActivity: true,
    });
    expect(decision).toEqual({ recover: true, reason: "tail-gap" });
  });

  it("recovers on an implausible tail gap backed only by interim speech evidence", () => {
    const decision = decideDeadStreamRecovery({
      ...baseInput,
      tailGapSec: TAIL_GAP_THRESHOLD_SEC + 0.1,
      tailHasInterimSpeechEvidence: true,
    });
    expect(decision).toEqual({ recover: true, reason: "tail-gap" });
  });

  it("does not recover a clean stop with a short trailing-silence gap", () => {
    const decision = decideDeadStreamRecovery(baseInput);
    expect(decision).toEqual({ recover: false, reason: "none" });
  });

  it("does not treat a plain tail gap as missing without timestamped coverage or captured/interim evidence", () => {
    const decision = decideDeadStreamRecovery({
      ...baseInput,
      tailGapSec: 5,
      hasTimestampedLiveCoverage: false,
    });
    expect(decision).toEqual({ recover: false, reason: "none" });
  });
});

describe("decideLiveTranscriptAdoption still gates on frames-never-sent via the shared predicate", () => {
  it("rejects adoption when frames were never sent", () => {
    const decision = decideLiveTranscriptAdoption({
      envelope: {
        source: "local-assist",
        text: "hello world",
        coverage: { complete: true, coveredSec: 10, totalSec: 10, droppedSec: 0, uncoveredTailSec: 0 },
      },
      assistModel: "base",
      finalModel: "base",
      framesNeverSent: 1,
    });
    expect(decision).toEqual({ adopt: false, reason: "frames-never-sent" });
  });
});
