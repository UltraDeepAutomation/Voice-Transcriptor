import { describe, it, expect } from "vitest";

import {
  candidateConfirmsTranscriptCoverage,
  chooseStopTranscript,
  joinTranscriptSegments,
  mergeReadings,
  unionTranscripts,
  richerTranscript,
  textFromEnvelope,
  type Reading,
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

  describe("unionTranscripts — 2026-09-03 23:49:57 seam duplication (§4.8)", () => {
    // Both texts below are verbatim from the saved evidence file
    // ``evidence-2026-09-03/2026-09-03_23-49-57-983102__Так_ слушай…txt``
    // in the app's userData directory: ``Original:`` is the backend's
    // final envelope, ``Transcription:`` is what the app delivered and
    // pasted. The delivered text carries the clause "prompt я
    // наговорил, можешь посмотреть WAV" twice.
    //
    // Feeding the delivered text back as the held reading reproduces
    // the failure exactly rather than approximating it: on the code as
    // it stood, ``unionTranscripts(DELIVERED, AUTHORITATIVE)`` returned
    // DELIVERED byte for byte — the duplicated clause is a one-sided
    // run that the alignment appended whole, and it survives every
    // further pass. The union is only correct if it collapses it.
    const AUTHORITATIVE =
      "Так, слушай. Если тебе нужно, я вот сейчас описываю прямо сейчас голосовой сообщение, оно останется " +
      "hello, hello everybody that's close up agents workflow that we are sub the issues inside my text lab de " +
      "la capitale de la France. На французском я обычно не говорю, но тем не менее Возможно, в чанках, проблема " +
      "в том что происходит после нажатия кнопки возможно проблема в обрезках, я не знаю, тебе нужно " +
      "самостоятельно это все изучить, может ты уже нашел истинные причины и can fix them them sub agents sub " +
      "agents c источник истины вот такой вот длины prompt я наговорил, ты можешь посмотреть WAV файлы через " +
      "логи прямо сейчас";
    const DELIVERED =
      "Так, слушай. Если тебе нужно, я вот сейчас описываю прямо сейчас голосовой сообщение, оно останется " +
      "hello, hello everybody that's close up agents workflow that we are sub the issues inside my text lab de " +
      "la capitale de la France. На французском я обычно не говорю, но тем не менее Возможно, в чанках, проблема " +
      "в том что происходит после нажатия кнопки возможно проблема в обрезках, я не знаю, тебе нужно " +
      "самостоятельно это все изучить, может ты уже нашел истинные причины и can fix them them sub agents sub " +
      "agents c источник истины вот такой вот длины prompt я наговорил, ты можешь посмотреть WAV prompt я " +
      "наговорил, можешь посмотреть WAV файлы через логи прямо сейчас";

    it("does not deliver the re-decoded clause twice", () => {
      const merged = unionTranscripts(DELIVERED, AUTHORITATIVE);
      expect((merged.match(/можешь посмотреть WAV/g) || []).length).toBe(1);
    });

    it("keeps the envelope's reading of that clause intact", () => {
      const merged = unionTranscripts(DELIVERED, AUTHORITATIVE);
      expect(merged).toContain("ты можешь посмотреть WAV файлы через логи прямо сейчас");
    });

    it("loses nothing else from either reading", () => {
      const merged = unionTranscripts(DELIVERED, AUTHORITATIVE);
      expect(merged).toBe(AUTHORITATIVE);
    });
  });

  describe("unionTranscripts — mirror invariant", () => {
    // The reverse of "keeps every word of the authoritative reading"
    // (above): the held reading is not second-class. On a two-sided
    // gap the longer run wins regardless of which side it came from.
    it("keeps every word of the held reading unless the authoritative covers that span with at least as many words", () => {
      const held = "начало общее середина держит гораздо больше слов чем версия конец общее";
      const authoritative = "начало общее середина версия конец общее";
      const merged = unionTranscripts(held, authoritative);
      expect(merged).toContain("держит гораздо больше слов чем версия");
    });

    it("still prefers the authoritative run when it is not shorter", () => {
      const held = "начало общее середина короче конец общее";
      const authoritative = "начало общее середина заметно длиннее и полнее конец общее";
      const merged = unionTranscripts(held, authoritative);
      expect(merged).toContain("заметно длиннее и полнее");
      expect(merged).not.toContain("короче");
    });
  });

  describe("unionTranscripts — similarity gate (§4.8b)", () => {
    it("falls back to the pick below the aligned-token floor even with a perfect ratio", () => {
      // A trivial one-word candidate can share 100% of ITS OWN small
      // vocabulary with a much larger text without being the same
      // speech in different words.
      const held = "один";
      const authoritative = "этот текст не содержит совпадений вовсе";
      expect(unionTranscripts(held, authoritative)).toBe(richerTranscript(held, authoritative));
    });
  });

  describe("unionTranscripts — punctuation is never dropped (§4.8d)", () => {
    it("keeps a standalone punctuation token attached to its neighbour", () => {
      const held = "фраза с восклицанием ! и продолжением";
      const authoritative = "фраза с восклицанием ! и продолжением дальше";
      const merged = unionTranscripts(held, authoritative);
      expect(merged).toContain("!");
    });
  });

  describe("unionTranscripts — long recordings still align (§4.8c)", () => {
    it("aligns two ~700-word readings (past the old 600-word cutoff) instead of falling back to a pick", () => {
      const base = Array.from({ length: 700 }, (_, i) => `слово${i}`);
      // Held has a clause authoritative lacks; authoritative has a
      // *different* clause held lacks, at a different position. A pick
      // (richerTranscript, and the old UNION_MAX_WORDS fallback) can
      // only return one side's words — never both insertions at once.
      const held = [...base.slice(0, 300), "held", "only", "clause", "here", "now", ...base.slice(300)].join(" ");
      const authoritative = [...base.slice(0, 500), "auth", "only", "clause", "here", "now", ...base.slice(500)].join(" ");
      const merged = unionTranscripts(held, authoritative);
      expect(merged).toContain("held only clause here now");
      expect(merged).toContain("auth only clause here now");
      // A fallback pick could contain at most one of the two clauses.
      expect(merged).not.toBe(richerTranscript(held, authoritative));
    });
  });
});

