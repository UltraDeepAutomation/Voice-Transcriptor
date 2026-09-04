"use strict";

// Can this machine actually paste right now — and if it cannot, what is
// the concrete thing the user has to do about it?
//
// BUGS_AUDIT 2026-09-03 §6.5/§6.6 fixed "we said we pasted when we only
// sent a keystroke". This module fixes the layer under it: "the OS says
// we are allowed to send that keystroke when we are not".
//
// The failure mode this exists for (observed by Whispering,
// epicenter-so/epicenter `keyboard/mod.rs`): after an app is re-signed
// and replaced in /Applications — exactly what a fresh 1.5.0 build is —
// the TCC row for Accessibility can survive while pointing at the old
// code identity. `AXIsProcessTrusted()` (Electron's
// `systemPreferences.isTrustedAccessibilityClient`) keeps answering
// **true**, the app keeps synthesising events, and the window server
// silently drops every one of them. Whispering's answer is to keep a
// real event tap alive as a liveness probe and to publish a capability
// state that gates the paste, so the app says "left on clipboard"
// instead of pretending it typed. Electron cannot open a CGEventTap
// without a native addon, so our liveness probe is the cheapest real
// action that travels the same road as the paste itself: an osascript
// `System Events` read of the frontmost process name. It needs the same
// Apple Events + Accessibility grants the paste needs, it cost 188-203 ms
// measured over three runs on macOS 27, and it fails when the grant is
// stale.
//
//   trusted flag | real probe | capability
//   -------------+------------+------------
//   true         | ok         | active
//   true         | fails      | broken     <- the stale-grant case
//   false        | (any)      | untrusted
//   unavailable  | (any)      | unknown    <- non-darwin; paste anyway
//
// Everything here is pure: state in, state out. desktop/main.js owns the
// side effects (spawning the probe, logging, turning a refusal into the
// status the user reads) and this module owns the decisions, so the
// decisions can be tested without a window server. See
// desktop/paste-capability.test.js.
//
// It is one of THREE modules on the paste path, and they do not overlap:
// this one decides IF we may paste at all and how long the ladder may
// spend, desktop/paste-verification-policy.js decides whether a paste is
// worth VERIFYING, and desktop/paste-result.js decides what one
// attempt's output MEANS.

/** The four capability states. Platform-agnostic. */
const PASTE_CAPABILITY = Object.freeze({
  /** Never probed, or the platform has no probe (Windows/Linux). */
  UNKNOWN: "unknown",
  /** The OS says we do not hold Accessibility. Asking again will not help. */
  UNTRUSTED: "untrusted",
  /** Trusted AND a real action just worked. */
  ACTIVE: "active",
  /** Trusted on paper, dead in practice — the stale post-update grant. */
  BROKEN: "broken",
});

/** An `active` verdict is believed this long before it is re-checked. */
const PASTE_PROBE_ACTIVE_TTL_MS = 60000;
/** Any non-`active` verdict is re-checked this often, so a user who
 *  fixes the grant in System Settings is noticed within seconds. */
const PASTE_PROBE_RECHECK_MS = 10000;
/** Wall-clock bound for the probe child process itself. */
const PASTE_PROBE_TIMEOUT_MS = 1000;

/**
 * The probe command. It is deliberately the same road the paste takes
 * (osascript → Apple Event → System Events → process list), because a
 * probe that uses a different mechanism (e.g. `lsappinfo`) would answer
 * "fine" while the mechanism we actually paste with is dead.
 */
const PASTE_PROBE_COMMAND = Object.freeze({
  cmd: "osascript",
  args: Object.freeze([
    "-e",
    'tell application "System Events" to get name of first process whose frontmost is true',
  ]),
  timeoutMs: PASTE_PROBE_TIMEOUT_MS,
});

function nowOr(now) {
  return Number.isFinite(now) ? Number(now) : Date.now();
}

