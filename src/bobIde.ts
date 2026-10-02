import { MCP_SERVER_NAME, jsonMcpEntry, mergeJsonMcpServers } from "./agentFiles";

export { MCP_SERVER_NAME };

/**
 * IBM Bob IDE support. Bob's agent reaches outside tools only through MCP servers listed in
 * `.bob/mcp.json`, so the research tools are offered only when the extension runs in Bob:
 * VS Code has no Bob agent to use them. Kept free of the `vscode` module so it can be unit tested.
 */

/** Whether the host product is IBM Bob, from `vscode.env.appName` and `vscode.env.uriScheme`. */
export function isBobProduct(appName: string, uriScheme: string): boolean {
  return /\bbob\b/i.test(appName) || /^(?:ibm-?)?bob(?:-|$)/i.test(uriScheme);
}

/**
 * The IDs of Bob's chat views, best first: webview views that a Bob extension contributes, read from
 * the extension manifests. Views named for chat or the side bar come first.
 */
export function bobChatViews(extensions: ReadonlyArray<{ id: string; packageJSON: unknown }>): string[] {
  const bob = /\bbob\b/i;
  const found: Array<{ id: string; chat: boolean }> = [];
  for (const extension of extensions) {
    const views = (extension.packageJSON as { contributes?: { views?: unknown } } | undefined)?.contributes?.views;
    if (!views || typeof views !== "object" || Array.isArray(views)) {
      continue;
    }
    for (const [container, list] of Object.entries(views)) {
      if (!Array.isArray(list)) {
        continue;
      }
      for (const view of list as Array<{ id?: unknown; name?: unknown; type?: unknown }>) {
        if (!view || view.type !== "webview" || typeof view.id !== "string") {
          continue;
        }
        const viewName = typeof view.name === "string" ? view.name : "";
        if ([extension.id, container, view.id, viewName].some((text) => bob.test(text))) {
          found.push({ id: view.id, chat: /chat|sidebar/i.test(`${view.id} ${viewName}`) });
        }
      }
    }
  }
  return [...found.filter((view) => view.chat), ...found.filter((view) => !view.chat)].map((view) => view.id);
}

export type BobPasteStep = { command: string } | { waitMs: number };

/**
 * The commands and waits that put the clipboard into Bob's chat view `viewId`. Only VS Code's own
 * `<viewId>.focus` is run on it: it opens a hidden view and focuses a visible one, and never closes
 * one. Bob's own focus commands toggle the chat, so running them closed an open chat. The focus
 * runs twice, `loadWaitMs` apart: the first opens a hidden chat, and the second focuses it once it
 * has loaded. The editor is focused first, so a paste that misses Bob's chat lands in the editor,
 * where it is seen and undone, never in the terminal, where a multi-line prompt could run as shell
 * commands.
 *
 * Bob focuses its input box itself only when the chat becomes visible, so the view focus of a chat
 * that is already open focuses the chat but not its input box. Bob's `focusInput` command, when
 * there is one, then puts the focus in the box. It runs only once the chat is open, and the view is
 * focused again after it, so the chat ends up focused even if the command toggles.
 */
export function bobPasteSteps(viewId: string, loadWaitMs: number, focusInput?: string): BobPasteStep[] {
  const focus = `${viewId}.focus`;
  return [
    { command: "workbench.action.focusActiveEditorGroup" },
    { command: focus },
    { waitMs: loadWaitMs },
    { command: focus },
    ...(focusInput ? [{ command: focusInput }, { waitMs: 150 }, { command: focus }] : []),
    { waitMs: 150 },
    { command: "editor.action.clipboardPasteAction" },
    { waitMs: 150 },
  ];
}

/**
 * Bob's command that focuses its chat input box, if any. Only a `focusInput` command: Bob's other
 * focus commands toggle the chat.
 */
export function bobFocusInputCommand(commands: readonly string[]): string | undefined {
  return commands.find((command) => /^bob\b.*\.focusInput$/i.test(command));
}

/** Bob commands that may focus its chat, listed in the log so the right one can be told apart. */
export function bobFocusCandidates(commands: readonly string[]): string[] {
  return commands.filter((command) => /^bob\b.*(focus|chat|input)/i.test(command));
}

export interface McpServerEntry {
  url: string;
  headers: Record<string, string>;
  alwaysAllow: string[];
}

export function mcpServerEntry(port: number, token: string, tools: readonly string[]): McpServerEntry {
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    alwaysAllow: [...tools],
  };
}

/**
 * The tools a refreshed entry lets Bob run without asking. Tools the user took out of `alwaysAllow`
 * stay out; only tools new since `offeredBefore` (the tools the previous start offered) are added.
 * Without `offeredBefore`, none are added. Tools that no longer exist are dropped.
 */
export function refreshedAlwaysAllow(
  existing: unknown,
  tools: readonly string[],
  offeredBefore: readonly string[] | undefined
): string[] {
  const kept = Array.isArray(existing) ? existing.filter((tool): tool is string => typeof tool === "string") : [];
  return tools.filter((tool) => kept.includes(tool) || (offeredBefore !== undefined && !offeredBefore.includes(tool)));
}

/** Options of this extension's `.bob/mcp.json` entry that belong to the user and are kept. */
const USER_OPTIONS: ReadonlySet<string> = new Set(["disabled", "timeout", "disabledTools"]);

/**
 * `.bob/mcp.json` text with this extension's entry set (or removed, with `entry` undefined),
 * keeping every other server and setting in the file.
 */
export function mergeMcpConfig(existing: string | undefined, entry: McpServerEntry | undefined): string {
  return mergeJsonMcpServers(existing, entry ? { ...entry } : undefined, { file: ".bob/mcp.json", userOptions: USER_OPTIONS });
}

/** This extension's entry in `.bob/mcp.json` text, if any. */
export function configuredEntry(text: string | undefined): { url?: unknown; headers?: unknown; alwaysAllow?: unknown } | undefined {
  return jsonMcpEntry(text);
}

/**
 * How a folder's `.bob/mcp.json` stands, for the Bob Research Tools view: connected on this computer
 * (or connected, but turned off in Bob's MCP settings), holding an entry that wasn't connected here
 * (one that came with a cloned project), or without this extension's entry.
 */
export type BobFolderStatus = "connected" | "disabled" | "notConnectedHere" | "none";

export function bobFolderStatus(text: string | undefined, connectedHere: boolean): BobFolderStatus {
  const entry = configuredEntry(text) as { disabled?: unknown } | undefined;
  if (!entry) {
    return "none";
  }
  if (!connectedHere) {
    return "notConnectedHere";
  }
  return entry.disabled === true ? "disabled" : "connected";
}

/**
 * One line for the Bob Research Tools header, which shows even with the section collapsed. The
 * first state that applies wins.
 */
export function bobStatusSummary(state: {
  enabled: boolean;
  folders: readonly BobFolderStatus[];
  port: number | undefined;
  startError: string | undefined;
  system: string | undefined;
}): string {
  if (!state.enabled) {
    return "Turned off";
  }
  const connected = state.folders.filter((status) => status === "connected" || status === "disabled");
  if (connected.length === 0) {
    return "Not connected";
  }
  if (connected.every((status) => status === "disabled")) {
    return "Turned off in Bob";
  }
  if (state.startError) {
    return "Tools not running";
  }
  if (state.port === undefined) {
    return "Starting…";
  }
  return `Connected · ${state.system ?? "no IBM i"}`;
}

