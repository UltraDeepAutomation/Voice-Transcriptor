import { describe, it, expect } from "vitest";

import {
  candidateConfirmsTranscriptCoverage,
  joinTranscriptSegments,
  unionTranscripts,
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

  describe("unionTranscripts — neither reading is complete", () => {
    // Measured over 69 stops on 2026-08-25: eight delivered LESS text
    // than the provider returned, and the loss was mid-sentence. The
    // tail graft cannot reach it and the pick prefers whichever text has
    // more words overall.
    const production = [
      {
        name: "a phrase the live splice dropped from the middle",
        held: "В смысле, старая база данных Я ж тебе скинул. А можно как-то вернуть пароль из истории guitar?",
        authoritative: "В смысле, старая база данных отклоняет пароли. Я ж тебе скинул. А можно как-то вернуть пароль из истории guitar?",
        mustContain: ["отклоняет пароли", "Я ж тебе скинул", "из истории guitar"],
      },
      {
        name: "a clause the live splice dropped",
        held: "Склей пожалуйста два видеоролика вот и отправь мне, я тебе расскажу, что, как.",
        authoritative: "Склей пожалуйста два видеоролика вот так, чтобы стоял Вот, и отправь мне, я тебе расскажу, что, как.",
        mustContain: ["так, чтобы стоял", "отправь мне", "расскажу"],
      },
      {
        name: "a single word the live splice dropped",
        held: "не проверял. Сейчас проверю тоже.",
        authoritative: "не проверял. Кстати, сейчас проверю тоже.",
        mustContain: ["Кстати", "проверю тоже"],
      },
      {
        name: "the reverse — a phrase only the live splice heard, and a tail only the final heard",
        held: "Так, ну и у меня сейчас в последних влогах несколько слов. Они иногда до самого конца доходят, а иногда я нажимаю кнопку stop и у меня обрываются",
        authoritative: "Так, ну и у меня сейчас в последних влогах до самого конца доходят, а иногда я нажимаю кнопку stop, и у меня обрываются слова. В чём проблема?",
        mustContain: ["несколько слов", "обрываются слова", "В чём проблема"],
      },
    ];

    for (const c of production) {
      it(c.name, () => {
        const merged = unionTranscripts(c.held, c.authoritative);
        for (const fragment of c.mustContain) {
          expect(merged).toContain(fragment);
        }
      });
    }

    it("never repeats a word the two readings share", () => {
      for (const c of production) {
        const merged = unionTranscripts(c.held, c.authoritative);
        const words = merged.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
        const adjacentRepeats = words.filter((w, i) => i > 0 && w === words[i - 1]);
        expect(adjacentRepeats).toEqual([]);
      }
    });

    it("keeps every word of the authoritative reading", () => {
      // Both sides normalised the same way: the merged text keeps the
      // original punctuation, so stripping it from only one side would
      // look for "както" inside "как-то".
      const words = (t: string) =>
        t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").split(/\s+/).filter(Boolean);
      for (const c of production) {
        const merged = new Set(words(unionTranscripts(c.held, c.authoritative)));
        for (const w of words(c.authoritative)) {
          expect(merged.has(w)).toBe(true);
        }
      }
    });

    it("falls back to the pick when the two texts are not the same speech", () => {
      const held = "совершенно другая тема без единого общего слова";
      const authoritative = "one two three four five six seven";
      expect(unionTranscripts(held, authoritative)).toBe(
        richerTranscript(held, authoritative),
      );
    });

    it("returns the other side when one is empty", () => {
      expect(unionTranscripts("", "только это")).toBe("только это");
      expect(unionTranscripts("только это", "")).toBe("только это");
    });

    it("is a no-op on identical readings", () => {
      const text = "один и тот же текст полностью";
      expect(unionTranscripts(text, text)).toBe(text);
    });
  });
});
