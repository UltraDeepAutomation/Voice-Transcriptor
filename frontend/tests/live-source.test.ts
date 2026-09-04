import { describe, it, expect } from "vitest";

import { mergeInterim } from "../src/live-source";

describe("live-source composition", () => {
  describe("the re-decoded seam — production 2026-08-25 14:19:55", () => {
    // What the log recorded for that stop:
    //   committedLen=46  lastInterimSnapshotLen=70  instantTranscriptLen=140
    // 46 + 1 + 70 = 117, and the delivered text opened with the sentence
    // twice. The final had mis-heard one word at the seam, and one
    // divergent word is enough to defeat an exact suffix/prefix rule at
    // every window length, so the whole hypothesis was appended.
    const committed = "Так, ну вроде сейчас сообщение записывается за";
    const snapshot = "Так, ну вроде сейчас сообщение записывается, заебись, довольно быстро.";

    it("does not repeat the opening of the sentence", () => {
      const merged = mergeInterim(committed, snapshot);
      const openings = merged.match(/Так, ну вроде сейчас/g) || [];
      expect(openings.length).toBe(1);
    });

    it("keeps the words only the hypothesis heard", () => {
      const merged = mergeInterim(committed, snapshot);
      expect(merged).toContain("заебись");
      expect(merged).toContain("довольно быстро");
    });

    it("supersedes the mis-heard word rather than keeping both readings", () => {
      // "за" was the final's rendering of "заебись". Keeping it would
      // leave "…записывается за заебись…".
      expect(mergeInterim(committed, snapshot)).toBe(snapshot);
    });
  });

  describe("guards that must keep holding", () => {
    it("drops a hypothesis already contained in the committed text", () => {
      expect(mergeInterim("привет как дела сегодня", "как дела")).toBe(
        "привет как дела сегодня",
      );
    });

    it("appends only the new tail across a shifted boundary", () => {
      expect(mergeInterim("я сказал больше", "больше завершил")).toBe(
        "я сказал больше завершил",
      );
    });

    it("recognises an inflected re-statement as already covered", () => {
      // 2026-08-24, session 20-32-21 — the case tokensInOrder exists for.
      expect(
        mergeInterim("именно обратил внимание на визуальную часть", "обратил внимание на визуальное"),
      ).toBe("именно обратил внимание на визуальную часть");
    });

    it("appends genuinely new content", () => {
      expect(mergeInterim("первая фраза", "совершенно другая мысль")).toBe(
        "первая фраза совершенно другая мысль",
      );
    });

    it("does not supersede on a short common opening", () => {
      // Two words in common is a coincidence, not a re-decode: the
      // hypothesis is new speech and must be appended, not swallow the
      // committed run before it.
      const merged = mergeInterim("мы поехали домой и всё", "и всё-таки он вернулся");
      expect(merged).toContain("мы поехали домой");
      expect(merged).toContain("вернулся");
    });

    it("leaves a long committed history alone when the hypothesis re-decodes its tail", () => {
      const base = "первое предложение. второе предложение. третье сообщение записывается за";
      const interim = "третье сообщение записывается, заебись, быстро";
      const merged = mergeInterim(base, interim);
      expect(merged).toContain("первое предложение.");
      expect(merged).toContain("второе предложение.");
      expect(merged).toContain("заебись");
      expect((merged.match(/третье сообщение/g) || []).length).toBe(1);
    });
  });


  describe("seam-anchored guards (BUGS_AUDIT_2026-09-03 §4.2)", () => {
    it("keeps a word the speaker says again much later", () => {
      // The containment guard used to search the WHOLE committed text:
      // "нужно" had occurred half a minute earlier, so the hypothesis
      // that carried it again was discarded in full.
      const base = "нужно сделать всё это а потом мы поговорим о том что случилось вчера вечером после работы";
      expect(mergeInterim(base, "нужно")).toBe(`${base} нужно`);
    });

    it("keeps a clause the speaker deliberately repeats", () => {
      const base = "сначала повтори это ещё раз потом сделай это";
      const merged = mergeInterim(base, "повтори это ещё раз");
      expect((merged.match(/повтори это ещё раз/g) || []).length).toBe(2);
    });

    it("still collapses a re-decode of the clause immediately before it", () => {
      // Same words, arriving as a re-statement of the seam rather than
      // as new speech: one copy, not two.
      const base = "сначала я сказал повтори это ещё раз";
      expect(mergeInterim(base, "повтори это ещё разок")).toBe(
        "сначала я сказал повтори это ещё разок",
      );
    });

    it("never drops more committed words than a mis-heard seam can explain", () => {
      // The share rule alone let a 70%-matched window supersede the
      // rest: four committed words vanish with nothing said in their
      // place. The absolute bound is what stops that.
      const base = "раз два три четыре пять шесть семь восемь девять десять";
      // Neither dropped nor duplicated: the alignment still says where
      // the hypothesis stops restating, so only its continuation is
      // appended.
      expect(mergeInterim(base, "раз два три четыре пять шесть семь и дальше")).toBe(
        `${base} и дальше`,
      );
    });
  });

  describe("the whole live composition: committed + current hypothesis", () => {
    it("returns committed text when there is no hypothesis at all", () => {
      expect(mergeInterim("готовый текст", "")).toBe("готовый текст");
    });

    it("uses the current hypothesis for the tail past the last final", () => {
      expect(mergeInterim("первая часть", "и вторая часть")).toBe("первая часть и вторая часть");
    });

    it("does not recover a word from a hypothesis a later final displaced", () => {
      // Session ``a9fd3fd9``, 2026-09-03T21:43:06Z. Deepgram's finals
      // were "…в одном из" [4.07-7.66] and "последних сообщений.
      // Посмотри внимательно." [7.66-10.30]; the word "трёх" existed
      // only in the interim [4.07-6.10] that the first final retired.
      // The renderer used to accumulate that residue and glue "трёх в"
      // onto the END of the transcript — a word put where it was never
      // spoken. Nothing here holds it any more: the preview is the
      // finals plus the CURRENT hypothesis, and a word missing from the
      // middle is the backend's word-level splice to place.
      const bothFinals = "Посмотри, пожалуйста, в одном из последних сообщений. Посмотри внимательно.";
      expect(mergeInterim(bothFinals, "")).toBe(bothFinals);
      expect(mergeInterim(bothFinals, "")).not.toContain("трёх");
    });
  });
});