// ── Seam-time merge (debt registry item (d)) ─────────────────────────

/**
 * A segment whose words are spread evenly across its span.
 *
 * The FIXTURE may interpolate; the production code deliberately does not
 * (see ``timedTokens``). This is how the backend's real envelopes look —
 * ``normalize_words`` puts a start/end on every word of every final — and
 * writing them out by hand for a ninety-word evidence text would be
 * noise, not fidelity.
 */
function wordTimed(text: string, start: number, end: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const step = words.length ? (end - start) / words.length : 0;
  return {
    text,
    start,
    end,
    words: words.map((word, i) => ({
      word,
      start: Number((start + i * step).toFixed(3)),
      end: Number((start + (i + 1) * step).toFixed(3)),
    })),
  };
}

/** A segment with a span and no per-word times — the live buffer's shape. */
function spanTimed(text: string, start: number, end: number) {
  return { text, start, end };
}

function reading(segments: Array<{ text: string }>, text?: string): Reading {
  return {
    text: text ?? segments.map((s) => s.text).join(" "),
    segments,
  };
}

describe("mergeReadings — strategy is chosen by the data", () => {
  it("falls back to the text union when either reading has no timestamps", () => {
    const held = "старая база данных Я ж тебе скинул";
    const authoritative = "старая база данных отклоняет пароли. Я ж тебе скинул.";
    expect(mergeReadings({ text: held }, { text: authoritative })).toBe(
      unionTranscripts(held, authoritative),
    );
    // One side timed is not enough: a seam needs one axis, not half of one.
    expect(
      mergeReadings(
        { text: held, segments: [spanTimed(held, 0, 4)] },
        { text: authoritative },
      ),
    ).toBe(unionTranscripts(held, authoritative));
  });

  it("falls back to the text union when the two readings are not the same speech", () => {
    const held = reading([spanTimed("один два три четыре пять шесть", 0, 3)]);
    const authoritative = reading([wordTimed("совершенно другая запись про другое дело", 0, 3)]);
    expect(mergeReadings(held, authoritative)).toBe(
      unionTranscripts(String(held.text), String(authoritative.text)),
    );
  });

  it("returns the other side when one reading is empty", () => {
    expect(mergeReadings({ text: "" }, { text: "только это" })).toBe("только это");
    expect(mergeReadings({ text: "только это" }, { text: "" })).toBe("только это");
  });

  it("takes the authoritative spelling when the two readings agree word for word", () => {
    const text = "проверка связи раз два три четыре";
    const held = reading([spanTimed(text, 0, 3)]);
    const authoritative = reading([wordTimed(text, 0, 3)]);
    expect(mergeReadings(held, authoritative)).toBe(text);
  });
});

