"use strict";

// Unit tests for the engine dependency policy SSOT (engine-deps.js).
// Pure node:test — no Electron, no network, mirrors accelerator.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultMarkerEnvironment,
  evaluateEnvironmentMarker,
  planDistributionRemoval,
  guessDistributionPaths,
  parseRequiresDist,
  specifierSatisfied,
  compareVersions,
  distInfoInventory,
  collectRequirementIndex,
  planEngineSitePrune,
  ENGINE_MIN_FREE_BYTES,
} = require("./engine-deps");

const MAC_PY312 = defaultMarkerEnvironment({
  python_version: "3.12",
  platform_system: "Darwin",
  sys_platform: "darwin",
  platform_machine: "arm64",
});

test("parseRequiresDist evaluates environment markers instead of dropping them", () => {
  const meta = [
    "Metadata-Version: 2.1",
    "Name: torch",
    "Requires-Dist: filelock",
    "Requires-Dist: typing-extensions>=4.10.0",
    "Requires-Dist: sympy>=1.13.3",
    // Excluded by this platform.
    "Requires-Dist: triton==3.7.1; platform_system == \"Linux\"",
    // An extra nobody requested.
    "Requires-Dist: opt-einsum>=3.3; extra == \"opt-einsum\"",
    // Excluded by this interpreter.
    "Requires-Dist: importlib-metadata>=4.6; python_version < \"3.10\"",
    // APPLIES here — and used to be dropped along with the rest, which
    // is how a staged copy could be pruned in favour of a bundle copy
    // that does not satisfy it.
    "Requires-Dist: cffi>=1.17; python_version >= \"3.11\"",
    "Requires-Dist: numpy==2.*",
  ].join("\n");
  assert.deepEqual(parseRequiresDist(meta, MAC_PY312), [
    { name: "filelock", spec: "", applies: true, unevaluatedMarker: false },
    { name: "typing-extensions", spec: ">=4.10.0", applies: true, unevaluatedMarker: false },
    { name: "sympy", spec: ">=1.13.3", applies: true, unevaluatedMarker: false },
    { name: "cffi", spec: ">=1.17", applies: true, unevaluatedMarker: false },
    { name: "numpy", spec: "==2.*", applies: true, unevaluatedMarker: false },
  ]);
});

test("a marker this parser cannot decide is reported, never assumed away", () => {
  const meta = [
    "Requires-Dist: sympy>=1.14; (python_version >= \"3.11\")",
    "Requires-Dist: cffi>=1.17; some_future_variable == \"x\"",
  ].join("\n");
  const reqs = parseRequiresDist(meta, MAC_PY312);
  assert.equal(reqs.length, 2);
  for (const req of reqs) {
    assert.equal(req.unevaluatedMarker, true, req.name);
    assert.equal(req.applies, true, "undecidable means it may well apply");
  }
});

test("evaluateEnvironmentMarker: the shapes real METADATA uses", () => {
  const yes = (m) => assert.equal(evaluateEnvironmentMarker(m, MAC_PY312), true, m);
  const no = (m) => assert.equal(evaluateEnvironmentMarker(m, MAC_PY312), false, m);
  const dunno = (m) => assert.equal(evaluateEnvironmentMarker(m, MAC_PY312), null, m);

  yes("");
  yes('python_version >= "3.11"');
  yes('python_version >= "3.9" and platform_system != "Windows"');
  yes('sys_platform == "darwin" or sys_platform == "win32"');
  yes('"arm64" in platform_machine');
  yes('implementation_name == "cpython"');
  no('python_version < "3.10"');
  no('platform_system == "Linux"');
  no('extra == "torch"', "no extras are requested by requirements-gigaam.txt");
  no('python_version >= "3.11" and platform_system == "Windows"');
  dunno('(python_version < "3.9")');
  dunno('some_future_variable == "x"');

  // Version comparison is numeric, not lexicographic: "3.9" > "3.10"
  // as strings, and getting that wrong flips a very common marker.
  assert.equal(evaluateEnvironmentMarker('python_version > "3.9"', MAC_PY312), true);

  // An unknown interpreter version is not the empty string.
  const noPython = defaultMarkerEnvironment({ python_version: "" });
  assert.equal(evaluateEnvironmentMarker('python_version >= "3.11"', noPython), null);
});

