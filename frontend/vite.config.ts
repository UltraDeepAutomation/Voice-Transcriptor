import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, "../desktop");

// 1.1.25: read the version from desktop/package.json — the SINGLE
// source of truth for the shipped artifact's version. electron-builder
// uses ``desktop/package.json`` for the DMG title, NSIS installer
// filename, and CFBundleShortVersionString; BUILD.command,
// INSTALL.command, and desktop/package.json scripts all read the same
// manifest. Previously ``vite.config.ts`` read frontend/package.json,
// so the maintainer had to bump TWO files in lock-
// step every release — the exact drift the SSOT comment in 1.1.13
// claimed to prevent.
//
// Reading the desktop manifest from inside the frontend's vite
// build is OK at build time: the file is always present in the
// repo at the parent's sibling, and is part of the release
// pipeline. ``frontend/package.json`` is package metadata only, not
// the shipped application version SSOT.
const DESKTOP_MANIFEST = JSON.parse(
  readFileSync(resolve(DESKTOP_DIR, "package.json"), "utf8"),
) as { version?: string; repository?: { url?: string } };

const PKG_VERSION: string = String(DESKTOP_MANIFEST.version || "0.0.0");

// Update-check coordinates, derived from the SAME manifest that owns the
// version — repository.url is the single source of truth for where
// releases live, so a repo move updates the checker without a second
// edit. Parsed down to a bare "owner/repo" slug for the GitHub API.
const APP_UPDATE_META: { version: string; repoSlug: string } = (() => {
  const url: string = String(DESKTOP_MANIFEST.repository?.url || "");
  // github.com/<owner>/<repo>(.git), tolerating scheme/case variants.
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.?#]+?)(?:\.git)?\/?$/i);
  return {
    version: PKG_VERSION,
    repoSlug: m ? `${m[1]}/${m[2]}` : "",
  };
})();

const SHORTCUT_DEFAULTS = (() => {
  const defaultsPath = resolve(DESKTOP_DIR, "shortcut-defaults.json");
  return JSON.parse(readFileSync(defaultsPath, "utf8"));
})();

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Never inline an AudioWorklet module.
    //
    // Vite inlines any asset under 4 KB as a `data:` URL. `pcm-worklet.js`
    // is 2.3 KB, so every production build emitted the PCM capture
    // processor as `data:text/javascript;base64,…` — and the page CSP is
    // `script-src 'self' 'unsafe-inline'`, which quite correctly refuses
    // to load a script from a `data:` URL.
    //
    // `audioWorklet.addModule()` therefore rejected on EVERY recording,
    // and the catch fell back to ScriptProcessor: the deprecated API that
    // runs capture on the main thread and drops frames under load, rather
    // than on a dedicated realtime audio thread. Silent, permanent
    // capture-quality loss on every single take. Measured after the
    // renderer console mirror was repaired: 5 fallbacks in 5 capture
    // attempts, i.e. 100 %.
    //
    // The CSP is not the thing to relax — `script-src data:` is a
    // standard XSS vector, and the policy was refusing an artifact the
    // build should never have produced. Emitting the worklet as a real
    // file, served from 'self' like every other script, is the fix.
    //
    // The callback form is deliberately narrow: it returns false only for
    // worklets, so every other asset keeps Vite's default sizing rule.
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith("-worklet.js") || filePath.endsWith("pcm-worklet.js")
        ? false
        : undefined,
    // Electron ships Chromium; keep CSS output aligned with that runtime
    // so production builds preserve unprefixed properties like backdrop-filter.
    cssTarget: "chrome142",
    // CSS ships unminified deliberately. This is a desktop app: the
    // stylesheet is read from disk by the local backend, never over a
    // network, so the ~60 KB minification would save costs nothing to
    // keep — and it buys the one thing that matters when a rendering
    // bug is reported from a packaged build, which is that the shipped
    // stylesheet can be read and matched against src/styles.css line
    // for line. Arrived unexplained with the Liquid Glass surface
    // system (bd6ba23); stated here rather than left as a bare flag.
    cssMinify: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify(PKG_VERSION),
    __APP_UPDATE_META__: JSON.stringify(APP_UPDATE_META),
    __SHORTCUT_DEFAULTS__: JSON.stringify(SHORTCUT_DEFAULTS),
  },
});
