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
const {
  existsSync, readdirSync, lstatSync, openSync, readSync, closeSync,
} = require("node:fs");
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

  // STEP 1 — sign bundled runtime binaries BEFORE @electron/osx-sign
  // walks the app. If we sign them after, the Resources envelope
  // (_CodeSignature/CodeResources) computed by osx-sign captures
  // hashes of the still-unsigned files, and the later signing
  // invalidates those hashes → verify --deep --strict fails.
  // Signing first means osx-sign's envelope hashes the final signed
  // bytes of every runtime file.
  const runtimeRoot = path.join(appPath, "Contents", "Resources", "runtime");
  if (existsSync(runtimeRoot)) {
    console.log(`[afterPack] Pre-signing bundled runtime binaries under ${runtimeRoot}`);
    let signedCount = 0;
    let execCount = 0;
    let dylibCount = 0;

    // Read first 16 bytes to detect Mach-O filetype.
    //   magic (u32) + cputype (u32) + cpusubtype (u32) + filetype (u32)
    //   MH_EXECUTE = 2, MH_DYLIB = 6, MH_BUNDLE = 8
    // codesign REJECTS --entitlements / --options runtime on MH_DYLIB /
    // MH_BUNDLE. Passing them to a plain .so silently fails ("invalid
    // format for a code signature"), leaving the file unsigned and the
    // site-packages extension unloadable under hardened runtime.
    const classifyMacho = (filePath) => {
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
        // Thin Mach-O: both 64-bit (feedfacf) and 32-bit (feedface).
        // filetype at offset 12: MH_EXECUTE=2, MH_DYLIB=6, MH_BUNDLE=8
        if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
          const filetype = buf.readUInt32LE(12);
          if (filetype === 2) return "executable";
          if (filetype === 6 || filetype === 8) return "dylib";
          return "macho-other";
        }
        // Fat Mach-O: magic is BE (cafebabe / cafebabf). Read one
        // nested arch's thin header to determine the REAL filetype.
        // Prior code assumed fat = executable; that sent runtime
        // hardening + entitlements into fat DYLIBS (onnxruntime,
        // cryptography _rust, numpy libgcc_s) where neither has
        // any effect and where a future macOS codesign hardening
        // could reject the combination.
        if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
          const fatHdr = Buffer.alloc(24); // magic(4)+nfat(4)+first fat_arch(16)
          if (readSync(fd, fatHdr, 0, 24, 0) < 24) return "macho-other";
          const firstOff = fatHdr.readUInt32BE(16);
          const thinHdr = Buffer.alloc(16);
          if (readSync(fd, thinHdr, 0, 16, firstOff) < 16) return "macho-other";
          const thinMagic = thinHdr.readUInt32LE(0);
          if (thinMagic !== 0xfeedfacf && thinMagic !== 0xfeedface) {
            return "macho-other";
          }
          const filetype = thinHdr.readUInt32LE(12);
          if (filetype === 2) return "executable";
          if (filetype === 6 || filetype === 8) return "dylib";
          return "macho-other";
        }
        return "non-macho";
      } finally {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    };

    const signOne = (filePath, kind) => {
      // Executables get hardened-runtime + entitlements.
      // Dylibs / bundles get a bare signature (entitlements aren't valid
      // on shared libraries and codesign errors out when passed here).
      const args = ["--force", "--sign", identity, "--timestamp=none"];
      if (kind === "executable") {
        args.push("--options", "runtime", "--entitlements", inheritEntitlements);
        execCount += 1;
      } else {
        dylibCount += 1;
      }
      args.push(filePath);
      try {
        execFileSync("/usr/bin/codesign", args,
          { stdio: ["ignore", "ignore", "pipe"] });
        signedCount += 1;
      } catch (e) {
        const stderr = e && e.stderr ? e.stderr.toString() : "";
        // HARD FAIL. A silently-unsigned .dylib under hardened runtime
        // crashes the Python interpreter at first `import` with "code
        // signature in ... not valid for use in process" — better to
        // abort the build here than ship a broken DMG.
        throw new Error(
          `afterPack: codesign failed for ${filePath}\n${stderr || (e.message || e)}`
        );
      }
    };

    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = path.join(dir, name);
        let st;
        // lstat, NOT stat — statSync follows symlinks so
        // isSymbolicLink() would be permanently false and we'd sign
        // the same target twice via different names, corrupting the
        // resource envelope.
        try { st = lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walk(full); continue; }
        if (!st.isFile()) continue;
        const kind = classifyMacho(full);
        if (kind === "non-macho" || kind === "macho-other") continue;
        signOne(full, kind);
      }
    };

    walk(runtimeRoot);
    console.log(
      `[afterPack] Pre-signed ${signedCount} runtime binaries ` +
      `(${execCount} executables + ${dylibCount} dylibs/bundles)`
    );
  }

  // STEP 2 — main @electron/osx-sign pass (bundle walk + envelope).
  //
  // Disable Apple's RFC3161 timestamp service. The default
  // @electron/osx-sign behaviour is ``--timestamp`` (no URL), which
  // queries ``timestamp.apple.com``. When that service is
  // unreachable (intermittent Apple outages, corporate firewalls,
  // offline builds) codesign hard-fails with "The timestamp service
  // is not available" and the whole build aborts. For a self-signed
  // certificate like ``AntigravityTelegramDev`` — used exclusively
  // for local TCC-grant persistence, not for distribution that
  // Gatekeeper will validate — the timestamp is not meaningful
  // (Gatekeeper skips it for non-Developer-ID identities anyway).
  // Passing ``"none"`` in the per-file options sends
  // ``--timestamp=none`` to codesign, making every build robust
  // against Apple TS outages. osx-sign@1.0.5 only consumes
  // ``timestamp`` from the per-file options returned by
  // ``optionsForFile``; passing it at the top level is silently
  // ignored (see node_modules/@electron/osx-sign/dist/esm/sign.js
  // line 163 — top-level opts are merged against the tool's built-in
  // defaultOptionsForFile, NOT our custom hook's return value).
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
          timestamp: "none",
        };
      }
      return {
        entitlements: inheritEntitlements,
        hardenedRuntime: true,
        timestamp: "none",
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
