import { describe, it, expect } from "vitest";

import {
  decideLiveTranscriptAdoption,
  hasUnsentFrames,
} from "../src/live-coverage";

// The Deepgram path's dead-stream and envelope-coverage rules
// (decideDeadStreamRecovery, envelopeCoversRecording) are deleted with
// their tests: that path asks one question now — did an envelope arrive
// — and it is answered by ``envelopeMissing`` in ./envelope-deadline.
// What remains here is the LOCAL provider's adoption policy.
describe("hasUnsentFrames — the client half of the local adoption gate", () => {
  it("is false for zero", () => {
    expect(hasUnsentFrames(0)).toBe(false);
  });
  it("is true for any positive count", () => {
    expect(hasUnsentFrames(1)).toBe(true);
  });
});

describe("decideLiveTranscriptAdoption gates on frames-never-sent", () => {
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
