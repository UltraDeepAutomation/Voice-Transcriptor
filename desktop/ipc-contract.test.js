"use strict";

// The main ↔ renderer IPC channels, as a contract both sides are checked
// against.
//
// A channel name is a string typed twice, in two files, that nothing
// resolves: rename it on one side and the other side goes quiet — no
// exception, no log line, just a feature that stops happening. Nothing
// else in the suite can catch that, because exercising the bridge needs
// a live Electron. Reading the two sources and requiring them to agree
// does not.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

test("recording-final is sent by the renderer and received by main", () => {
  assert.match(preloadSource, /ipcRenderer\.send\("recording-final"/);
  assert.match(mainSource, /ipcMain\.on\("recording-final"/);
});

test("system-suspend is sent by main and subscribed to by the renderer bridge", () => {
  // The renderer holds a microphone capture warm after a recording and
  // cannot see powerMonitor, which lives in main.
  assert.match(mainSource, /webContents\.send\("system-suspend"/);
  assert.match(preloadSource, /ipcRenderer\.on\("system-suspend"/);
  assert.match(preloadSource, /onSystemSuspend:/, "the bridge is what the renderer actually calls");
  assert.match(
    preloadSource,
    /ipcRenderer\.removeListener\("system-suspend"/,
    "a subscription with no way off leaks across renderer reloads",
  );
});

test("main notifies on BOTH suspend and lock-screen", () => {
  // A lock does not always become a suspend, and a suspend does not
  // always announce a lock first.
  assert.match(mainSource, /for \(const reason of \["suspend", "lock-screen"\]\)/);
  assert.match(mainSource, /powerMonitor\.on\(reason/);
});

test("the preload exposes fixed channels only — never raw ipcRenderer", () => {
  // A bridge that hands the renderer `ipcRenderer` (or a send that takes
  // the channel as an argument) gives it every channel in the app.
  assert.ok(
    !/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadSource),
    "ipcRenderer itself must never cross the bridge",
  );
  for (const call of preloadSource.match(/ipcRenderer\.(send|on|invoke|removeListener)\(([^,)]*)/g) || []) {
    const channel = call.split("(")[1].trim();
    assert.match(channel, /^"[a-z][a-z0-9:-]*"$/, `channel must be a literal, got ${channel}`);
  }
});