describe("mergeReadings — 2026-09-03 23:49:57 duplication, decided in time", () => {
  // The same evidence pair as the union fixture above, placed on the
  // clock the live stream actually gave it: the held reading's last
  // segment is the live splice's own RE-DECODE of the clause before it
  // (that is why it repeats it), so it overlaps that clause in time,
  // while the envelope states the clause once with per-word times.
  const PREFIX =
    "Так, слушай. Если тебе нужно, я вот сейчас описываю прямо сейчас голосовой сообщение, оно останется " +
    "hello, hello everybody that's close up agents workflow that we are sub the issues inside my text lab de " +
    "la capitale de la France. На французском я обычно не говорю, но тем не менее Возможно, в чанках, проблема " +
    "в том что происходит после нажатия кнопки возможно проблема в обрезках, я не знаю, тебе нужно " +
    "самостоятельно это все изучить, может ты уже нашел истинные причины и can fix them them sub agents sub " +
    "agents c источник истины вот такой вот длины";
  const AUTHORITATIVE_TAIL = "prompt я наговорил, ты можешь посмотреть WAV файлы через логи прямо сейчас";
  const HELD_TAIL_FIRST = "prompt я наговорил, ты можешь посмотреть WAV";
  const HELD_TAIL_REDECODE = "prompt я наговорил, можешь посмотреть WAV файлы через логи прямо сейчас";

  const held = reading([
    spanTimed(PREFIX, 0, 39.5),
    spanTimed(HELD_TAIL_FIRST, 40.2, 43),
    spanTimed(HELD_TAIL_REDECODE, 41.5, 47),
  ]);
  const authoritative = reading([
    wordTimed(PREFIX, 0, 39.5),
    wordTimed(AUTHORITATIVE_TAIL, 40.2, 47),
  ]);

  it("does not deliver the re-decoded clause twice", () => {
    const merged = mergeReadings(held, authoritative);
    expect((merged.match(/можешь посмотреть WAV/g) || []).length).toBe(1);
  });

  it("keeps the envelope's reading of that clause intact", () => {
    expect(mergeReadings(held, authoritative)).toContain(
      "ты можешь посмотреть WAV файлы через логи прямо сейчас",
    );
  });

  it("loses nothing else from either reading", () => {
    expect(mergeReadings(held, authoritative)).toBe(`${PREFIX} ${AUTHORITATIVE_TAIL}`);
  });
});

