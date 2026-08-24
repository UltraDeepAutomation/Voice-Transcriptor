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
const PKG_VERSION: string = (() => {
  const pkgPath = resolve(DESKTOP_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return String(pkg.version || "0.0.0");
})();

// Update-check coordinates, derived from the SAME manifest that owns the
// version — repository.url is the single source of truth for where
// releases live, so a repo move updates the checker without a second
// edit. Parsed down to a bare "owner/repo" slug for the GitHub API.
const APP_UPDATE_META: { version: string; repoSlug: string } = (() => {
  const pkgPath = resolve(DESKTOP_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const url: string = String(pkg.repository?.url || "");
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
    // Electron ships Chromium; keep CSS output aligned with that runtime
    // so production builds preserve unprefixed properties like backdrop-filter.
    cssTarget: "chrome142",
    cssMinify: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify(PKG_VERSION),
    __APP_UPDATE_META__: JSON.stringify(APP_UPDATE_META),
    __SHORTCUT_DEFAULTS__: JSON.stringify(SHORTCUT_DEFAULTS),
  },
});
