import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // The type gate for tests is ``npm run typecheck`` (``tsc --noEmit``):
    // ``tsconfig.json`` now includes ``tests``, so a test that no longer
    // matches its subject's signature fails the same command AGENTS.md
    // already requires before every commit. This block stays so
    // ``vitest --typecheck`` (for ``*.test-d.ts`` type assertions) resolves
    // the same project rather than a default one.
    typecheck: {
      tsconfig: "./tsconfig.json",
    },
  },
});