describe("mergeReadings — a two-sided divergence the text union mishandles", () => {
  // Two readings of one utterance, differing over the SAME span, with a
  // 0.8 s pause in the middle of it. The union aligns them by their
  // shared words and takes the longer run out of each gap, so it emits a
  // sentence that exists in neither reading; the seam merge cuts once at
  // the pause and each reading is delivered whole on its own side of it.
  const HELD_TEXT = "мы поехали в магазин за молоком и хлебом";
  const AUTHORITATIVE_TEXT = "мы пошли в лавку за хлебом";
  const held = reading([
    spanTimed("мы поехали в магазин", 0, 1.6),
    spanTimed("за молоком и хлебом", 2.4, 4.2),
  ], HELD_TEXT);
  const authoritative = reading([
    wordTimed("мы пошли в лавку", 0, 1.6),
    wordTimed("за хлебом", 2.4, 4.2),
  ], AUTHORITATIVE_TEXT);

  it("the text union invents a sentence neither reading contains", () => {
    const united = unionTranscripts(HELD_TEXT, AUTHORITATIVE_TEXT);
    expect(united).not.toBe(HELD_TEXT);
    expect(united).not.toBe(AUTHORITATIVE_TEXT);
    expect(united).toContain("лавку за молоком");
  });

  it("the seam merge cuts at the pause and mixes nothing inside a clause", () => {
    const merged = mergeReadings(held, authoritative);
    expect(merged).toBe("мы поехали в магазин за хлебом");
  });
});

describe("mergeReadings — a phrase genuinely said twice is kept twice", () => {
  // The n-gram guard collapses a repeat only when the two runs occupy
  // the SAME seconds of audio. Here the speaker says "это очень важно"
  // at 1 s and again at 30 s: same words, different audio, both kept.
  const REPEAT = "это очень важно";
  const held = reading([
    spanTimed(`Слушай ${REPEAT} и запомни`, 0.5, 3.5),
    spanTimed("потом были другие дела и разговоры", 10, 14),
    spanTimed(`а в конце я повторил ${REPEAT}`, 29, 32),
  ]);
  const authoritative = reading([
    wordTimed(`Слушай ${REPEAT} и запомни`, 0.5, 3.5),
    wordTimed("потом были другие дела, разговоры и встречи", 10, 14),
    wordTimed(`а в конце я повторил ${REPEAT}`, 29, 32),
  ]);

  it("keeps both occurrences", () => {
    const merged = mergeReadings(held, authoritative);
    expect((merged.match(/это очень важно/g) || []).length).toBe(2);
  });
});

describe("mergeReadings — a word straddling the seam takes the authoritative spelling", () => {
  // The seam falls in the 0.9 s pause at ~4.5 s. "субагента" is spoken
  // across it; the live splice heard "сунагента" and the full-context
  // decode heard "субагента". It must appear once, spelled the
  // authoritative way — the alignment inside the ±1 s window is what
  // decides that, not the cut.
  const held = reading([
    spanTimed("нам нужно проверить как работает", 1, 4.05),
    spanTimed("сунагента", 4.05, 4.95),
    spanTimed("в этом сценарии подробно", 4.95, 7),
  ]);
  const authoritative = reading([
    wordTimed("нам нужно проверить как работает", 1, 4),
    wordTimed("субагента", 4.1, 5),
    wordTimed("в этом сценарии подробнее", 5, 7),
  ]);

  it("spells the straddling word the authoritative way, exactly once", () => {
    const merged = mergeReadings(held, authoritative);
    expect((merged.match(/агента/g) || []).length).toBe(1);
    expect(merged).toContain("субагента");
    expect(merged).not.toContain("сунагента");
  });
});

describe("mergeReadings — the held reading's uncommitted tail always survives", () => {
  it("does not append the whole transcript when the held text also differs mid-way", () => {
    // The held text the stop path composes is NOT always its committed
    // text plus a suffix: an earlier envelope merge can have put words in
    // the middle of it. A prefix rule would call the entire text "the
    // tail" and append the transcript to itself.
    const held: Reading = {
      text: "первая часть и вторая, уточнённая, часть плюс незакрытый хвост",
      segments: [spanTimed("первая часть и вторая часть", 0, 3)],
    };
    const authoritative = reading([wordTimed("первая часть и вторая часть", 0, 3)]);
    const merged = mergeReadings(held, authoritative);
    expect((merged.match(/первая часть/g) || []).length).toBe(1);
    expect(merged).toContain("плюс незакрытый хвост");
  });

  it("emits interim words no committed segment accounts for", () => {
    const held: Reading = {
      // What the live view holds: the committed segments PLUS the
      // interim hypothesis for audio nothing has finalized yet.
      text: "первая часть и вторая часть плюс незакрытый хвост",
      segments: [spanTimed("первая часть и вторая часть", 0, 3)],
    };
    const authoritative = reading([wordTimed("первая часть и вторая часть", 0, 3)]);
    expect(mergeReadings(held, authoritative)).toBe(
      "первая часть и вторая часть плюс незакрытый хвост",
    );
  });
});

