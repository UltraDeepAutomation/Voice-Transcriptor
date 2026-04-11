// afterPack hook for electron-builder.
//
// Runs AFTER electron-builder has staged Transcriptor.app inside
// ``dist/mac-arm64/`` or ``dist/mac/`` but BEFORE it packages the
// .app into a DMG. We take over code signing here so we can do
// ad-hoc signing (``codesign --sign -``) instead of relying on a
// paid Apple Developer ID.
//
// Strategy
// --------
// We use a single ``codesign --force --deep --sign -`` invocation
// on the top-level ``.app`` bundle. The ``--deep`` flag walks every
// nested framework, helper app, dylib, and Mach-O binary in the
// right order (innermost first) and seals each one. Apple marks
// ``--deep`` as deprecated for NOTARIZED distribution (Developer ID
// + notarytool), but it remains the supported and reliable path
// for ad-hoc signing — which is exactly what we need here.
//
// An earlier version of this hook implemented a manual walker that
// picked up only ``.dylib``/``.node``/``.so`` + ``.app``/``.framework``
// /``.xpc`` bundles. That missed Mach-O executables with no file
// extension (e.g. ``Electron Framework.framework/Versions/A/Helpers/
// chrome_crashpad_handler``), so signing the enclosing framework
// exploded with "code object is not signed at all In subcomponent".
// ``codesign --deep`` identifies Mach-O binaries by file header
// rather than filename and handles this path cleanly.
//
// Ad-hoc signing semantics
// ------------------------
// - Produces a valid code signature with no trusted authority.
// - Works without friction on the SAME Mac that built the app
//   (quarantine xattr is stripped in BUILD.sh).
// - On OTHER Macs the first launch still needs the right-click →
//   Open confirmation because Gatekeeper cannot verify the
//   signature against any trusted CA. This is inherent to free
//   code signing; only a paid Apple Developer ID + notarization
//   can give a fully frictionless first-launch experience.
//
// Why not rely on electron-builder's own signing?
//   electron-builder resolves ``identity`` as a keychain certificate
//   NAME. Passing ``"-"`` (the canonical ``codesign`` ad-hoc marker)
//   fails because ``macCodeSign.js#findIdentity`` treats any non-null
//   string as a certificate name and returns null when no match is
//   found. Setting ``identity: null`` tells electron-builder to skip
//   signing entirely — we pick it up here.

const { execFileSync } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

/**
 * Run ``codesign`` and stream output. Throws on non-zero exit so
 * the build fails loudly instead of silently producing an unsigned
 * .app.
 */
function runCodesign(args) {
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
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

  console.log(`[afterPack] Ad-hoc signing ${appPath}`);
  console.log(`[afterPack] Entitlements: ${entitlements}`);

  // Single deep walk from the top-level .app bundle. codesign
  // handles the recursion order and identifies Mach-O binaries by
  // file header, so helper executables without file extensions
  // (e.g. ``chrome_crashpad_handler``) get signed correctly.
  runCodesign([
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    appPath,
  ]);

  // Verify. ``--strict`` catches any resource envelope drift,
  // ``--deep`` walks all nested items. On failure this throws and
  // aborts the build, so a broken signature never silently
  // propagates into the DMG.
  runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  // Print the top-level signature so the build log shows the
  // ad-hoc signer identity and hardened-runtime flag.
  try {
    execFileSync("/usr/bin/codesign", ["-dv", "--verbose=2", appPath], {
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
