// afterAllArtifactBuild hook for electron-builder.
//
// afterPack signs the staged .app bundle before electron-builder wraps it in a
// DMG. The DMG is a separate distributable code object, so public macOS release
// builds must sign that container too. Keeping this in the build hook makes the
// release artifact reproducible instead of relying on a manual post-build step.

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { hasSigningIdentity } = require("./scripts/macos-signing-utils");

const DEFAULT_INTERNAL_SIGNING_IDENTITY = "AntigravityTelegramDev";

function isDmgArtifact(artifactPath) {
  return path.extname(String(artifactPath || "")).toLowerCase() === ".dmg";
}

function signDmg(dmgPath, identity, timestampArg) {
  console.log(`[afterAllArtifactBuild] Signing DMG ${dmgPath} with identity "${identity}"`);
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", identity, timestampArg, dmgPath],
    { stdio: "inherit" },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--verbose=2", dmgPath],
    { stdio: "inherit" },
  );
  try {
    execFileSync(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", dmgPath],
      { stdio: "inherit" },
    );
  } catch {
    // Informational only; verification above is authoritative.
  }
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  const artifacts = Array.isArray(buildResult && buildResult.artifactPaths)
    ? buildResult.artifactPaths
    : [];
  const dmgArtifacts = artifacts.filter(isDmgArtifact);
  if (dmgArtifacts.length === 0) {
    return [];
  }

  if (process.env.TRANSCRIPTOR_ALLOW_ADHOC_SIGN === "1") {
    console.log(
      "[afterAllArtifactBuild] TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 - leaving DMG unsigned " +
        "for explicit local ad-hoc builds.",
    );
    return [];
  }

  const requestedIdentity = String(
    process.env.TRANSCRIPTOR_SIGNING_IDENTITY || DEFAULT_INTERNAL_SIGNING_IDENTITY,
  ).trim();
  if (!hasSigningIdentity(requestedIdentity)) {
    throw new Error(
      `afterAllArtifactBuild: missing signing identity "${requestedIdentity}". ` +
        "Set TRANSCRIPTOR_SIGNING_IDENTITY to a valid keychain identity before building DMG artifacts.",
    );
  }

  const isDeveloperIdIdentity = /^Developer ID Application:/i.test(requestedIdentity);
  const timestampArg = isDeveloperIdIdentity ? "--timestamp" : "--timestamp=none";
  for (const dmgPath of dmgArtifacts) {
    signDmg(dmgPath, requestedIdentity, timestampArg);
  }
  return [];
};
