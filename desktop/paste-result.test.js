"use strict";

// Executable specification for desktop/paste-result.js — the SSOT
// "did this paste actually succeed, and can the clipboard be trusted"
// decision every method branch in tryPasteToFocusedField (desktop/main.js)
// goes through. Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  lastLineOf,
  pasteSentReceipt,
  isVbsPasteSuccess,
  isPwshPasteFallbackSuccess,
  isLinuxPasteSuccess,
  parseMacPasteOutcome,
  evaluatePasteOutcome,
} = require("./paste-result");

test("vbs: requires BOTH a zero exit code AND the OK:vbs-paste marker", () => {
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "OK:vbs-paste" }), true);
  // The exact regression from BUGS_AUDIT §6.1: cscript exits 0 but the
  // script never got to the SendKeys line (e.g. AppActivate failed
  // before the fix that makes it Quit 2).
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "" }), false);
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "ERR:activate" }), false);
  // Marker present but the process itself reported failure (non-zero exit).
  assert.equal(isVbsPasteSuccess({ ok: false, stdout: "OK:vbs-paste" }), false);
});

test("vbs: tolerates surrounding whitespace/newlines from cscript", () => {
  assert.equal(isVbsPasteSuccess({ ok: true, stdout: "\r\nOK:vbs-paste\r\n" }), true);
});

test("pwsh fallback: ok + any OK: marker succeeds", () => {
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: "OK:pwsh-paste" }), true);
  assert.equal(isPwshPasteFallbackSuccess({ ok: true, stdout: "" }), false);
  assert.equal(isPwshPasteFallbackSuccess({ ok: false, stdout: "OK:pwsh-paste" }), false);
});

test("linux: exit code is the only signal (no protocol string)", () => {
  assert.equal(isLinuxPasteSuccess({ ok: true }), true);
  assert.equal(isLinuxPasteSuccess({ ok: false }), false);
});

test("mac: !ok with no receipt is a failure regardless of stdout content", () => {
  const r = parseMacPasteOutcome({ ok: false, stdout: "OK:menu-paste-primary:verified" });
  assert.equal(r.success, false);
  assert.equal(r.verified, false);
  assert.equal(r.sent, false);
});

test("mac: a SENT receipt after a wall-clock kill counts as pasted-but-unverified", () => {
  // The per-attempt bound killed osascript while the AX verification
  // read was still running — AFTER the keystroke was delivered. Retrying
  // here would paste the transcript a second time.
  const r = parseMacPasteOutcome({
    ok: false,
    stdout: "",
    stderr: "SENT:robust-paste\nTimed out",
  });
  assert.equal(r.success, true, "the paste did land; the ladder must stop");
  assert.equal(r.verified, false, "nothing verified it, so the clipboard keeps the transcript");
  assert.equal(r.sent, true);
  assert.equal(r.reason, "SENT:robust-paste");
});

test("mac: a receipt does NOT override the script's own ERR verdict", () => {
  const r = parseMacPasteOutcome({
    ok: true,
    stdout: "ERR:no-focus",
    stderr: "SENT:robust-paste",
  });
  assert.equal(r.success, false);
  assert.equal(r.sent, false);
});

test("mac: the receipt on stderr does not shadow a complete OK result", () => {
  const r = parseMacPasteOutcome({
    ok: true,
    stdout: "OK:robust-paste:verified",
    stderr: "SENT:robust-paste",
  });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.equal(r.sent, true);
});

test("mac: the verdict is the LAST line, so a receipt printed to stdout cannot hide it", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "SENT:robust-paste\nOK:robust-paste:verified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
});

test("pasteSentReceipt only matches a marker at the start of a line", () => {
  assert.equal(pasteSentReceipt({ stderr: "SENT:menu-paste-primary\n" }), "SENT:menu-paste-primary");
  assert.equal(pasteSentReceipt({ stdout: "line\nSENT:robust-paste" }), "SENT:robust-paste");
  // A target app's own error text mentioning the word must not be read
  // as our receipt.
  assert.equal(pasteSentReceipt({ stderr: 'error: nothing was SENT:anything' }), "");
  assert.equal(pasteSentReceipt({}), "");
});

test("lastLineOf ignores blank lines and trailing newlines", () => {
  assert.equal(lastLineOf("a\n\nb\n\n"), "b");
  assert.equal(lastLineOf(""), "");
  assert.equal(lastLineOf(null), "");
});