/** Fresh state for a process that has not probed anything yet. */
function initialPasteCapability(now = 0) {
  const at = nowOr(now);
  return {
    state: PASTE_CAPABILITY.UNKNOWN,
    reason: "never-probed",
    since: at,
    probedAt: 0,
    changedAt: at,
    /** Consecutive "the command ran but nothing happened" paste failures. */
    silentFailures: 0,
  };
}

function transition(prev, state, reason, now) {
  const at = nowOr(now);
  const changed = prev.state !== state;
  return {
    state,
    reason,
    since: changed ? at : prev.since,
    probedAt: prev.probedAt,
    changedAt: changed ? at : prev.changedAt,
    silentFailures: state === PASTE_CAPABILITY.ACTIVE ? 0 : prev.silentFailures,
  };
}

/**
 * Fold a probe result into the state.
 *
 * @param {object} prev      previous state (from initialPasteCapability)
 * @param {object} result
 * @param {string} result.platform     process.platform of the probing host
 * @param {boolean|null} result.trusted  the AXIsProcessTrusted bit, or null
 *                                       when the platform has no such bit
 * @param {boolean} result.probeOk     did the real action succeed
 * @param {string} [result.probeReason] stderr/stdout of the probe, for logs
 * @param {number} [result.now]
 */
function applyProbeResult(prev, result = {}) {
  const base = prev || initialPasteCapability();
  const at = nowOr(result.now);
  const trusted = result.trusted;
  const probeReason = String(result.probeReason || "").trim();
  let next;
  if (trusted === null || trusted === undefined) {
    // R5: Windows/Linux have no trust bit and no probe. Unknown is not a
    // failure — it is "nothing has disproved paste yet", and
    // shouldAttemptPaste() lets it through.
    next = transition(base, PASTE_CAPABILITY.UNKNOWN, "probe-unavailable", at);
  } else if (trusted === false) {
    next = transition(base, PASTE_CAPABILITY.UNTRUSTED, "not-trusted", at);
  } else if (result.probeOk) {
    next = transition(base, PASTE_CAPABILITY.ACTIVE, "probe-ok", at);
  } else {
    // The whole point of this module: trusted on paper, dead in practice.
    next = transition(
      base,
      PASTE_CAPABILITY.BROKEN,
      probeReason ? `stale-grant:${probeReason}` : "stale-grant",
      at,
    );
  }
  next.probedAt = at;
  return next;
}

/**
 * What kind of paste failure is this reason string?
 *
 *  - "permission": the OS told us we are not allowed. Terminal until the
 *    user changes a setting.
 *  - "silent": the command was dispatched and nothing came back — an
 *    Apple Event timeout, a killed osascript, a spawn failure. One of
 *    these is a loaded machine; two in a row on a "trusted" system is
 *    the stale-grant signature.
 *  - "target": there was nothing to paste into (no process, no focus, a
 *    secure field). Says nothing about our capability.
 *  - "other": anything else. Says nothing about our capability.
 */
function classifyPasteFailure(reason) {
  const r = String(reason || "").toLowerCase();
  if (!r) return "other";
  if (
    r.includes("no-accessibility") ||
    r.includes("not authorized") ||
    r.includes("not permitted") ||
    r.includes("not allowed assistive") ||
    r.includes("-1743")
  ) {
    return "permission";
  }
  if (
    r.includes("no-target") ||
    r.includes("no-process") ||
    r.includes("no-focus") ||
    r.includes("not-editable") ||
    r.includes("secure-field") ||
    r.includes("empty-text")
  ) {
    return "target";
  }
  if (
    r.includes("timed out") ||
    r.includes("timeout") ||
    r.includes("-1712") ||
    r.includes("osascript-failed") ||
    r.includes("spawn")
  ) {
    return "silent";
  }
  return "other";
}

/** Two silent failures in a row on a trusted system = stale grant. */
const SILENT_FAILURES_BEFORE_BROKEN = 2;

