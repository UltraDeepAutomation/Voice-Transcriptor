import { describe, it, expect } from "vitest";

import {
  captureElapsedMs,
  decidePreRoll,
  decideWarmHold,
  decideWarmReuse,
  isBluetoothInputLabel,
  type WarmHoldInput,
  type WarmReuseInput,
} from "../src/capture-warm";

const holdInput: WarmHoldInput = {
  warmHoldMs: 30_000,
  deviceLabel: "MacBook Pro Microphone",
  trackLive: true,
  contextState: "running",
  workletCapture: true,
};

const reuseInput: WarmReuseInput = {
  now: 10_000,
  heldSince: 5_000,
  warmHoldMs: 30_000,
  heldDeviceId: "mic-a",
  requestedDeviceId: "mic-a",
  trackLive: true,
  contextState: "running",
};

describe("isBluetoothInputLabel", () => {
  it("matches the labels a Bluetooth headset reports, whatever the case", () => {
    expect(isBluetoothInputLabel("AirPods Pro")).toBe(true);
    expect(isBluetoothInputLabel("Leo's Beats Fit Pro")).toBe(true);
    expect(isBluetoothInputLabel("Bluetooth Hands-Free")).toBe(true);
    expect(isBluetoothInputLabel("WH-1000XM5 (Hands-Free AG Audio)")).toBe(true);
  });

  it("leaves wired and built-in inputs alone", () => {
    expect(isBluetoothInputLabel("MacBook Pro Microphone")).toBe(false);
    expect(isBluetoothInputLabel("Yeti Stereo Microphone")).toBe(false);
    expect(isBluetoothInputLabel("External Microphone")).toBe(false);
  });

  it("treats an unnamed device as Bluetooth", () => {
    // A device we cannot name is a device we cannot clear, and the cost
    // of the two mistakes is not symmetric: a false positive costs one
    // optimisation, a false negative degrades the user's headset audio
    // for the whole hold window.
    expect(isBluetoothInputLabel("")).toBe(true);
    expect(isBluetoothInputLabel("   ")).toBe(true);
  });
});

describe("decideWarmHold", () => {
  it("holds a live worklet graph on a wired microphone", () => {
    expect(decideWarmHold(holdInput)).toEqual({ hold: true, reason: "held" });
  });

  it("holds nothing when the TTL is zero — the documented off switch", () => {
    expect(decideWarmHold({ ...holdInput, warmHoldMs: 0 })).toEqual({
      hold: false,
      reason: "disabled",
    });
  });

  it("never holds a Bluetooth input", () => {
    // HFP: any application holding the input keeps the headset in the
    // narrowband hands-free profile and out of A2DP, for the whole hold.
    expect(decideWarmHold({ ...holdInput, deviceLabel: "AirPods Max" })).toEqual({
      hold: false,
      reason: "bluetooth",
    });
  });

  it("never holds a ScriptProcessor session — there is no ring to fill", () => {
    expect(decideWarmHold({ ...holdInput, workletCapture: false })).toEqual({
      hold: false,
      reason: "script-fallback",
    });
  });

  it("does not hold a graph whose track or context has already gone", () => {
    expect(decideWarmHold({ ...holdInput, trackLive: false })).toEqual({
      hold: false,
      reason: "track-ended",
    });
    expect(decideWarmHold({ ...holdInput, contextState: "suspended" })).toEqual({
      hold: false,
      reason: "context-suspended",
    });
    expect(decideWarmHold({ ...holdInput, contextState: "" })).toEqual({
      hold: false,
      reason: "context-unknown",
    });
  });
});

