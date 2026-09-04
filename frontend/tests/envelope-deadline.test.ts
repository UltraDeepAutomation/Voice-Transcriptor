import { describe, it, expect } from "vitest";

import {
  computeEnvelopeDeadlineMs,
  envelopeMissing,
  envelopeTranscript,
} from "../src/envelope-deadline";

const CONFIG = { confirmMs: 1_500, marginMs: 800, maxWaitMs: 11_000 };

describe("computeEnvelopeDeadlineMs — PROTOCOL CONTRACT C3", () => {
  it("announcement arrives 125 ms into a 1500 ms window and extends it", () => {
    // BUGS_AUDIT_2026-09-03 §2.1: the backend announced a 6000ms budget
    // but the old code had already frozen a 1500ms cap before the
    // announcement could arrive (median +126ms). The deadline is always
    // measured from when the wait started, so a late announcement still
    // gets the full extension applied.
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 6_000, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(6_000 + CONFIG.marginMs);
    expect(deadline).toBeGreaterThan(CONFIG.confirmMs);
  });

  it("expectsMore=false does not extend", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 6_000, expectsMore: false },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.confirmMs);
  });

  it("clamps an extension to the hard ceiling", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 50_000, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.maxWaitMs);
  });

  it("never drops below the confirm window even for a tiny announced budget", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: 10, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.confirmMs);
  });

  it("treats a negative budgetMs as zero rather than shrinking the window", () => {
    const deadline = computeEnvelopeDeadlineMs(
      { budgetMs: -500, expectsMore: true },
      CONFIG,
    );
    expect(deadline).toBe(CONFIG.confirmMs);
  });
});

describe("envelopeMissing — the one predicate that picks the fallback", () => {
  it("no envelope at all is missing (deadline expired, or no socket ever existed)", () => {
    expect(envelopeMissing(null)).toBe(true);
    expect(envelopeMissing(undefined)).toBe(true);
  });

  it("an errored envelope is missing — including the synthetic one ws.onclose resolves with", () => {
    expect(envelopeMissing({ text: "", error: "websocket closed" })).toBe(true);
    // Even carrying text: an error means the session failed rather than
    // finished, and a partial reading is exactly what must not be pasted.
    expect(envelopeMissing({ text: "половина фразы", error: "deepgram: 1011" })).toBe(true);
  });

  it("an EMPTY envelope with no error is present, not missing — that is silence", () => {
    // The recording holds no speech and the backend says so. Falling
    // back here would spend the on-disk decode's seconds to be told the
    // same thing again.
    expect(envelopeMissing({ text: "" })).toBe(false);
    expect(envelopeMissing({ text: "   ", error: "" })).toBe(false);
  });

  it("a normal envelope is present", () => {
    expect(envelopeMissing({ text: "полный текст" })).toBe(false);
  });
});

describe("envelopeTranscript — the envelope's text is delivered verbatim", () => {
  // The three sessions of 2026-09-04 that were pasted with whole clauses
  // twice. Each fixture is the exact envelope text the backend logged
  // for that stop, verified byte-for-byte against main.log's own
  // candidateLen/candidateWords figures. The old stop path merged the
  // renderer's own reading of the same speech into these; the merge is
  // gone, so the only thing that can be asserted about the delivered
  // text is that it IS the envelope.

  // Session 521f9788: one Deepgram final spanning the whole 33.35 s.
  // The delivered (buggy) paste was 189 words / 966 chars — this
  // 76-word / 395-char envelope followed by the live buffer's own
  // reading of the same speech.
  const ENVELOPE_521f9788 =
    "Скажи, пожалуйста, мы все устройства движения и так далее, Которые Были У Автора, Построили У Нас Я " +
    "тебе давал такую задачу и говорил, что она есть в Все устройства, которые у него есть, вот, в его " +
    "картах, там, да, то, что он там четыре папки в два. Там есть очень много чего у нас нет и что у нас " +
    "сделано хуже. Именно по по движениям, по анимациям и далее. Далее. Это всё нужно перевести к нам.";
  // What the live preview held for the same speech — restating most of
  // the same clauses with a different ending. Present here only to be
  // shown having no path into the result.
  const PREVIEW_521f9788 =
    "вот, в его картах, там, да, то, что он там четыре папки в два. Там есть очень много чего у нас нет " +
    "и что у нас сделано хуже. Именно по по движениям, по анимациям и далее. Далее. Это все нужно Скажи, " +
    "пожалуйста, мы все устройства движения и так далее, Которые Были У Автора, Построили У Нас Я тебе " +
    "давал такую задачу и говорил, что она есть в Все устройства, которые у него есть, вот, в его картах, " +
    "там, да, то, что он там четыре папки в два. Там есть очень много чего у нас нет и что у нас сделано " +
    "хуже. Именно по по движениям, по анимациям и далее. Далее. Это все нужно";

  // Session 8c12d76e: dual-stream, envelope covered 23.35 s of a
  // 24.53 s recording — the case the old code called "incomplete" and
  // merged with the preview, producing 75 words out of two 37/38-word
  // readings of the same two clauses. Coverage is not a question any
  // more: the backend closes its own gaps before it sends.
  const ENVELOPE_8c12d76e =
    "Смотри, какие-то куски повторяются. Посмотри, последнюю запись, вот. Самое 1-ое сообщение это " +
    "предпоследнее. запись получается, и сейчас то, что я записываю это, до Вот, Такая Тема. Может Быть, " +
    "Какие-то еще найдешь Баги, Ошибки. Повторение кусков это довольно странно.";

  it("delivers session 521f9788's envelope byte for byte", () => {
    expect(envelopeTranscript({ text: ENVELOPE_521f9788 })).toBe(ENVELOPE_521f9788);
  });

  it("no clause of session 521f9788 is delivered twice", () => {
    const delivered = envelopeTranscript({ text: ENVELOPE_521f9788 });
    expect((delivered.match(/движениям, по анимациям и далее/g) || []).length).toBe(1);
    expect(delivered.split(/\s+/).length).toBe(76);
    // The preview's own reading of the same speech is 60 words that
    // used to be appended to these 76. It is not a parameter of this
    // decision at all — there is nothing it could be passed as.
    expect(delivered).not.toContain("Это все нужно Скажи");
    expect(PREVIEW_521f9788.length).toBeGreaterThan(0);
  });

  it("delivers session 8c12d76e's envelope byte for byte, coverage notwithstanding", () => {
    expect(envelopeTranscript({ text: ENVELOPE_8c12d76e })).toBe(ENVELOPE_8c12d76e);
    const delivered = envelopeTranscript({ text: ENVELOPE_8c12d76e });
    expect((delivered.match(/куски повторяются/g) || []).length).toBe(1);
    expect((delivered.match(/довольно странно/g) || []).length).toBe(1);
  });

  it("trims surrounding whitespace and nothing else", () => {
    expect(envelopeTranscript({ text: "  два   пробела внутри  " })).toBe("два   пробела внутри");
  });

  it("an absent or empty envelope yields empty text", () => {
    expect(envelopeTranscript(null)).toBe("");
    expect(envelopeTranscript({})).toBe("");
  });
});