/**
 * Fold a real paste outcome into the state. A paste that worked is the
 * strongest liveness evidence there is — stronger than the probe — so it
 * promotes any state to `active`.
 *
 * @param {object} prev
 * @param {object} outcome
 * @param {boolean} outcome.ok      did the paste ladder report success
 * @param {string} [outcome.reason]
 * @param {string} [outcome.platform]
 * @param {number} [outcome.now]
 */
function applyPasteOutcome(prev, outcome = {}) {
  const base = prev || initialPasteCapability();
  const at = nowOr(outcome.now);
  if (outcome.ok) return transition(base, PASTE_CAPABILITY.ACTIVE, "paste-succeeded", at);
  const kind = classifyPasteFailure(outcome.reason);
  if (kind === "permission") {
    return transition(base, PASTE_CAPABILITY.UNTRUSTED, "paste-denied", at);
  }
  if (kind === "silent") {
    const silentFailures = base.silentFailures + 1;
    if (silentFailures >= SILENT_FAILURES_BEFORE_BROKEN && base.state !== PASTE_CAPABILITY.UNTRUSTED) {
      const next = transition(base, PASTE_CAPABILITY.BROKEN, "paste-silent", at);
      next.silentFailures = silentFailures;
      return next;
    }
    return { ...base, silentFailures };
  }
  // "target" / "other": nothing was learned about the capability.
  return { ...base };
}

/**
 * The gate. `untrusted` and `broken` mean the paste cannot land, so the
 * caller must leave the transcript on the clipboard and say so instead
 * of running a ladder of Apple Events that will all fail (Whispering's
 * rule: never report a paste we did not perform). `unknown` pastes — a
 * platform with no probe is Active-until-proven-otherwise.
 */
function shouldAttemptPaste(state) {
  const s = typeof state === "string" ? state : state?.state;
  return s !== PASTE_CAPABILITY.UNTRUSTED && s !== PASTE_CAPABILITY.BROKEN;
}

/**
 * Is the cached verdict old enough to be worth re-probing? This is the
 * background question — boot, focus regain, and the refresh a paste
 * kicks off behind itself.
 */
function shouldProbe(cap, now = 0) {
  const at = nowOr(now);
  const state = cap?.state || PASTE_CAPABILITY.UNKNOWN;
  if (!cap || !cap.probedAt) return true;
  const ttl = state === PASTE_CAPABILITY.ACTIVE ? PASTE_PROBE_ACTIVE_TTL_MS : PASTE_PROBE_RECHECK_MS;
  return at - cap.probedAt >= ttl;
}

/**
 * Must a paste WAIT for a fresh probe before it decides anything?
 *
 * Only in the two cases where the answer changes what happens: nothing
 * has ever been probed, or the cached verdict is the thing that would
 * refuse this paste. Never act on a stale refusal — two transient
 * timeouts must not switch pasting off for a whole recheck window, and
 * the probe is one bounded round trip (~200 ms measured on macOS 27)
 * against a ladder that would otherwise spend seconds failing.
 *
 * A verdict that ALLOWS the paste is never waited on, however old it is:
 * the user has just stopped talking and is waiting for text.
 */
function mustProbeBeforePaste(cap) {
  if (!cap || !cap.probedAt) return true;
  return !shouldAttemptPaste(cap);
}

/**
 * The user-facing half. `fix` is the literal sequence of clicks that
 * repairs the state — for `broken` that is remove-and-re-add, because a
 * stale row cannot be repaired by toggling it.
 */
function pasteCapabilityMessage(state) {
  const s = typeof state === "string" ? state : state?.state;
  if (s === PASTE_CAPABILITY.BROKEN) {
    return {
      title: "Auto-paste is blocked by a stale Accessibility permission",
      fix: "System Settings → Privacy & Security → Accessibility: remove and re-add Transcriptor.",
    };
  }
  if (s === PASTE_CAPABILITY.UNTRUSTED) {
    return {
      title: "Auto-paste needs Accessibility permission",
      fix: "System Settings → Privacy & Security → Accessibility: add Transcriptor and switch it on.",
    };
  }
  return { title: "", fix: "" };
}

