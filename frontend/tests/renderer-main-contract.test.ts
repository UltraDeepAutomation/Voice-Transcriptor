import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const liveDefaultsFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../contracts/live-defaults.json"), "utf-8"),
) as { languages: string[]; keyterm_token_budget: number };

/**
 * `window.__transcriptorFinishedRecords` is a two-process contract: the
 * renderer trims the list when it writes, and `desktop/main.js` trims
 * again when it reads. Both trimmed to a depth written out as a literal
 * on each side, with nothing connecting them — a renderer that kept
 * fewer than the main process expects silently shortens the paste
 * history, and the main process cannot import the renderer's constants.
 * So the two are pinned here.
 */
const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const desktopMain = readFileSync(resolve(process.cwd(), "../desktop/main.js"), "utf8");

describe("__transcriptorFinishedRecords depth", () => {
  const declared = /FINISHED_RECORDS_KEPT\s*=\s*(\d+)/.exec(mainTsx)?.[1];

  it("is a named constant on the renderer side", () => {
    expect(declared, "FINISHED_RECORDS_KEPT not found in main.tsx").toBeTruthy();
    expect(mainTsx).toContain("next.slice(-FINISHED_RECORDS_KEPT)");
  });

  it("matches the depth desktop/main.js trims to when it reads the list", () => {
    // The main process names its own copy now
    // (RENDERER_FINISHED_RECORDS_LIMIT), and interpolates it into the
    // injected script — so read the constant, not the call site.
    const block = desktopMain.slice(desktopMain.indexOf("__transcriptorFinishedRecords"));
    const usesNamedLimit = /\.slice\(-\$\{RENDERER_FINISHED_RECORDS_LIMIT\}\)/.test(block);
    const desktopDepth = usesNamedLimit
      ? /RENDERER_FINISHED_RECORDS_LIMIT\s*=\s*(\d+)/.exec(desktopMain)?.[1]
      : /\.slice\(-(\d+)\)/.exec(block)?.[1];
    expect(desktopDepth, "no finished-records trim depth found in desktop/main.js").toBeTruthy();
    expect(Number(desktopDepth)).toBe(Number(declared));
  });
});

/**
 * The document.title bridge. Three messages, two processes, and until
 * now four independent string literals on the renderer side alone.
 */
describe("the title bridge prefixes match desktop/main.js", () => {
  const desktopMain = readFileSync(resolve(process.cwd(), "../desktop/main.js"), "utf8");

  it("declares each prefix once in the renderer", () => {
    const block = /TITLE_BRIDGE_PREFIX = \{([\s\S]*?)\} as const;/.exec(mainTsx)?.[1];
    expect(block, "TITLE_BRIDGE_PREFIX not found").toBeTruthy();
    const prefixes = Array.from(String(block).matchAll(/"(__app_[a-z_]+__)"/g)).map((m) => m[1]);
    expect(prefixes.sort()).toEqual([
      "__app_record_toggle__",
      "__app_reveal_recording__",
      "__app_shortcuts__",
    ]);
    for (const prefix of prefixes) {
      // Once in the declaration, nowhere else: the three call sites go
      // through postTitleBridgeMessage.
      expect(mainTsx.split(`"${prefix}"`).length - 1, prefix).toBe(1);
    }
  });

  it("is the same set the main process listens for", () => {
    for (const prefix of ["__app_shortcuts__", "__app_record_toggle__", "__app_reveal_recording__"]) {
      expect(desktopMain, prefix).toContain(prefix);
    }
  });
});

/**
 * B-027 / R-016: the backend is the sole owner of the live-path
 * defaults (dual-stream, secondary language, the language option list,
 * the keyterm token budget). This block guards the two ways a renderer
 * copy could creep back in: a hardcoded fallback constant, and a
 * pre-hydration `<select>` that quietly drifts from what the backend
 * will later replace it with (``applyLiveLanguageOptions`` keeps the
 * current selection across the swap, so a stale pre-hydration option
 * missing from the backend's list would be silently dropped instead of
 * merely relabelled).
 */
