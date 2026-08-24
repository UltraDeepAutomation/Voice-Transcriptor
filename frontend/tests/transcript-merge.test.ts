import { describe, it, expect } from "vitest";

import {
  candidateConfirmsTranscriptCoverage,
  joinTranscriptSegments,
  richerTranscript,
  textFromEnvelope,
} from "../src/transcript-merge";

describe("transcript-merge SSOT", () => {
  describe("textFromEnvelope", () => {
    it("prefers field text when it carries at least as many words", () => {
      expect(
        textFromEnvelope({ text: "one two three", segments: [{ text: "one" }] }),
      ).toBe("one two three");
    });
    it("falls back to joined segments when the field is thinner", () => {
      expect(
        textFromEnvelope({ text: "one", segments: [{ text: "one" }, { text: "two three" }] }),
      ).toBe("one two three");
    });
    it("returns empty for null/undefined envelopes", () => {
      expect(textFromEnvelope(null)).toBe("");
      expect(textFromEnvelope(undefined)).toBe("");
    });
  });

  describe("joinTranscriptSegments", () => {
    it("joins with single spaces, dropping empties", () => {
      expect(joinTranscriptSegments([{ text: " a b" }, { text: "" }, { text: "c" }])).toBe("a b c");
    });
    it("accepts typed TranscriptSegment-like objects without index signatures", () => {
      expect(joinTranscriptSegments([{ text: "x" }])).toBe("x");
    });
  });

  describe("richerTranscript — the tail-truncation fix core", () => {
    it("adopts the envelope when it restores the missing tail", () => {
      const instant = "начало фразы и";
      const backend = "начало фразы и самый конец";
      expect(richerTranscript(instant, backend)).toBe(backend);
    });
    it("keeps instant when the envelope adds nothing", () => {
      const t = "полный текст целиком";
      expect(richerTranscript(t, t)).toBe(t);
      expect(richerTranscript(t, "")).toBe(t);
    });
    it("equal word counts: longer candidate wins the length tiebreak (historical)", () => {
      // Preserved verbatim from main.tsx: same words but one more char
      // (e.g. trailing punctuation kept by whitespace normalization)
      // counts as "richer". Changing this tiebreak is a policy decision,
      // not a bugfix.
      expect(richerTranscript("один два", "один два!")).toBe("один два!");
    });
  });

  describe("candidateConfirmsTranscriptCoverage", () => {
    it("confirms identical or longer candidates", () => {
      expect(candidateConfirmsTranscriptCoverage("a b c", "a b c")).toBe(true);
      expect(candidateConfirmsTranscriptCoverage("a b c", "a b c d")).toBe(true);
    });
    it("rejects clearly shorter candidates", () => {
      expect(candidateConfirmsTranscriptCoverage("a b c d e f g h i j", "a b")).toBe(false);
    });
    it("accepts ≥90% overlap as confirmation", () => {
      const cur = "alpha beta gamma delta epsilon zeta eta theta";
      const cand = "alpha beta gamma delta epsilon zeta eta";
      expect(candidateConfirmsTranscriptCoverage(cur, cand)).toBe(true);
    });
  });
});
