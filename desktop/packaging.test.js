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

test("every file the app reads at runtime is actually shipped as an extraResource", () => {
  // getRepoRoot() is process.resourcesPath in a packaged app, so anything
  // main.js reads relative to it must be listed here or the read fails only
  // on a user's machine. requirements.runtime-lock.txt was the case that
  // proved it: prepare-runtime.sh built the bundle with those constraints,
  // the file was never copied into Resources, and the on-device repair
  // install ("Installing dependencies (first launch)…") could not possibly
  // apply them — it was free to put a numpy or an onnxruntime into the
  // user's environment that the pinned faster-whisper / ctranslate2 pair was
  // never tested against.
  const destinations = new Set(pkg.build.extraResources.map((entry) => entry.to));
  for (const name of ["requirements.txt", "requirements.runtime-lock.txt", ".python-version"]) {
    assert.ok(destinations.has(name), `${name} must be copied into Resources`);
    assert.ok(
      fs.existsSync(path.join(__dirname, "..", name)),
      `${name} is named in extraResources but does not exist`,
    );
  }
});

test("one set of dependency pins: build, CI and the on-device repair all apply the lock", () => {
  // requirements.txt keeps ranges for five direct dependencies on purpose
  // (numpy, urllib3, cryptography, httptools, websockets) and the exact
  // versions live in requirements.runtime-lock.txt. Three installers read
  // those files; all three must apply the same constraints, or a green CI
  // run describes a version set the DMG does not ship.
  const lockName = "requirements.runtime-lock.txt";

  const prepare = fs.readFileSync(path.join(__dirname, "scripts", "prepare-runtime.sh"), "utf8");
  assert.match(prepare, /REQS_LOCK=/, "the release build must resolve the lock");
  assert.match(prepare, /pip_args\+=\(-c "\$\{REQS_LOCK\}"\)/, "the release build must pass it to pip");

  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "tests.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    new RegExp(`pip install -c ${lockName.replace(/\./g, "\\.")} -r requirements\\.txt`),
    "CI must install the version set the release is built with",
  );

  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(mainSource, /const lockPath = path\.join\(repoRoot, "requirements\.runtime-lock\.txt"\)/);
  assert.match(
    mainSource,
    /const constraintArgs = fs\.existsSync\(lockPath\) \? \["-c", lockPath\] : \[\]/,
    "the repair install must apply the lock when it is there",
  );
  // Both pip invocations on the backend-runtime repair path — the first
  // attempt and the --break-system-packages retry — must use the same
  // constraints. A retry that installs a different version set than the
  // attempt it replaces is a second source of truth reachable only from a
  // failure. (The optional-engine install is deliberately not included: it
  // installs requirements-gigaam.txt into its own staging site, and
  // engine-deps.js reconciles that set against the bundle by its own rules.)
  const backendInstalls = [
    ...mainSource.matchAll(/"-m", "pip", "install"(?:(?!runCommand)[\s\S])*?requirementsPath/g),
  ].map((m) => m[0]);
  assert.equal(backendInstalls.length, 2, "expected the attempt and its --break-system-packages retry");
  for (const call of backendInstalls) {
    assert.match(call, /constraintArgs/, `pip call without the lock: ${call}`);
  }
});

test("CI runs the desktop suite where its osacompile tests can execute", () => {
  // applescript.test.js and paste-script.test.js hand the AppleScript the
  // product ships to osacompile and skip themselves off darwin. On
  // ubuntu-latest they had never run once, so the exact failure
  // applescript.test.js was written for — a stray backtick truncating the
  // paste template — would have reached users with CI green.
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "tests.yml"),
    "utf8",
  );
  const desktopJob = workflow.slice(workflow.indexOf("\n  desktop:"));
  assert.match(desktopJob, /runs-on:\s*macos-latest/);

  // ...and those two suites must still be the darwin-gated ones, or the
  // reason for the macOS runner has quietly moved somewhere else.
  const darwinGated = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.js") && f !== path.basename(__filename))
    .filter((f) => fs.readFileSync(path.join(__dirname, f), "utf8").includes('process.platform !== "darwin"'));
  assert.deepEqual(darwinGated.sort(), ["applescript.test.js", "paste-script.test.js"]);

  // AGENTS.md names this a required check before every commit, and CI had
  // never run it.
  assert.match(desktopJob, /node --check main\.js && node --check preload\.js/);

  // The workflow states its token scope and cancels superseded runs.
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^concurrency:$/m);
  assert.match(workflow, /cancel-in-progress: true/);
});
