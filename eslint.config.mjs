// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["out/", "dist/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Type-aware rules: a promise dropped on the floor in extension code is a silent failure.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false, attributes: false } }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // node:test's describe() and it() return promises by design.
    files: ["src/test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    rules: {
      curly: "error",
      eqeqeq: ["error", "smart"],
    },
  }
);