test("specifierSatisfied covers operators used by the engine stack", () => {
  assert.equal(specifierSatisfied(">=4.10.0", "4.15.0"), true);
  assert.equal(specifierSatisfied(">=4.10.0", "4.9.9"), false);
  assert.equal(specifierSatisfied(">=1.13.3", "1.14.0"), true);
  assert.equal(specifierSatisfied("", "anything"), true);
  // Wildcards are release-segment prefix matches (numpy==2.* is a real
  // gigaam constraint — the bundle's 2.0.2 must satisfy it).
  assert.equal(specifierSatisfied("==2.*", "2.0.2"), true);
  assert.equal(specifierSatisfied("==2.*", "3.0.2"), false);
  assert.equal(specifierSatisfied("!=2.*", "3.0.2"), true);
  assert.equal(specifierSatisfied("!=2.*", "2.5"), false);
  assert.equal(specifierSatisfied("!=1.13.3", "1.14.0"), true);
  assert.equal(specifierSatisfied("<14,>=13.0.3", "13.0.3"), true);
  assert.equal(specifierSatisfied("<14,>=13.0.3", "14.0.0"), false);
});

test("compareVersions is numeric-aware, not lexical", () => {
  assert.ok(compareVersions("4.10.0", "4.2.0") > 0);
  assert.ok(compareVersions("1.14.0", "1.14.0") === 0);
  assert.ok(compareVersions("2025.10.0", "2026.7.0") < 0);
});

test("distInfoInventory normalizes names and keeps first version", () => {
  const inv = distInfoInventory(() => [
    "typing_extensions-4.16.0.dist-info",
    "Torch-2.13.0.dist-info",
    "numpy-2.0.2.dist-info",
    "README",
  ]);
  assert.equal(inv["typing-extensions"], "4.16.0");
  assert.equal(inv["torch"], "2.13.0");
  assert.equal(inv["numpy"], "2.0.2");
});

test("collectRequirementIndex unions constraints across staged packages", () => {
  const fsLike = {
    readdirSync: () => ["torch-2.13.0.dist-info", "gigaam-0.2.0.dist-info", "bin"],
    readFileSync: (p) => {
      if (p.includes("torch-")) {
        return "Requires-Dist: typing-extensions>=4.10.0\nRequires-Dist: sympy>=1.13.3";
      }
      return "Requires-Dist: numpy==2.*\nRequires-Dist: soundfile";
    },
  };
  const idx = collectRequirementIndex("/staging", fsLike);
  assert.deepEqual(idx.get("typing-extensions"), [">=4.10.0"]);
  assert.deepEqual(idx.get("sympy"), [">=1.13.3"]);
  assert.deepEqual(idx.get("numpy"), ["==2.*"]);
  assert.equal(idx.has("soundfile"), false); // unconstrained mention imposes nothing
});

test("planEngineSitePrune: bundle-satisfied overlap prunes, additions stay", () => {
  const { prune, conflicts } = planEngineSitePrune({
    staged: {
      torch: "2.13.0",
      sympy: "1.14.0",
      networkx: "3.6.1", // bundle lacks it → pure addition
      numpy: "2.1.0",
    },
    bundle: { sympy: "1.14.0", numpy: "2.0.2" },
    needs: new Map([
      ["sympy", [">=1.13.3"]],
      ["numpy", ["==2.*"]],
    ]),
  });
  assert.deepEqual(prune, ["numpy", "sympy"]);
  assert.equal(conflicts.length, 0);
});

test("planEngineSitePrune: unsatisfiable bundle copy is a loud conflict", () => {
  const { prune, conflicts } = planEngineSitePrune({
    staged: { sympy: "1.15.0", filelock: "3.32.4" },
    bundle: { sympy: "1.12.0", filelock: "3.19.1" },
    needs: new Map([["sympy", [">=1.13.3"]]]),
  });
  assert.deepEqual(prune, ["filelock"]);
  assert.deepEqual(conflicts, [
    { name: "sympy", required: ">=1.13.3", have: "1.12.0" },
  ]);
});

test("unreferenced overlap defaults to prune (bundle wins unless declared)", () => {
  const { prune } = planEngineSitePrune({
    staged: { cffi: "2.1.1", onnxruntime: "1.23.0" },
    bundle: { cffi: "2.0.0", onnxruntime: "1.22.0" },
    needs: new Map(),
  });
  assert.deepEqual(prune, ["cffi", "onnxruntime"]);
});

test("disk floor constant stays at the audited 8 GB ceiling", () => {
  assert.equal(ENGINE_MIN_FREE_BYTES, 8 * 1024 * 1024 * 1024);
});

// ── version ordering ──────────────────────────────────────────────────

