"use strict";

// Pure "did this paste attempt actually succeed, and can we trust the
// clipboard to hold the pasted text after it?" decision — extracted so
// every paste method in desktop/main.js's tryPasteToFocusedField makes
// the call through ONE tested function instead of five near-duplicate
// ad-hoc `if (check.ok) ...` blocks that had drifted out of sync.
//
// BUGS_AUDIT_2026-09-03 §6.1: the Windows VBS branch trusted cscript's
// exit code alone and never looked at stdout, so a VBS script that ran
// to completion without the paste actually landing (AppActivate failing
// silently, SendKeys throwing) was reported as a successful paste — the
// macOS branch, for comparison, already required stdout to start with
// "OK:". This module makes both platforms go through the same kind of
// check, and adds a "verified" bit (§6.4/§6.6) so callers can decide
// whether it is safe to restore the user's previous clipboard.
//
// Every script this module understands prints its own outcome on
// stdout as the LAST line of output:
//   - Windows VBS (SendKeys "^v"):        "OK:vbs-paste"   / "ERR:activate" / (silent + non-zero exit)
//   - Windows PowerShell SendKeys fallback: "OK:pwsh-paste" (SendKeys itself has no failure signal)
//   - Linux (wtype/xdotool/ydotool):       nothing — exit code is the only signal these CLIs give
//   - macOS AppleScript (robust_paste / menu-paste-primary / menu-paste):
//       "OK:<method>[+activated][:verified|:unverified]" / "ERR:<reason>"
//
// `ok` — the child process's own exit-code success, from runCommand —
// is required in every branch: a script that never got to run (spawn
// error, PowerShell parse error, timeout + SIGKILL) has no stdout worth
// trusting, no matter what happens to be sitting in the buffer.

function outcomeOf(stdout) {
  return String(stdout == null ? "" : stdout).trim();
}

/**
 * The LAST non-empty line of a stream. The macOS script now writes a
 * progress receipt before its result (see ``pasteSentReceipt``), so the
 * verdict is the last line, not the whole trimmed buffer.
 */
function lastLineOf(text) {
  const lines = String(text == null ? "" : text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * "The paste was already dispatched" receipt.
 *
 * The macOS script emits ``log "SENT:<method>"`` — which osascript
 * flushes to stderr immediately, verified against a live osascript — the
 * instant after the Cmd+V keycode or the Edit ▸ Paste click leaves, and
 * BEFORE the AX verification read that can block for up to its own
 * timeout. That ordering is the whole point: when the per-attempt
 * wall-clock bound kills osascript, the receipt tells us whether the
 * kill landed before or after the paste was delivered.
 *
 * Without it, a kill during the verification read looked identical to a
 * kill before the keystroke, so the ladder retried and the target got
 * the transcript TWICE. Handy's paste_tx makes the same distinction —
 * only receipts that arrive after chord injection count as proof.
 */
function pasteSentReceipt({ stdout, stderr } = {}) {
  const haystack = `${String(stdout == null ? "" : stdout)}\n${String(stderr == null ? "" : stderr)}`;
  const m = /(^|[\r\n])(SENT:[A-Za-z0-9_.+-]+)/.exec(haystack);
  return m ? m[2] : "";
}

/** Windows VBS SendKeys paste (method: "vbs_paste"). */
function isVbsPasteSuccess({ ok, stdout }) {
  return !!ok && outcomeOf(stdout).includes("OK:vbs-paste");
}

/** Windows PowerShell SendKeys fallback (method: "pwsh_paste_fallback"). */
function isPwshPasteFallbackSuccess({ ok, stdout }) {
  return !!ok && outcomeOf(stdout).includes("OK:");
}

/**
 * Linux paste cascade (wtype / xdotool / ydotool). None of these CLIs
 * print a protocol string on success — the process exit code is the
 * only truthful signal available, so that is the whole decision.
 */
function isLinuxPasteSuccess({ ok }) {
  return !!ok;
}

/**
 * macOS AppleScript paste — both the primary robust_paste script
 * (methods "robust_paste" and "menu-paste-primary", returned as
 * "OK:robust-paste…" / "OK:menu-paste-primary…") and the secondary
 * menu-paste fallback ("OK:menu-paste"). A trailing ":verified" means
 * the script itself read the focused element's AXValue/AXNumberOfCharacters
 * length before and after the paste and saw it grow by exactly the
 * pasted text's length; ":unverified" means the target didn't expose an
 * inspectable value (verification impossible, not a failure) or the
 * growth didn't match; a bare "OK:<reason>" (no suffix — the secondary
 * menu-paste fallback never adds one) means nothing was verified.
 */
function parseMacPasteOutcome({ ok, stdout, stderr }) {
  const out = lastLineOf(stdout);
  // An explicit ERR: verdict is the script's own considered answer and
  // outranks any receipt — the script only logs a receipt after the
  // paste is out, and it never returns ERR: afterwards.
  if (out.startsWith("ERR:")) {
    return { success: false, verified: false, sent: false, reason: out };
  }
  const receipt = pasteSentReceipt({ stdout, stderr });
  if (ok && out.startsWith("OK:")) {
    const verified = /:verified$/.test(out);
    return { success: true, verified, sent: !!receipt, reason: out };
  }
  if (receipt) {
    // Killed (or otherwise cut short) AFTER the paste was dispatched:
    // the text is in the target, but nothing verified it. Report it as a
    // success that is NOT verified — that stops the ladder from pasting
    // a second time, and leaves the transcript on the clipboard because
    // the restore gate only opens for verified pastes.
    return { success: true, verified: false, sent: true, reason: receipt };
  }
  if (!ok) return { success: false, verified: false, sent: false, reason: out };
  return { success: false, verified: false, sent: false, reason: out || "paste-return-unknown" };
}

/**
 * Single dispatch point: given the method name tryPasteToFocusedField is
 * about to report, and the raw {ok, stdout} from runCommand, decide
 * success + verified. This is the function every method branch should
 * call — see desktop/main.js's tryPasteToFocusedField.
 */
function evaluatePasteOutcome({ method, ok, stdout, stderr }) {
  switch (method) {
    case "vbs_paste":
      return { success: isVbsPasteSuccess({ ok, stdout }), verified: false, sent: false, reason: outcomeOf(stdout) };
    case "pwsh_paste_fallback":
      return { success: isPwshPasteFallbackSuccess({ ok, stdout }), verified: false, sent: false, reason: outcomeOf(stdout) };
    case "wtype":
    case "xdotool":
    case "ydotool":
      return { success: isLinuxPasteSuccess({ ok }), verified: false, sent: false, reason: outcomeOf(stdout) };
    case "robust_paste":
    case "menu-paste-primary":
    case "menu-paste":
      return parseMacPasteOutcome({ ok, stdout, stderr });
    default:
      return { success: !!ok, verified: false, sent: false, reason: outcomeOf(stdout) };
  }
}

module.exports = {
  lastLineOf,
  pasteSentReceipt,
  isVbsPasteSuccess,
  isPwshPasteFallbackSuccess,
  isLinuxPasteSuccess,
  parseMacPasteOutcome,
  evaluatePasteOutcome,
};
