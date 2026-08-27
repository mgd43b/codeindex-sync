// Flat config. Deliberately small: a linter that argues about style costs more
// contributor goodwill than it saves. These rules catch bugs, not opinions —
// formatting is left alone.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
    rules: {
      // Unused vars are usually a mistake; "_" prefix opts out deliberately.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Empty catch is load-bearing here: several paths deliberately swallow
      // errors (logging must never throw, git may fail normally). Require a
      // comment so each one is a decision rather than an oversight.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // Tests construct deliberately malformed input; strictness there is noise.
    files: ["test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
