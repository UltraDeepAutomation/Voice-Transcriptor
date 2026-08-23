"use strict";

// Canonical Electron accelerator vocabulary per platform — the renderer
// stores bindings using user-intent tokens ("Command", "CommandOrControl")
// so a single saved binding reads correctly in cross-platform JSON.
// Electron's globalShortcut API, however, only recognises those tokens on
// darwin; elsewhere "Command" must become "Super" and
// "CommandOrControl" must become "Control" before registration.
//
// This module is the single SSOT boundary every accelerator passes
// through: safeRegisterShortcut calls canonicalAcceleratorForPlatform,
// and the status payload published to the renderer records the canonical
// form so the Settings UI shows exactly what was actually bound.
//
// Pure CommonJS, zero dependencies — unit-tested by accelerator.test.js
// (node --test), which runs against the exact code Electron loads.
const TOKEN_MAPS = Object.freeze({
  darwin: Object.freeze({
    cmd: "Command",
    commandorcontrol: "Command",
    meta: "Command",
    // A binding stored as "Super+…" (e.g. synced from a Linux profile)
    // must register as Command on macOS — Electron has no Super key
    // there, and passing it through verbatim silently no-ops the bind.
    super: "Command",
  }),
  default: Object.freeze({
    cmd: "Super",
    commandorcontrol: "Control",
    meta: "Super",
    super: "Super",
  }),
});

function canonicalAcceleratorForPlatform(acc, platform = process.platform) {
  if (!acc || typeof acc !== "string") return acc;
  const map = TOKEN_MAPS[platform] || TOKEN_MAPS.default;
  const tokens = acc.split("+").map((t) => t.trim()).filter(Boolean);
  const out = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const lower = raw.toLowerCase();
    if (lower === "command" || lower === "cmd") out[i] = map.cmd;
    else if (lower === "commandorcontrol" || lower === "cmdorctrl") out[i] = map.commandorcontrol;
    else if (lower === "meta") out[i] = map.meta;
    else if (lower === "super") out[i] = map.super;
    else if (lower === "control" || lower === "ctrl") out[i] = "Control";
    else if (lower === "alt" || lower === "option") out[i] = platform === "darwin" ? "Option" : "Alt";
    else if (lower === "shift") out[i] = "Shift";
    else out[i] = raw;
  }
  return out.join("+");
}

module.exports = { canonicalAcceleratorForPlatform };
