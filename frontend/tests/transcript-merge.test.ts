import { describe, it, expect } from "vitest";

import {
  candidateConfirmsTranscriptCoverage,
  joinTranscriptSegments,
  mergeTranscriptTail,
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

  describe("mergeTranscriptTail — the union of two partial views", () => {
    // Production, 2026-08-25 13:05. Both texts are 27 words, so the
    // word-count comparison tied and the length tie-break handed the
    // user the live splice — which stops mid-thought. Each text holds
    // something the other lost.
    const liveSplice =
      "Так, ну и у меня сейчас в последних влогах несколько слов. Они иногда " +
      "до самого конца доходят, а иногда я нажимаю кнопку stop и у меня обрываются";
    const backendFinal =
      "Так, ну и у меня сейчас в последних влогах до самого конца доходят, " +
      "а иногда я нажимаю кнопку stop, и у меня обрываются слова. В чём проблема?";

    it("keeps the phrase only the live splice heard AND the clause only the final heard", () => {
      const merged = mergeTranscriptTail(liveSplice, backendFinal);
      expect(merged).toContain("несколько слов. Они иногда");
      expect(merged).toContain("обрываются слова. В чём проблема?");
    });

    it("picks a winner where the old policy did, and it lost the tail", () => {
      // The behaviour being replaced, kept as the reason this exists.
      expect(richerTranscript(liveSplice, backendFinal)).toBe(liveSplice);
      expect(richerTranscript(liveSplice, backendFinal)).not.toContain("В чём проблема");
    });

    it("appends nothing when the candidate ends where we do", () => {
      const held = "начало фразы и самый конец";
      expect(mergeTranscriptTail(held, "фразы и самый конец")).toBe(held);
    });

    it("anchors on the LAST occurrence of a repeated phrase", () => {
      const held = "раз два три раз два три";
      expect(mergeTranscriptTail(held, "раз два три раз два три четыре")).toBe(
        "раз два три раз два три четыре",
      );
    });

    it("aligns across an inflected re-decode of the anchor words", () => {
      // A later hypothesis re-states the same span with different
      // endings. Stem keys collide, so the anchor still holds and the
      // wording the user already saw is the one that is kept.
      const held = "мы проверили визуальную составляющую";
      const merged = mergeTranscriptTail(held, "мы проверили визуальное составляющее и цвет");
      expect(merged).toBe("мы проверили визуальную составляющую и цвет");
    });

    it("falls back to the pick when the two texts do not continue each other", () => {
      expect(mergeTranscriptTail("совершенно другой текст", "one two three four five")).toBe(
        "one two three four five",
      );
    });

    it("does not graft a punctuation-only tail", () => {
      const held = "фраза до самого конца";
      expect(mergeTranscriptTail(held, "фраза до самого конца .")).toBe(held);
    });

    it("returns the other side when one is empty", () => {
      expect(mergeTranscriptTail("", "候補")).toBe("候補");
      expect(mergeTranscriptTail("held", "")).toBe("held");
    });
  });
});
