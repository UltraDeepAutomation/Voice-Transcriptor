"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { parsePythonVersion, readPythonVersion, PYTHON_VERSION_FILENAME } = require("./python-version");

const ROOT = path.join(__dirname, "..");

test("the repository's own .python-version parses, and the tags derive from it", () => {
  const parsed = readPythonVersion(ROOT);
  assert.ok(parsed, `${PYTHON_VERSION_FILENAME} must exist at the repo root and hold X.Y.Z`);
  assert.equal(parsed.version, fs.readFileSync(path.join(ROOT, PYTHON_VERSION_FILENAME), "utf8").trim());
  assert.equal(parsed.xy, parsed.version.split(".").slice(0, 2).join("."));
  assert.equal(parsed.abiTag, `cp${parsed.xy.replace(".", "")}`);
});

test("the derivation reproduces the literals prepare-runtime.sh used to carry", () => {
  // Before the SSOT existed the script carried PBS_PYVER="3.12.13", the ABI
  // tag "cp312" three times, and "python3.12/site-packages" twice. The
  // derivation must produce exactly those, or the release build silently
  // changes shape on the next bump.
  const parsed = parsePythonVersion("3.12.13\n");
  assert.deepEqual(parsed, { version: "3.12.13", xy: "3.12", abiTag: "cp312" });
});

test("anything that is not a full X.Y.Z version is refused, not guessed", () => {
  for (const raw of ["3.12", "3", "", "   ", "python 3.12.13", "3.12.13rc1", null, undefined, 3.12]) {
    assert.equal(parsePythonVersion(raw), null, `parsePythonVersion(${JSON.stringify(raw)})`);
  }
});

test("a missing file degrades to null instead of throwing", () => {
  assert.equal(readPythonVersion(path.join(__dirname, "no-such-dir-for-tests")), null);
});

test("no file retypes the interpreter version that .python-version declares", () => {
  // D-069: the version was typed into nine places. These are the two that
  // must name it literally — a shell script cannot be asked to read a JS
  // module, and a legal notice cannot compute. Both are locked to the SSOT
  // here so a bump that misses one fails the suite instead of shipping.
  const { version, xy } = readPythonVersion(ROOT);

  const prepare = fs.readFileSync(path.join(__dirname, "scripts", "prepare-runtime.sh"), "utf8");
  assert.match(prepare, /\.python-version/, "prepare-runtime.sh must read the SSOT");
  const shellCode = prepare.replace(/^\s*#.*$/gm, "");
  assert.ok(
    !/\bcp3\d\d?\b/.test(shellCode),
    "prepare-runtime.sh must derive its ABI tag, not retype it",
  );
  assert.ok(
    !/python\d+\.\d+\//.test(shellCode),
    "prepare-runtime.sh must derive its site-packages path, not retype it",
  );
  assert.ok(
    !new RegExp(`["' ]${version.replace(/\./g, "\\.")}["' ]`).test(shellCode),
    "prepare-runtime.sh must not carry the full version literal any more",
  );

  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "tests.yml"), "utf8");
  assert.match(
    workflow,
    /python-version-file:\s*\.python-version/,
    "CI must install the interpreter the product ships",
  );
  assert.ok(
    !/python-version:\s*["']?\d/.test(workflow),
    "CI must not pin a second, literal interpreter version",
  );

  // NOTICE.md states which CPython build is redistributed inside the DMG.
  // It has to spell the version out; it must spell out THIS one.
  const notice = fs.readFileSync(path.join(ROOT, "NOTICE.md"), "utf8");
  const noticeVersions = [...notice.matchAll(/\bPython (\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
  assert.ok(noticeVersions.length > 0, "NOTICE.md must name the bundled interpreter");
  for (const named of noticeVersions) {
    assert.equal(named, version, `NOTICE.md names Python ${named}, .python-version says ${version}`);
  }

  // main.js quotes the version at the user (the Windows source-checkout
  // recovery dialog). It must read it, not repeat it.
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(mainSource, /require\("\.\/python-version"\)/, "main.js must read the SSOT");
  assert.ok(
    !new RegExp(`Python\\.Python\\.${xy.replace(".", "\\.")}`).test(mainSource),
    "main.js must not hardcode the winget package id for a specific minor version",
  );
});