describe("live-path defaults have no renderer-owned copy", () => {
  it("readDeepgramDualStream/readDeepgramDualSecondaryLanguage fall back to backendLiveDefaults, not a literal", () => {
    const dualStreamFn = /function readDeepgramDualStream\(\)[^{]*\{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    const secondaryFn = /function readDeepgramDualSecondaryLanguage\(\)[^{]*\{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    expect(dualStreamFn, "readDeepgramDualStream not found").toBeTruthy();
    expect(secondaryFn, "readDeepgramDualSecondaryLanguage not found").toBeTruthy();
    expect(String(dualStreamFn)).toContain("backendLiveDefaults");
    expect(String(secondaryFn)).toContain("backendLiveDefaults");
    // Neither function may fall back to a boolean/string literal default —
    // only to the checkbox/select state or backendLiveDefaults.
    expect(String(dualStreamFn)).not.toMatch(/:\s*(true|false)\s*;/);
  });

  it("declares no DUAL_STREAM_DEFAULT / DUAL_SECONDARY_LANGUAGE_DEFAULT constant of its own", () => {
    expect(mainTsx).not.toMatch(/\bconst\s+DUAL_STREAM_DEFAULT\b/);
    expect(mainTsx).not.toMatch(/\bconst\s+DUAL_SECONDARY_LANGUAGE_DEFAULT\b/);
  });

  it("#language's pre-hydration options match the backend's live-language list (index.html placeholder, replaced by applyLiveLanguageOptions)", () => {
    const block = /<select id="language">([\s\S]*?)<\/select>/.exec(html)?.[1];
    expect(block, "#language select not found in index.html").toBeTruthy();
    const values = Array.from(String(block).matchAll(/<option value="([^"]+)"/g)).map((m) => m[1]);
    expect(values).toEqual(liveDefaultsFixture.languages);
  });

  it("states the keyterm budget from the backend, not a hardcoded number, next to the field", () => {
    expect(mainTsx).toContain("applyKeytermBudgetNote");
    expect(mainTsx).not.toMatch(/Up to \d+ tokens in total/);
  });
});

/**
 * S-06: ``UI_TOKENS.finalize.segmentEpsilonSec`` (0.08) and
 * ``backend/live.py``'s ``LiveConfig.emit_epsilon_sec`` (0.05) look like
 * the same tolerance and were flagged as a suspected third duplicate
 * (R-016/S-05/S-04's sibling). They are not: one dedups two SENT
 * segments in the renderer's own preview merge regardless of provider,
 * the other governs what a single Whisper-only live session EMITS
 * across two overlapping inference passes, before anything reaches this
 * renderer. Unifying them would make a Whisper-timestamp property
 * decide how the renderer dedups a Deepgram segment pair. This is a
 * documented decision NOT to unify, guarded here so neither comment can
 * be deleted without the other going stale.
 */
describe("segmentEpsilonSec vs. live.py's emit_epsilon_sec (S-06, deliberately not unified)", () => {
  const backendLive = readFileSync(resolve(process.cwd(), "../backend/live.py"), "utf8");

  it("both constants carry a comment explaining why they are not the same value", () => {
    const rendererBlock = /segmentEpsilonSec:\s*0\.08/.exec(mainTsx);
    expect(rendererBlock, "segmentEpsilonSec: 0.08 not found in main.tsx").toBeTruthy();
    const before = mainTsx.slice(0, rendererBlock!.index).slice(-1200);
    expect(before).toMatch(/S-06/);
    expect(before).toMatch(/emit_epsilon_sec/);

    const backendBlock = /emit_epsilon_sec:\s*float\s*=\s*0\.05/.exec(backendLive);
    expect(backendBlock, "emit_epsilon_sec: float = 0.05 not found in backend/live.py").toBeTruthy();
    const backendBefore = backendLive.slice(0, backendBlock!.index).slice(-1500);
    expect(backendBefore).toMatch(/segmentEpsilonSec/);
  });
});
