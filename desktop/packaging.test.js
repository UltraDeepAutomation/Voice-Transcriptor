"use strict";

// Executable specification for the electron-builder "files" whitelist.
//
// The whitelist is OPT-IN per file: anything required by main.js at
// module load that is not listed is simply absent from the packaged
// app — and the DMG then dies at startup with MODULE_NOT_FOUND before
// a single window exists. No unit test catches that, because tests run
// from the source tree where the file always exists.
//
// This spec closes the class of bug: it parses every local require()
// out of the packaged entrypoints and asserts each resolved file is
// matched by a POSITIVE pattern in build.files. Adding a new local
// module without updating the whitelist fails npm test here, in CI or
// on the dev machine — not in a user's freshly mounted DMG.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_DIR = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "package.json"), "utf8"));

// Entrypoints electron-builder packs and whose require() graph must be
// fully covered by build.files.
const ENTRYPOINTS = ["main.js", "preload.js"];

function localRequires(file) {
  const src = fs.readFileSync(path.join(DESKTOP_DIR, file), "utf8");
  const found = [];
  // require("./name") and require("./name.ext") — relative, literal,
  // single argument. Dynamic/parent-dir requires would be flagged by
  // review; none exist today.
  const re = /require\(\s*["']\.\/([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) found.push(m[1]);
  return found;
}

function resolveCandidate(rel) {
  // Node resolution as used by require("./x"): exact file, then .js,
  // then .json (directories are not used by this codebase).
  const base = path.join(DESKTOP_DIR, rel);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return rel;
  for (const ext of [".js", ".json"]) {
    if (fs.existsSync(base + ext)) return rel + ext;
  }
  return null;
}

function positiveWhitelist() {
  return (pkg.build?.files || []).filter((p) => !p.startsWith("!"));
}

function coveredByWhitelist(resolved) {
  // Exact-name entries are how every current module is whitelisted;
  // glob patterns are honoured conservatively via prefix match so a
  // future "lib/**" entry also satisfies "lib/foo.js".
  return positiveWhitelist().some((pattern) => {
    if (pattern === resolved) return true;
    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      return resolved.startsWith(dir.endsWith("/") ? dir : dir + "/");
    }
    return false;
  });
}

test("build.files whitelist covers every local require of the packaged entrypoints", () => {
  const problems = [];
  for (const entry of ENTRYPOINTS) {
    assert.ok(
      fs.existsSync(path.join(DESKTOP_DIR, entry)),
      `entrypoint ${entry} must exist`,
    );
    for (const req of localRequires(entry)) {
      const resolved = resolveCandidate(req);
      assert.ok(
        resolved !== null,
        `${entry} requires "./${req}" but no such file exists on disk`,
      );
      if (!coveredByWhitelist(resolved)) {
        problems.push(`${entry} -> ./${resolved} is MISSING from build.files`);
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    "packaged app would crash with MODULE_NOT_FOUND:\n  " + problems.join("\n  "),
  );
});

test("the accelerator SSOT module itself is packaged", () => {
  // Regression anchor for the bug this spec was born from: main.js's
  // require of ./accelerator shipped unlisted once already.
  assert.ok(
    coveredByWhitelist("accelerator.js"),
    "accelerator.js must stay in build.files",
  );
});
