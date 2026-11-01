import * as vscode from "vscode";

/**
 * What ran in the editor's terminals, and what it printed.
 *
 * VS Code gives an extension no read of a terminal's buffer. What it does
 * give, through shell integration, is each command as it runs: its command
 * line, its working directory, its output as a stream and its exit code.
 * `TerminalHistory` listens from activation and keeps the last few
 * commands of every terminal (output capped, escape sequences stripped),
 * which is what @terminal attaches and what the terminal's Explain and Fix
 * commands are about.
 *
 * A terminal without shell integration (an unsupported shell, or output
 * from before the extension started) has no history; `copyTerminalText`
 * reads it the one other way there is -- select all, copy, and put the
 * clipboard back as it was.
 */

export interface CommandRecord {
  command: string;
  cwd: string | null;
  output: string;
  /** Undefined while the command runs, or when the shell did not report one. */
  exitCode: number | undefined;
  done: boolean;
}

/** Commands kept per terminal, and the output kept per command (its tail). */
export const COMMANDS_PER_TERMINAL = 10;
export const OUTPUT_CHARS = 50_000;

/** CSI and OSC escape sequences, and the lone control characters a shell writes around them. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Terminal output as text: escape sequences gone, carriage-return redraws resolved to their last state. */
export function plainText(raw: string): string {
  return raw
    .replace(ESCAPES, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Keep the end of `text` within `max`, saying so where it was cut. */
export function tail(text: string, max = OUTPUT_CHARS): string {
  return text.length <= max ? text : `… (earlier output cut)\n${text.slice(text.length - max)}`;
}

/** One command as a model reads it: the prompt line, then its output and how it ended. */
export function describeCommand(record: CommandRecord): string {
  const status = !record.done
    ? "still running"
    : record.exitCode === undefined
      ? "exit code not reported"
      : `exit code ${record.exitCode}`;
  const where = record.cwd ? ` (in ${record.cwd})` : "";
  return `$ ${record.command}${where}\n${record.output.trimEnd()}\n[${status}]`;
}

export class TerminalHistory implements vscode.Disposable {
  private readonly records = new Map<vscode.Terminal, CommandRecord[]>();
  private readonly running = new Map<vscode.TerminalShellExecution, CommandRecord>();
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      vscode.window.onDidStartTerminalShellExecution((event) => void this.capture(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const record = this.running.get(event.execution);
        if (!record) return;
        record.exitCode = event.exitCode;
        record.done = true;
        this.running.delete(event.execution);
      }),
      vscode.window.onDidCloseTerminal((terminal) => this.records.delete(terminal)),
    ];
  }

  /** The terminal's recent commands, oldest first. */
  commands(terminal: vscode.Terminal): readonly CommandRecord[] {
    return this.records.get(terminal) ?? [];
  }

  /** The terminal's last finished command, or the one running when none has finished. */
  last(terminal: vscode.Terminal): CommandRecord | undefined {
    const rows = this.commands(terminal);
    return [...rows].reverse().find((r) => r.done) ?? rows.at(-1);
  }

  private async capture(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    const record: CommandRecord = {
      command: event.execution.commandLine.value.trim(),
      cwd: event.execution.cwd?.fsPath ?? null,
      output: "",
      exitCode: undefined,
      done: false,
    };
    const rows = this.records.get(event.terminal) ?? [];
    rows.push(record);
    this.records.set(event.terminal, rows.slice(-COMMANDS_PER_TERMINAL));
    this.running.set(event.execution, record);
    let raw = "";
    try {
      for await (const data of event.execution.read()) {
        raw = (raw + data).slice(-OUTPUT_CHARS * 2);
        record.output = tail(plainText(raw));
      }
    } catch {
      // A stream that breaks keeps what it carried.
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.records.clear();
    this.running.clear();
  }
}

/** The text of a terminal's whole buffer, by select-all and copy; null when nothing came of it. */
export async function copyTerminalText(terminal: vscode.Terminal): Promise<string | null> {
  const saved = await vscode.env.clipboard.readText();
  try {
    // The terminal commands act on the active terminal.
    terminal.show(true);
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("workbench.action.terminal.selectAll");
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    await vscode.commands.executeCommand("workbench.action.terminal.clearSelection");
    const text = await vscode.env.clipboard.readText();
    return text.trim() ? tail(plainText(text)) : null;
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
}

/**
 * What @terminal attaches for a terminal: its recent commands with their
 * output when shell integration saw them, else its copied buffer; null
 * when neither has anything.
 */
export async function terminalText(history: TerminalHistory, terminal: vscode.Terminal): Promise<string | null> {
  const commands = history.commands(terminal);
  if (commands.length > 0) return commands.map(describeCommand).join("\n\n");
  return copyTerminalText(terminal);
}
