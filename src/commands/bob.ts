import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  MCP_SERVER_NAME,
  configuredEntry,
  excludeFromGit,
  mcpServerEntry,
  mergeMcpConfig,
  readFileBelow,
  writeFileBelow,
} from "../bobIde";
import { BobMcpServer, McpTool } from "../bobMcpServer";
import { SERVER_INSTRUCTIONS, createResearchTools } from "../bobMcpTools";
import {
  describeFile,
  findSourceMembers,
  getSystemName,
  searchSourceMembers,
  serviceProgramExports,
  whereUsed,
} from "../codeForIBMi";
import { errorMessage } from "../errors";
import { bringReferenceCopiesFor } from "./checkout";
import { CommandContext } from "./context";
import { lookupDependencies, searchLibraries } from "./dependencies";

/** Secret storage key of the token Bob sends; one per user, shared by every workspace. */
const TOKEN_KEY = "bob.mcpToken";
/** workspaceState key of the port, kept so `.bob/mcp.json` rarely needs rewriting. */
const PORT_KEY = "bob.mcpPort";

const MCP_CONFIG = path.join(".bob", "mcp.json");
const RULES_FILE = path.join(".bob", "rules", "ibmi-member-workspace.md");

const RULES = `# IBM i Member Workspace

- Use the \`${MCP_SERVER_NAME}\` MCP tools to research IBM i programs: \`find_member_dependencies\` for what a
  member uses, \`find_where_used\` for what uses a program or file, \`describe_file\` for file layouts,
  \`read_member_source\` to read a member.
- Members these tools bring into the checkout folder are **read-only reference copies**. They may be
  production source. Never edit, chmod, rename, delete or overwrite a reference copy, and never copy one
  over another file. \`list_checkouts\` shows which files are reference copies.
- To change a member, tell the user to check it out through their change-management system (for example,
  Rocket LMI) and then use Check Out Member on the copy in their development library.
- Only edit members that are checked out for change, and never upload to the IBM i without asking the user.
`;

/**
 * Starts the research tools server for Bob's agent and registers the commands that connect Bob
 * to it. Called only when running in IBM Bob.
 */
