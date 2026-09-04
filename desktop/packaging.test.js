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

// Entrypoints electron-builder packs and whose ENTIRE local-require
// graph must be covered by build.files (BUG-17: a helper required by
// preload.js would previously escape the top-level-only check).
const ENTRYPOINTS = ["main.js", "preload.js"];

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

/** Walk the local-require graph from the entrypoints, cycle-safe. */
function collectLocalRequiresGraph() {
  const seen = new Set();
  const edges = [];
  const queue = ENTRYPOINTS.map((f) => ({ from: f, file: f }));
  while (queue.length) {
    const { from, file } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(DESKTOP_DIR, file), "utf8");
    // require("./name") and require("./name.ext") — relative, literal,
    // single argument. Dynamic/parent-dir requires would be flagged by
    // review; none exist today.
    const re = /require\(\s*["']\.\/([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const resolved = resolveCandidate(m[1]);
      assert.ok(resolved !== null, `${file} requires "./${m[1]}" but no such file exists on disk`);
      edges.push({ from: file, resolved });
      queue.push({ from: file, file: resolved });
    }
  }
  return edges;
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
  for (const { from, resolved } of collectLocalRequiresGraph()) {
    if (!coveredByWhitelist(resolved)) {
      problems.push(`${from} -> ./${resolved} is MISSING from build.files`);
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

test("frontend and desktop package versions match the desktop SSOT", () => {
  // desktop/package.json is the version SSOT (AGENTS.md rule 4);
  // frontend/package.json duplicates the number for tooling, and the
  // two have drifted in the past (BUG-75). A release that bumps one
  // and not the other now fails npm test instead of shipping a
  // renderer that reports a different version than the shell.
  const frontendPkg = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_DIR, "..", "frontend", "package.json"), "utf8"),
  );
  assert.equal(
    frontendPkg.version,
    pkg.version,
    `version drift: desktop/package.json=${pkg.version}, frontend/package.json=${frontendPkg.version} — bump both together`,
  );
});

test("the release runtime constraints actually ship, so a repair install can use them", () => {
  // requirements.txt keeps ranges for five direct dependencies on
  // purpose and the exact versions live in requirements.runtime-lock.txt,
  // which was applied ONLY when building the bundle. It was not in
  // extraResources, so the on-device repair install
  // ("Installing dependencies (first launch)…") could not possibly apply
  // it — it could put a numpy or onnxruntime into the user's environment
  // that the pinned faster-whisper / ctranslate2 pair was never tested
  // against.
  const froms = pkg.build.extraResources.map((entry) => entry.from);
  assert.ok(froms.includes("../requirements.txt"));
  assert.ok(froms.includes("../requirements.runtime-lock.txt"));
  assert.ok(
    fs.existsSync(path.join(__dirname, "..", "requirements.runtime-lock.txt")),
    "the lock file named in extraResources must exist",
  );
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(mainSource, /requirements\.runtime-lock\.txt/, "and main.js must pass it to pip as -c");
});

test("no extraResource is copied to the same destination twice", () => {
  // app-builder-lib CONCATENATES build.<platform>.extraResources onto
  // build.extraResources rather than replacing them, so
  // ../requirements-gigaam.txt and ../ENABLE_GIGAAM appeared four times
  // across the manifest: each was copied to the same path twice, all four
  // had to be edited together, and `mas` was missing them entirely.
  for (const platform of ["mac", "win", "linux", "mas"]) {
    const platformCfg = pkg.build[platform] || {};
    const combined = [...pkg.build.extraResources, ...(platformCfg.extraResources || [])];
    const destinations = combined.map((entry) => entry.to);
    assert.deepEqual(
      [...new Set(destinations)].sort(),
      [...destinations].sort(),
      `${platform}: duplicate extraResources destinations ${JSON.stringify(destinations)}`,
    );
  }
});

test("the DMG artifact name is pinned, not inherited from a default template", () => {
  // Five independent strings across BUILD.command, notarize-dmg.sh,
  // sign-mas.js, INSTALL_ON_OTHER_MAC.command and docs reproduce
  // electron-builder's DEFAULT artifact name. A default is not a
  // contract: an upstream change to it breaks the release at
  // "Built DMG not found".
  assert.equal(pkg.build.artifactName, "${productName}-${version}-${arch}.${ext}");
});

test("the Python version is committed, in one file, and every reader uses it", () => {
  const root = path.join(__dirname, "..");
  const versionFile = path.join(root, ".python-version");
  assert.ok(fs.existsSync(versionFile), ".python-version is the SSOT and must be committed");
  const version = fs.readFileSync(versionFile, "utf8").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, `.python-version must hold X.Y.Z, got "${version}"`);

  // prepare-runtime.sh used to carry PBS_PYVER="3.12.13" plus five more
  // literal "3.12"/"cp312" occurrences; a minor bump needed nine
  // synchronised edits across the repo and a missed one either failed the
  // build with "could not find site-packages" or left CI on the old
  // interpreter.
  const prepare = fs.readFileSync(path.join(__dirname, "scripts", "prepare-runtime.sh"), "utf8");
  assert.match(prepare, /\.python-version/, "prepare-runtime.sh must read the SSOT");
  const stripped = prepare.replace(/^\s*#.*$/gm, "");
  assert.ok(
    !/\bcp3\d\d\b/.test(stripped) && !/python3\.\d+\//.test(stripped),
    "prepare-runtime.sh must derive its interpreter tags, not retype them",
  );

  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "tests.yml"), "utf8");
  assert.match(workflow, /python-version-file:\s*\.python-version/, "CI must read the SSOT too");
});

test("CI runs the desktop suite where its osacompile tests can execute", () => {
  // applescript.test.js and paste-script.test.js compile the AppleScript
  // the product ships and skip themselves off darwin. On ubuntu-latest
  // they had never run once: a syntax error in the generated paste script
  // would have reached users with CI green.
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "tests.yml"),
    "utf8",
  );
  const desktopJob = workflow.slice(workflow.indexOf("\n  desktop:"));
  assert.match(desktopJob, /runs-on:\s*macos-latest/);
  // AGENTS.md declares this a required check; it was declared and never run.
  assert.match(desktopJob, /node --check main\.js && node --check preload\.js/);
  // And the workflow states its token scope and cancels superseded runs.
  assert.match(workflow, /^permissions:/m);
  assert.match(workflow, /^concurrency:/m);
});
