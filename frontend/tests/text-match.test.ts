import { describe, it, expect } from "vitest";

import {
  normalizeWords,
  normalizeComparable,
  countWords,
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
