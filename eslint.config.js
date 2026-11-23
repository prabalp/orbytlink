import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      "node_modules/**",
      ".data/**",
      "playwright-report/**",
      "test-results/**",
      "v0/**",
      "migration/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly", Buffer: "readonly", URL: "readonly" } },
  },
  {
    // The browser extension runs in Chrome, not in Node.
    files: ["extension/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries(["chrome", "document", "window", "location", "navigator", "crypto", "console", "setTimeout", "clearTimeout", "setInterval", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "btoa", "atob", "fetch", "AbortSignal", "Event", "KeyboardEvent", "MouseEvent", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Element", "getComputedStyle", "innerHeight", "scrollY"].map((n) => [n, "readonly"])),
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
