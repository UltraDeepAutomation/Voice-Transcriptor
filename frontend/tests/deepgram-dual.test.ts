import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("the markup default agrees with the documented backend default (R-006)", () => {
  // ``process.cwd()`` is the vitest root (frontend/); the jsdom
  // environment gives ``import.meta.url`` an http origin, so it cannot
  // be resolved to a file path here.
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

  /**
   * A checkbox's markup default is not a display detail. There are two
   * ways ``preferences.deepgram.dual_stream`` can be absent when the
   * autosave debouncer fires: the key is missing from the config (which
   * ``resolveDualStreamPreference`` already resolves to the documented
   * default), or the config was never read and the DOM still shows the
   * markup. The second path bypasses this module entirely and reads the
   * checkbox, so the checkbox has to carry the same default — otherwise
   * the first autosave persists "off" and turns a backend default off
   * behind the user's back, which is the very failure this module's
   * header describes.
   */
  it("#deepgramDualStreamCheck carries DUAL_STREAM_DEFAULT", () => {
    const tag = /<input[^>]*id="deepgramDualStreamCheck"[^>]*>/.exec(html)?.[0];
    expect(tag, "#deepgramDualStreamCheck is missing from index.html").toBeTruthy();
    expect(/\bchecked\b/.test(String(tag))).toBe(DUAL_STREAM_DEFAULT);
  });
});