describe("decideWarmReuse", () => {
  it("adopts a graph held for less than the TTL on the same device", () => {
    expect(decideWarmReuse(reuseInput)).toEqual({ reuse: true, reason: "reused" });
  });

  it("refuses a graph older than the TTL even when the timer has not fired", () => {
    // The case this exists for: setTimeout does not run while the
    // machine is asleep, so a lid closed for two hours would otherwise
    // hand a two-hour-old MediaStream to the next press.
    expect(decideWarmReuse({ ...reuseInput, now: 5_000 + 30_001 })).toEqual({
      reuse: false,
      reason: "expired",
    });
    // A clock that moved backwards is not evidence of freshness either.
    expect(decideWarmReuse({ ...reuseInput, now: 4_000 })).toEqual({
      reuse: false,
      reason: "expired",
    });
  });

  it("refuses a graph on a different device than the one now selected", () => {
    expect(decideWarmReuse({ ...reuseInput, requestedDeviceId: "mic-b" })).toEqual({
      reuse: false,
      reason: "device-changed",
    });
  });

  it("accepts the held device when the picker asks for the system default", () => {
    expect(decideWarmReuse({ ...reuseInput, requestedDeviceId: "" })).toEqual({
      reuse: true,
      reason: "reused",
    });
  });

  it("refuses a graph whose track ended or whose context stopped running", () => {
    expect(decideWarmReuse({ ...reuseInput, trackLive: false })).toEqual({
      reuse: false,
      reason: "track-ended",
    });
    expect(decideWarmReuse({ ...reuseInput, contextState: "interrupted" })).toEqual({
      reuse: false,
      reason: "context-interrupted",
    });
  });

  it("reuses nothing when the hold is switched off", () => {
    expect(decideWarmReuse({ ...reuseInput, warmHoldMs: 0 })).toEqual({
      reuse: false,
      reason: "disabled",
    });
  });
});

describe("decidePreRoll", () => {
  const freshRing = { sampleCount: 24_000, sampleRate: 48_000, staleMs: 2, maxAgeMs: 2_000 };

  it("accepts the half-second the ring was holding at the press", () => {
    const verdict = decidePreRoll(freshRing);
    expect(verdict.accept).toBe(true);
    expect(verdict.reason).toBe("accepted");
    expect(verdict.durationMs).toBeCloseTo(500, 6);
    expect(verdict.ageMs).toBeCloseTo(502, 6);
  });

  it("drops a ring that stopped being written — a slept machine", () => {
    // The ring still holds audio, but it is audio from some earlier
    // minute; prepending it would put words the user never just said at
    // the front of the transcript.
    const verdict = decidePreRoll({ ...freshRing, staleMs: 90_000 });
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("stale");
  });

  it("drops the ring the moment its oldest sample passes the age limit", () => {
    // 2 s of ring, 2 s limit: the oldest sample is exactly at the limit
    // and stays; one millisecond more and the whole ring goes.
    expect(decidePreRoll({ ...freshRing, sampleCount: 96_000, staleMs: 0 }).accept).toBe(true);
    expect(decidePreRoll({ ...freshRing, sampleCount: 96_000, staleMs: 1 }).accept).toBe(false);
  });

  it("has nothing to say about an empty or rate-less ring", () => {
    expect(decidePreRoll({ ...freshRing, sampleCount: 0 })).toEqual({
      accept: false, durationMs: 0, ageMs: 0, reason: "empty",
    });
    expect(decidePreRoll({ ...freshRing, sampleRate: 0 })).toEqual({
      accept: false, durationMs: 0, ageMs: 0, reason: "empty",
    });
  });

  it("treats an unknown staleness as the ring's own age", () => {
    const verdict = decidePreRoll({ ...freshRing, staleMs: Number.NaN });
    expect(verdict.accept).toBe(true);
    expect(verdict.ageMs).toBeCloseTo(500, 6);
  });
});

describe("captureElapsedMs — one clock for 'is this a recording yet?'", () => {
  it("measures a cold start from the press, not the first frame (§4.9)", () => {
    // The press at 1000, the first sample 310 ms later: at 1600 the user
    // has held the hotkey for 600 ms, and a 500 ms floor must keep the
    // recording. Measuring from the frame would say 290 ms and drop a
    // one-word dictation.
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 1_000, startAt: 1_310 })).toBe(600);
  });

  it("measures a warm start from the audio, which begins before the press (§4.7)", () => {
    // Pre-roll: the recording contains half a second captured before the
    // hotkey, so the audio's own clock is the earlier one.
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 1_000, startAt: 500 })).toBe(1_100);
  });

  it("uses whichever clock has started when only one has", () => {
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 0, startAt: 1_310 })).toBe(290);
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 1_000, startAt: 0 })).toBe(600);
  });

  it("is zero before either clock starts, and never negative", () => {
    expect(captureElapsedMs({ now: 1_600, startRequestedAt: 0, startAt: 0 })).toBe(0);
    expect(captureElapsedMs({ now: 900, startRequestedAt: 1_000, startAt: 0 })).toBe(0);
  });
});
