// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["out/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      curly: "error",
      eqeqeq: ["error", "smart"],
    },
  }
);
