// afterPack hook for electron-builder — code signing + TCC stability.
//
// Runs AFTER electron-builder has staged ``Transcriptor.app`` inside
// ``dist/mac-arm64/`` or ``dist/mac/`` but BEFORE the .app is packaged
// into a DMG. We take over code signing here so we can pin a STABLE
// signing identity across rebuilds — which is the only reliable way
// to stop macOS TCC (Transparency, Consent, Control) from re-prompting
// the user for Microphone / Accessibility / Apple Events permissions
// on every rebuild.
//
// Why rebuilds kept re-prompting
// ------------------------------
// macOS TCC indexes granted permissions by:
//   1. The app's signing identifier (``-i`` / designated requirement), AND
//   2. For ad-hoc signed apps, the CDHash of the whole .app bundle.
//
// Ad-hoc signatures have no trusted authority, so TCC has nothing to
// verify against except the CDHash. Every rebuild produces a new
// CDHash (different Electron binary mtimes, different frontend asset
// hashes, different entitlements seal), so TCC sees every rebuild as
// a brand-new "unknown" app and blows away every prior grant.
//
// With a STABLE self-signed certificate (``AntigravityTelegramDev``
// in the local keychain), TCC anchors grants to the certificate
// fingerprint + signing identifier pair. Rebuilds keep producing
// different CDHashes, but TCC recognizes the cert as the same
// authority and preserves the grant. The user now only sees each
// permission prompt ONCE in the life of the installation.
//
// Identity selection
// ------------------
// The user's local keychain already has a self-signed code-signing
// cert named "AntigravityTelegramDev" (10-year expiry, Code Signing
// EKU). We use it as the default identity. If it's not present (fresh
// machine, CI runner, etc.), we fall back to ad-hoc signing so the
// build never fails — the user will just be re-prompted on each
// rebuild like before. This graceful fallback keeps the build
// reproducible across environments.
//
// Entitlements + hardened runtime
// -------------------------------
// We still enable ``--options runtime`` (hardened runtime) and pass
// ``entitlements.mac.plist`` so microphone + Apple Events + JIT +
// network-client permissions survive the signing step. The
// entitlements file is the SSOT for what the app is allowed to do
// after TCC grants permission.
//
// Why --deep
// ----------
// ``codesign --deep`` walks every nested framework, helper app,
// dylib, and Mach-O binary in the right order (innermost first) and
// seals each one with the same identity. Apple marks ``--deep`` as
// deprecated for NOTARIZED distribution (Developer ID + notarytool),
// but it remains the supported path for self-signed / ad-hoc local
// signing. A manual bottom-up walker would miss Mach-O files with
// no file extension (e.g. ``Helpers/chrome_crashpad_handler``).

const { execFileSync, execSync } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

// Name of the preferred code-signing identity to look for in the
// local keychain. If found, it is used; otherwise we drop to ad-hoc.
// This specific cert was generated on the user's Mac with a 10-year
// validity and the Code Signing EKU — perfect for local dev use.
const PREFERRED_SIGNING_IDENTITY = "AntigravityTelegramDev";

/**
 * Run ``codesign`` and stream output. Throws on non-zero exit so
 * the build fails loudly instead of silently producing an unsigned
 * .app.
 */
function runCodesign(args) {
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
}

/**
 * Return ``true`` if the preferred signing identity is currently
 * available in the local keychain. We probe via ``security find-
 * identity -v -p codesigning`` and look for the exact CN. An absent
 * identity (or keychain read failure) yields ``false`` so the caller
 * can fall back to ad-hoc signing.
 */
function hasPreferredIdentity() {
  try {
    const out = execSync("/usr/bin/security find-identity -v -p codesigning", {
      encoding: "utf8",
    });
    return out.includes(`"${PREFERRED_SIGNING_IDENTITY}"`);
  } catch {
    return false;
  }
}

exports.default = async function afterPack(context) {
  // electron-builder invokes afterPack for every platform. Only
  // touch macOS builds — Windows ignores codesign.
  const platform = context.electronPlatformName || context.packager.platform.nodeName;
  if (platform !== "darwin") {
    return;
  }

  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`afterPack: ${appPath} does not exist`);
  }

  const projectDir = context.packager.info.projectDir;
  const entitlements = path.join(projectDir, "entitlements.mac.plist");
  if (!existsSync(entitlements)) {
    throw new Error(`afterPack: entitlements plist missing at ${entitlements}`);
  }

  // Bundle identifier pinning
  //
  // ``--identifier`` forces the signed bundle's designated
  // requirement to use the exact bundle ID declared in package.json,
  // independent of whatever the Info.plist says. This is important
  // because macOS TCC looks up permission grants keyed by the
  // DESIGNATED REQUIREMENT's signing identifier, not by the
  // CFBundleIdentifier string. Pinning both together guarantees that
  // TCC has a stable key across rebuilds.
  const bundleId = context.packager.appInfo.id || "local.transcriptor.app";

  // Pick signing identity: stable cert when available, ad-hoc otherwise.
  const useStableIdentity = hasPreferredIdentity();
  const signingIdentity = useStableIdentity ? PREFERRED_SIGNING_IDENTITY : "-";

  if (useStableIdentity) {
    console.log(
      `[afterPack] Signing ${appPath} with stable identity "${PREFERRED_SIGNING_IDENTITY}"`,
    );
    console.log(
      "[afterPack] TCC permissions (microphone, accessibility, Apple Events) will persist across rebuilds.",
    );
  } else {
    console.log(
      `[afterPack] Preferred identity "${PREFERRED_SIGNING_IDENTITY}" not in keychain — falling back to ad-hoc signing`,
    );
    console.log(
      "[afterPack] NOTE: ad-hoc signed rebuilds invalidate TCC grants; the user will see permission prompts every build.",
    );
  }
  console.log(`[afterPack] Entitlements: ${entitlements}`);
  console.log(`[afterPack] Bundle identifier pinned: ${bundleId}`);

  // Single deep walk from the top-level .app bundle. codesign handles
  // the recursion order and identifies Mach-O binaries by file header,
  // so helper executables without file extensions (e.g.
  // ``chrome_crashpad_handler``) get signed correctly.
  //
  // For a STABLE identity we drop ``--timestamp=none`` — codesign
  // falls back to the secure timestamp server when available, which
  // is fine for local use and matches how Developer ID signed builds
  // work. For ad-hoc signatures the timestamp flag is a no-op anyway
  // (Apple's timestamp server only talks to real certs).
  //
  // ``--identifier`` pins the signing identifier to the bundle ID
  // regardless of what's in Info.plist — TCC uses this string (not
  // CDHash) to look up grants when the signature has a trusted
  // authority.
  const signArgs = [
    "--force",
    "--deep",
    "--sign",
    signingIdentity,
    "--identifier",
    bundleId,
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
  ];
  if (!useStableIdentity) {
    // Ad-hoc signatures can't use timestamps.
    signArgs.push("--timestamp=none");
  }
  signArgs.push(appPath);
  runCodesign(signArgs);

  // Verify. ``--strict`` catches any resource envelope drift, ``--deep``
  // walks all nested items. On failure this throws and aborts the
  // build, so a broken signature never silently propagates into the
  // DMG.
  runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  // Print the top-level signature so the build log shows the
  // signing identity, team identifier (if any), CDHash, and
  // hardened-runtime flag.
  try {
    execFileSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
      stdio: "inherit",
    });
  } catch {
    // The verbose dump is informational only; do not fail on it.
  }

  const stat = statSync(appPath);
  console.log(
    `[afterPack] Signed ${appName}.app OK (mtime=${stat.mtime.toISOString()})`,
  );
};
