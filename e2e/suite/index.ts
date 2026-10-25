import * as path from "node:path";
import Mocha from "mocha/lib/mocha.cjs";

/**
 * The entry the editor calls (`--extensionTestsPath`): mocha over the suite
 * beside it, both bundled by e2e/run.mjs. A real model answers one turn
 * here, on whatever the deployment runs it on, so the timeout is minutes.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", reporter: "spec", color: true, timeout: 5 * 60_000 });
  mocha.addFile(path.join(__dirname, "chat.test.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
