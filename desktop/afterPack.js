// afterPack hook for electron-builder — code signing via @electron/osx-sign.
//
// Runs AFTER electron-builder has staged ``Transcriptor.app`` inside
// ``dist/mac-arm64/`` or ``dist/mac/`` but BEFORE the DMG wrapper is
// built. We take over code signing so we can pin a stable identity
// across rebuilds without re-triggering macOS TCC permission prompts.
//
// Why @electron/osx-sign instead of raw codesign
// ------------------------------------------------
// Our previous attempt used ``codesign --deep --sign X --identifier
// local.transcriptor.app`` which crashed the app at launch with:
//
//     Library not loaded: @rpath/Electron Framework.framework/...
//     mapping process and mapped file (non-platform) have different
//     Team IDs
//
// Two root causes:
//
//   1. ``--deep --identifier Y`` clobbered the signing identifier of
//      every nested Framework/helper/.app as well. After the pass,
//      ``Electron Framework`` claimed the SAME identifier
//      (``local.transcriptor.app``) as the main binary. Hardened
//      runtime library validation refused to load a "framework"
//      that identifies as the main app.
//
//   2. Each Electron helper (.app / Renderer / Plugin / GPU) needs
//      its OWN entitlements subset (renderer gets cs.allow-jit only,
//      the top-level bundle gets the full set including audio-input
//      and automation). Passing one entitlements file to every
//      nested item via ``--deep`` over-privileges helpers and still
//      leaves the top-level bundle misconfigured.
//
// ``@electron/osx-sign`` is the canonical Electron signing tool
// written specifically for this structure. It walks the bundle
// innermost-first, preserves each nested item's natural identifier,
// applies helper-specific default entitlements from its bundled
// templates (``default.darwin.{renderer,plugin,gpu}.plist``), and
// uses a full custom entitlements file only for the top-level .app.
// Library validation passes because every item keeps its own
// identifier and they all share the same signing authority.
//
// Identity selection
// ------------------
// Probes the local keychain for ``AntigravityTelegramDev`` (the
// user's self-signed 10-year code-signing certificate). When found,
// uses it as the ``identity`` option. When absent (fresh machine,
// CI runner), drops to ad-hoc via ``-`` and logs a warning — the
// build never fails on a missing certificate.
//
// TCC persistence
// ---------------
// macOS TCC indexes permission grants by the signing certificate
// fingerprint + bundle identifier. Using a stable keychain identity
// (instead of ad-hoc ``-``) anchors grants to the certificate, so
// rebuilds keep their Microphone / Accessibility / Apple Events
// grants even though every rebuild produces a different CDHash.

