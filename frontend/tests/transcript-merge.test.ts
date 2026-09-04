import { describe, it, expect } from "vitest";

import {
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
});
