"use strict";

// Is it worth reading the target accessibility value to verify a paste
// into THIS app — given what happened the last times we tried?
//
// ── The measurement this exists for (BUGS_AUDIT §6.6, hotfix A3) ──────
//
// Verification (desktop/paste-script.js) reads the focused element text
// length before and after the paste and calls the paste ":verified" when
// it grew by exactly the pasted length. Some apps never expose a
// readable value: measured against the Claude desktop app on macOS 27,
// AXValue and AXNumberOfCharacters of its focused element both fail
// with -1728, and the log for 2026-09-03 shows every single paste into
// it returning "OK:menu-paste-primary:unverified" while robust_paste
// went from 216 ms to 1543 ms. Those reads are not a failed
// verification, they are an IMPOSSIBLE one, and repeating them on every
// paste for the rest of the process buys nothing.
//
// So: remember per target. Two consecutive UNREADABLE outcomes for one
// app — reads that returned nothing at all — and verification for that
// app is off for the lifetime of the process. A verified outcome resets
// the memory: an app that CAN be verified keeps being verified, which is
// the case worth paying for.
//
// An inconclusive outcome (the reads worked, the length simply did not
// grow by what we predicted) is deliberately NOT evidence of anything.
// It used to be counted, and while the after-read was being taken before
// the paste had landed that meant every app, without exception, had
// verification switched off after two pastes.
//
// ── Why the memory is not persisted ───────────────────────────────────
//
// Whether an app exposes a readable value depends on the app version,
// its focused element at that moment, and the state of our own
// accessibility grant. A file on disk would carry a verdict about an app
// the user has since updated, and there is no signal that would ever
// invalidate it. A process lifetime is short enough to re-learn and long
// enough to stop the bleeding.
//
// Everything here is pure — no clock, no logging, no Electron. main.js
// owns the single process-wide instance and does the logging through the
// onDisable callback. See desktop/paste-verification-policy.test.js.

/** Consecutive UNREADABLE outcomes before verification is switched off. */
const UNVERIFIED_STREAK_LIMIT = 2;

/** What a verification attempt can tell us about a target. */
const PASTE_VERIFICATION_OUTCOME = Object.freeze({
  /** The reads landed and the focused element grew by the pasted length. */
  VERIFIED: "verified",
  /**
   * A read returned nothing at all: this target exposes no inspectable
   * value, so verifying it is IMPOSSIBLE rather than failed. This is the
   * only outcome that counts towards switching the reads off.
   */
  UNREADABLE: "unreadable",
  /**
   * The reads landed but the growth did not match — the target rewrote
   * the text, focus moved, the poll bound expired. Inconclusive: it says
   * nothing about whether this app CAN be verified, so it neither counts
   * towards disabling nor clears a streak.
   *
   * This distinction is the difference between a policy that learns and
   * one that switches itself off everywhere: while the after-read was
   * taken before the paste had landed, EVERY app produced this outcome
   * and every app had verification disabled after two pastes.
   */
  INCONCLUSIVE: "inconclusive",
  /** The paste itself failed, so the attempt says nothing about the app. */
  ERROR: "error",
});

/**
 * The memory key for a paste target: the bundle id when we have one (a
 * renamed app cannot fool it), otherwise the app name macOS gives us
 * today. An empty key means "we do not know what we pasted into" — such
 * an outcome is not attributed to anything and never disables anything.
 */
function pasteVerificationKey(target = {}) {
  const bundleId = String(target.bundleId || "").trim().toLowerCase();
  if (bundleId) return bundleId;
  return String(target.appName || "").trim().toLowerCase();
}

/**
 * @param {object}   [options]
 * @param {number}   [options.limit]     consecutive unverified outcomes to tolerate
 * @param {Function} [options.onDisable] called ONCE per key, when it is switched off
 */
