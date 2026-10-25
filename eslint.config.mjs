// The same base as web/eslint.config.js -- @eslint/js recommended plus
// typescript-eslint recommended -- without the React plugins, which have
// nothing to check here. The extension host is Node and the webview script is
// a browser bundle, so both global sets are allowed and the bundler decides.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config([
  { ignores: ["dist", "node_modules", ".vscode-test", "*.vsix"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
  },
]);
