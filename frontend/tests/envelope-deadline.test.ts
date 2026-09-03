import { describe, it, expect } from "vitest";

import { computeEnvelopeDeadlineMs } from "../src/envelope-deadline";

const CONFIG = { confirmMs: 1_500, marginMs: 800, maxWaitMs: 11_000 };

describe("computeEnvelopeDeadlineMs — PROTOCOL CONTRACT C3", () => {
  it("announcement arrives 125 ms into a 1500 ms window and extends it", () => {
    // BUGS_AUDIT_2026-09-03 §2.1: the backend announced a 6000ms budget
    // but the old code had already frozen a 1500ms cap before the
    // announcement could arrive (median +126ms). The deadline is always
    // measured from when the wait started, so a late announcement still
    // gets the full extension applied.
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 6_000, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(6_000 + CONFIG.marginMs);
    expect(deadline).toBeGreaterThan(CONFIG.confirmMs);
  });

  it("expectsMore=false does not extend", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 6_000, expectsMore: false },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.confirmMs);
  });

  it("clamps an extension to the hard ceiling", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 50_000, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.maxWaitMs);
  });

  it("never drops below the confirm window even for a tiny announced budget", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 10, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.confirmMs);
  });

  it("treats a negative budgetMs as zero rather than shrinking the window", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: -500, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.confirmMs);
  });
});
