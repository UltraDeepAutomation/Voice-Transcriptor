import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
