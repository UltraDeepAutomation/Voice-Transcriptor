/**
 * Dual-stream Auto — what the stored preference means.
 *
 * Measured 2026-09-04: two Nova-3 streams, the multilingual one and one
 * fixed-language one, merged by word timestamps, closed both
 * language-switch holes of the trilingual test recording
 * (BUGS_AUDIT_2026-09-03 §1 "Дополнение" (c)) for twice the Deepgram
 * minutes and no extra latency. The backend owns the behaviour and
 * validates the two config keys; this module owns the ONE question the
 * renderer has to answer about them — what a stored value, a missing
 * value or a value the current build cannot offer resolves to.
 *
 * It matters because the wrong answer is silent. The config is written
 * back on every debounced autosave, so a missing key resolved to "off"
 * would not merely display wrong once: the next keystroke anywhere in
 * Settings would persist that "off" and turn a backend default off
 * behind the user's back. Absent therefore means the documented default,
 * never off.
 *
 * The defaults themselves are NOT written here (B-027 / R-016). They
 * used to be — ``DUAL_STREAM_DEFAULT = true`` and
 * ``DUAL_SECONDARY_LANGUAGE_DEFAULT = "ru"``, a third copy beside
 * ``backend/model_catalog.py`` and ``backend/config.py`` — and the copy
 * was dangerous in exactly the direction described above: if this file
 * ever said "off" where the backend said "on", the next autosave made
 * the backend wrong too. They now arrive in the backend's bootstrap
 * payload (``live_defaults``) and are passed in as ``fallback``.
 *
 * Pure: no DOM, no fetch. Unit-tested in tests/deepgram-dual.test.ts.
 */

export interface DualStreamDefaults {
  /** ``live_defaults.dual_stream`` — what the backend does when unset. */
  dualStream: boolean;
  /** ``live_defaults.dual_secondary_language`` — its partner language. */
  secondaryLanguage: string;
}

export interface DualStreamPreferenceInput {
  /** ``preferences.deepgram.dual_stream`` exactly as the config had it. */
  dualStream?: unknown;
  /** ``preferences.deepgram.dual_secondary_language`` exactly as the config had it. */
  secondaryLanguage?: unknown;
  /**
   * Language codes this build can actually offer for the second stream —
   * the live language picker's own options, minus "auto". The picker is
   * itself filled from the backend's ``live_defaults.languages``.
   */
  availableLanguages: ReadonlyArray<string>;
  /** What the BACKEND does with an absent preference. Not a guess. */
  fallback: DualStreamDefaults;
}

export interface DualStreamPreference {
  dualStream: boolean;
  secondaryLanguage: string;
}

/**
 * Resolve the stored pair into the pair the controls should show.
 *
 * The secondary language must be one this build can offer, or the select
 * would silently fall back to its first option while the renderer
 * believed it had set something else — and that belief is what the next
 * autosave writes to disk. "auto" is never a secondary language: the
 * second stream exists to be monolingual, and an Auto secondary would be
 * the multilingual stream twice at twice the price.
 */
export function resolveDualStreamPreference(input: DualStreamPreferenceInput): DualStreamPreference {
  const fallbackLanguage = String(input.fallback.secondaryLanguage || "").trim().toLowerCase();
  const offered = input.availableLanguages
    .map((code) => String(code || "").trim().toLowerCase())
    .filter((code) => code && code !== "auto");
  const stored = String(input.secondaryLanguage ?? "").trim().toLowerCase();
  const secondaryLanguage = offered.includes(stored)
    ? stored
    : offered.includes(fallbackLanguage)
      ? fallbackLanguage
      : offered[0] || fallbackLanguage;
  return {
    dualStream:
      typeof input.dualStream === "boolean" ? input.dualStream : input.fallback.dualStream,
    secondaryLanguage,
  };
}

/**
 * The one sentence that states what the second stream buys and costs.
 *
 * Two surfaces show this fact — the Settings note under the toggle and
 * the Auto hint on the Record view — and they stated it in two
 * different wordings ("costs 2× Deepgram minutes" against "for twice
 * the Deepgram minutes"), so a correction to the price or the claim
 * landed on one of them. It is one fact, so it is written once; the
 * language argument is the only thing the two surfaces disagree about,
 * because only the Record view knows which language is configured.
 */
export function dualStreamTradeOffText(secondaryLanguage = ""): string {
  const code = String(secondaryLanguage || "").trim().toUpperCase();
  const subject = code ? `A second ${code} stream fills` : "Fills";
  return `${subject} phrases the multilingual model drops, at twice the Deepgram minutes.`;
}
