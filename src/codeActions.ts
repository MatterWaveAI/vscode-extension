import * as vscode from "vscode";

/**
 * MatterWave in the lightbulb: Fix for each problem under the cursor, and
 * Explain, Generate Tests and Add Docs for a selection. Each action only
 * names a command and its arguments; the commands do the work -- Fix and
 * Add Docs through the reviewed diff inline edit uses, Explain and Generate
 * Tests as a question in the chat, whose code blocks Apply can then land.
 */

export const CODE_ACTION_COMMANDS = {
  fix: "matterwave.fixProblem",
  explain: "matterwave.explainCode",
  tests: "matterwave.generateTests",
  docs: "matterwave.addDocs",
} as const;

/** How many of the problems under the cursor get their own Fix. */
const MAX_FIXES = 3;

export const EXPLAIN_QUESTION = "Explain this code.";
export const TESTS_QUESTION =
  "Write unit tests for this code with the test framework this project already uses. Put each test file in its own fenced code block, with the file's path after the language.";
export const DOCS_INSTRUCTION =
  "Add documentation comments, in this language's usual style, to what is declared here. Change no code.";

/** What the model is asked to do about one problem: its message, and the tool and code that reported it. */
export function fixInstruction(problem: { message: string; source?: string; code?: unknown }): string {
  const code = typeof problem.code === "object" && problem.code !== null ? (problem.code as { value?: unknown }).value : problem.code;
  const reporter = [problem.source, code === undefined || code === null || code === "" ? null : String(code)].filter(Boolean).join(" ");
  return `Fix this problem${reporter ? ` (${reporter})` : ""}: ${problem.message.trim().replace(/[.\s]+$/, "")}. Change only what the fix needs.`;
}

/** A problem's message as an action's title: its first line, cut short. */
function short(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export class MatterWaveCodeActions implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const problem of context.diagnostics.slice(0, MAX_FIXES)) {
      const action = new vscode.CodeAction(`Fix with MatterWave: ${short(problem.message)}`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [problem];
      action.command = {
        command: CODE_ACTION_COMMANDS.fix,
        title: "Fix with MatterWave",
        arguments: [document.uri, problem.range, fixInstruction(problem)],
      };
      actions.push(action);
    }
    if (!range.isEmpty) {
      const kind = vscode.CodeActionKind.Refactor.append("matterwave");
      const about = (title: string, command: string) => {
        const action = new vscode.CodeAction(title, kind);
        action.command = { command, title, arguments: [document.uri, range] };
        return action;
      };
      actions.push(
        about("Explain with MatterWave", CODE_ACTION_COMMANDS.explain),
        about("Generate Tests with MatterWave", CODE_ACTION_COMMANDS.tests),
        about("Add Docs with MatterWave", CODE_ACTION_COMMANDS.docs),
      );
    }
    return actions;
  }
}
