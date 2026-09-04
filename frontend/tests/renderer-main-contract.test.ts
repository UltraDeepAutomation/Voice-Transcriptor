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
    const block = desktopMain.slice(desktopMain.indexOf("__transcriptorFinishedRecords"));
    const desktopDepth = /\.slice\(-(\d+)\)/.exec(block)?.[1];
    expect(desktopDepth, "no .slice(-N) found after the finished-records read").toBeTruthy();
    expect(Number(desktopDepth)).toBe(Number(declared));
  });
});