// ── chooseStopTranscript (D2) ─────────────────────────────────────────
//
// Support log 2026-09-04, three sessions where the renderer duplicated
// text on stop. The saved evidence files (copied to
// ``evidence-2026-09-03/`` in the app's userData directory, per the
// session's own timestamp) hold ``Original:`` / ``Transcription:``
// fields for each recording; the fixtures below reconstruct the exact
// candidate texts the stop path had in hand, verified byte-for-byte
// against the numbers ``main.log`` printed for the same stop
// (``candidateLen``/``candidateWords``, ``instantWords``, the final
// ``transcriptLen``/``transcriptWords``).
describe("chooseStopTranscript — complete envelope replaces the held reading (D2, session 521f9788)", () => {
  // Single-stream recording, one Deepgram final spanning the whole
  // 33.35 s (0.00–33.35, gap=0) — ``envelopeCoversRecording`` is true.
  // ``ENVELOPE`` is the exact 76-word/395-char final the backend log
  // reported (``race-first envelope ms=177 words=76 ... candidateLen=395
  // candidateWords=76``) and is also, byte for byte, the leading run of
  // the delivered (buggy) 189-word/966-char paste — the rest of that
  // paste is the live buffer's own reading of the same speech, unioned
  // in by the deleted ``composeStopTranscript`` even though the
  // envelope already had it all.
  const ENVELOPE =
    "Скажи, пожалуйста, мы все устройства движения и так далее, Которые Были У Автора, Построили У Нас Я " +
    "тебе давал такую задачу и говорил, что она есть в Все устройства, которые у него есть, вот, в его " +
    "картах, там, да, то, что он там четыре папки в два. Там есть очень много чего у нас нет и что у нас " +
    "сделано хуже. Именно по по движениям, по анимациям и далее. Далее. Это всё нужно перевести к нам.";
  // The live buffer's own reading of the same speech (real text — the
  // remainder of the delivered paste once ``ENVELOPE`` is stripped off
  // its front). It restates most of the same clauses with a different
  // ending ("Это все нужно" instead of "Это всё нужно перевести к
  // нам.") — exactly the kind of near-duplicate an alignment-based
  // union used to graft on rather than recognise as already covered.
  const HELD =
    "вот, в его картах, там, да, то, что он там четыре папки в два. Там есть очень много чего у нас нет " +
    "и что у нас сделано хуже. Именно по по движениям, по анимациям и далее. Далее. Это все нужно Скажи, " +
    "пожалуйста, мы все устройства движения и так далее, Которые Были У Автора, Построили У Нас Я тебе " +
    "давал такую задачу и говорил, что она есть в Все устройства, которые у него есть, вот, в его картах, " +
    "там, да, то, что он там четыре папки в два. Там есть очень много чего у нас нет и что у нас сделано " +
    "хуже. Именно по по движениям, по анимациям и далее. Далее. Это все нужно";

  it("delivers the envelope text exactly, no duplication, regardless of what the held reading contains", () => {
    const result = chooseStopTranscript({
      envelopeText: ENVELOPE,
      envelopeCovers: true,
      heldText: HELD,
    });
    expect(result.text).toBe(ENVELOPE);
    expect(result.source).toBe("envelope");
    // The defect this regresses: the held reading's own restatement of
    // "движениям, по анимациям и далее" must not survive a second time.
    expect((result.text.match(/движениям, по анимациям и далее/g) || []).length).toBe(1);
  });

  it("still replaces outright even when the held reading is empty or identical", () => {
    expect(chooseStopTranscript({ envelopeText: ENVELOPE, envelopeCovers: true, heldText: "" }))
      .toEqual({ text: ENVELOPE, source: "envelope" });
    expect(chooseStopTranscript({ envelopeText: ENVELOPE, envelopeCovers: true, heldText: ENVELOPE }))
      .toEqual({ text: ENVELOPE, source: "envelope" });
  });
});

