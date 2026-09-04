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
 * Pure: no DOM, no fetch. Unit-tested in tests/deepgram-dual.test.ts.
 */

/** Backend defaults, restated here because the renderer must resolve absence without asking. */
export const DUAL_STREAM_DEFAULT = true;
export const DUAL_SECONDARY_LANGUAGE_DEFAULT = "ru";

export interface DualStreamPreferenceInput {
  /** ``preferences.deepgram.dual_stream`` exactly as the config had it. */
  dualStream?: unknown;
  /** ``preferences.deepgram.dual_secondary_language`` exactly as the config had it. */
  secondaryLanguage?: unknown;
  /**
   * Language codes this build can actually offer for the second stream —
   * the live language picker's own options, minus "auto".
   */
  availableLanguages: ReadonlyArray<string>;
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
  const offered = input.availableLanguages
    .map((code) => String(code || "").trim().toLowerCase())
    .filter((code) => code && code !== "auto");
  const stored = String(input.secondaryLanguage ?? "").trim().toLowerCase();
  const secondaryLanguage = offered.includes(stored)
    ? stored
    : offered.includes(DUAL_SECONDARY_LANGUAGE_DEFAULT)
      ? DUAL_SECONDARY_LANGUAGE_DEFAULT
      : offered[0] || DUAL_SECONDARY_LANGUAGE_DEFAULT;
  return {
    dualStream: typeof input.dualStream === "boolean" ? input.dualStream : DUAL_STREAM_DEFAULT,
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
