import { afterEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import {
  COMMANDS_PER_TERMINAL,
  copyTerminalText,
  describeCommand,
  plainText,
  proposedCommand,
  tail,
  terminalCommandPrompt,
  TerminalHistory,
  terminalText,
} from "../src/terminalOutput";
import { commands, env, window } from "./vscode-mock";

/** A shell-integration execution whose output arrives in `chunks`, then ends. */
function execution(command: string, chunks: string[]) {
  let release: () => void = () => {};
  const finished = new Promise<void>((resolve) => (release = resolve));
  return {
    execution: {
      commandLine: { value: command },
      cwd: { fsPath: "/ws" },
      async *read() {
        for (const chunk of chunks) yield chunk;
        release();
      },
    },
    finished,
  };
}

const terminal = { name: "bash", show() {} } as unknown as vscode.Terminal;

afterEach(() => {
  commands.effects.clear();
  commands.executed.length = 0;
  env.clipboard.text = "";
});

describe("plainText", () => {
  it("drops colour, cursor and title sequences", () => {
    expect(plainText("\u001b[31merror\u001b[0m: \u001b]0;title\u0007bad\u001b[2K")).toBe("error: bad");
    expect(plainText("\u001b]633;C\u001b\\out")).toBe("out");
  });

  it("keeps the last state of a line redrawn with carriage returns", () => {
    expect(plainText("10%\r50%\r100%\r\ndone\r\n")).toBe("100%\ndone\n");
  });
});

describe("tail and describeCommand", () => {
  it("keeps the end of long output, saying it was cut", () => {
    expect(tail("abcdef", 3)).toBe("… (earlier output cut)\ndef");
    expect(tail("abc", 3)).toBe("abc");
  });

  it("writes a command as a prompt line, its output, and how it ended", () => {
    const text = describeCommand({ command: "npm test", cwd: "/ws", output: "1 failing\n", exitCode: 1, done: true });
    expect(text).toBe("$ npm test (in /ws)\n1 failing\n[exit code 1]");
    expect(describeCommand({ command: "sleep 9", cwd: null, output: "", exitCode: undefined, done: false })).toContain("[still running]");
  });
});

describe("TerminalHistory", () => {
  it("keeps each command's output and exit code as shell integration reports them", async () => {
    const history = new TerminalHistory();
    const run = execution("npm test", ["\u001b[32mok\u001b[0m 3\n", "\u001b[31mnot ok\u001b[0m 1\n"]);
    window.fire("start", { terminal, execution: run.execution });
    await run.finished;
    window.fire("end", { terminal, execution: run.execution, exitCode: 1 });

    expect(history.last(terminal)).toEqual({ command: "npm test", cwd: "/ws", output: "ok 3\nnot ok 1\n", exitCode: 1, done: true });
    history.dispose();
  });

  it("keeps only the recent commands, and forgets a closed terminal", async () => {
    const history = new TerminalHistory();
    for (let i = 0; i < COMMANDS_PER_TERMINAL + 3; i++) {
      const run = execution(`echo ${i}`, [`${i}\n`]);
      window.fire("start", { terminal, execution: run.execution });
      await run.finished;
      window.fire("end", { terminal, execution: run.execution, exitCode: 0 });
    }
    expect(history.commands(terminal)).toHaveLength(COMMANDS_PER_TERMINAL);
    expect(history.commands(terminal)[0]?.command).toBe("echo 3");
    window.fire("close", terminal);
    expect(history.commands(terminal)).toEqual([]);
    history.dispose();
  });

  it("stops listening once disposed", () => {
    const history = new TerminalHistory();
    history.dispose();
    expect(window.terminalListeners.start).toHaveLength(0);
  });
});

describe("terminalText", () => {
  it("attaches the recent commands when shell integration saw them", async () => {
    const history = new TerminalHistory();
    const run = execution("ls", ["a.ts\n"]);
    window.fire("start", { terminal, execution: run.execution });
    await run.finished;
    window.fire("end", { terminal, execution: run.execution, exitCode: 0 });
    expect(await terminalText(history, terminal)).toBe("$ ls (in /ws)\na.ts\n[exit code 0]");
    expect(commands.executed).toEqual([]);
    history.dispose();
  });

  it("copies the buffer when there is no history, and puts the clipboard back", async () => {
    const history = new TerminalHistory();
    env.clipboard.text = "what the person had copied";
    commands.effects.set("workbench.action.terminal.copySelection", () => {
      env.clipboard.text = "\u001b[1m$ make\u001b[0m\nbuilt\n";
    });
    expect(await terminalText(history, terminal)).toBe("$ make\nbuilt\n");
    expect(commands.executed).toEqual([
      "workbench.action.terminal.selectAll",
      "workbench.action.terminal.copySelection",
      "workbench.action.terminal.clearSelection",
    ]);
    expect(env.clipboard.text).toBe("what the person had copied");
    history.dispose();
  });

  it("is null when the copy came back empty", async () => {
    env.clipboard.text = "kept";
    expect(await copyTerminalText(terminal)).toBeNull();
    expect(env.clipboard.text).toBe("kept");
  });
});

describe("terminalCommandPrompt and proposedCommand", () => {
  const failed = { command: "npm tset", cwd: "/ws", output: "npm error Unknown command: \"tset\"\n", exitCode: 1, done: true };

  it("asks for an explanation with the command, its output and its exit code fenced", () => {
    const prompt = terminalCommandPrompt("explain", "bash", failed);
    expect(prompt).toMatch(/^Explain what this terminal command did/);
    expect(prompt).toContain("From the terminal “bash”:");
    expect(prompt).toContain('```console\n$ npm tset (in /ws)\nnpm error Unknown command: "tset"\n[exit code 1]\n```');
  });

  it("asks a fix for one fenced command, and fences output that holds backticks with a longer fence", () => {
    const prompt = terminalCommandPrompt("fix", "zsh", { ...failed, output: "```weird```\n" });
    expect(prompt).toMatch(/^This terminal command did not do what was meant\. Answer with the corrected command in one fenced code block/);
    expect(prompt).toContain("````console\n");
  });

  it("takes the one proposed command, dropping an echoed prompt sign", () => {
    expect(proposedCommand("Use this:\n\n```sh\n$ npm test\n```\n\nYou swapped two letters.")).toBe("npm test");
    expect(proposedCommand("```\nnpm run build\n```")).toBe("npm run build");
  });

  it("proposes nothing when the answer has no command or several", () => {
    expect(proposedCommand("Just retry it.")).toBeNull();
    expect(proposedCommand("```sh\na\n```\nor\n```sh\nb\n```")).toBeNull();
  });
});
