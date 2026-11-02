import * as path from "node:path";
import Mocha from "mocha/lib/mocha.cjs";

/**
 * The entry the editor calls (`--extensionTestsPath`): mocha over one of the
 * suites beside it, all bundled by e2e/run.mjs, chosen by `E2E_SUITE`.
 * `editor` is the editor's own behaviour (edits, undo, files, folders),
 * which needs no deployment; `agent` is the coding agent against a scripted
 * /v1 the suite serves itself; `deployment` has a real model answer one
 * turn, on whatever the deployment runs it on, so the timeout is minutes.
 */
const SUITES: Record<string, string[]> = {
  editor: ["editor.test.js"],
  agent: ["agent.test.js"],
  deployment: ["chat.test.js"],
};

export function run(): Promise<void> {
  const files = SUITES[process.env.E2E_SUITE ?? ""];
  if (!files) return Promise.reject(new Error(`E2E_SUITE must be one of ${Object.keys(SUITES).join(", ")}`));
  const mocha = new Mocha({ ui: "bdd", reporter: "spec", color: true, timeout: 5 * 60_000 });
  for (const file of files) mocha.addFile(path.join(__dirname, file));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
