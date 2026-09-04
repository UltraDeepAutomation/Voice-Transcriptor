import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  dualStreamTradeOffText,
  resolveDualStreamPreference,
  type DualStreamDefaults,
} from "../src/deepgram-dual";

/**
 * The BACKEND's defaults (B-027 / R-016).
 *
 * Not restated here. This module used to declare ``DUAL_STREAM_DEFAULT``
 * and ``DUAL_SECONDARY_LANGUAGE_DEFAULT`` as its own constants — a third
 * copy beside ``backend/model_catalog.py`` — and the fixture below closes
 * that gap the same way ``contracts/live-final-envelope.json`` does for
 * the stop envelope (B-038): it is produced by
 * ``backend/tests/test_live.py::FrontendLiveDefaultsFixtureTests`` from
 * the backend's own bootstrap-payload builder and committed, so a
 * changed default turns THIS suite red instead of leaving it stale.
 *
 * ``process.cwd()`` is the vitest root (frontend/); the jsdom environment
 * gives ``import.meta.url`` an http origin, so it cannot be resolved to a
 * file path here.
 */
const FIXTURE_PATH = resolve(process.cwd(), "../contracts/live-defaults.json");
const liveDefaults = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
  languages: string[];
  dual_stream: boolean;
  dual_secondary_language: string;
  dual_secondary_languages: string[];
  keyterm_token_budget: number;
  audio_ext_to_mime: Record<string, string>;
};

const fallback: DualStreamDefaults = {
  dualStream: liveDefaults.dual_stream,
  secondaryLanguage: liveDefaults.dual_secondary_language,
};

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

const offered = liveDefaults.dual_secondary_languages;

describe("resolveDualStreamPreference", () => {
  it("keeps what the user stored", () => {
    expect(
      resolveDualStreamPreference({
        dualStream: false,
        secondaryLanguage: "en",
        availableLanguages: offered,
        fallback,
      }),
    ).toEqual({ dualStream: false, secondaryLanguage: "en" });
  });

  it("reads an absent preference as the backend default, never as off", () => {
    // The config is rewritten on every debounced autosave, so resolving a
    // missing key to "off" would persist that "off" on the next keystroke
    // anywhere in Settings.
    expect(resolveDualStreamPreference({ availableLanguages: offered, fallback })).toEqual({
      dualStream: fallback.dualStream,
      secondaryLanguage: fallback.secondaryLanguage,
    });
    expect(
      resolveDualStreamPreference({ dualStream: null, availableLanguages: offered, fallback }).dualStream,
    ).toBe(fallback.dualStream);
    expect(
      resolveDualStreamPreference({ dualStream: "true", availableLanguages: offered, fallback }).dualStream,
    ).toBe(fallback.dualStream);
  });

  it("normalises the stored language the way the picker writes it", () => {
    expect(
      resolveDualStreamPreference({ secondaryLanguage: " EN ", availableLanguages: offered, fallback })
        .secondaryLanguage,
    ).toBe("en");
  });

  it("refuses a language this build cannot offer", () => {
    // The select would silently show its first option while the renderer
    // believed it had set something else — and that belief is what the
    // next autosave writes.
    expect(
      resolveDualStreamPreference({ secondaryLanguage: "fr", availableLanguages: offered, fallback })
        .secondaryLanguage,
    ).toBe(fallback.secondaryLanguage);
  });

  it("never resolves to Auto as the second stream", () => {
    // A second multilingual stream is the first one again, at twice the
    // Deepgram minutes and no new information.
    expect(
      resolveDualStreamPreference({
        secondaryLanguage: "auto",
        availableLanguages: liveDefaults.languages,
        fallback,
      }).secondaryLanguage,
    ).toBe("ru");
  });

  it("falls back to the first offered language when the default is not on the list", () => {
    expect(
      resolveDualStreamPreference({
        secondaryLanguage: "",
        availableLanguages: ["de"],
        fallback,
      }).secondaryLanguage,
    ).toBe("de");
    // Nothing on offer at all: the backend's own default stands.
    expect(
      resolveDualStreamPreference({ availableLanguages: [], fallback }).secondaryLanguage,
    ).toBe(fallback.secondaryLanguage);
  });
});

describe("the markup default agrees with the backend's bootstrap default (R-006)", () => {
  /**
   * A checkbox's markup default is not a display detail. There are two
   * ways ``preferences.deepgram.dual_stream`` can be absent when the
   * autosave debouncer fires: the key is missing from the config (which
   * ``resolveDualStreamPreference`` already resolves to the backend's
   * default), or the config was never read and the DOM still shows the
   * markup. The second path bypasses this module entirely and reads the
   * checkbox, so the checkbox has to carry the same default — otherwise
   * the first autosave persists "off" and turns a backend default off
   * behind the user's back, which is the very failure this module's
   * header describes.
   */
  it("#deepgramDualStreamCheck carries the backend's dual_stream default", () => {
    const tag = /<input[^>]*id="deepgramDualStreamCheck"[^>]*>/.exec(html)?.[0];
    expect(tag, "#deepgramDualStreamCheck is missing from index.html").toBeTruthy();
    expect(/\bchecked\b/.test(String(tag))).toBe(liveDefaults.dual_stream);
  });
});

/**
 * The trade-off sentence. Two surfaces state it — the Settings note and
 * the Record view's Auto hint — and they stated it in two wordings, so
 * a correction landed on one of them.
 */
describe("dualStreamTradeOffText", () => {
  it("states the gain and the price in one sentence", () => {
    const text = dualStreamTradeOffText();
    expect(text).toContain("multilingual model drops");
    expect(text).toContain("twice the Deepgram minutes");
  });

  it("names the second stream's language when the caller knows it", () => {
    expect(dualStreamTradeOffText("ru")).toContain("A second RU stream");
    expect(dualStreamTradeOffText(" en ")).toContain("A second EN stream");
  });

  it("says the same thing about gain and price either way", () => {
    const withLang = dualStreamTradeOffText("ru");
    expect(withLang).toContain("phrases the multilingual model drops, at twice the Deepgram minutes.");
    expect(dualStreamTradeOffText()).toContain("phrases the multilingual model drops, at twice the Deepgram minutes.");
  });

  it("is the only place the markup's note comes from", () => {
    const note = new DOMParser().parseFromString(html, "text/html")
      .getElementById("deepgramDualStreamNote");
    expect(note, "#deepgramDualStreamNote missing").toBeTruthy();
    expect(note?.textContent?.trim()).toBe("");
  });
});