describe("chooseStopTranscript — incomplete envelope still merges, held tail included (D2, session 8c12d76e)", () => {
  // Dual-stream recording; the merged envelope covered 23.35 s of a
  // 24.53 s recording (gap 1.18 s > TAIL_GAP_THRESHOLD_SEC) —
  // ``envelopeCoversRecording`` is false. Both texts below are
  // reconstructed from the evidence file and verified byte-for-byte
  // against ``main.log``'s own numbers for this stop: ``HELD`` matches
  // ``instantWords=37`` exactly (255 chars/37 words) and ``ENVELOPE``
  // matches ``race-first envelope ... words=38 candidateLen=268
  // candidateWords=38`` exactly. The actual delivered 75-word/524-char
  // paste is what the deleted ``composeStopTranscript`` produced from
  // these same two readings — each of the two clauses (the "Смотри…"
  // opener and the "Вот, Такая Тема…" closer) worded twice, once per
  // reading — which is the defect this test guards against.
  const HELD =
    "Смотри, какие-то куски повторяются. Посмотри, последнюю запись, вот. Самое первое сообщение это " +
    "запись получается, и сейчас то, что я записываю это, до Вот, Такая Тема. Может Быть, Какие-то Ещё " +
    "Найдёшь Баги, Ошибки. Повторение кусков это довольно странно.";
  const ENVELOPE =
    "Смотри, какие-то куски повторяются. Посмотри, последнюю запись, вот. Самое 1-ое сообщение это " +
    "предпоследнее. запись получается, и сейчас то, что я записываю это, до Вот, Такая Тема. Может Быть, " +
    "Какие-то еще найдешь Баги, Ошибки. Повторение кусков это довольно странно.";

  it("does not concatenate both readings' wording of the same two clauses", () => {
    const result = chooseStopTranscript({
      envelopeText: ENVELOPE,
      envelopeCovers: false,
      heldText: HELD,
    });
    expect(result.source).toBe("merged");
    // The actual 2026-09-04 defect: both wordings of the opener and of
    // the closing sentence, back to back.
    expect(result.text).not.toBe(`${HELD} ${ENVELOPE}`);
    expect((result.text.match(/куски повторяются/g) || []).length).toBe(1);
    expect((result.text.match(/довольно странно/g) || []).length).toBe(1);
    // Well below the naive union's 75 words — this is two clauses
    // merged, not four clauses appended.
    expect(result.text.split(/\s+/).length).toBeLessThan(50);
  });
});

describe("chooseStopTranscript — no envelope: held union recovery, as before (D2)", () => {
  it("unions the recovery decode into the held floor when it adds words", () => {
    const held = "старая база данных Я ж тебе скинул";
    const recovered = "старая база данных отклоняет пароли. Я ж тебе скинул.";
    const result = chooseStopTranscript({
      envelopeText: "",
      envelopeCovers: false,
      heldText: held,
      recoveredText: recovered,
    });
    expect(result).toEqual({ text: recovered, source: "recovery" });
  });

  it("keeps the held reading when recovery adds nothing", () => {
    const held = "старая база данных отклоняет пароли. Я ж тебе скинул.";
    const result = chooseStopTranscript({
      envelopeText: "",
      envelopeCovers: false,
      heldText: held,
      recoveredText: "старая база данных",
    });
    expect(result).toEqual({ text: held, source: "held" });
  });

  it("returns empty when nothing is available", () => {
    expect(chooseStopTranscript({ envelopeText: "", envelopeCovers: false, heldText: "" }))
      .toEqual({ text: "", source: "held" });
  });
});
