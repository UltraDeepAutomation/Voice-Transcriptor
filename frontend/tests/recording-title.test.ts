import { describe, expect, it } from "vitest";
import {
  SMART_TITLE_MAX_CHARS,
  SMART_TITLE_MAX_WORDS,
  smartRecordingTitle,
} from "../src/recording-title";

describe("smartRecordingTitle", () => {
  it("takes the first eight words", () => {
    expect(smartRecordingTitle("one two three four five six seven eight nine ten", "fb"))
      .toBe("one two three four five six seven eight");
  });

  it("keeps a shorter transcript whole", () => {
    expect(smartRecordingTitle("just three words", "fb")).toBe("just three words");
  });

  it("normalises runs of whitespace, including newlines", () => {
    expect(smartRecordingTitle("  hello \n\n  there\tworld  ", "fb")).toBe("hello there world");
  });

  it("falls back when the transcript has no words", () => {
    // The Re-transcribe path used to name the recording "" here.
    expect(smartRecordingTitle("", "Recording 2026-09-04")).toBe("Recording 2026-09-04");
    expect(smartRecordingTitle("   \n\t ", "Recording 2026-09-04")).toBe("Recording 2026-09-04");
  });

  it("caps a long title with an ellipsis, ellipsis included in the cap", () => {
    // Eight words that run past the ceiling: German compounds, a URL, or
    // dictated base64 all do this, and the second implementation had no
    // ceiling at all.
    const long = "Donaudampfschifffahrtsgesellschaftskapitaen "
      + "Rindfleischetikettierungsueberwachungsaufgabenuebertragungsgesetz "
      + "Grundstuecksverkehrsgenehmigungszustaendigkeitsuebertragungsverordnung";
    const title = smartRecordingTitle(long, "fb");
    expect(title.length).toBe(SMART_TITLE_MAX_CHARS);
    expect(title.endsWith("...")).toBe(true);
  });

  it("does not add an ellipsis to a title that exactly fits", () => {
    const exact = "a".repeat(SMART_TITLE_MAX_CHARS);
    expect(smartRecordingTitle(exact, "fb")).toBe(exact);
  });

  it("counts words, not characters, before applying the ceiling", () => {
    const words = Array.from({ length: SMART_TITLE_MAX_WORDS + 5 }, (_, i) => `w${i}`).join(" ");
    expect(smartRecordingTitle(words, "fb").split(" ")).toHaveLength(SMART_TITLE_MAX_WORDS);
  });

  it("tolerates a non-string transcript", () => {
    expect(smartRecordingTitle(undefined as unknown as string, "fb")).toBe("fb");
  });
});