// ── Retry / timeout budget ─────────────────────────────────────────────
//
// ONE table for every bound the paste ladder is allowed to spend, so
// "how long can a paste take" has a single answer a test can check
// against the deadline the user is already waiting inside. The numbers
// are the ones the ladder in desktop/main.js actually uses; the ladder
// reads them from here rather than carrying literals next to each
// runCommand call.
//
// What this table does NOT own: how long ONE accessibility read inside
// the AppleScript may take. That bound lives with the script that
// carries it (desktop/paste-script.js AX_READ_TIMEOUT_SEC), because it
// is enforced by AppleScript, not by us. What this table owns is the
// parent's wall clock: `verificationAllowanceMs` is the extra time an
// attempt is granted when the script carries those reads at all.
//
// Fields:
//   maxAttempts        — attempts of the whole method ladder. The
//                        contract ceiling is PASTE_MAX_ATTEMPTS (5, the
//                        Wispr Flow number); every platform stays at the
//                        3 it has always used, because nothing measured
//                        says a fourth identical attempt lands where
//                        three did not, and each one is seconds the user
//                        spends watching a spinner.
//   attemptDelaysMs    — settle sleep before attempt N (index = attempt).
//   methodTimeoutsMs   — the bounded child processes ONE attempt may
//                        spawn, in order. macOS runs one osascript;
//                        Windows runs cscript then the PowerShell
//                        fallback; Linux walks its CLI cascade.
//   verificationAllowanceMs — added to a macOS attempt when the script
//                        carries the AX verification reads. Worst case:
//                        the "before" read (focused element + AXValue +
//                        AXNumberOfCharacters, each an Apple Event
//                        bounded at AX_READ_TIMEOUT_SEC = 0.25 s) plus
//                        the "after" read, which resolves the element
//                        once and then polls its value up to
//                        AX_VERIFY_POLLS times, AX_VERIFY_POLL_INTERVAL_SEC
//                        apart, because a key code is delivered
//                        asynchronously and reading immediately measured
//                        the element BEFORE the paste. Measured against a
//                        scratch TextEdit document, one poll sufficed in
//                        8 of 8 trials, so the typical cost is ~50 ms;
//                        the allowance covers the bound, not the typical.
//   activationSettleMs — sleep after re-activating the target INSIDE an
//                        attempt (Windows/Linux do this every attempt).
//   preflightSettleMs  — the same sleep paid ONCE before the ladder
//                        (macOS activates the target before attempt 1).
//   tailFallbackTimeoutMs — the one bounded child that runs after the
//                        ladder is exhausted (macOS menu-paste).
//   preflightMs        — worst case spent before the ladder starts:
//                        waiting for the paste-last hotkey's own
//                        modifiers to come up (see planModifierRelease).
const PASTE_MAX_ATTEMPTS = 5;

const PASTE_BUDGET = Object.freeze({
  darwin: Object.freeze({
    maxAttempts: 3,
    attemptDelaysMs: Object.freeze([45, 85, 125]),
    methodTimeoutsMs: Object.freeze([3200]),
    // 0.75 s "before" + 0.25 s element resolve
    // + AX_VERIFY_POLLS x (interval + 2 bounded reads) = 0.25 + 4 x 0.55
    // -> 3.2 s, rounded up.
    verificationAllowanceMs: 3300,
    activationSettleMs: 0,
    preflightSettleMs: 80,
    tailFallbackTimeoutMs: 4500,
    preflightMs: 500,
  }),
  win32: Object.freeze({
    maxAttempts: 3,
    attemptDelaysMs: Object.freeze([30, 60, 90]),
    // cscript (Defender can spend 1-3 s scanning it) then the
    // PowerShell SendKeys fallback, which now runs after every VBS
    // failure rather than only on the last attempt.
    methodTimeoutsMs: Object.freeze([3500, 3000]),
    verificationAllowanceMs: 0,
    activationSettleMs: 70,
    preflightSettleMs: 0,
    tailFallbackTimeoutMs: 0,
    preflightMs: 0,
  }),
  linux: Object.freeze({
    maxAttempts: 3,
    attemptDelaysMs: Object.freeze([30, 60, 90]),
    // wtype / xdotool / ydotool — at most three of them per attempt,
    // depending on whether the session is Wayland, X11 or both.
    methodTimeoutsMs: Object.freeze([2000, 2000, 2000]),
    verificationAllowanceMs: 0,
    activationSettleMs: 60,
    preflightSettleMs: 0,
    tailFallbackTimeoutMs: 0,
    preflightMs: 0,
  }),
});

