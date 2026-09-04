import { describe, expect, it } from "vitest";
import {
  decideUploadQueueRestore,
  shouldDropLegacyUploadQueueSnapshot,
} from "../src/upload-queue-restore";

describe("decideUploadQueueRestore", () => {
  it("never writes anything back when the backend read failed", () => {
    expect(
      decideUploadQueueRestore({
        serverReadOk: false,
        queueEmptyAfterServer: true,
        legacyAvailable: false,
      }),
    ).toEqual({
      adoptLegacy: false,
      markLoaded: false,
      persist: false,
      reason: "server-read-failed",
    });
  });

  it("still refuses to write when a legacy snapshot exists but the backend read failed", () => {
    // The legacy copy is not evidence about the server's file: adopting it and
    // persisting would replace the server's queue with a stale local one.
    const decision = decideUploadQueueRestore({
      serverReadOk: false,
      queueEmptyAfterServer: true,
      legacyAvailable: true,
    });
    expect(decision.persist).toBe(false);
    expect(decision.adoptLegacy).toBe(false);
    expect(decision.markLoaded).toBe(false);
  });

  it("keeps the loaded latch down after a failed read so a later attempt can retry", () => {
    expect(
      decideUploadQueueRestore({
        serverReadOk: false,
        queueEmptyAfterServer: false,
        legacyAvailable: false,
      }).markLoaded,
    ).toBe(false);
  });

  it("adopts the server snapshot when the read succeeded and returned items", () => {
    expect(
      decideUploadQueueRestore({
        serverReadOk: true,
        queueEmptyAfterServer: false,
        legacyAvailable: true,
      }),
    ).toEqual({
      adoptLegacy: false,
      markLoaded: true,
      persist: true,
      reason: "server-snapshot",
    });
  });

  it("falls back to the legacy snapshot only when the server was read and was empty", () => {
    expect(
      decideUploadQueueRestore({
        serverReadOk: true,
        queueEmptyAfterServer: true,
        legacyAvailable: true,
      }),
    ).toEqual({
      adoptLegacy: true,
      markLoaded: true,
      persist: true,
      reason: "legacy-snapshot",
    });
  });

  it("marks a genuinely empty backend queue as loaded", () => {
    expect(
      decideUploadQueueRestore({
        serverReadOk: true,
        queueEmptyAfterServer: true,
        legacyAvailable: false,
      }),
    ).toEqual({
      adoptLegacy: false,
      markLoaded: true,
      persist: true,
      reason: "server-snapshot",
    });
  });
});

describe("shouldDropLegacyUploadQueueSnapshot", () => {
  it("drops the legacy key only after a write that actually succeeded", () => {
    expect(shouldDropLegacyUploadQueueSnapshot({ persisted: true, saveOk: true })).toBe(true);
  });

  it("keeps the legacy key when the write failed", () => {
    expect(shouldDropLegacyUploadQueueSnapshot({ persisted: true, saveOk: false })).toBe(false);
  });

  it("keeps the legacy key when nothing was written at all", () => {
    expect(shouldDropLegacyUploadQueueSnapshot({ persisted: false, saveOk: true })).toBe(false);
  });
});
