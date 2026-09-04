"use strict";

// The AppleScript the macOS paste path runs, as a pure function of the
// target and of ONE decision: do we verify this paste, or not?
//
// ── Why this is a module and not a template literal in main.js ────────
//
// It used to be an inline template inside tryPasteToFocusedField, which
// meant the only guard on it was desktop/applescript.test.js scanning
// main.js for template literals and compiling them with `${...}`
// replaced by the literal 0. That guard cannot see the script this
// module actually emits, and the script now has TWO shapes — with and
// without the accessibility verification reads. A pure builder can be
// required from a test, so desktop/paste-script.test.js compiles both
// real shapes with osacompile and asserts, textually, that the
// non-verifying shape contains no accessibility read at all.
//
// ── The verification reads and their bound (BUGS_AUDIT §6.6, A3) ──────
//
// Verification means: read the length of the focused element text
// before the paste, read it again after, and call the paste "verified"
// when it grew by exactly the pasted length. Some targets never expose
// an inspectable value — measured against the Claude desktop app on
// macOS 27, AXValue and AXNumberOfCharacters of its focused element
// both fail immediately with -1728 — so for those apps every paste is
// reported ":unverified" and the reads are pure cost.
// desktop/paste-verification-policy.js is the memory that stops paying
// that cost; this module is what it switches off.
//
// The read bound was also, until now, fiction. `with timeout of N
// second` bounds an Apple Event sent BY the enclosing statement, and the
// old code placed it INSIDE `tell application "System Events"`, where it
// bounds nothing. Measured on macOS 27 against the Finder process, whose
// AXFocusedUIElement read is the pathological case the timeout was
// written for:
//
//   no timeout                                    -> still blocked at 20 s (killed)
//   `with timeout` INSIDE the tell block (old)    -> still blocked at 12 s (killed)
//   `with timeout of 0.25 second` AROUND the tell -> error -1712 after 286 ms
//   `with timeout of 2 seconds`   AROUND the tell -> error -1712 after 2044 ms
//   `with timeout of 0 seconds`   AROUND the tell -> no bound at all (killed at 10 s)
//
// So the timeout statement must wrap the `tell`, fractional values are
// honoured (0.25 s really is 0.25 s — it is NOT coerced to an integer),
// and 0 means "wait forever". Every read below is written that way.

/**
 * AppleScript string literals terminate at CR/LF. A bare newline in a
 * target app name would break out of the quoted string and inject
 * arbitrary AppleScript. Strip all control characters AND escape
 * backslashes + quotes. Backslash must be replaced FIRST so the
 * subsequent double-quote replacement does not double-escape its own
 * slash.
 *
 * Lives here, with the scripts, so every AppleScript main.js builds
 * escapes its interpolations through one function.
 */
