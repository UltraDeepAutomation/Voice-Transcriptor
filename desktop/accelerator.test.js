"use strict";

// Executable specification for desktop/accelerator.js — the SSOT
// boundary every Electron global shortcut crosses at registration.
// Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { canonicalAcceleratorForPlatform } = require("./accelerator");

test("darwin: Command/Cmd stay Command", () => {
  assert.equal(canonicalAcceleratorForPlatform("Command+S", "darwin"), "Command+S");
  assert.equal(canonicalAcceleratorForPlatform("Cmd+Shift+F9", "darwin"), "Command+Shift+F9");
});

test("darwin: Meta and Super canonicalise to Command (Electron has no Super on macOS)", () => {
  assert.equal(canonicalAcceleratorForPlatform("Meta+P", "darwin"), "Command+P");
  assert.equal(canonicalAcceleratorForPlatform("Super+X", "darwin"), "Command+X");
});

test("darwin: CommandOrControl/CmdOrCtrl become Command", () => {
  assert.equal(canonicalAcceleratorForPlatform("CommandOrControl+R", "darwin"), "Command+R");
  assert.equal(canonicalAcceleratorForPlatform("CmdOrCtrl+L", "darwin"), "Command+L");
});

test("darwin: Option is the canonical Alt token", () => {
  assert.equal(canonicalAcceleratorForPlatform("Alt+ArrowUp", "darwin"), "Option+ArrowUp");
  assert.equal(canonicalAcceleratorForPlatform("Option+ArrowUp", "darwin"), "Option+ArrowUp");
});

test("linux/win32: Command/Cmd/Meta become Super (the original silent no-op bug)", () => {
  assert.equal(canonicalAcceleratorForPlatform("Command+Shift+S", "linux"), "Super+Shift+S");
  assert.equal(canonicalAcceleratorForPlatform("Cmd+E", "win32"), "Super+E");
  assert.equal(canonicalAcceleratorForPlatform("Meta+W", "linux"), "Super+W");
});

test("linux/win32: stored Super stays Super", () => {
  assert.equal(canonicalAcceleratorForPlatform("Super+K", "linux"), "Super+K");
});

test("linux/win32: CommandOrControl/CmdOrCtrl become Control", () => {
  assert.equal(canonicalAcceleratorForPlatform("CommandOrControl+R", "linux"), "Control+R");
  assert.equal(canonicalAcceleratorForPlatform("CmdOrCtrl+L", "win32"), "Control+L");
});

test("linux/win32: Ctrl/Control/Alt/Shift pass through canonically", () => {
  assert.equal(canonicalAcceleratorForPlatform("Ctrl+C", "linux"), "Control+C");
  assert.equal(canonicalAcceleratorForPlatform("Alt+F4", "win32"), "Alt+F4");
  assert.equal(canonicalAcceleratorForPlatform("Shift+Space", "linux"), "Shift+Space");
});

test("unknown platform falls back to the non-darwin map", () => {
  assert.equal(canonicalAcceleratorForPlatform("Command+Q", "freebsd"), "Super+Q");
  assert.equal(canonicalAcceleratorForPlatform("CommandOrControl+Q", "sunos"), "Control+Q");
});

test("default platform argument follows process.platform", () => {
  assert.equal(
    canonicalAcceleratorForPlatform("Command+J"),
    canonicalAcceleratorForPlatform("Command+J", process.platform),
  );
});

test("whitespace and case are normalised; key order preserved", () => {
  assert.equal(
    canonicalAcceleratorForPlatform(" command + SHIFT + f9 ", "darwin"),
    "Command+Shift+f9",
  );
});

test("empty and non-string input pass through untouched", () => {
  assert.equal(canonicalAcceleratorForPlatform("", "darwin"), "");
  assert.equal(canonicalAcceleratorForPlatform(null, "darwin"), null);
  assert.equal(canonicalAcceleratorForPlatform(undefined, "linux"), undefined);
});

test("normalisation is idempotent", () => {
  const samples = ["CommandOrControl+Shift+F9", "Super+X", "Meta+P", "Ctrl+Alt+Delete"];
  for (const s of samples) {
    for (const platform of ["darwin", "linux"]) {
      const once = canonicalAcceleratorForPlatform(s, platform);
      assert.equal(canonicalAcceleratorForPlatform(once, platform), once);
    }
  }
});
