"use strict";

// Executable specification for desktop/shortcut-defaults.json — the SSOT
// data source readShortcutsFromConfig() (desktop/main.js) reads at
// startup. BUGS_AUDIT 2026-09-03 §6.10: the old Windows/Linux default
// pair (F9/F10) collided with the Win32 menu-mnemonic-activation key and
// with debugger run/step keys in Visual Studio, VS Code and JetBrains
// IDEs. These assertions pin the replacement so a future edit cannot
// silently reintroduce a colliding default.
// Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("./shortcut-defaults.json");

test("darwin defaults are unchanged (Alt+Left / Alt+Shift+V)", () => {
  assert.deepEqual(manifest.platformDefaults.darwin, {
    record: "Alt+Left",
    paste: "Alt+Shift+V",
  });
});

test("default (win32/linux) record/paste no longer use bare F9/F10", () => {
  const { record, paste } = manifest.platformDefaults.default;
  assert.notEqual(record, "F9");
  assert.notEqual(paste, "F10");
});

test("default (win32/linux) accelerators are distinct 3+ modifier chords", () => {
  const { record, paste } = manifest.platformDefaults.default;
  assert.notEqual(record, paste);
  for (const acc of [record, paste]) {
    const parts = acc.split("+");
    // At least three segments: two-or-more modifiers plus a key.
    assert.ok(parts.length >= 3, `expected a multi-modifier chord, got "${acc}"`);
  }
});

test("legacy.winLinuxFunctionPair records the exact stale default migrateShortcuts must catch", () => {
  assert.deepEqual(manifest.legacy.winLinuxFunctionPair, { record: "F9", paste: "F10" });
});

test("legacy.macFunctionPair is untouched by this change", () => {
  assert.deepEqual(manifest.legacy.macFunctionPair, { record: "F9", paste: "F10" });
});

test("no default accelerator collides with the darwin defaults (cross-platform config sync safety)", () => {
  const darwin = manifest.platformDefaults.darwin;
  const other = manifest.platformDefaults.default;
  assert.notEqual(darwin.record, other.record);
  assert.notEqual(darwin.paste, other.paste);
});