/**
 * The deadline processPostStopTask waits for a paste-ready transcript
 * (BUGS_AUDIT §6.7/§6.9). Lives here because the paste budget is only
 * meaningful relative to it: the ladder has to fit inside the same
 * envelope the user is already waiting in, which is what
 * pasteBudgetWorstCaseMs is checked against.
 */
const PASTE_POST_STOP_DEADLINE_MS = 32000;

function pasteBudgetFor(platform) {
  return PASTE_BUDGET[platform] || PASTE_BUDGET.linux;
}

/** Delay before attempt `attempt` (0-based), clamped to the table. */
function pasteAttemptDelayMs(platform, attempt) {
  const budget = pasteBudgetFor(platform);
  const delays = budget.attemptDelaysMs;
  if (!delays.length) return 0;
  const idx = Math.max(0, Math.min(delays.length - 1, Number(attempt) || 0));
  return delays[idx];
}

/**
 * Wall-clock bound for ONE bounded child inside an attempt.
 * `verify` adds the verification allowance to the first (and, on macOS,
 * only) method — that is the osascript that carries the AX reads.
 */
function pasteMethodTimeoutMs(platform, methodIndex = 0, verify = false) {
  const budget = pasteBudgetFor(platform);
  const timeouts = budget.methodTimeoutsMs;
  const idx = Math.max(0, Math.min(timeouts.length - 1, Number(methodIndex) || 0));
  const base = timeouts[idx];
  return verify && idx === 0 ? base + budget.verificationAllowanceMs : base;
}

/**
 * Worst case wall-clock of the whole paste ladder: every attempt runs
 * every method it may run, every one of them times out, verification is
 * attempted throughout, and the tail fallback times out too.
 */
function pasteBudgetWorstCaseMs(platform) {
  const b = pasteBudgetFor(platform);
  const delays = b.attemptDelaysMs.slice(0, b.maxAttempts).reduce((a, x) => a + x, 0);
  const perAttemptMethods = b.methodTimeoutsMs.reduce((a, x) => a + x, 0) + b.verificationAllowanceMs;
  return (
    b.preflightMs +
    b.preflightSettleMs +
    delays +
    b.maxAttempts * (perAttemptMethods + b.activationSettleMs) +
    b.tailFallbackTimeoutMs
  );
}

// ── Marking the transcript as transient ────────────────────────────────
//
// Clipboard managers hoover up everything that lands on the pasteboard,
// so a dictated transcript ends up in the user's clipboard history
// forever. The convention for opting out is to put the type
// `org.nspasteboard.TransientType` on the same pasteboard item
// (nspasteboard.org).
//
// Electron 42.4.1 (the pinned version) cannot do it without native code,
// and the reason is structural rather than a missing argument:
//   - `clipboard.write(data)` takes a fixed `Data` shape — text, html,
//     image, rtf, bookmark. There is no key for a custom UTI.
//   - `clipboard.writeBuffer(format, buffer)` does take an arbitrary
//     format, but it is a WRITE, not an addition: every Electron
//     clipboard write goes through a ScopedClipboardWriter whose commit
//     replaces the pasteboard contents. Writing the marker after the
//     text removes the text; writing it before, the text removes the
//     marker. There is no API to add a type to the item already there.
// Doing it properly needs NSPasteboard directly, which means a native
// addon — out of scope here. Documented, and skipped.
const PASTE_TRANSIENT_TYPE = "org.nspasteboard.TransientType";
const PASTE_TRANSIENT_TYPE_SUPPORTED = false;

