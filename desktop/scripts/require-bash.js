#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const target = process.argv[2] || "release build";
const probe = spawnSync("bash", ["--version"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

if (probe.status === 0) {
  process.exit(0);
}

const detail = (probe.stderr || probe.stdout || probe.error?.message || "").trim();
console.error(
  [
    `Transcriptor ${target} requires bash in PATH.`,
    "Use Git Bash/MSYS2 on Windows, or run the release build from the macOS/Linux release host.",
    detail ? `bash probe failed: ${detail}` : "",
  ].filter(Boolean).join("\n"),
);
process.exit(1);
