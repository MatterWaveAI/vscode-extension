import * as vscode from "vscode";

/**
 * Picking one workspace file: a QuickPick that searches the whole
 * workspace as the person types, rather than a list cut at a fixed count.
 * Every keystroke (after a short pause) asks the editor's file search for
 * the paths that hold what was typed, so a file is reachable in a
 * workspace of any size; the picker's own fuzzy filter then ranks what
 * came back.
 */

/** Build output and vendored code: never offered. */
export const EXCLUDED = "**/{.git,node_modules,dist,out,build}/**";

/** How many paths one search shows; typing more narrows it. */
export const SEARCH_RESULTS = 200;

/**
 * The glob for a typed query: paths whose file name holds it, or under a
 * directory whose name holds it -- either case, either separator, glob
 * syntax in the query taken literally. Null for an empty query.
 */
export function fileSearchGlob(query: string): string | null {
  const text = query.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!text) return null;
  let pattern = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower !== upper) pattern += `[${lower}${upper}]`;
    else if ("[]{}*?!,".includes(char)) pattern += `[${char}]`;
    else pattern += char;
  }
  return `{**/*${pattern}*,**/*${pattern}*/**}`;
}

/** The workspace files a query finds, at most `SEARCH_RESULTS`, ordered by path. */
export async function searchWorkspaceFiles(query: string, token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const glob = fileSearchGlob(query) ?? "**/*";
  const found = await vscode.workspace.findFiles(glob, EXCLUDED, SEARCH_RESULTS, token);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

type FileItem = vscode.QuickPickItem & { uri: vscode.Uri };

/**
 * One workspace file out of a QuickPick that searches as the person types;
 * null when they back out. `describe` names a file in the list.
 */
export function pickWorkspaceFile(title: string, describe: (uri: vscode.Uri) => string): Promise<vscode.Uri | null> {
  const pick = vscode.window.createQuickPick<FileItem>();
  pick.title = title;
  pick.placeholder = "Type to search every file in the workspace";
  pick.matchOnDescription = true;
  let search: vscode.CancellationTokenSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (query: string) => {
    search?.cancel();
    const current = new vscode.CancellationTokenSource();
    search = current;
    pick.busy = true;
    searchWorkspaceFiles(query, current.token).then(
      (uris) => {
        if (search !== current) return;
        pick.items = uris.map((uri) => ({ uri, label: describe(uri) }));
        pick.busy = false;
      },
      () => {
        if (search === current) pick.busy = false;
      },
    );
  };
  return new Promise((resolve) => {
    let settled = false;
    const done = (uri: vscode.Uri | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      search?.cancel();
      resolve(uri);
      pick.dispose();
    };
    pick.onDidChangeValue((value) => {
      clearTimeout(timer);
      timer = setTimeout(() => run(value), 150);
    });
    pick.onDidAccept(() => done(pick.selectedItems[0]?.uri ?? null));
    pick.onDidHide(() => done(null));
    run("");
    pick.show();
  });
}