function createPasteVerificationPolicy({ limit = UNVERIFIED_STREAK_LIMIT, onDisable = null } = {}) {
  const effectiveLimit = Math.max(1, Number(limit) || UNVERIFIED_STREAK_LIMIT);
  /** @type {Map<string, {unverifiedStreak: number, disabled: boolean}>} */
  const memory = new Map();

  function entryFor(key) {
    let entry = memory.get(key);
    if (!entry) {
      entry = { unverifiedStreak: 0, disabled: false };
      memory.set(key, entry);
    }
    return entry;
  }

  function snapshot(key, entry) {
    return {
      key,
      unverifiedStreak: entry.unverifiedStreak,
      disabled: entry.disabled,
      limit: effectiveLimit,
    };
  }

  return {
    /**
     * Should the next paste into `key` carry the verification reads?
     * An unknown target always may: the cost is only worth avoiding
     * where we have evidence it is wasted.
     */
    shouldAttemptVerification(key) {
      if (!key) return true;
      const entry = memory.get(key);
      return !entry || !entry.disabled;
    },

    /**
     * Record what a verification ATTEMPT produced. Call this only when
     * verification was actually attempted — a paste that ran without the
     * reads reports "unverified" too, and feeding that back would count
     * the same missing evidence forever.
     *
     * @returns {object|null} the resulting state, or null for an
     *   unattributable outcome (no key).
     */
    recordOutcome(key, outcome) {
      if (!key) return null;
      const entry = entryFor(key);
      if (outcome === PASTE_VERIFICATION_OUTCOME.VERIFIED) {
        // Proof that this app CAN be verified outranks everything the
        // policy believed before it.
        entry.unverifiedStreak = 0;
        entry.disabled = false;
        return snapshot(key, entry);
      }
      if (outcome === PASTE_VERIFICATION_OUTCOME.UNREADABLE) {
        entry.unverifiedStreak += 1;
        if (!entry.disabled && entry.unverifiedStreak >= effectiveLimit) {
          entry.disabled = true;
          if (typeof onDisable === "function") {
            try {
              onDisable(snapshot(key, entry));
            } catch {
              // A logging failure must never break a paste.
            }
          }
        }
        return snapshot(key, entry);
      }
      // INCONCLUSIVE / ERROR (and anything unrecognised): the paste
      // either did not complete or completed without telling us whether
      // this app is verifiable. Nothing is learned, so nothing changes.
      // Deliberately NOT a reset either — a run of failures must not
      // erase a streak that is one step from switching the reads off.
      return snapshot(key, entry);
    },

    /** Current memory for a key — diagnostics and tests. */
    stateFor(key) {
      const entry = memory.get(key);
      return entry ? snapshot(key, entry) : { key, unverifiedStreak: 0, disabled: false, limit: effectiveLimit };
    },
  };
}

// ── Cost of the reads, measured rather than assumed ───────────────────
//
// AppleScript has no sub-second clock that does not cost a
// `do shell script`, so the script marks the edges of each read with
// `log`, which osascript flushes to stderr line by line as they happen.
// The parent timestamps their arrival (runCommand's onStreamLine) and
// this function turns those timestamps into per-read durations for the
// paste trace — the evidence for whether the 0.25 s bound is being hit.
// The marker itself comes from ./paste-protocol, the one place the
// script that emits it and every parser that reads it agree on.
const { AX_TRACE_LINE_RE: AX_TRACE_LINE } = require("./paste-protocol");

/**
 * @param {Array<{line: string, ms: number}>} events lines with their
 *   arrival time, in order, relative to the osascript spawn.
 * @returns {{reads: Array, totalMs: number, unfinished: boolean}}
 *   `reads` carries one entry per read, `ms: -1` marking a read that
 *   began and never reported an end — the signature of an osascript
 *   killed mid-read, which is exactly the case the bound is for.
 */
function summarizeAxReadTrace(events = []) {
  const openedAt = new Map();
  const reads = [];
  for (const event of Array.isArray(events) ? events : []) {
    const match = AX_TRACE_LINE.exec(String((event && event.line) || "").trim());
    if (!match) continue;
    const [, label, edge] = match;
    const at = Number((event && event.ms) || 0);
    if (edge === "begin") {
      openedAt.set(label, at);
      continue;
    }
    if (!openedAt.has(label)) continue;
    reads.push({ label, ms: Math.max(0, at - openedAt.get(label)) });
    openedAt.delete(label);
  }
  for (const [label] of openedAt) reads.push({ label, ms: -1 });
  return {
    reads,
    totalMs: reads.reduce((sum, read) => sum + Math.max(0, read.ms), 0),
    unfinished: reads.some((read) => read.ms < 0),
  };
}

module.exports = {
  UNVERIFIED_STREAK_LIMIT,
  PASTE_VERIFICATION_OUTCOME,
  pasteVerificationKey,
  createPasteVerificationPolicy,
  summarizeAxReadTrace,
};