const { execFileSync, execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const PREFERRED_SIGNING_IDENTITY = "AntigravityTelegramDev";

/**
 * Return ``true`` if the preferred signing identity is currently
 * available in the local keychain. Probes via ``security find-
 * identity -v -p codesigning``.
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
  const inheritEntitlements = path.join(projectDir, "entitlements.mac.inherit.plist");
  if (!existsSync(entitlements)) {
    throw new Error(`afterPack: entitlements plist missing at ${entitlements}`);
  }
  if (!existsSync(inheritEntitlements)) {
    throw new Error(`afterPack: inherit entitlements missing at ${inheritEntitlements}`);
  }

  const useStableIdentity = hasPreferredIdentity();
  const identity = useStableIdentity ? PREFERRED_SIGNING_IDENTITY : "-";

  if (useStableIdentity) {
    console.log(
      `[afterPack] Signing ${appPath} with stable identity "${PREFERRED_SIGNING_IDENTITY}" via @electron/osx-sign`,
    );
    console.log(
      "[afterPack] TCC permissions (microphone, accessibility, Apple Events) will persist across rebuilds.",
    );
  } else {
    console.log(
      `[afterPack] Preferred identity "${PREFERRED_SIGNING_IDENTITY}" not in keychain — using ad-hoc signing`,
    );
    console.log(
      "[afterPack] NOTE: ad-hoc rebuilds invalidate TCC grants; the user will see permission prompts every build.",
    );
  }
  console.log(`[afterPack] Top-level entitlements: ${entitlements}`);

  // @electron/osx-sign is the canonical Electron signing tool. It
  // walks the bundle innermost-first, preserves each nested item's
  // natural signing identifier, and applies helper-specific default
  // entitlements from its bundled templates. We pass:
  //
  //   - ``app``                 : the .app bundle to sign
  //   - ``identity``            : keychain cert name or "-" for ad-hoc
  //   - ``identityValidation``  : false so it accepts our self-signed
  //                                cert and the ad-hoc "-" marker
  //                                without trying to validate them
  //                                against Apple's cert chain
  //   - ``optionsForFile``      : per-file hook. For the top-level
  //                                .app we return our custom
  //                                entitlements; every nested item
  //                                gets the tool's default
  //                                helper-specific entitlements
  //                                (returning undefined from the hook
  //                                triggers the default behaviour).
  //   - ``preAutoEntitlements: false``
  //                                disables the mas-specific sandbox
  //                                entitlement injection (we are not
  //                                targeting the Mac App Store).
  //   - ``type: "distribution"`` the hardened-runtime code path.
  //   - ``platform: "darwin"``  non-mas build.
  //
  // Signing helpers with hardened runtime + their own (narrower)
  // entitlements is what fixes the "different Team IDs" launch
  // crash we hit with ``codesign --deep``: each framework keeps its
  // own signing identifier, so library validation sees them as
  // normal dylibs loaded by the main binary rather than duplicate
  // main binaries.

  // Dynamically import @electron/osx-sign so a missing dep gives a
  // clear error message instead of a cryptic MODULE_NOT_FOUND at
  // afterPack time.
  let osxSign;
  try {
    osxSign = require("@electron/osx-sign");
  } catch (e) {
    throw new Error(
      "afterPack: @electron/osx-sign is required for macOS signing. " +
        "Run `npm --prefix desktop install` to install it. " +
        `Underlying error: ${e && e.message ? e.message : String(e)}`,
    );
  }
  const signApp = osxSign.signAsync || osxSign.sign;
  if (typeof signApp !== "function") {
    throw new Error(
      "afterPack: @electron/osx-sign does not expose signAsync/sign — " +
        "incompatible version installed.",
    );
  }

  await signApp({
    app: appPath,
    identity,
    identityValidation: false,
    platform: "darwin",
    type: "distribution",
    hardenedRuntime: true,
    preAutoEntitlements: false,
    // Per-file entitlements hook.
    //
    // Top-level .app bundle gets the full entitlements
    // (microphone, Apple Events, network client + disable-
    // library-validation).
    //
    // Every helper (.app) and framework/dylib gets the INHERIT
    // entitlements (allow-jit, allow-unsigned-executable-memory,
    // audio-input, disable-library-validation).
    //
    // Why force our own entitlements on every nested item instead
    // of letting osx-sign use its bundled defaults:
    //
    //   The default osx-sign templates (default.darwin.renderer.
    //   plist, default.darwin.gpu.plist, default.darwin.plugin.
    //   plist) do NOT contain disable-library-validation. Under
    //   hardened runtime with a self-signed certificate that has
    //   no Team ID, the helpers fail to load Electron Framework
    //   via dyld4 library validation and crash at launch — the
    //   exact "different Team IDs" crash we hit with a raw
    //   codesign --deep pass. Passing our inherit plist
    //   explicitly guarantees the entitlement lands on every
    //   helper that might independently load the framework.
    optionsForFile: (filePath) => {
      if (filePath === appPath) {
        return {
          entitlements,
          hardenedRuntime: true,
        };
      }
      return {
        entitlements: inheritEntitlements,
        hardenedRuntime: true,
      };
    },
  });

  // Verify the finished signature. ``--strict`` catches any resource
  // envelope drift, ``--deep`` walks all nested items. On failure
  // this throws and aborts the build.
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" },
  );

  // Dump the top-level signature identity + authority + runtime flags
  // so the build log shows exactly how the app was signed.
  try {
    execFileSync(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", appPath],
      { stdio: "inherit" },
    );
  } catch {
    // Informational only; do not fail on it.
  }

  // Also print the Electron Framework's identifier — if library
  // validation fails at launch, this is the first thing to check.
  const electronFw = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  if (existsSync(electronFw)) {
    try {
      execFileSync(
        "/usr/bin/codesign",
        ["-dv", "--verbose=2", electronFw],
        { stdio: "inherit" },
      );
    } catch {
      // Informational only.
    }
  }

  console.log(`[afterPack] Signed ${appName}.app OK`);
};
