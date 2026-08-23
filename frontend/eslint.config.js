// @ts-check
// Flat-config ESLint for the frontend (introduced from chiliec's PR #4
// proposal, regenerated on top of the current lockfile).
//
// Ratchet policy: rules that already pass at "error" stay there; rules
// with pre-existing findings start at "warn" so `npm run lint` is green
// from day one and every future cleanup can tighten one setting.
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
      // marker already used across the codebase (e.g. `_reason`, `_td`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Empty catch blocks are used deliberately to swallow best-effort
      // errors (71 sites; see BUGS_AUDIT BUG-10 policy — each must carry a
      // reason comment in new code).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Control chars in a regex are intentional here (input sanitization
      // that strips \x00-\x1f / \x7f).
      "no-control-regex": "off",
      // Baseline was cleaned to zero findings on introduction; these
      // are errors now. Keep the ratchet: never add a rule below "error"
      // once the tree is green under it.
      "no-useless-escape": "error",
      "prefer-const": "error",
    },
  },
);
