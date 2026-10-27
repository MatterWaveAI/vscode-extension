import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `vscode` only exists inside the editor's extension host. Aliasing it to a
// small hand-written mock keeps the unit tests runnable anywhere, without
// downloading an editor build the way @vscode/test-electron would. The SDK
// is vendored at src/lib/matterwaveClient.ts and imported by its path.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode-mock.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
