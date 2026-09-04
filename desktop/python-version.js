"use strict";

/**
 * The interpreter version, read from the ONE file that declares it.
 *
 * `.python-version` at the repository root is the SSOT — the same role
 * `.nvmrc` plays for Node. `desktop/scripts/prepare-runtime.sh` builds the
 * bundled runtime from it, the CI workflow installs it with
 * `python-version-file:`, and this module is how the main process quotes it
 * back to the user without retyping it.
 *
 * The file ships in `build.extraResources`, so `getRepoRoot()` finds it in a
 * packaged app exactly as it finds `requirements.txt`.
 *
 * Pure module: no Electron imports, so `node --test` can drive it.
 */

const fs = require("node:fs");
const path = require("node:path");

const PYTHON_VERSION_FILENAME = ".python-version";

/**
 * Parse the contents of a `.python-version` file.
 *
 * Returns `null` for anything that is not a full `X.Y.Z` version rather than
 * guessing: a caller that cannot name the version must say nothing about it,
 * because inventing a fallback here would recreate the second source of truth
 * this module exists to remove.
 */
function parsePythonVersion(raw) {
  if (typeof raw !== "string") return null;
  const version = raw.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const [major, minor] = version.split(".");
  const xy = `${major}.${minor}`;
  return {
    version, // 3.12.13 — what the bundled runtime actually is
    xy, // 3.12    — what a package manager and a site-packages path use
    abiTag: `cp${major}${minor}`, // cp312 — the CPython wheel ABI tag
  };
}

/**
 * Read `.python-version` from `root`. Returns `null` if the file is absent or
 * unreadable (a stripped-down checkout, a broken bundle) so the caller can
 * degrade to wording that names no version at all.
 */
function readPythonVersion(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, PYTHON_VERSION_FILENAME), "utf8");
  } catch {
    return null;
  }
  return parsePythonVersion(raw);
}

module.exports = {
  PYTHON_VERSION_FILENAME,
  parsePythonVersion,
  readPythonVersion,
};