// ── Modifier-release race ─────────────────────────────────────────
//
// The record hotkey pastes 1–2 s after the key is released, so the
// physical modifiers are long up. The paste-last hotkey (Alt+Shift+V on
// macOS) pastes IMMEDIATELY, while Alt and Shift are still physically
// held — and a synthesised Cmd+V inherits the real modifier flags, so
// the target app receives Cmd+Alt+Shift+V and does something else
// entirely (or nothing).
//
// Handy holds its injected chord for CHORD_HOLD_MS = 100 ms so the
// target reliably sees a complete key event, and local-speak waits up to
// CTRL_WAIT_DEADLINE = 0.5 s for the user's own control keys to come up
// before injecting. We take both numbers: wait for the flags to clear,
// give up after 500 ms, and never inject sooner than 150 ms after the
// hotkey (≥ CHORD_HOLD_MS, so the user's own chord has finished being
// delivered to whatever else is listening).
const MODIFIER_HOLD_MS = 150;
const MODIFIER_WAIT_DEADLINE_MS = 500;
const MODIFIER_POLL_INTERVAL_MS = 25;
/** osascript + JXA startup measured at ~240 ms; 600 ms is that with room. */
const MODIFIER_SPAWN_ALLOWANCE_MS = 600;

/** NSEventModifierFlags bits we care about (AppKit). */
const NS_EVENT_MODIFIER_FLAGS = Object.freeze({
  shift: 1 << 17,
  control: 1 << 18,
  option: 1 << 19,
  command: 1 << 20,
});
const NS_EVENT_MODIFIER_MASK =
  NS_EVENT_MODIFIER_FLAGS.shift |
  NS_EVENT_MODIFIER_FLAGS.control |
  NS_EVENT_MODIFIER_FLAGS.option |
  NS_EVENT_MODIFIER_FLAGS.command;

/**
 * Does this paste need to wait for the user's own modifiers, and for how
 * long? Only the hotkey-triggered paste does: `trigger: "hotkey"` with a
 * modifier-bearing accelerator.
 */
function planModifierRelease({ platform = "", accelerator = "", trigger = "" } = {}) {
  const none = {
    needed: false,
    holdMs: 0,
    deadlineMs: 0,
    pollIntervalMs: MODIFIER_POLL_INTERVAL_MS,
  };
  if (platform !== "darwin") return none;
  if (trigger !== "hotkey") return none;
  const accel = String(accelerator || "");
  if (!accel.includes("+")) return none;
  return {
    needed: true,
    holdMs: MODIFIER_HOLD_MS,
    deadlineMs: MODIFIER_WAIT_DEADLINE_MS,
    pollIntervalMs: MODIFIER_POLL_INTERVAL_MS,
  };
}

/**
 * JXA source for the wait. One osascript spawn does the whole poll —
 * spawning once per 25 ms poll would cost more than the wait itself.
 * `NSEvent.modifierFlags` is a global read that needs no permission at
 * all, so this works even when the capability probe says `broken`.
 * Prints `MODS:<cleared|held>:<flags>:<waitedMs>`.
 */
