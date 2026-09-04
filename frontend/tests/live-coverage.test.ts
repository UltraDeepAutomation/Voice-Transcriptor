import { describe, it, expect } from "vitest";

import {
  decideDeadStreamRecovery,
  decideLiveTranscriptAdoption,
  envelopeAudioEndSec,
  envelopeCoversRecording,
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

describe("envelopeCoversRecording — D1 (session 62115e77, 2026-09-03T21:42:09Z)", () => {
  // The envelope that ended the race 130 ms after CloseStream: the
  // backend had streamed 14.26 s (456192 bytes at 16 kHz) and its last
  // final ended at 10.85 s. The clause "Напиши, на чем кто вас
  // поверил." arrived 2.7 s later and was never delivered.
  const truncatedEnvelope = {
    streamedSec: 14.26,
    coveredEndSec: 10.85,
    uncoveredSpeechSec: 0,
    recordedSec: 14.3,
  };

  it("rejects the envelope that stopped 3.4 s before the audio did", () => {
    expect(envelopeCoversRecording(truncatedEnvelope)).toBe(false);
  });

  it("accepts an envelope whose last final reaches the end of the stream", () => {
    expect(envelopeCoversRecording({ ...truncatedEnvelope, coveredEndSec: 14.2 })).toBe(true);
  });

  it("treats a gap at the tail-gap threshold as trailing silence, not a cut", () => {
    expect(
      envelopeCoversRecording({
        streamedSec: 10,
        coveredEndSec: 10 - TAIL_GAP_THRESHOLD_SEC,
        recordedSec: 10,
      }),
    ).toBe(true);
    expect(
      envelopeCoversRecording({
        streamedSec: 10,
        coveredEndSec: 10 - TAIL_GAP_THRESHOLD_SEC - 0.01,
        recordedSec: 10,
      }),
    ).toBe(false);
  });

  it("rejects any envelope that proved a hole, however well it covers the tail", () => {
    expect(
      envelopeCoversRecording({
        streamedSec: 10,
        coveredEndSec: 10,
        uncoveredSpeechSec: 0.4,
        recordedSec: 10,
      }),
    ).toBe(false);
  });

  it("rejects an envelope with no finals at all against a real recording", () => {
    expect(envelopeCoversRecording({ streamedSec: 14.26, coveredEndSec: 0, recordedSec: 14.3 })).toBe(false);
  });

  it("does not call an envelope incomplete when the backend sent no coverage fields", () => {
    // C5 fields are optional: an older backend omits them, and "no
    // field" must never be read as "not covered" — that would send
    // every stop through full-audio recovery on a protocol mismatch.
    expect(envelopeCoversRecording({ recordedSec: 14.3 })).toBe(true);
    expect(envelopeCoversRecording({})).toBe(true);
  });

  it("measures against the later of streamed and recorded seconds", () => {
    // The two numbers measure one axis from the two ends of the socket.
    expect(envelopeAudioEndSec({ streamedSec: 9, recordedSec: 14.26 })).toBe(14.26);
    expect(envelopeAudioEndSec({ streamedSec: 14.26, recordedSec: 9 })).toBe(14.26);
    expect(envelopeAudioEndSec({})).toBe(0);
    // A renderer that recorded 14.26 s is not covered by a transcript
    // that ends at 10.85 s even when the backend only ever received 11 s.
    expect(
      envelopeCoversRecording({ streamedSec: 11, coveredEndSec: 10.85, recordedSec: 14.26 }),
    ).toBe(false);
  });

  it("cannot judge coverage with no covered end, and says so by accepting", () => {
    expect(envelopeCoversRecording({ streamedSec: 14.26, recordedSec: 14.3 })).toBe(true);
  });
});