test("a release candidate sorts BELOW its final release (PEP 440)", () => {
  // The previous key split on [.+~-] and compared segment by segment, so
  // "1.0rc1" became [1, "0rc1"] against [1, 0] — a string never equals a
  // number and the string branch put "0rc1" above "0", making
  // 1.0rc1 > 1.0. A bundle pinned to a release candidate would then have
  // read as satisfying ">=1.0", and the staged copy of the FINAL release
  // pruned in its favour.
  assert.ok(compareVersions("1.0rc1", "1.0") < 0);
  assert.ok(compareVersions("1.0", "1.0rc1") > 0);
  assert.equal(specifierSatisfied(">=1.0", "1.0rc1"), false);
  assert.equal(specifierSatisfied(">=1.0", "1.0"), true);

  assert.ok(compareVersions("2.0.0b1", "2.0.0") < 0);
  assert.ok(compareVersions("1.0a1", "1.0b1") < 0);
  assert.ok(compareVersions("1.0.dev1", "1.0a1") < 0, "dev is below every pre-release");
  assert.ok(compareVersions("1.0.post1", "1.0") > 0, "post is above the final release");
  assert.ok(compareVersions("1.0rc2", "1.0rc1") > 0);
});

test("version comparison ignores what does not order versions", () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0, "trailing zeros are the same version");
  assert.equal(compareVersions("2.6.0+cu121", "2.6.0"), 0, "a local identifier does not order");
  assert.ok(compareVersions("4.10.0", "4.2.0") > 0, "numeric, not lexicographic");
  assert.ok(compareVersions("1!1.0", "2.0") > 0, "epoch outranks the release");
});

// ── what a prune actually removes ─────────────────────────────────────

test("a prune removes the package, not just its metadata", () => {
  // The prune used to delete only the .dist-info and leave numpy/ ,
  // numpy.libs/ and every .so on a PYTHONPATH that puts engine-site
  // AHEAD of the bundle — so `import numpy` still resolved to the
  // engine-site copy while the log said "pruned duplicate numpy".
  const record = [
    "numpy/__init__.py,sha256=aaa,100",
    "numpy/core/_multiarray_umath.so,sha256=bbb,900",
    "numpy.libs/libopenblas.dylib,sha256=ccc,10",
    "numpy-2.0.2.dist-info/METADATA,sha256=ddd,5",
    "numpy-2.0.2.dist-info/RECORD,,",
  ].join("\n");
  const { paths, unsafe } = planDistributionRemoval(record, "numpy-2.0.2.dist-info");
  assert.deepEqual(unsafe, []);
  assert.ok(paths.includes("numpy/__init__.py"));
  assert.ok(paths.includes("numpy/core/_multiarray_umath.so"));
  assert.ok(paths.includes("numpy.libs/libopenblas.dylib"));
  assert.ok(paths.includes("numpy-2.0.2.dist-info"), "and the metadata directory itself");
  // Deepest first, so directories are empty by the time they are removed.
  const depth = paths.map((p) => p.split("/").length);
  assert.deepEqual(depth, [...depth].sort((a, b) => b - a));
});

test("a RECORD cannot make a prune reach outside the site directory", () => {
  // RECORD is generated by whatever wheel was installed.
  const record = [
    "../../../etc/passwd,,",
    "/etc/shadow,,",
    "..\\\\windows\\\\system32\\\\x.dll,,",
    "C:/Windows/x.dll,,",
    "good/file.py,,",
  ].join("\n");
  const { paths, unsafe } = planDistributionRemoval(record, "");
  assert.deepEqual(paths, ["good/file.py"]);
  assert.equal(unsafe.length, 4, `refused: ${JSON.stringify(unsafe)}`);
});

test("a quoted RECORD path with a comma in it survives parsing", () => {
  const { paths } = planDistributionRemoval('"weird,name.py",sha256=x,1\n', "");
  assert.deepEqual(paths, ["weird,name.py"]);
});

test("without a RECORD the fallback covers the conventional layout, both spellings", () => {
  const guessed = guessDistributionPaths("typing-extensions", "4.12.0");
  for (const expected of [
    "typing-extensions-4.12.0.dist-info",
    "typing_extensions-4.12.0.dist-info",
    "typing_extensions",
    "typing_extensions.libs",
    "typing_extensions.py",
  ]) {
    assert.ok(guessed.includes(expected), `${expected} missing from ${JSON.stringify(guessed)}`);
  }
});

// ── markers reaching the prune plan ───────────────────────────────────

test("a requirement under an undecidable marker is a conflict, not permission to prune", () => {
  // The failure this closes: a staged distribution requires sympy>=1.14
  // under a marker we cannot evaluate; the requirement was dropped, the
  // specifier list came back empty, "nobody cares" was concluded, and
  // the staged copy was pruned in favour of a bundle sympy 1.12 that
  // does not satisfy it.
  const needs = new Map();
  needs.undecidable = new Set(["sympy"]);
  const plan = planEngineSitePrune({
    staged: { sympy: "1.14", numpy: "2.0.2" },
    bundle: { sympy: "1.12", numpy: "2.0.2" },
    needs,
  });
  assert.deepEqual(plan.prune, ["numpy"], "an unconstrained overlap still prunes");
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].name, "sympy");
  assert.equal(plan.conflicts[0].have, "1.12");
});