function modifierReleaseScript(plan) {
  const holdMs = Math.max(0, Number(plan?.holdMs) || 0);
  const deadlineMs = Math.max(holdMs, Number(plan?.deadlineMs) || 0);
  const pollMs = Math.max(5, Number(plan?.pollIntervalMs) || MODIFIER_POLL_INTERVAL_MS);
  return [
    'ObjC.import("AppKit");',
    'ObjC.import("Foundation");',
    `var MASK = ${NS_EVENT_MODIFIER_MASK};`,
    `var HOLD = ${holdMs};`,
    `var DEADLINE = ${deadlineMs};`,
    `var POLL = ${pollMs};`,
    "var started = Date.now();",
    "var flags = 0;",
    "var cleared = false;",
    "while (true) {",
    "  var waited = Date.now() - started;",
    "  flags = Number($.NSEvent.modifierFlags) & MASK;",
    "  if (flags === 0 && waited >= HOLD) { cleared = true; break; }",
    "  if (waited >= DEADLINE) { break; }",
    "  $.NSThread.sleepForTimeInterval(POLL / 1000);",
    "}",
    '"MODS:" + (cleared ? "cleared" : "held") + ":" + flags + ":" + (Date.now() - started);',
  ].join("\n");
}

/**
 * The whole spawn, so no caller can get the interpreter flag wrong: the
 * script above is JavaScript for Automation, and `osascript` compiles
 * AppleScript unless told otherwise. Measured on macOS 27: 405 ms wall
 * for a 164 ms wait, i.e. ~240 ms of osascript + JXA startup, which is
 * why this runs ONCE per paste-last press and never in a poll loop.
 *
 * The timeout is the plan deadline plus that startup allowance: the
 * script always returns on its own at the deadline, so a wall-clock kill
 * here means something else went wrong, and the caller pastes anyway.
 */
function modifierReleaseCommand(plan) {
  return {
    cmd: "osascript",
    args: ["-l", "JavaScript", "-e", modifierReleaseScript(plan)],
    timeoutMs: Math.max(0, Number(plan?.deadlineMs) || 0) + MODIFIER_SPAWN_ALLOWANCE_MS,
  };
}

/** Parse `MODS:<cleared|held>:<flags>:<waitedMs>` out of osascript stdout. */
function parseModifierReleaseResult(stdout) {
  const line = String(stdout == null ? "" : stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  const m = /^MODS:(cleared|held):(\d+):(\d+)$/.exec(line || "");
  if (!m) return { ok: false, cleared: false, flags: 0, waitedMs: 0 };
  return {
    ok: true,
    cleared: m[1] === "cleared",
    flags: Number(m[2]),
    waitedMs: Number(m[3]),
  };
}

/** Which modifiers are still down, from a raw NSEventModifierFlags value. */
function heldModifiersFromFlags(flags) {
  const f = Number(flags) || 0;
  return Object.keys(NS_EVENT_MODIFIER_FLAGS).filter((k) => (f & NS_EVENT_MODIFIER_FLAGS[k]) !== 0);
}

module.exports = {
  PASTE_CAPABILITY,
  PASTE_PROBE_ACTIVE_TTL_MS,
  PASTE_PROBE_RECHECK_MS,
  PASTE_PROBE_TIMEOUT_MS,
  PASTE_PROBE_COMMAND,
  SILENT_FAILURES_BEFORE_BROKEN,
  initialPasteCapability,
  applyProbeResult,
  applyPasteOutcome,
  classifyPasteFailure,
  shouldAttemptPaste,
  shouldProbe,
  mustProbeBeforePaste,
  pasteCapabilityMessage,
  PASTE_BUDGET,
  PASTE_MAX_ATTEMPTS,
  PASTE_POST_STOP_DEADLINE_MS,
  PASTE_TRANSIENT_TYPE,
  PASTE_TRANSIENT_TYPE_SUPPORTED,
  pasteBudgetFor,
  pasteAttemptDelayMs,
  pasteMethodTimeoutMs,
  pasteBudgetWorstCaseMs,
  NS_EVENT_MODIFIER_FLAGS,
  NS_EVENT_MODIFIER_MASK,
  MODIFIER_HOLD_MS,
  MODIFIER_WAIT_DEADLINE_MS,
  MODIFIER_POLL_INTERVAL_MS,
  planModifierRelease,
  modifierReleaseScript,
  modifierReleaseCommand,
  MODIFIER_SPAWN_ALLOWANCE_MS,
  parseModifierReleaseResult,
  heldModifiersFromFlags,
};
