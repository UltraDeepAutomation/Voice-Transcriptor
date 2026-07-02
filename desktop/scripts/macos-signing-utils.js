const { execFileSync, execSync } = require("node:child_process");
const {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} = require("node:fs");
const path = require("node:path");

const PYTHON_IMPORT_TREES = Object.freeze([
  path.join("Contents", "Resources", "runtime", "python"),
  path.join("Contents", "Resources", "backend"),
]);

function walkTree(root, visitor) {
  const visit = (entryPath) => {
    let st;
    try { st = lstatSync(entryPath); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(entryPath); } catch { return; }
      for (const name of entries) visit(path.join(entryPath, name));
      visitor(entryPath, st);
      return;
    }
    if (st.isFile()) visitor(entryPath, st);
  };
  visit(root);
}

function pathIsInside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function classifyMacho(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch { return "non-macho"; }
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    if (n < 16) return "non-macho";
    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);
    if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
      const filetype = buf.readUInt32LE(12);
      if (filetype === 2) return "executable";
      if (filetype === 6 || filetype === 8) return "dylib";
      return "macho-other";
    }
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
      const fatHdr = Buffer.alloc(24);
      if (readSync(fd, fatHdr, 0, 24, 0) < 24) return "macho-other";
      const firstOff = magicBE === 0xcafebabf
        ? Number(fatHdr.readBigUInt64BE(16))
        : fatHdr.readUInt32BE(16);
      if (!Number.isSafeInteger(firstOff) || firstOff <= 0) return "macho-other";
      const thinHdr = Buffer.alloc(16);
      if (readSync(fd, thinHdr, 0, 16, firstOff) < 16) return "macho-other";
      const thinMagic = thinHdr.readUInt32LE(0);
      if (thinMagic !== 0xfeedfacf && thinMagic !== 0xfeedface) return "macho-other";
      const filetype = thinHdr.readUInt32LE(12);
      if (filetype === 2) return "executable";
      if (filetype === 6 || filetype === 8) return "dylib";
      return "macho-other";
    }
    return "non-macho";
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function shouldIgnoreOsxSignPath(filePath, appPath, runtimeRoot) {
  if (filePath === appPath) return false;
  if (pathIsInside(filePath, runtimeRoot)) return true;
  if (filePath.endsWith(".app") || filePath.endsWith(".framework")) return false;
  let st;
  try { st = lstatSync(filePath); } catch { return true; }
  if (!st.isFile()) return false;
  const kind = classifyMacho(filePath);
  return kind === "non-macho" || kind === "macho-other";
}

function assertNoBundledBytecode(appPath) {
  const offenders = [];
  for (const relRoot of PYTHON_IMPORT_TREES) {
    const root = path.join(appPath, relRoot);
    if (!existsSync(root)) continue;
    walkTree(root, (entryPath, st) => {
      if (
        (st.isDirectory() && path.basename(entryPath) === "__pycache__") ||
        (st.isFile() && entryPath.endsWith(".pyc"))
      ) {
        offenders.push(entryPath);
      }
    });
  }
  if (offenders.length > 0) {
    throw new Error(
      "bundled Python bytecode is forbidden inside the signed app. " +
        `First offenders:\n${offenders.slice(0, 20).join("\n")}`,
    );
  }
}

function makeBundledPythonImportsReadOnly(appPath) {
  let fileCount = 0;
  let dirCount = 0;
  for (const relRoot of PYTHON_IMPORT_TREES) {
    const root = path.join(appPath, relRoot);
    if (!existsSync(root)) continue;
    walkTree(root, (entryPath, st) => {
      const executable = (st.mode & 0o111) !== 0;
      const mode = st.isDirectory() ? 0o555 : (executable ? 0o555 : 0o444);
      chmodSync(entryPath, mode);
      if (st.isDirectory()) dirCount += 1;
      if (st.isFile()) fileCount += 1;
    });
  }
  return { fileCount, dirCount };
}

function hasSigningIdentity(identity) {
  const wanted = String(identity || "").trim();
  if (!wanted) return false;
  try {
    const out = execSync("/usr/bin/security find-identity -v -p codesigning", {
      encoding: "utf8",
    });
    return out.includes(`"${wanted}"`);
  } catch {
    return false;
  }
}

function preSignRuntimeBinaries({ appPath, identity, entitlements, timestampArg = "--timestamp", log = console.log }) {
  const runtimeRoot = path.join(appPath, "Contents", "Resources", "runtime");
  if (!existsSync(runtimeRoot)) {
    return { runtimeRoot, signedCount: 0, execCount: 0, dylibCount: 0 };
  }
  log(`[macos-signing] Pre-signing bundled runtime binaries under ${runtimeRoot}`);
  let signedCount = 0;
  let execCount = 0;
  let dylibCount = 0;
  const signOne = (filePath, kind) => {
    const args = ["--force", "--sign", identity, timestampArg];
    if (kind === "executable") {
      args.push("--options", "runtime", "--entitlements", entitlements);
      execCount += 1;
    } else {
      dylibCount += 1;
    }
    args.push(filePath);
    try {
      execFileSync("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
      signedCount += 1;
    } catch (e) {
      const stderr = e && e.stderr ? e.stderr.toString() : "";
      throw new Error(`codesign failed for ${filePath}\n${stderr || (e.message || e)}`);
    }
  };
  walkTree(runtimeRoot, (entryPath, st) => {
    if (!st.isFile()) return;
    const kind = classifyMacho(entryPath);
    if (kind === "non-macho" || kind === "macho-other") return;
    signOne(entryPath, kind);
  });
  log(
    `[macos-signing] Pre-signed ${signedCount} runtime binaries ` +
    `(${execCount} executables + ${dylibCount} dylibs/bundles)`,
  );
  return { runtimeRoot, signedCount, execCount, dylibCount };
}

module.exports = {
  assertNoBundledBytecode,
  classifyMacho,
  hasSigningIdentity,
  makeBundledPythonImportsReadOnly,
  pathIsInside,
  preSignRuntimeBinaries,
  shouldIgnoreOsxSignPath,
  walkTree,
};
