import { describe, it, expect } from "vitest";

import {
  DUAL_SECONDARY_LANGUAGE_DEFAULT,
  DUAL_STREAM_DEFAULT,
  resolveDualStreamPreference,
} from "../src/deepgram-dual";

const offered = ["ru", "en"];

describe("resolveDualStreamPreference", () => {
  it("keeps what the user stored", () => {
    expect(
      resolveDualStreamPreference({
        dualStream: false,
        secondaryLanguage: "en",
        availableLanguages: offered,
      }),
    ).toEqual({ dualStream: false, secondaryLanguage: "en" });
  });

  it("reads an absent preference as the backend default, never as off", () => {
    // The config is rewritten on every debounced autosave, so resolving a
    // missing key to "off" would persist that "off" on the next keystroke
    // anywhere in Settings.
    expect(resolveDualStreamPreference({ availableLanguages: offered })).toEqual({
      dualStream: DUAL_STREAM_DEFAULT,
      secondaryLanguage: DUAL_SECONDARY_LANGUAGE_DEFAULT,
    });
    expect(
      resolveDualStreamPreference({ dualStream: null, availableLanguages: offered }).dualStream,
    ).toBe(DUAL_STREAM_DEFAULT);
    expect(
      resolveDualStreamPreference({ dualStream: "true", availableLanguages: offered }).dualStream,
    ).toBe(DUAL_STREAM_DEFAULT);
  });

  it("normalises the stored language the way the picker writes it", () => {
    expect(
      resolveDualStreamPreference({ secondaryLanguage: " EN ", availableLanguages: offered })
        .secondaryLanguage,
    ).toBe("en");
  });

  it("refuses a language this build cannot offer", () => {
    // The select would silently show its first option while the renderer
    // believed it had set something else — and that belief is what the
    // next autosave writes.
    expect(
      resolveDualStreamPreference({ secondaryLanguage: "fr", availableLanguages: offered })
        .secondaryLanguage,
    ).toBe(DUAL_SECONDARY_LANGUAGE_DEFAULT);
  });

  it("never resolves to Auto as the second stream", () => {
    // A second multilingual stream is the first one again, at twice the
    // Deepgram minutes and no new information.
    expect(
      resolveDualStreamPreference({
        secondaryLanguage: "auto",
        availableLanguages: ["auto", "ru", "en"],
      }).secondaryLanguage,
    ).toBe("ru");
  });

  it("falls back to the first offered language when the default is not on the list", () => {
    expect(
      resolveDualStreamPreference({ secondaryLanguage: "", availableLanguages: ["auto", "de", "en"] })
        .secondaryLanguage,
    ).toBe("de");
    // Nothing on offer at all: the documented default stands, and the
    // backend validates it anyway.
    expect(
      resolveDualStreamPreference({ availableLanguages: [] }).secondaryLanguage,
    ).toBe(DUAL_SECONDARY_LANGUAGE_DEFAULT);
  });
});
