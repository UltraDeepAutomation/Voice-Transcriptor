import { describe, it, expect } from "vitest";

import {
  composeLivePreviewText,
  joinTranscriptSegments,
  richerTranscript,
} from "../src/transcript-merge";

// What is left of this module serves the LIVE PREVIEW only. The stop
// path's own merge machinery — chooseStopTranscript, mergeReadings,
// unionTranscripts and the timed-token seam merge — is deleted along
// with its tests: the backend's ``final`` envelope is complete by
// construction and is delivered verbatim (see envelope-deadline.test.ts),
// so there is no second reading to reconcile it against.
describe("transcript-merge — live-preview helpers", () => {
  describe("joinTranscriptSegments — the committed finals as one string", () => {
    it("joins with single spaces, dropping empties", () => {
      expect(joinTranscriptSegments([{ text: " a b" }, { text: "" }, { text: "c" }])).toBe("a b c");
    });
    it("accepts typed TranscriptSegment-like objects without index signatures", () => {
      expect(joinTranscriptSegments([{ text: "x" }])).toBe("x");
    });
    it("is empty for an empty segment list", () => {
      expect(joinTranscriptSegments([])).toBe("");
    });
  });

  describe("richerTranscript — the preview's monotonic display floor", () => {
    it("grows when the fresh read carries more", () => {
      const shown = "начало фразы и";
      const fresh = "начало фразы и самый конец";
      expect(richerTranscript(shown, fresh)).toBe(fresh);
    });
    it("never regresses when a Deepgram interim resets at an utterance boundary", () => {
      const shown = "полный текст целиком";
      expect(richerTranscript(shown, "полный текст")).toBe(shown);
      expect(richerTranscript(shown, "")).toBe(shown);
    });
    it("takes the candidate when the floor is empty", () => {
      expect(richerTranscript("", "первое слово")).toBe("первое слово");
    });
    it("equal word counts: longer candidate wins the length tiebreak", () => {
      // Same words but one more char (e.g. trailing punctuation kept by
      // whitespace normalization) counts as "richer". A policy decision,
      // not a bugfix.
      expect(richerTranscript("один два", "один два!")).toBe("один два!");
    });
    it("equal word counts do NOT win when the candidate is a different reading", () => {
      expect(richerTranscript("один два", "одинx дваy")).toBe("один два");
    });
  });

  /**
   * B-041 (2026-09-05): a session's LIVE PREVIEW pane showed its whole
   * transcript twice after a stop ("Всё, другие агенты … проблем. Все,
   * другие агенты … проблем.") while the TRANSCRIBE pane — which only
   * ever reads the backend's ``final`` envelope verbatim — showed it
   * once. The envelope's segments had been appended onto a buffer that
   * already held the same speech from the incremental
   * ``segments``/``interim`` stream; their timings didn't line up
   * closely enough for the segment-level dedup to recognise the overlap.
   * The fix is not a better dedup: once a session's envelope has
   * resolved, it is the ONE text the preview shows, full stop — nothing
   * is unioned with it.
   */
  describe("composeLivePreviewText — the live preview's ONE rule once an envelope resolves", () => {
    it("committed finals text T, envelope text T → preview is T once (not T twice)", () => {
      const T = "Все, другие агенты вроде как починили наш транскриптор.";
      expect(composeLivePreviewText(T, T)).toBe(T);
    });

    it("no envelope yet (null) → shows the committed/interim reading as-is", () => {
      expect(composeLivePreviewText("начало фразы", null)).toBe("начало фразы");
      expect(composeLivePreviewText("начало фразы", undefined)).toBe("начало фразы");
    });

    it("envelope resolved, even with FEWER words than the committed/interim reading → envelope wins outright", () => {
      const committedAndInterim = "начало фразы и самый конец с лишним хвостом";
      const envelopeText = "начало фразы и конец";
      expect(composeLivePreviewText(committedAndInterim, envelopeText)).toBe(envelopeText);
    });

    it("envelope resolved with NO speech (empty string, not missing) → preview clears, does not fall back", () => {
      expect(composeLivePreviewText("частично услышанный текст", "")).toBe("");
    });

    it("normalizes whitespace the same way the rest of this module does", () => {
      expect(composeLivePreviewText("", "  два   слова  ")).toBe("два слова");
    });
  });
});
