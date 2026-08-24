"use strict";

// Unit tests for the engine dependency policy SSOT (engine-deps.js).
// Pure node:test — no Electron, no network, mirrors accelerator.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseRequiresDist,
  specifierSatisfied,
  compareVersions,
  distInfoInventory,
  collectRequirementIndex,
  planEngineSitePrune,
  ENGINE_MIN_FREE_BYTES,
} = require("./engine-deps");

test("parseRequiresDist extracts constraints and skips markers/extras", () => {
  const meta = [
    "Metadata-Version: 2.1",
    "Name: torch",
    "Requires-Dist: filelock",
    "Requires-Dist: typing-extensions>=4.10.0",
    "Requires-Dist: sympy>=1.13.3",
    "Requires-Dist: triton==3.7.1; platform_system == \"Linux\"",
    "Requires-Dist: torch>=2.6; extra == \"torch\"",
    "Requires-Dist: numpy==2.*",
  ].join("\n");
  const reqs = parseRequiresDist(meta);
  assert.deepEqual(reqs, [
    { name: "filelock", spec: "" },
    { name: "typing-extensions", spec: ">=4.10.0" },
    { name: "sympy", spec: ">=1.13.3" },
    { name: "numpy", spec: "==2.*" },
  ]);
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
