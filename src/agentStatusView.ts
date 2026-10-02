import * as path from "node:path";
import * as vscode from "vscode";
import { jsonMcpEntry, readFileBelow } from "./agentFiles";
import { AGENTS, AgentConnectionStatus, AgentId, agentsStatusSummary, codexEntryState } from "./agentConfig";
import { getSystemName } from "./codeForIBMi";

/** An agent the user connected on this computer; `folder` is the workspace folder URI for agents configured by a file. */
export interface AgentConnection {
  agent: AgentId;
  folder?: string;
}

/** What the AI Research Tools view shows, read from `registerAgentCommands` each time it redraws. */
export interface AgentStatusState {
  enabled(): boolean;
  available(): AgentId[];
  connections(): readonly AgentConnection[];
  /** The port the research tools listen on, once started. */
  port(): number | undefined;
  /** Why the last start failed, until one succeeds. */
  startError(): string | undefined;
}

export type AgentStatusRow =
  | { kind: "agent"; agent: AgentId; folderUri?: string; folderName?: string; status: AgentConnectionStatus }
  | { kind: "server" }
  | { kind: "system" };

const CONNECT = "ibmi-member-workspace.agents.connect";
const REFRESH = "ibmi-member-workspace.agents.refreshStatus";

/**
 * The AI Research Tools view above Checked Out Members in VS Code, as the Bob Research Tools view is
 * in Bob. It shows no rows until an agent is connected, which leaves room for the Connect button of
 * its welcome content. Its header sums the status up in one line.
 */
export class AgentStatusProvider implements vscode.TreeDataProvider<AgentStatusRow>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<AgentStatusRow | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private view: vscode.TreeView<AgentStatusRow> | undefined;

  constructor(private readonly state: AgentStatusState) {}

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  attach(view: vscode.TreeView<AgentStatusRow>): void {
    this.view = view;
    this.refresh();
  }

  refresh(): void {
    if (this.view) {
      const rows = this.agentRows();
      this.view.description = agentsStatusSummary({
        enabled: this.state.enabled(),
        connected: rows.filter(isConnected).map((row) => row.agent),
        port: this.state.port(),
        startError: this.state.startError(),
        system: getSystemName(),
      });
    }
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: AgentStatusRow): AgentStatusRow[] {
    if (element || !this.state.enabled()) {
      return [];
    }
    const rows = this.agentRows();
    if (!rows.some(isConnected)) {
      return [];
    }
    return [...rows, { kind: "server" }, { kind: "system" }];
  }

  /** One row per available agent, or per workspace folder where a file-configured agent has an entry. */
  private agentRows(): Array<Extract<AgentStatusRow, { kind: "agent" }>> {
    const connections = this.state.connections();
    const folders = vscode.workspace.workspaceFolders ?? [];
    return this.state.available().flatMap((agent): Array<Extract<AgentStatusRow, { kind: "agent" }>> => {
      const configFile = AGENTS[agent].configFile;
      if (!configFile) {
        const connected = connections.some((connection) => connection.agent === agent);
        return [{ kind: "agent" as const, agent, status: connected ? "connected" as const : "none" as const }];
      }
      const perFolder = folders.map((folder) => ({
        kind: "agent" as const,
        agent,
        folderUri: folder.uri.toString(),
        folderName: folders.length > 1 ? folder.name : undefined,
        status: fileStatus(
          agent,
          folder.uri.fsPath,
          configFile,
          connections.some((connection) => connection.agent === agent && connection.folder === folder.uri.toString())
        ),
      }));
      const shown = perFolder.filter((row) => row.status !== "none");
      return shown.length > 0 ? shown : [{ kind: "agent" as const, agent, status: "none" as const }];
    });
  }

  getTreeItem(row: AgentStatusRow): vscode.TreeItem {
    switch (row.kind) {
      case "agent":
        return agentItem(row);
      case "server":
        return this.serverItem();
      case "system":
        return systemItem();
    }
  }

  private serverItem(): vscode.TreeItem {
    const port = this.state.port();
    if (port !== undefined) {
      return item("Research tools running", "pass-filled", {
        description: `127.0.0.1:${port}`,
        tooltip: "The research tools run on this computer and only accept requests with your token.",
      });
    }
    const error = this.state.startError();
    if (error) {
      return item("Research tools not running: click to try again", "error", {
        tooltip: `Could not start the research tools: ${error}`,
        command: { command: REFRESH, title: "Try Again" },
      });
    }
    return item("Research tools starting…", "loading~spin", {});
  }
}

function isConnected(row: AgentStatusRow): row is Extract<AgentStatusRow, { kind: "agent" }> {
  return row.kind === "agent" && (row.status === "connected" || row.status === "disabled");
}

/** How a folder's config file stands for a file-configured agent. */
function fileStatus(agent: AgentId, root: string, configFile: string, connectedHere: boolean): AgentConnectionStatus {
  let text: string | undefined;
  try {
    text = readFileBelow(root, path.join(root, ...configFile.split("/")));
  } catch {
    // A file that can't be read is shown as not connected; Connect reports why.
  }
  const state = agent === "codex"
    ? codexEntryState(text)
    : jsonMcpEntry(text) ? "enabled" : "none";
  if (state === "none") {
    return "none";
  }
  if (!connectedHere) {
    return "notConnectedHere";
  }
  return state === "disabled" ? "disabled" : "connected";
}

function agentItem(row: Extract<AgentStatusRow, { kind: "agent" }>): vscode.TreeItem {
  const { name, configFile } = AGENTS[row.agent];
  const where = row.folderName ? ` in ${row.folderName}` : "";
  const connect = { command: CONNECT, title: "Connect", arguments: [{ agent: row.agent, folderUri: row.folderUri }] };
  switch (row.status) {
    case "connected":
      return item(`${name}: connected${where}`, "pass-filled", {
        contextValue: "agentConnection",
        tooltip: configFile
          ? `${name} can use the IBM i research tools${where}. If it doesn't list them, start a new conversation.`
          : `${name} can use the IBM i research tools in this workspace. They're listed in Copilot Chat's tools in agent mode.`,
      });
    case "disabled":
      return item(`${name}: turned off${where}`, "circle-slash", {
        contextValue: "agentConnection",
        tooltip: `The "ibmi-member-workspace" server is connected${where}, but turned off in ${configFile}. Turn it on there to use the tools.`,
      });
    case "notConnectedHere":
      return item(`${name}: not connected on this computer${where}`, "warning", {
        description: "click to connect",
        tooltip: `${configFile}${where} has an "ibmi-member-workspace" entry that wasn't connected on this computer, for example one that came with the project. Click to connect it.`,
        command: connect,
      });
    case "none":
      return item(`${name}: not connected${where}`, "plug", {
        description: "click to connect",
        tooltip: `Click to let ${name} research IBM i programs.`,
        command: connect,
      });
  }
}

function systemItem(): vscode.TreeItem {
  const system = getSystemName();
  return system
    ? item(`IBM i: ${system}`, "vm-active", { tooltip: `The research tools read ${system} through your Code for IBM i connection.` })
    : item("IBM i: not connected", "debug-disconnect", {
      tooltip: "The research tools read the IBM i through Code for IBM i. Connect to a system to use them.",
    });
}

function item(
  label: string,
  icon: string,
  options: { description?: string; tooltip?: string; contextValue?: string; command?: vscode.Command }
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  treeItem.iconPath = new vscode.ThemeIcon(icon);
  treeItem.description = options.description;
  treeItem.tooltip = options.tooltip;
  treeItem.contextValue = options.contextValue;
  treeItem.command = options.command;
  return treeItem;
}
