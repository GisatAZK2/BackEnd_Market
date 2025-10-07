// eslint.config.cjs
const js = require("@eslint/js");
const globals = require("globals");
const { defineConfig } = require("eslint/config");

module.exports = defineConfig([
  {
    files: ["**/*.{js,cjs,mjs}"],
    ignores: ["node_modules/**", "dist/**", "uploads/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    extends: [js.configs.recommended],
  },
]);
