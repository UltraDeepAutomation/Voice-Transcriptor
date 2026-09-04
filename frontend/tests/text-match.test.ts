import { describe, it, expect } from "vitest";

import {
  normalizeWords,
  normalizeComparable,
  countWords,
  stemKey,
  tokensInOrderAtTail,
} from "../src/text-match";

describe("text-match SSOT primitives", () => {
  describe("normalizeWords", () => {
    it("lowercases and strips punctuation", () => {
      expect(normalizeWords("Привет, МИР!")).toEqual(["привет", "мир"]);
      expect(normalizeWords("Hello—World (test)")).toEqual(["helloworld", "test"]);
    });

    it("keeps letters, digits and inner whitespace only", () => {
      expect(normalizeWords("a1-b2 c3")).toEqual(["a1b2", "c3"]);
      expect(normalizeWords("…")).toEqual([]);
      expect(normalizeWords("")).toEqual([]);
    });
  });

  describe("normalizeComparable", () => {
    it("collapses whitespace to single spaces", () => {
      expect(normalizeComparable("  A,  B\tC ")).toBe("a b c");
    });
    it("matches the word pipeline output when joined", () => {
      const s = "Раз — два, три!";
      expect(normalizeComparable(s)).toBe(normalizeWords(s).join(" "));
    });
  });

  describe("countWords", () => {
    it("counts whitespace-separated tokens", () => {
      expect(countWords("one two three")).toBe(3);
      expect(countWords("   ")).toBe(0);
      expect(countWords("")).toBe(0);
      // Note: punctuation-aware counting lives in normalizeWords;
      // countWords intentionally mirrors the historical behaviour.
      expect(countWords("well-known")).toBe(1);
    });
  });
});

describe("stemKey + tail containment — interim re-statement guard", () => {
  it("collides inflectional variants of the same word", () => {
    expect(stemKey("визуальную")).toBe(stemKey("визуальное"));
    expect(stemKey("записи")).toBe(stemKey("записях"));
  });

  describe("tokensInOrderAtTail", () => {
    const stems = (text: string): string[] => normalizeWords(text).map(stemKey);

    it("matches a re-statement of the haystack's own tail", () => {
      expect(
        tokensInOrderAtTail(
          stems("именно обратил внимание на визуальную часть"),
          stems("обратил внимание на визуальное"),
          2,
        ),
      ).toBe(true);
    });

    it("refuses a match that ends too far from the tail", () => {
      // Same words, but four haystack words follow them: the speaker
      // moved on, so this is a repeat, not a re-decode of the seam.
      expect(
        tokensInOrderAtTail(
          stems("сначала повтори это ещё раз потом сделай это снова"),
          stems("повтори это ещё раз"),
          2,
        ),
      ).toBe(false);
    });

    it("tolerates the allowed number of trailing words", () => {
      expect(tokensInOrderAtTail(stems("один два три четыре"), stems("один два"), 2)).toBe(true);
      expect(tokensInOrderAtTail(stems("один два три четыре"), stems("один два"), 1)).toBe(false);
    });

    it("still requires order and full containment", () => {
      expect(tokensInOrderAtTail(stems("первый второй третий"), stems("третий первый"), 5)).toBe(false);
      expect(tokensInOrderAtTail(stems("один два"), stems("один два три"), 5)).toBe(false);
      expect(tokensInOrderAtTail(stems("один два"), [], 0)).toBe(true);
    });
  });
});