function escapeAppleScriptString(s) {
  return String(s || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Per-Apple-Event bound for one accessibility read, in seconds. Three
 * reads make up one axFocusedValueLength call (focused element, then
 * AXValue, then AXNumberOfCharacters), so a call against a wedged app
 * costs at most 0.75 s — and the "after" read is skipped entirely when
 * the "before" read already failed, because the comparison needs both.
 */
const AX_READ_TIMEOUT_SEC = 0.25;

/**
 * Prefix of the progress markers the script writes with `log`, which
 * osascript flushes to stderr line by line as they happen (verified
 * against a live osascript: a marker logged before a 1 s delay arrives
 * ~1 s before the result on stdout). The parent times their arrival, so
 * the cost of the reads is measured without spending anything inside
 * the script to measure it — AppleScript has no sub-second clock that
 * does not cost a `do shell script`.
 *
 * Format: AXT:<label>:begin / AXT:<label>:end — parsed by
 * desktop/paste-verification-policy.js summarizeAxReadTrace.
 */
const AX_TRACE_PREFIX = "AXT:";

/** Sanitize a numeric interpolation before it reaches AppleScript. */
function safeInt(value, max = 2 ** 31) {
  const n = Number.parseInt(String(value ?? 0), 10) || 0;
  return Number.isFinite(n) && n >= 0 && n < max ? Math.trunc(n) : 0;
}

/**
 * Build the primary macOS paste script.
 *
 * @param {object}  target
 * @param {string}  target.appName      raw app name (escaped here)
 * @param {string}  target.windowTitle  raw window title (escaped here)
 * @param {number}  target.pid          unix pid of the target process
 * @param {number}  target.pastedTextLen  length of the text on the clipboard
 * @param {boolean} target.verify       attempt AX verification at all
 * @returns {string} AppleScript source for `osascript -e`
 *
 * Returns, on stdout:
 *   OK:menu-paste-primary[+activated][:verified|:unverified]
 *   OK:robust-paste[+activated][:verified|:unverified]
 *   ERR:no-accessibility | ERR:no-process | ERR:no-focus
 * The `:verified`/`:unverified` suffix is present ONLY when verify is
 * true; with verify false the result is the plain form, which
 * desktop/paste-result.js already reads as an unverified success.
 */
function robustPasteScript({
  appName = "",
  windowTitle = "",
  pid = 0,
  pastedTextLen = 0,
  verify = false,
} = {}) {
  const escapedApp = escapeAppleScriptString(appName);
  const escapedWindowTitle = escapeAppleScriptString(windowTitle);
  const safePid = safeInt(pid);
  const safeLen = safeInt(pastedTextLen);
  const wantVerify = !!verify;

  // The four verification-only fragments. Each is interpolated into a
  // position where the applescript.test.js placeholder (a bare 0) also
  // compiles, so the source-scanning guard keeps working.
  const beforeRead = wantVerify
    ? 'set beforeLen to my axFocusedValueLength(p, "before")'
    : "";
  // Skipping the "after" read when the "before" read failed is not an
  // optimisation, it is the only correct behaviour: the verdict is a
  // comparison of the two, so a missing "before" makes "after"
  // unusable — and it halves the worst-case cost against an app whose
  // accessibility reads hang.
  const afterRead = wantVerify
    ? 'if beforeLen is not -1 then set afterLen to my axFocusedValueLength(p, "after")'
    : "";
  const verifiedTagExpr = wantVerify
    ? "my pasteVerifiedTag(beforeLen, afterLen, pastedTextLen)"
    : '""';
  const axHandlers = wantVerify ? axVerificationHandlers() : "";

  return `
    set targetApp to "${escapedApp}"
    set targetPid to ${safePid}
    set targetWindowTitle to "${escapedWindowTitle}"
    set pastedTextLen to ${safeLen}
    set beforeLen to -1
    set afterLen to -1
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set p to missing value

      -- Priority 1: Target by exact Unix PID
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      end if

      -- Priority 2: Target by exact App Name
      if p is missing value and targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if

      if p is missing value then return "ERR:no-process"

      -- Fast path: bring target to front and send physical Cmd+V keycode.
      -- Avoid AXFocusedUIElement probing HERE (before even deciding how
      -- to paste) because some apps block this call for several seconds
      -- and make the recording status look stuck on transcribing --
      -- measured against the Finder process AXFocusedUIElement itself,
      -- a probe with no bound blocked for 40+ seconds. The verification
      -- reads below are bounded, one Apple Event at a time, by the
      -- timeout statements that WRAP their tell blocks.
      --
      -- The activation and its settle delay are conditional. Transcriptor
      -- never takes focus -- the capsule is a non-focusable window -- so the
      -- app the user dictated into is still frontmost when the transcript
      -- comes back: 1459 of 1459 pastes in the log recorded
      -- "target_activation_skipped reason=already-frontmost". Raising an
      -- app that is already raised is free; the 80 ms delay after it was
      -- not, and it was paid on every one of them. Reading "frontmost"
      -- is a single attribute fetch, and the activation still happens
      -- whenever focus really did move.
      set activationTag to ""
      if frontmost of p is false then
        set frontmost of p to true
        set activationTag to "+activated"
        delay 0.08
      end if
      if targetWindowTitle is not "" then
        try
          -- Resolve the window ONCE. "if exists X then set w to X" runs
          -- the same accessibility traversal twice; a try around a
          -- single fetch has identical semantics (a missing window
          -- raises, which the surrounding try already swallows).
          set w to missing value
          try
            set w to first window of p whose name is targetWindowTitle
          end try
          if w is not missing value then
            try
              perform action "AXRaise" of w
            end try
            try
              set value of attribute "AXMain" of w to true
            end try
            delay 0.05
          end if
        end try
      end if

      -- Snapshot the focused element text length right before the
      -- paste fires, so the same length read after it fires (at either
      -- return point below) can tell a genuine paste from a click/keycode
      -- that was sent but never received by anything. Emitted only when
      -- the caller asked for verification.
      ${beforeRead}

      -- If the target exposes a standard Edit > Paste command, prefer
      -- executing that command directly over synthesising Cmd+V. A
      -- keycode only proves the keyboard event was delivered; the menu
      -- command is the target app own paste action and is a stronger
      -- signal that the active responder can accept text.
      try
        -- Walk the target menu bar ONCE. The previous form asked
        -- "exists" for this exact path and then fetched it again -- two
        -- full accessibility traversals of another application menu
        -- bar, the most expensive operation in this script. Measured
        -- against a live app: 170-240 ms duplicated (and visibly
        -- jittery) versus a flat 160 ms evaluated once, over a 40 ms
        -- osascript baseline. Semantics are unchanged: a missing menu
        -- item raises, which is what the "exists" test was detecting.
        set pasteMenuItem to missing value
        try
          set pasteMenuItem to menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1 of p
        end try
        if pasteMenuItem is not missing value then
          if enabled of pasteMenuItem is false then
            return "ERR:no-focus"
          end if
          try
            click pasteMenuItem
            -- No settle delay before returning. "click" performs the
            -- app own paste action; nothing this script does afterwards
            -- observes the result, and the two things that DO care about
            -- the paste having landed carry their own waits: the clipboard
            -- restore does not run for at least 1.5 s, and the auto-send
            -- Enter sleeps before it fires. A delay here was 160 ms added
            -- to the moment the user is waiting for.
            ${afterRead}
            return "OK:menu-paste-primary" & activationTag & ${verifiedTagExpr}
          end try
        end if
      end try

      -- Perform physical V key press (key code 9) + Cmd
      -- This bypasses keyboard layout issues (like Russian "m") where keystroke "v" fails
      tell p
        key code 9 using {command down}
      end tell

      -- Same reasoning as the menu path: the settle allowance lives with
      -- the caller that needs it, not in front of the return.
      ${afterRead}
      return "OK:robust-paste" & activationTag & ${verifiedTagExpr}
    end tell
    ${axHandlers}
  `;
}

/**
 * The verification half of the script: emitted only when the caller
 * asked for it, so a paste that will not be verified spawns an
 * osascript whose source contains no accessibility read at all.
 */
function axVerificationHandlers() {
  return `
    -- Length of the focused UI element text value, or -1 when it is
    -- unavailable/unreadable/times out. Every read is wrapped by its own
    -- "with timeout of ${AX_READ_TIMEOUT_SEC} second" placed AROUND the tell block --
    -- inside the block the statement bounds nothing, which is how an
    -- unbounded AXFocusedUIElement read against Finder was measured
    -- blocking for 20+ seconds under a timeout that looked like it was
    -- there. Worst case for one call is three bounded reads.
    on axFocusedValueLength(p, label)
      log "${AX_TRACE_PREFIX}" & label & ":begin"
      set axElem to missing value
      try
        with timeout of ${AX_READ_TIMEOUT_SEC} second
          tell application "System Events"
            set axElem to (value of attribute "AXFocusedUIElement" of p)
          end tell
        end timeout
      on error
        log "${AX_TRACE_PREFIX}" & label & ":end"
        return -1
      end try
      set axLen to -1
      -- AXValue works for standard text fields; AXNumberOfCharacters is
      -- what some custom text views expose instead. Measured against the
      -- Claude desktop app, both fail instantly with -1728, which is the
      -- case the verification policy exists to stop paying for.
      try
        with timeout of ${AX_READ_TIMEOUT_SEC} second
          tell application "System Events"
            set axLen to (count of (value of attribute "AXValue" of axElem))
          end tell
        end timeout
      end try
      if axLen is -1 then
        try
          with timeout of ${AX_READ_TIMEOUT_SEC} second
            tell application "System Events"
              set axLen to (value of attribute "AXNumberOfCharacters" of axElem)
            end tell
          end timeout
        end try
      end if
      log "${AX_TRACE_PREFIX}" & label & ":end"
      return axLen
    end axFocusedValueLength

    -- ":verified" only when both reads landed and the focused element
    -- grew by exactly the pasted length; ":unverified" otherwise, which
    -- includes "this target does not expose a readable value" -- an
    -- unverifiable paste, not a failed one.
    on pasteVerifiedTag(beforeLen, afterLen, pastedTextLen)
      if beforeLen is not -1 and afterLen is not -1 and (afterLen - beforeLen) is equal to pastedTextLen then
        return ":verified"
      end if
      return ":unverified"
    end pasteVerifiedTag
  `;
}

module.exports = {
  AX_READ_TIMEOUT_SEC,
  AX_TRACE_PREFIX,
  escapeAppleScriptString,
  robustPasteScript,
};