export function registerBobCommands(ctx: CommandContext): void {
  const { context, log } = ctx;
  let server: BobMcpServer | undefined;
  let port: number | undefined;
  let token: string | undefined;

  const tools = createTools(ctx);

  const enabled = () =>
    vscode.workspace.getConfiguration("ibmi-member-workspace").get<boolean>("bob.researchTools", true);

  const start = async () => {
    if (server || !enabled()) {
      return;
    }
    token = await context.secrets.get(TOKEN_KEY);
    if (!token) {
      token = crypto.randomBytes(32).toString("hex");
      await context.secrets.store(TOKEN_KEY, token);
    }
    const candidate = new BobMcpServer(tools, token, {
      name: MCP_SERVER_NAME,
      version: String(context.extension.packageJSON.version ?? ""),
      instructions: SERVER_INSTRUCTIONS,
    }, (message) => log.appendLine(message));
    port = await candidate.start(context.workspaceState.get<number>(PORT_KEY));
    server = candidate;
    await context.workspaceState.update(PORT_KEY, port);
    log.appendLine(`[bob] Research tools listening on 127.0.0.1:${port}`);
    refreshConfiguredEntries(port, token, tools, log);
  };

  const stop = () => {
    server?.dispose();
    server = undefined;
    port = undefined;
  };
  context.subscriptions.push({ dispose: stop });

  void start().catch((err) => log.appendLine(`[bob] Could not start the research tools: ${errorMessage(err)}`));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("ibmi-member-workspace.bob.researchTools")) {
        return;
      }
      if (enabled()) {
        void start().catch((err) => log.appendLine(`[bob] Could not start the research tools: ${errorMessage(err)}`));
      } else {
        stop();
        log.appendLine("[bob] Research tools stopped.");
      }
    }),

    vscode.commands.registerCommand("ibmi-member-workspace.bob.connectResearchTools", async () => {
      if (!enabled()) {
        const choice = await vscode.window.showWarningMessage(
          "The IBM i research tools for Bob are turned off in your user settings.",
          "Open Settings"
        );
        if (choice) {
          void vscode.commands.executeCommand("workbench.action.openSettings", "ibmi-member-workspace.bob.researchTools");
        }
        return;
      }
      try {
        await start();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not start the IBM i research tools: ${errorMessage(err)}`);
        return;
      }
      const folder = await pickFolder();
      if (!folder || port === undefined || !token) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `Let Bob research IBM i programs in ${folder.name}?`,
        {
          modal: true,
          detail:
            `This adds the "${MCP_SERVER_NAME}" server to .bob/mcp.json with a token that only works on this computer, ` +
            "and, in a Git repository, keeps that file out of commits.\n\nThe tools only read the IBM i. Members Bob looks at are " +
            "brought into your checkout folder as read-only reference copies, which can't be uploaded or merged back.",
        },
        "Connect",
        "Connect and Add Bob Rules"
      );
      if (!choice) {
        return;
      }
      const root = folder.uri.fsPath;
      try {
        const target = path.join(root, MCP_CONFIG);
        writeFileBelow(root, target, mergeMcpConfig(readFileBelow(root, target), mcpServerEntry(port, token, toolNames(tools))));
        const excluded = excludeFromGit(root, "/.bob/mcp.json");
        if (choice === "Connect and Add Bob Rules") {
          const rules = path.join(root, RULES_FILE);
          if (readFileBelow(root, rules) === undefined) {
            writeFileBelow(root, rules, RULES, 0o644);
          }
        }
        log.appendLine(`[bob] Connected ${folder.name}: ${target}${excluded ? " (excluded from Git)" : ""}`);
        vscode.window.showInformationMessage(
          `Bob can now use the IBM i research tools in ${folder.name}. If they don't appear, refresh the MCP servers in Bob's MCP settings.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Could not update .bob/mcp.json: ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand("ibmi-member-workspace.bob.disconnectResearchTools", async () => {
      const folder = await pickFolder();
      if (!folder) {
        return;
      }
      const root = folder.uri.fsPath;
      const target = path.join(root, MCP_CONFIG);
      try {
        const existing = readFileBelow(root, target);
        if (!configuredEntry(existing)) {
          vscode.window.showInformationMessage(`Bob is not connected to the IBM i research tools in ${folder.name}.`);
          return;
        }
        writeFileBelow(root, target, mergeMcpConfig(existing, undefined));
        log.appendLine(`[bob] Disconnected ${folder.name}`);
        vscode.window.showInformationMessage(`Removed the IBM i research tools from ${folder.name}'s .bob/mcp.json.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not update .bob/mcp.json: ${errorMessage(err)}`);
      }
    })
  );
}

function createTools(ctx: CommandContext): McpTool[] {
  const { service } = ctx;
  return createResearchTools({
    connectedSystem: getSystemName,
    entries: (system) => service.getEntriesForSystem(system),
    findEntry: (system, library, sourceFile, member) => service.findEntry(system, library, sourceFile, member),
    findMembers: findSourceMembers,
    bringReferenceCopies: (system, members) => bringReferenceCopiesFor(ctx, system, members),
    readLocal: (localPath) => fs.readFileSync(localPath, "utf-8"),
    lookupDependencies: (system, entry) => lookupDependencies(ctx, system, entry),
    searchLibraries,
    whereUsedLibraryLimit: () =>
      vscode.workspace.getConfiguration("ibmi-member-workspace").get<number>("bob.whereUsedMaxLibraries"),
    whereUsed,
    searchSourceMembers,
    describeFile,
    serviceProgramExports,
  });
}

function toolNames(tools: readonly McpTool[]): string[] {
  return tools.map((tool) => tool.name);
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage("Open a folder or workspace first: Bob reads its MCP servers from .bob/mcp.json there.");
    return undefined;
  }
  return folders.length === 1
    ? folders[0]
    : vscode.window.showWorkspaceFolderPick({ placeHolder: "Which folder should Bob use the IBM i research tools in?" });
}

/** Keeps connected folders pointing at the port and token in use, e.g. after the saved port was taken. */
function refreshConfiguredEntries(
  port: number,
  token: string,
  tools: readonly McpTool[],
  log: vscode.OutputChannel
): void {
  const entry = mcpServerEntry(port, token, toolNames(tools));
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    const target = path.join(root, MCP_CONFIG);
    try {
      const existing = readFileBelow(root, target);
      const current = configuredEntry(existing);
      if (!current) {
        continue;
      }
      const headers = current.headers as Record<string, unknown> | undefined;
      if (current.url === entry.url && headers?.Authorization === entry.headers.Authorization) {
        continue;
      }
      writeFileBelow(root, target, mergeMcpConfig(existing, entry));
      log.appendLine(`[bob] Updated ${target} for port ${port}`);
    } catch (err) {
      log.appendLine(`[bob] Could not update ${target}: ${errorMessage(err)}`);
    }
  }
}
