import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The design tokens are an SSOT, and a `var(--x, #literal)` is the one
 * construct that lets a violation of it render perfectly.
 *
 * Five tokens were referenced by name and declared nowhere, so every use
 * silently painted its inline fallback instead — and where the same
 * missing token was written twice with two different fallbacks
 * (`--text-dim` as `#9aa` and as `#aab`) the palette had a colour the
 * palette did not know about, in two shades. A stylesheet cannot fail a
 * type check, so this stands in for one.
 *
 * The rules deliberately stop short of banning fallbacks outright: a
 * fallback on a DECLARED token is a legitimate defence for the boot
 * window before the stylesheet parses. What is banned is a reference to
 * a token that does not exist, and two disagreeing fallbacks for one
 * token.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

/** Custom properties this file declares, anywhere (`--x: value`). */
function declaredTokens(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}

/** Every `var(--x…)` reference, with its fallback text when present. */
function tokenReferences(source: string): Array<{ token: string; fallback: string }> {
  const out: Array<{ token: string; fallback: string }> = [];
  for (const m of source.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g)) {
    out.push({ token: m[1], fallback: (m[2] || "").trim() });
  }
  return out;
}

describe("styles.css design tokens", () => {
  const declared = declaredTokens(css);
  const references = tokenReferences(css);

  it("finds the palette (sanity check on the parser)", () => {
    expect(declared.has("--text-2")).toBe(true);
    expect(references.length).toBeGreaterThan(100);
  });

  it("references no token that is never declared", () => {
    const undeclared = [...new Set(
      references.filter((r) => !declared.has(r.token)).map((r) => r.token),
    )].sort();
    expect(undeclared).toEqual([]);
  });

  it("carries no fallback literal for a token it declares", () => {
    // A fallback on a declared token can never be used, but it can
    // disagree — and nine of them did, so `--text-2` was written as
    // four different colours (`#a0a0a0` eleven times, `#777777` five,
    // `#c4c4c4`, `#6b7280`) while its actual value was a fifth thing.
    // A reader comparing two rules had no way to know which literal, if
    // any, described the palette. The token is the answer; there is no
    // second one to keep in sync.
    const redundant = [...new Set(
      references.filter((r) => r.fallback && declared.has(r.token)).map((r) => r.token),
    )].sort();
    expect(redundant).toEqual([]);
  });
});

describe("styles.css is the only stylesheet", () => {
  it("index.html links no external stylesheet, so nothing outside the bundle can carry rules", () => {
    // `frontend/styles.css` held the whole update-check block and was
    // imported by nothing; this is what made that invisible.
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(/<link[^>]+rel=["']stylesheet["']/i.test(html)).toBe(false);
  });

  it("carries the update-check rules that used to live in an unbuilt file", () => {
    expect(css).toContain(".update-check-status[data-tone=\"new\"]");
  });
});
