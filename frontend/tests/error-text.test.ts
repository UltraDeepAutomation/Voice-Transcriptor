import { describe, it, expect, vi } from "vitest";

import {
  MAX_ERROR_TEXT,
  describeError,
  installErrorAwareConsole,
  needsErrorText,
} from "../src/error-text";

describe("describeError", () => {
  it("renders a DOMException with its name, which is the diagnostic part", () => {
    // The regression this exists for: every recording fell back from
    // AudioWorklet to ScriptProcessor and the log said only
    // "[object DOMException]". The name is what separates a CSP refusal
    // from a permission denial from a cancellation.
    const err = new DOMException("Failed to load module script", "NotSupportedError");
    expect(describeError(err)).toBe("NotSupportedError: Failed to load module script");
  });

  it("renders an Error the same way", () => {
    expect(describeError(new TypeError("nope"))).toBe("TypeError: nope");
  });

  it("falls back to the bare name when there is no message", () => {
    expect(describeError(new DOMException("", "AbortError"))).toBe("AbortError");
  });

  it("keeps strings and numbers as they are", () => {
    expect(describeError("plain reason")).toBe("plain reason");
    expect(describeError(42)).toBe("42");
  });

  it("handles null and undefined without throwing", () => {
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("reads name/message off an error-shaped plain object", () => {
    // Structured-clone copies across a worker boundary lose their
    // prototype but keep the fields.
    expect(describeError({ name: "QuotaExceededError", message: "disk full" }))
      .toBe("QuotaExceededError: disk full");
  });

  it("serialises a plain object rather than printing [object Object]", () => {
    expect(describeError({ code: 7, detail: "x" })).toBe('{"code":7,"detail":"x"}');
  });

  it("survives an unserialisable object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });

  it("clips a pathological message and says how much was dropped", () => {
    const err = new Error("x".repeat(MAX_ERROR_TEXT + 120));
    const out = describeError(err);
    expect(out.length).toBeLessThan(MAX_ERROR_TEXT + 60);
    expect(out).toContain("chars)");
  });
});

describe("needsErrorText", () => {
  it("is true for the values that format as [object …]", () => {
    expect(needsErrorText(new Error("x"))).toBe(true);
    expect(needsErrorText(new DOMException("x", "AbortError"))).toBe(true);
    expect(needsErrorText({ a: 1 })).toBe(true);
  });

  it("is false for values that already print readably", () => {
    expect(needsErrorText("text")).toBe(false);
    expect(needsErrorText(7)).toBe(false);
    expect(needsErrorText(null)).toBe(false);
    expect(needsErrorText(undefined)).toBe(false);
  });
});

describe("installErrorAwareConsole", () => {
  const makeConsole = () => ({ warn: vi.fn(), error: vi.fn() });

  it("rewrites only the error argument, leaving the context message alone", () => {
    const c = makeConsole();
    const original = { warn: c.warn, error: c.error };
    installErrorAwareConsole(c);
    c.warn("AudioWorklet capture init failed", new DOMException("blocked", "NotSupportedError"));
    expect(original.warn).toHaveBeenCalledWith(
      "AudioWorklet capture init failed",
      "NotSupportedError: blocked",
    );
  });

  it("wraps error as well as warn", () => {
    const c = makeConsole();
    const original = { error: c.error };
    installErrorAwareConsole(c);
    c.error("boom", new Error("detail"));
    expect(original.error).toHaveBeenCalledWith("boom", "Error: detail");
  });

  it("is idempotent, so a hot reload cannot stack wrappers", () => {
    const c = makeConsole();
    const original = c.warn;
    installErrorAwareConsole(c);
    const wrappedOnce = c.warn;
    installErrorAwareConsole(c);
    expect(c.warn).toBe(wrappedOnce);
    c.warn("x", new Error("y"));
    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith("x", "Error: y");
  });

  it("passes non-error arguments through untouched", () => {
    const c = makeConsole();
    const original = c.warn;
    installErrorAwareConsole(c);
    c.warn("just", "strings", 5);
    expect(original).toHaveBeenCalledWith("just", "strings", 5);
  });
});
