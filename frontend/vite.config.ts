import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Read the SSOT version from package.json at build time. The Settings
// tab's version badge previously hardcoded "1.1.1" in index.html and
// drifted forever after every release bump (we shipped through 1.1.11
// before noticing). Now ``__APP_VERSION__`` is injected as a string
// literal at compile time, the renderer rewrites the badge from this
// constant on boot, and the only place to bump the displayed version
// is frontend/package.json (which release notes already require to
// match desktop/package.json).
const PKG_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return String(pkg.version || "0.0.0");
})();

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(PKG_VERSION),
  },
});