test("mac: OK: prefix required for success", () => {
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "ERR:no-process" }).success, false);
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "" }).success, false);
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste" }).success, true);
});

test("mac: :verified suffix sets verified=true", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:menu-paste-primary:verified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
});

test("mac: :unverified suffix sets verified=false without failing", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:menu-paste-primary:unverified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
});

test("mac: :unverified must not be matched by a naive endsWith('verified') check", () => {
  // Regression guard: "unverified" ends with the substring "verified",
  // so a careless `out.endsWith("verified")` check would call this
  // verified. The real rule requires the colon immediately before it.
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste:unverified" }).verified, false);
});

test("mac: activation tag before the verification suffix is handled", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:robust-paste+activated:verified" });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
});

test("mac: bare OK with no suffix at all (secondary menu-paste fallback) is success, unverified", () => {
  const r = parseMacPasteOutcome({ ok: true, stdout: "OK:menu-paste" });
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
});

test("mac: a paste run with verification switched off is a success, unverified", () => {
  // Hotfix A3: when desktop/paste-verification-policy.js has switched an
  // app off, desktop/paste-script.js emits a script with no accessibility
  // read in it, so the primary path returns the SUFFIX-LESS form. The
  // parser must read that exactly as it reads the secondary fallback: the
  // paste happened, nothing verified it, so the clipboard keeps the
  // transcript.
  for (const stdout of ["OK:menu-paste-primary", "OK:menu-paste-primary+activated", "OK:robust-paste+activated"]) {
    const r = parseMacPasteOutcome({ ok: true, stdout });
    assert.equal(r.success, true, `${stdout} is a successful paste`);
    assert.equal(r.verified, false, `${stdout} verifies nothing`);
    assert.equal(r.reason, stdout);
  }
  const dispatched = evaluatePasteOutcome({ method: "robust_paste", ok: true, stdout: "OK:menu-paste-primary\n" });
  assert.equal(dispatched.success, true);
  assert.equal(dispatched.verified, false);
});

test("mac: ERR:secure-field and ERR:no-accessibility are failures, not crashes", () => {
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "ERR:secure-field" }).success, false);
  assert.equal(parseMacPasteOutcome({ ok: true, stdout: "ERR:no-accessibility" }).success, false);
});

test("evaluatePasteOutcome dispatches vbs_paste like isVbsPasteSuccess", () => {
  const r = evaluatePasteOutcome({ method: "vbs_paste", ok: true, stdout: "OK:vbs-paste" });
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
  const fail = evaluatePasteOutcome({ method: "vbs_paste", ok: true, stdout: "ERR:activate" });
  assert.equal(fail.success, false);
});

test("evaluatePasteOutcome dispatches pwsh_paste_fallback", () => {
  assert.equal(evaluatePasteOutcome({ method: "pwsh_paste_fallback", ok: true, stdout: "OK:pwsh-paste" }).success, true);
});

test("evaluatePasteOutcome dispatches each linux method by ok alone", () => {
  for (const method of ["wtype", "xdotool", "ydotool"]) {
    assert.equal(evaluatePasteOutcome({ method, ok: true, stdout: "" }).success, true);
    assert.equal(evaluatePasteOutcome({ method, ok: false, stdout: "" }).success, false);
  }
});

test("evaluatePasteOutcome dispatches mac methods through parseMacPasteOutcome", () => {
  const r = evaluatePasteOutcome({ method: "robust_paste", ok: true, stdout: "OK:robust-paste:verified" });
  assert.deepEqual(r, { success: true, verified: true, sent: false, reason: "OK:robust-paste:verified" });
  const r2 = evaluatePasteOutcome({ method: "menu-paste-primary", ok: true, stdout: "OK:menu-paste-primary:unverified" });
  assert.equal(r2.success, true);
  assert.equal(r2.verified, false);
  const r3 = evaluatePasteOutcome({ method: "menu-paste", ok: true, stdout: "OK:menu-paste" });
  assert.equal(r3.success, true);
  assert.equal(r3.verified, false);
});

test("evaluatePasteOutcome falls back to ok-only for an unknown method", () => {
  assert.equal(evaluatePasteOutcome({ method: "something-new", ok: true, stdout: "garbage" }).success, true);
  assert.equal(evaluatePasteOutcome({ method: "something-new", ok: false, stdout: "" }).success, false);
});
