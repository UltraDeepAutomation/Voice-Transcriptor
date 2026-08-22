// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output, deps, and the raw AudioWorklet processor are not linted.
    ignores: ["dist", "node_modules", "src/pcm-worklet.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
    },
    rules: {
      // Underscore-prefixed args/vars are an intentional "unused on purpose"
      // marker already used across the codebase (e.g. `_reason`, `_stageTimer`).
      // The rule is a warning for now so `npm run lint` stays green while linting
      // is introduced; there is one genuinely-unused variable (`captureRmsAccum`
      // in main.tsx) worth cleaning up separately. Ratchet to "error" afterward.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Empty catch blocks are used deliberately to swallow best-effort errors.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Control chars in a regex are intentional here (input sanitization that
      // strips \x00-\x1f / \x7f).
      "no-control-regex": "off",
      // The remaining findings on the existing code are surfaced as warnings so
      // `npm run lint` stays green while introducing linting. Ratchet these up
      // to "error" as the code is cleaned up.
      "no-useless-escape": "warn",
      "prefer-const": "warn",
    },
  },
);
