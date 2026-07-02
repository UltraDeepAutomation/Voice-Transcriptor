#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertNoBundledBytecode,
  hardenAppTransportSecurity,
  hasCertificateIdentity,
  hasSigningIdentity,
  makeBundledPythonImportsReadOnly,
  normalizeMacPrivacyUsageDescriptions,
  preSignRuntimeBinaries,
  shouldIgnoreOsxSignPath,
} = require("./macos-signing-utils");

function requiredEnvSet(names) {
  const values = {};
  const missing = [];
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (!value) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return values;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.stdio || "pipe",
    encoding: options.encoding || "utf8",
    input: options.input,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function plistValue(plistPath, keyPath) {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${keyPath}`, plistPath]).trim();
}

function plistValueOptional(plistPath, keyPath) {
  try {
    return plistValue(plistPath, keyPath);
  } catch {
    return "";
  }
}

function readProvisioningProfileEntitlements(profilePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcriptor-mas-profile-"));
  const plistPath = path.join(tmpDir, "profile.plist");
  try {
    run("/usr/bin/security", ["cms", "-D", "-i", profilePath, "-o", plistPath]);
    return {
      appIdentifier:
        plistValueOptional(plistPath, "Entitlements:application-identifier") ||
        plistValueOptional(plistPath, "Entitlements:com.apple.application-identifier"),
      sandbox: /^true$/i.test(plistValueOptional(plistPath, "Entitlements:com.apple.security.app-sandbox")),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertBundleId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)) {
    throw new Error(`TRANSCRIPTOR_MAS_APP_ID must be a reverse-DNS bundle id, got "${value}"`);
  }
  if (/^local\./i.test(value)) {
    throw new Error("TRANSCRIPTOR_MAS_APP_ID must be an explicit App Store Connect bundle id, not local.*");
  }
}

function assertProfileMatchesAppId(profilePath, appId) {
  const entitlements = readProvisioningProfileEntitlements(profilePath);
  const appIdentifier = String(entitlements.appIdentifier || "");
  if (!appIdentifier.endsWith(`.${appId}`)) {
    throw new Error(
      `Provisioning profile does not match bundle id ${appId}. ` +
      `Profile application-identifier is "${appIdentifier || "missing"}".`,
    );
  }
  if (!entitlements.sandbox) {
    throw new Error("Provisioning profile does not include com.apple.security.app-sandbox.");
  }
  return entitlements;
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  const projectDir = path.resolve(__dirname, "..");
  const packageJson = readJson(path.join(projectDir, "package.json"));
  const releaseEnv = requiredEnvSet([
    "TRANSCRIPTOR_MAS_APP_ID",
    "TRANSCRIPTOR_MAS_SIGNING_IDENTITY",
    "TRANSCRIPTOR_MAS_INSTALLER_IDENTITY",
    "TRANSCRIPTOR_MAS_PROVISIONING_PROFILE",
  ]);
  const appId = releaseEnv.TRANSCRIPTOR_MAS_APP_ID;
  const appIdentity = releaseEnv.TRANSCRIPTOR_MAS_SIGNING_IDENTITY;
  const installerIdentity = releaseEnv.TRANSCRIPTOR_MAS_INSTALLER_IDENTITY;
  const provisioningProfile = path.resolve(releaseEnv.TRANSCRIPTOR_MAS_PROVISIONING_PROFILE);
  assertBundleId(appId);
  if (!fs.existsSync(provisioningProfile)) {
    throw new Error(`Provisioning profile not found: ${provisioningProfile}`);
  }
  if (!hasSigningIdentity(appIdentity)) {
    throw new Error(`Missing MAS app signing identity in keychain: "${appIdentity}"`);
  }
  if (!hasCertificateIdentity(installerIdentity)) {
    throw new Error(`Missing MAS installer signing identity in keychain: "${installerIdentity}"`);
  }
  assertProfileMatchesAppId(provisioningProfile, appId);
  if (preflightOnly) {
    console.log("[mas-sign] Preflight OK");
    return;
  }

  const appPath = path.resolve(
    process.env.TRANSCRIPTOR_MAS_APP_PATH ||
    path.join(projectDir, "dist", "mas-arm64", "Transcriptor.app"),
  );
  if (!fs.existsSync(appPath)) {
    throw new Error(`MAS app bundle not found: ${appPath}`);
  }
  const actualBundleId = plistValue(path.join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier");
  if (actualBundleId !== appId) {
    throw new Error(`Built MAS bundle id "${actualBundleId}" does not match "${appId}".`);
  }

  const entitlements = path.join(projectDir, "entitlements.mas.plist");
  const inheritEntitlements = path.join(projectDir, "entitlements.mas.inherit.plist");
  for (const file of [entitlements, inheritEntitlements]) {
    if (!fs.existsSync(file)) throw new Error(`Missing MAS entitlements file: ${file}`);
  }

  hardenAppTransportSecurity(appPath, {
    log: (message) => console.log(message.replace("[macos-signing]", "[mas-sign]")),
  });
  normalizeMacPrivacyUsageDescriptions(appPath, {
    log: (message) => console.log(message.replace("[macos-signing]", "[mas-sign]")),
  });
  assertNoBundledBytecode(appPath);
  const { runtimeRoot } = preSignRuntimeBinaries({
    appPath,
    identity: appIdentity,
    entitlements: inheritEntitlements,
    timestampArg: "--timestamp",
  });

  let osxSign;
  try {
    osxSign = require("@electron/osx-sign");
  } catch (e) {
    throw new Error(`@electron/osx-sign is required for MAS signing: ${e.message || e}`);
  }
  const signApp = osxSign.signAsync || osxSign.sign;
  if (typeof signApp !== "function") {
    throw new Error("@electron/osx-sign does not expose signAsync/sign.");
  }
  await signApp({
    app: appPath,
    identity: appIdentity,
    identityValidation: false,
    platform: "mas",
    type: "distribution",
    provisioningProfile,
    preAutoEntitlements: true,
    strictVerify: true,
    ignore: (filePath) => shouldIgnoreOsxSignPath(filePath, appPath, runtimeRoot),
    optionsForFile: (filePath) => {
      if (filePath === appPath) {
        return { entitlements, hardenedRuntime: true };
      }
      return { entitlements: inheritEntitlements, hardenedRuntime: true };
    },
  });

  const locked = makeBundledPythonImportsReadOnly(appPath);
  console.log(
    `[mas-sign] Locked bundled Python import trees read-only ` +
    `(${locked.fileCount} files + ${locked.dirCount} directories)`,
  );
  assertNoBundledBytecode(appPath);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });

  const pkgPath = path.resolve(
    process.env.TRANSCRIPTOR_MAS_PKG_PATH ||
    path.join(projectDir, "dist", `Transcriptor-${packageJson.version}-mas-arm64.pkg`),
  );
  fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
  if (fs.existsSync(pkgPath)) fs.rmSync(pkgPath, { force: true });
  run(
    "/usr/bin/productbuild",
    ["--sign", installerIdentity, "--component", appPath, "/Applications", pkgPath],
    { stdio: "inherit" },
  );
  run("/usr/sbin/pkgutil", ["--check-signature", pkgPath], { stdio: "inherit" });
  const sha = run("/usr/bin/shasum", ["-a", "256", pkgPath]).trim();
  console.log(`[mas-sign] Created ${pkgPath}`);
  console.log(`[mas-sign] ${sha}`);
  console.log(`[mas-sign] Ready for App Store Connect/TestFlight upload.`);
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`[mas-sign] ${process.env.DEBUG === "1" && error && error.stack ? error.stack : message}`);
  process.exit(1);
});
