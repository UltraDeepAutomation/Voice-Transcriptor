"use strict";

// Engine dependency policy + install lifecycle primitives — the single
// source of truth (SSOT) for everything GigaAM-engine-install related
// that can be pure. Unit-tested directly by engine-deps.test.js against
// the exact code Electron loads, mirroring the ./accelerator.js pattern.
//
// ── Why this module exists ────────────────────────────────────────────
//
// The engine stack (torch + gigaam + audio deps) installs into a
// --target directory (userData/engine-site) which is PREPENDED to
// PYTHONPATH for every backend interpreter invocation. Path-level
// precedence means ANY package name present in both the release-pinned
// bundle site-packages and engine-site silently shadows the pinned
// version — the bug class behind numpy/ml_dtypes hand-pruning
// (commit 7c7bb63). An empirical audit (2026-08-24) found ~20 such
// shadowed names, including runtime-critical ones (onnxruntime, cffi,
// sympy, typing_extensions).
//
// The invariant enforced here instead:
//
//   engine-site may only ADD names the bundle does not ship.
//   Every overlapping name is pruned from the staged install UNLESS a
//   staged distribution explicitly requires it AND the bundle copy does
//   not satisfy that requirement — in which case the install FAILS
//   LOUDLY with a precise conflict report instead of silently winning
//   or losing an import-resolution race.

const ENGINE_INSTALL_PHASES = Object.freeze({
  IDLE: "idle",
  PROBING: "probing",
  INSTALLING: "installing",
  DONE: "done",
  FAILED: "failed",
});

// Hosts the staged `pip install -r requirements-gigaam.txt` must reach:
// PyPI serves the wheels, github.com serves the pinned GigaAM checkout.
const ENGINE_NETWORK_HOSTS = Object.freeze([
  { host: "pypi.org", port: 443 },
  { host: "github.com", port: 443 },
]);

// Free-disk floor for the install (bytes): ~2 GB download, ~6-7 GB
// unpacked, plus pip's cache copy mid-install. Verified ceiling with
// headroom; see BUG-33.
const ENGINE_MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Parse one ``Requires-Dist:`` value into a constraint we understand.
 * Returns null for anything outside the enforced subset — environment
 * markers (``; platform_system == ...``) and extras (``[torch]``) are
 * skipped by the CALLER because they do not constrain this platform or
 * are satisfied by installing the extra itself.
 */
function parseRequirementLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.includes(";") || raw.includes("[")) return null;
  const match = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
  if (!match) return null;
  const name = match[1].toLowerCase().replace(/_/g, "-");
  const specifier = (match[2] || "").trim();
  return { name, spec: specifier.replace(/\s+/g, "") };
}

/**
 * Extract constraints from one METADATA body. Skips markers/extras and
 * duplicate declarations. Returns [{name, spec}] where spec may be ""
 * (unconstrained presence).
 */
