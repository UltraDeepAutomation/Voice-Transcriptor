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

test("no win32/linux default is a bare function key, in either slot", () => {
  // The old assertions were `record !== "F9"` and `paste !== "F10"`, which
  // a default of `record: "F10"` would have walked straight past — and F10
  // is the very key (Win32 menu-mnemonic activation) the change was made
  // to get away from.
  const { record, paste } = manifest.platformDefaults.default;
  for (const acc of [record, paste]) {
    assert.ok(!/^F\d{1,2}$/.test(acc), `a bare function key is not usable as a global default: "${acc}"`);
  }
  // And neither may be the legacy pair in ANY arrangement.
  const legacy = new Set([
    manifest.legacy.winLinuxFunctionPair.record,
    manifest.legacy.winLinuxFunctionPair.paste,
    manifest.legacy.unpressablePaste,
  ]);
  for (const acc of [record, paste]) assert.ok(!legacy.has(acc), `"${acc}" is a legacy default`);
});

test("default (win32/linux) accelerators are distinct 3-modifier chords", () => {
  const { record, paste } = manifest.platformDefaults.default;
  assert.notEqual(record, paste);
  for (const acc of [record, paste]) {
    const parts = acc.split("+");
    // Three modifiers plus a key. The old assertion said "3+ modifier
    // chords" in its name and then checked `parts.length >= 3`, which is
    // two modifiers and a key — one fewer than the collision analysis in
    // shortcut-defaults.json relies on (Ctrl+Alt+V IS Office's Paste
    // Special; the third modifier is what makes it a different chord).
    assert.ok(parts.length >= 4, `expected three modifiers and a key, got "${acc}"`);
    assert.ok(!/^F\d{1,2}$/.test(parts[parts.length - 1]), `the key itself must not be a function key: "${acc}"`);
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

test("the documented hotkeys are the ones the app registers", () => {
  // README.md and README.en.md printed F9 / F10 for Windows and Linux for
  // eleven days after this manifest stopped using them: a user read the
  // documentation, pressed F9, and nothing happened.
  const fs = require("node:fs");
  const path = require("node:path");
  const pretty = (acc) => acc.split("+").map((part) => `\`${part === "Control" ? "Ctrl" : part}\``).join("+");
  const root = path.join(__dirname, "..");
  for (const name of ["README.md", "README.en.md"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const acc of [
      manifest.platformDefaults.default.record,
      manifest.platformDefaults.default.paste,
    ]) {
      assert.ok(
        source.includes(pretty(acc)),
        `${name} does not document the current Windows/Linux default ${acc} (expected ${pretty(acc)})`,
      );
    }
    for (const stale of [manifest.legacy.winLinuxFunctionPair.record, manifest.legacy.winLinuxFunctionPair.paste]) {
      assert.ok(
        !source.includes(`\`${stale}\``),
        `${name} still documents the retired default \`${stale}\``,
      );
    }
  }
});
