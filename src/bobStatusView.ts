import * as path from "node:path";
import * as vscode from "vscode";
import { BobFolderStatus, bobFolderStatus, readFileBelow } from "./bobIde";
import { getSystemName } from "./codeForIBMi";

/** What the Bob Research Tools view shows, read from `registerBobCommands` each time it redraws. */
export interface BobStatusState {
  enabled(): boolean;
  /** The port the research tools listen on, once started. */
  port(): number | undefined;
  /** Why the last start failed, until one succeeds. */
  startError(): string | undefined;
  /** URIs of the workspace folders connected on this computer. */
  connectedFolders(): readonly string[];
}

export type BobStatusRow =
  | { kind: "folder"; folderUri: string; name: string; status: BobFolderStatus }
  | { kind: "server" }
  | { kind: "system" };

const CONNECT = "ibmi-member-workspace.bob.connectResearchTools";
const REFRESH = "ibmi-member-workspace.bob.refreshStatus";

/**
 * The Bob Research Tools view above Checked Out Members, so Connect is one click away. It shows no
 * rows until a folder is connected, which leaves room for the Connect button of its welcome content.
 */
export class BobStatusProvider implements vscode.TreeDataProvider<BobStatusRow>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BobStatusRow | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly state: BobStatusState, private readonly mcpConfig: string) {}

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: BobStatusRow): BobStatusRow[] {
    if (element || !this.state.enabled()) {
      return [];
    }
    const connected = this.state.connectedFolders();
    const folders: BobStatusRow[] = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const root = folder.uri.fsPath;
      let text: string | undefined;
      try {
        text = readFileBelow(root, path.join(root, this.mcpConfig));
      } catch {
        // A file that can't be read is shown as not connected; Connect reports why.
      }
      const status = bobFolderStatus(text, connected.includes(folder.uri.toString()));
      return { kind: "folder", folderUri: folder.uri.toString(), name: folder.name, status };
    });
    if (!folders.some((row) => row.kind === "folder" && (row.status === "connected" || row.status === "disabled"))) {
      return [];
    }
    return [...folders, { kind: "server" }, { kind: "system" }];
  }

  getTreeItem(row: BobStatusRow): vscode.TreeItem {
    switch (row.kind) {
      case "folder":
        return folderItem(row);
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
        tooltip: "The research tools run on this computer and only accept Bob's requests with your token.",
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

function folderItem(row: Extract<BobStatusRow, { kind: "folder" }>): vscode.TreeItem {
  const connect = { command: CONNECT, title: "Connect", arguments: [row.folderUri] };
  switch (row.status) {
    case "connected":
      return item(`Connected in ${row.name}`, "pass-filled", {
        contextValue: "bobFolder-connected",
        tooltip: `Bob's agent can use the IBM i research tools in ${row.name}. If Bob doesn't list them, refresh the MCP servers in Bob's MCP settings.`,
      });
    case "disabled":
      return item(`${row.name}: turned off in Bob's MCP settings`, "circle-slash", {
        contextValue: "bobFolder-connected",
        tooltip: `The "ibmi-member-workspace" server is connected in ${row.name}, but turned off in Bob's MCP settings. Turn it on there to use the tools.`,
      });
    case "notConnectedHere":
      return item(`${row.name}: not connected on this computer`, "warning", {
        description: "click to connect",
        tooltip: `${row.name}'s .bob/mcp.json has an "ibmi-member-workspace" entry that wasn't connected on this computer, for example one that came with the project. Click to connect it.`,
        command: connect,
      });
    case "none":
      return item(`${row.name}: not connected`, "plug", {
        description: "click to connect",
        tooltip: `Click to let Bob research IBM i programs in ${row.name}.`,
        command: connect,
      });
  }
}

function systemItem(): vscode.TreeItem {
  const system = getSystemName();
  return system
    ? item(`IBM i: ${system}`, "vm-active", { tooltip: `Bob's research tools read ${system} through your Code for IBM i connection.` })
    : item("IBM i: not connected", "debug-disconnect", {
      tooltip: "Bob's research tools read the IBM i through Code for IBM i. Connect to a system to use them.",
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
