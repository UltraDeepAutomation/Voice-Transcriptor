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

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function hasCertificateIdentity(identity) {
  const wanted = String(identity || "").trim();
  if (!wanted) return false;
  try {
    const out = execFileSync("/usr/bin/security", ["find-certificate", "-a", "-c", wanted, "-Z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.includes(`"alis"<blob>="${wanted}"`) || out.includes(`"labl"<blob>="${wanted}"`);
  } catch {
    return false;
  }
}

function runPlistBuddy(plistPath, command, { optional = false } = {}) {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"],
    }).trim();
  } catch (e) {
    if (optional) return "";
    const stderr = e && e.stderr ? e.stderr.toString() : "";
    throw new Error(`PlistBuddy failed for ${plistPath}: ${command}\n${stderr || (e.message || e)}`);
  }
}

function hardenAppTransportSecurity(appPath, { log = console.log } = {}) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlist)) {
    throw new Error(`Info.plist not found: ${infoPlist}`);
  }

  // Electron injects a broad NSAllowsArbitraryLoads=true default for
  // compatibility. Transcriptor only needs insecure HTTP for its local
  // loopback backend; App Store and production builds should keep ATS
  // tight for all external traffic.
  runPlistBuddy(infoPlist, "Delete :NSAppTransportSecurity", { optional: true });
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity dict");
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false");
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true");
  runPlistBuddy(infoPlist, "Add :NSAppTransportSecurity:NSExceptionDomains dict");

  for (const host of ["127.0.0.1", "localhost"]) {
    const base = `:NSAppTransportSecurity:NSExceptionDomains:${host}`;
    runPlistBuddy(infoPlist, `Add ${base} dict`);
    runPlistBuddy(infoPlist, `Add ${base}:NSIncludesSubdomains bool false`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionAllowsInsecureHTTPLoads bool true`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionAllowsInsecureHTTPSLoads bool false`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionMinimumTLSVersion string 1.2`);
    runPlistBuddy(infoPlist, `Add ${base}:NSTemporaryExceptionRequiresForwardSecrecy bool true`);
  }

  const arbitraryLoads = runPlistBuddy(
    infoPlist,
    "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads",
  );
  const localNetworking = runPlistBuddy(
    infoPlist,
    "Print :NSAppTransportSecurity:NSAllowsLocalNetworking",
  );
  if (arbitraryLoads !== "false" || localNetworking !== "true") {
    throw new Error(
      `ATS hardening verification failed for ${infoPlist}: ` +
        `NSAllowsArbitraryLoads=${arbitraryLoads}, NSAllowsLocalNetworking=${localNetworking}`,
    );
  }
  log(`[macos-signing] Hardened App Transport Security in ${infoPlist}`);
}

function plistSetString(plistPath, key, value) {
  runPlistBuddy(plistPath, `Delete :${key}`, { optional: true });
  runPlistBuddy(plistPath, `Add :${key} string ${value}`);
}

function normalizeMacPrivacyUsageDescriptions(appPath, { log = console.log } = {}) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlist)) {
    throw new Error(`Info.plist not found: ${infoPlist}`);
  }

  const microphoneUsage = "Transcriptor records microphone audio when you start a live transcription.";
  plistSetString(infoPlist, "NSMicrophoneUsageDescription", microphoneUsage);
  plistSetString(infoPlist, "NSAudioCaptureUsageDescription", microphoneUsage);
  plistSetString(
    infoPlist,
    "NSAppleEventsUsageDescription",
    "Transcriptor uses Apple Events to paste transcripts into the app you are working in.",
  );

  // Electron injects generic Camera/Bluetooth prompts by default, but
  // Transcriptor only captures microphone audio. Shipping unused usage
  // descriptions makes App Store privacy review noisier and implies
  // capabilities that are not part of the product contract.
  for (const key of [
    "NSCameraUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
  ]) {
    runPlistBuddy(infoPlist, `Delete :${key}`, { optional: true });
  }

  const camera = runPlistBuddy(infoPlist, "Print :NSCameraUsageDescription", { optional: true });
  const bluetoothAlways = runPlistBuddy(
    infoPlist,
    "Print :NSBluetoothAlwaysUsageDescription",
    { optional: true },
  );
  const bluetoothPeripheral = runPlistBuddy(
    infoPlist,
    "Print :NSBluetoothPeripheralUsageDescription",
    { optional: true },
  );
  if (camera || bluetoothAlways || bluetoothPeripheral) {
    throw new Error(`Privacy usage description normalization failed for ${infoPlist}`);
  }
  log(`[macos-signing] Normalized macOS privacy usage descriptions in ${infoPlist}`);
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
  const removeExistingSignature = (filePath) => {
    try {
      execFileSync("/usr/bin/codesign", ["--remove-signature", filePath], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // Unsigned Mach-O files are expected in third-party wheels.
    }
  };
  const removeBuildOnlyXattrs = (filePath) => {
    for (const attr of ["com.apple.provenance"]) {
      try {
        execFileSync("/usr/bin/xattr", ["-d", attr, filePath], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        // Missing xattrs are fine; the packaged source file is left untouched.
      }
    }
  };
  const signOne = (filePath, kind) => {
    const signIdentity = kind === "executable" ? identity : "-";
    const args = ["--force", "--sign", signIdentity];
    if (signIdentity !== "-") args.push(timestampArg);
    if (kind === "executable") {
      args.push("--options", "runtime", "--entitlements", entitlements);
      execCount += 1;
    } else {
      dylibCount += 1;
    }
    args.push(filePath);
    let lastError = "";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      removeExistingSignature(filePath);
      removeBuildOnlyXattrs(filePath);
      try {
        execFileSync("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
        signedCount += 1;
        return;
      } catch (e) {
        const stderr = e && e.stderr ? e.stderr.toString() : "";
        lastError = stderr || (e.message || String(e));
        if (attempt < 5) sleepMs(150 * attempt);
      }
    }
    throw new Error(`codesign failed for ${filePath}\n${lastError}`);
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
  hardenAppTransportSecurity,
  hasCertificateIdentity,
  hasSigningIdentity,
  makeBundledPythonImportsReadOnly,
  normalizeMacPrivacyUsageDescriptions,
  pathIsInside,
  preSignRuntimeBinaries,
  shouldIgnoreOsxSignPath,
  walkTree,
};
