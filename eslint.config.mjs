import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { "react-hooks": reactHooks }, rules: { ...reactHooks.configs.recommended.rules, "react-hooks/set-state-in-effect": "off" } },
  { plugins: { "@next/next": nextPlugin }, rules: nextPlugin.configs.recommended.rules },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // fraud-eval/ is a standalone Node script, not application code: it is run
  // with `node fraud-eval/run.mjs`, never bundled. Without this it is linted
  // against the browser globals the rest of the config assumes, and every
  // `console` and `process` reads as undefined. Declared rather than ignored,
  // so the script is still checked for real mistakes.
  {
    files: ["fraud-eval/**/*.mjs"],
    languageOptions: {
      globals: {
        // Node, where the script itself runs.
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        // Browser, inside the page.evaluate() callback. That function is
        // serialised and executed in Chromium, so these ARE defined where they
        // are used -- eslint simply cannot see the boundary.
        atob: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        File: "readonly",
      },
    },
  },
  { ignores: [".next/", "out/", "node_modules/", "src/components/ui/", "src/components/magicui/"] }
);
