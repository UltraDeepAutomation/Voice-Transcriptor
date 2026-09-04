"use strict";

// Executable specification for "stop paying for a verification this app
// can never give us" (BUGS_AUDIT §6.6, hotfix A3).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  UNVERIFIED_STREAK_LIMIT,
  PASTE_VERIFICATION_OUTCOME: OUTCOME,
  pasteVerificationKey,
  createPasteVerificationPolicy,
  summarizeAxReadTrace,
} = require("./paste-verification-policy");

test("the key prefers a bundle id and falls back to the app name", () => {
  assert.equal(pasteVerificationKey({ bundleId: "com.anthropic.claudefordesktop" }), "com.anthropic.claudefordesktop");
  assert.equal(pasteVerificationKey({ bundleId: "  Com.Example.APP ", appName: "Other" }), "com.example.app");
  assert.equal(pasteVerificationKey({ appName: "Claude" }), "claude");
  assert.equal(pasteVerificationKey({ appName: "  " }), "");
  assert.equal(pasteVerificationKey(), "");
});

test("verification is attempted until two consecutive unverified outcomes", () => {
  const policy = createPasteVerificationPolicy();
  assert.equal(UNVERIFIED_STREAK_LIMIT, 2);
  assert.equal(policy.shouldAttemptVerification("claude"), true);
  policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification("claude"), true, "one is not a pattern");
  policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification("claude"), false, "two in a row is");
});

test("switching off is per target, not global", () => {
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification("claude"), false);
  assert.equal(policy.shouldAttemptVerification("textedit"), true);
});

test("a verified outcome resets the memory", () => {
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("notes", OUTCOME.UNVERIFIED);
  policy.recordOutcome("notes", OUTCOME.VERIFIED);
  policy.recordOutcome("notes", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification("notes"), true, "the streak restarted");
  assert.equal(policy.stateFor("notes").unverifiedStreak, 1);
});

test("a failed paste neither counts toward the streak nor clears it", () => {
  // The ladder failed before anything could be read. That is a fact
  // about the paste, not about whether this app is verifiable.
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("mail", OUTCOME.UNVERIFIED);
  policy.recordOutcome("mail", OUTCOME.ERROR);
  assert.equal(policy.stateFor("mail").unverifiedStreak, 1);
  assert.equal(policy.shouldAttemptVerification("mail"), true);
  policy.recordOutcome("mail", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification("mail"), false);
});

test("the switch-off is announced exactly once per target", () => {
  const disabled = [];
  const policy = createPasteVerificationPolicy({ onDisable: (state) => disabled.push(state) });
  for (let i = 0; i < 6; i += 1) policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  assert.equal(disabled.length, 1, "one log line, not one per paste");
  assert.equal(disabled[0].key, "claude");
  assert.equal(disabled[0].limit, 2);
  assert.equal(disabled[0].unverifiedStreak, 2);
});

test("a throwing onDisable can never break a paste", () => {
  const policy = createPasteVerificationPolicy({
    onDisable: () => {
      throw new Error("log volume full");
    },
  });
  policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  policy.recordOutcome("claude", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification("claude"), false);
});

test("an unattributable outcome disables nothing", () => {
  const policy = createPasteVerificationPolicy();
  assert.equal(policy.recordOutcome("", OUTCOME.UNVERIFIED), null);
  policy.recordOutcome("", OUTCOME.UNVERIFIED);
  assert.equal(policy.shouldAttemptVerification(""), true);
});

test("the limit is configurable and never below one", () => {
  const one = createPasteVerificationPolicy({ limit: 1 });
  one.recordOutcome("claude", OUTCOME.UNVERIFIED);
  assert.equal(one.shouldAttemptVerification("claude"), false);
  const zero = createPasteVerificationPolicy({ limit: 0 });
  assert.equal(zero.stateFor("claude").limit, UNVERIFIED_STREAK_LIMIT);
});

test("stateFor reports a target nothing is known about", () => {
  const policy = createPasteVerificationPolicy();
  assert.deepEqual(policy.stateFor("finder"), {
    key: "finder",
    unverifiedStreak: 0,
    disabled: false,
    limit: 2,
  });
});

// ── AX read timings ───────────────────────────────────────────────────

test("read timings come from the arrival times of the script markers", () => {
  const summary = summarizeAxReadTrace([
    { line: "AXT:before:begin", ms: 120 },
    { line: "AXT:before:end", ms: 371 },
    { line: "AXT:after:begin", ms: 402 },
    { line: "AXT:after:end", ms: 410 },
  ]);
  assert.deepEqual(summary.reads, [
    { label: "before", ms: 251 },
    { label: "after", ms: 8 },
  ]);
  assert.equal(summary.totalMs, 259);
  assert.equal(summary.unfinished, false);
});

test("a read that began and never ended is reported, not silently dropped", () => {
  // osascript killed by the parent wall-clock bound while the read was
  // still running — the one case where the cost is unbounded.
  const summary = summarizeAxReadTrace([
    { line: "AXT:before:begin", ms: 100 },
    { line: "AXT:before:end", ms: 140 },
    { line: "AXT:after:begin", ms: 200 },
  ]);
  assert.deepEqual(summary.reads, [
    { label: "before", ms: 40 },
    { label: "after", ms: -1 },
  ]);
  assert.equal(summary.totalMs, 40, "an unfinished read contributes no time it cannot know");
  assert.equal(summary.unfinished, true);
});

test("unrelated output and stray ends are ignored", () => {
  const summary = summarizeAxReadTrace([
    { line: "OK:menu-paste-primary", ms: 5 },
    { line: "AXT:after:end", ms: 6 },
    { line: "AXT:before:begin", ms: 10 },
    { line: "AXT:before:end", ms: 12 },
    { line: "", ms: 13 },
  ]);
  assert.deepEqual(summary.reads, [{ label: "before", ms: 2 }]);
  assert.equal(summarizeAxReadTrace().reads.length, 0);
  assert.equal(summarizeAxReadTrace(null).totalMs, 0);
});
