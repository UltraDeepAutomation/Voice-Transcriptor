import { describe, it, expect } from "vitest";

import { composeCanonicalLiveSourceText, mergeInterim } from "../src/live-source";

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

  describe("composeCanonicalLiveSourceText", () => {
    it("returns committed text when there is no hypothesis at all", () => {
      expect(composeCanonicalLiveSourceText("готовый текст", "", "")).toBe("готовый текст");
    });

    it("recovers the tail a partial final cut off", () => {
      // The reason the snapshot is kept: the final committed "последние"
      // out of "последние слова" and the interim that held the rest was
      // cleared by that very final.
      const merged = composeCanonicalLiveSourceText("это были последние", "", "последние слова");
      expect(merged).toBe("это были последние слова");
    });

    it("uses the current hypothesis for the tail past the last final", () => {
      expect(composeCanonicalLiveSourceText("первая часть", "и вторая часть", "")).toBe(
        "первая часть и вторая часть",
      );
    });
  });
});