function parseRequiresDist(metadataText) {
  const out = [];
  const seen = new Set();
  for (const line of String(metadataText || "").split(/\r?\n/)) {
    if (!line.startsWith("Requires-Dist:")) continue;
    const parsed = parseRequirementLine(line.slice("Requires-Dist:".length));
    if (!parsed) continue;
    const key = `${parsed.name}${parsed.spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/** Numeric-aware release-segment key: "4.10.0" sorts above "4.2.0". */
function versionKey(version) {
  return String(version || "0")
    .split(/[.+~-]/)
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const sa = ka[i];
    const sb = kb[i];
    if (sa === sb) continue;
    if (sa === undefined) return typeof sb === "number" ? -1 : 1;
    if (sb === undefined) return typeof sa === "number" ? 1 : -1;
    if (typeof sa === "number" && typeof sb === "number") return sa - sb;
    return String(sa) < String(sb) ? -1 : 1;
  }
  return 0;
}

/**
 * Evaluate ONE PEP 440 specifier clause ("", ">=4.10.0", "==1.13.3",
 * "<14,>=13.0.3", "~=2.6", "==2.*") against a version. Wildcards are
 * prefix matches on the release segments ("==2.*" accepts 2.0.2 and
 * 2.1, rejects 3.0). Supported operators cover every constraint
 * observed in the torch/gigaam dependency trees; arbitrary equality
 * ("===") is treated as UNSATISFIABLE-by-analysis and reported rather
 * than guessed.
 */
function specifierSatisfied(spec, version) {
  const cleaned = String(spec || "").trim();
  if (!cleaned) return true;
  for (const clause of cleaned.split(",")) {
    const m = clause.match(/^(>=|<=|==|!=|~=|>|<|=)(.*)$/);
    if (!m) return false;
    const op = m[1];
    let target = m[2].trim();
    if (target.endsWith(".*")) {
      // Wildcard: release-segment prefix match. Only meaningful with
      // == / != per PEP 440; other operators with a wildcard refuse.
      const prefix = target.slice(0, -2);
      const vPrefix = String(version).slice(0, prefix.length + 1);
      const within = vPrefix === `${prefix}.` || String(version) === prefix;
      if (op === "==") { if (!within) return false; continue; }
      if (op === "!=") { if (within) return false; continue; }
      return false;
    }
    const cmp = compareVersions(version, target);
    switch (op) {
      case ">=": if (!(cmp >= 0)) return false; break;
      case "<=": if (!(cmp <= 0)) return false; break;
      case ">": if (!(cmp > 0)) return false; break;
      case "<": if (!(cmp < 0)) return false; break;
      case "~=": {
        // Compatible-release: >= prefix, and version within the same
        // leading segments as the target minus its last segment.
        const prefixSegs = target.split(".");
        prefixSegs.pop();
        const prefix = prefixSegs.join(".");
        if (!String(version).startsWith(prefix + ".") && String(version) !== prefix) return false;
        if (cmp < 0) return false;
        break;
      }
      case "!=": if (cmp === 0) return false; break;
      case "==":
      case "=": if (cmp !== 0) return false; break;
      default: return false;
    }
  }
  return true;
}

/** Read every ``<name>-<version>.dist-info`` directory name into {name: version}. */
function distInfoInventory(readdirSync) {
  const inv = Object.create(null);
  for (const entry of readdirSync()) {
    const m = entry.match(/^(.+)-(\d[^/]*)\.dist-info$/i);
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/_/g, "-");
    if (!(name in inv)) inv[name] = m[2];
  }
  return inv;
}

/**
 * Build the requirement index across ALL staged distributions: for each
 * constrained name, the union of specifiers any staged package declares.
 * A staged copy of X is shadowing-safe only if the BUNDLE copy of X
 * satisfies EVERY declaration (that is exactly pip's resolver contract,
// restricted to the overlap surface this install can actually affect).
 */
function collectRequirementIndex(stagingDir, fsLike) {
  const index = new Map(); // name -> Array<spec>
  for (const entry of fsLike.readdirSync(stagingDir)) {
    if (!/\.dist-info$/i.test(entry)) continue;
    const metaPath = `${stagingDir}/${entry}/METADATA`;
    let text;
    try {
      text = fsLike.readFileSync(metaPath, "utf8");
    } catch {
      continue; // malformed dist-info: absence of declarations ≠ permission
    }
    for (const req of parseRequiresDist(text)) {
      if (!req.spec) continue; // unconstrained mentions impose nothing
      const list = index.get(req.name) || [];
      list.push(req.spec);
      index.set(req.name, list);
    }
  }
  return index;
}

/**
 * Decide, for the overlap between a staged engine install and the
 * release-pinned bundle, which staged copies must be pruned and whether
 * any overlap is UNSAFE (bundle copy cannot satisfy a declared need).
 *
 * @param {Object} args
 * @param {Object.<string,string>} args.staged   name → version (staging)
 * @param {Object.<string,string>} args.bundle   name → version (bundle)
 * @param {Map<string,string[]>}   args.needs    name → specifier union
 * @returns {{prune: string[], conflicts: Array<{name,required,have}>}}
 */
function planEngineSitePrune({ staged, bundle, needs }) {
  const prune = [];
  const conflicts = [];
  for (const name of Object.keys(staged)) {
    if (!(name in bundle)) continue; // pure addition — keep
    const specs = (needs && needs.get(name)) || [];
    const unsatisfied = specs.filter((s) => !specifierSatisfied(s, bundle[name]));
    if (unsatisfied.length === 0) {
      prune.push(name); // bundle wins: satisfies everyone who cares
    } else {
      conflicts.push({
        name,
        required: unsatisfied.join(" & "),
        have: bundle[name],
      });
    }
  }
  prune.sort();
  return { prune, conflicts };
}

module.exports = {
  ENGINE_INSTALL_PHASES,
  ENGINE_NETWORK_HOSTS,
  ENGINE_MIN_FREE_BYTES,
  parseRequirementLine,
  parseRequiresDist,
  collectRequirementIndex,
  planEngineSitePrune,
  specifierSatisfied,
  compareVersions,
  distInfoInventory,
};
