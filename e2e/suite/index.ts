import * as path from "node:path";
import Mocha from "mocha/lib/mocha.cjs";

/**
 * The entry the editor calls (`--extensionTestsPath`): mocha over one suite
 * beside it, both bundled by e2e/run.mjs. `E2E_SUITE` picks it: `agent`
 * (the coding agent against a scripted /v1 the suite serves itself) or
 * `deployment` (a real model answers one turn, on whatever the deployment
 * runs it on, so the timeout is minutes).
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", reporter: "spec", color: true, timeout: 5 * 60_000 });
  mocha.addFile(path.join(__dirname, process.env.E2E_SUITE === "agent" ? "agent.test.js" : "chat.test.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
