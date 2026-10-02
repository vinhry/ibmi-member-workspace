import * as path from "node:path";
import * as vscode from "vscode";
import { GENERATED_RULES_MARKER, excludeFromGit, readFileBelow, shouldRewriteRules, writeFileBelow } from "../agentFiles";
import { RULES_BODY } from "../agentConfig";
import {
  MCP_SERVER_NAME,
  bobChatViews,
  bobFocusCandidates,
  bobFocusInputCommand,
  configuredEntry,
  mcpServerEntry,
  mergeMcpConfig,
  refreshedAlwaysAllow,
} from "../bobIde";
import { onConnectionChange } from "../codeForIBMi";
import { BobPromptKind, buildBobPrompt } from "../bobPrompts";
import { BobStatusProvider } from "../bobStatusView";
import { errorMessage } from "../errors";
import { pasteIntoChat } from "./chatPaste";
import { CommandContext } from "./context";
import { hasMembersToInvestigate, investigatedMembers, trackCheckoutPaths, warnLeftOut } from "./investigate";
import { ResearchServer } from "./researchServer";

/**
 * workspaceState key of the folders the user connected on this computer. Only those are kept up
 * to date: a `.bob/mcp.json` that came with a cloned project is never given this user's token.
 */
const CONNECTED_KEY = "bob.connectedFolders";
/** workspaceState key of the tool names this workspace's last start offered, to tell which tools a new version added. */
const OFFERED_TOOLS_KEY = "bob.offeredTools";

const MCP_CONFIG = path.join(".bob", "mcp.json");
const RULES_FILE = path.join(".bob", "rules", "ibmi-member-workspace.md");

const RULES = `${GENERATED_RULES_MARKER}\n${RULES_BODY}`;

/** The rules 1.6.0 wrote, before the marker; a file still holding exactly this is upgraded. */
const RULES_1_6_0 = `# IBM i Member Workspace

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

/** Texts earlier builds wrote without the marker. */
const PREVIOUS_RULES = [RULES_1_6_0, RULES_BODY];

/**
 * Starts the research tools server for Bob's agent and registers the commands that connect Bob
 * to it. Called only when running in IBM Bob.
 */
export function registerBobCommands(ctx: CommandContext): void {
  const { context, log } = ctx;

  registerInvestigateCommands(ctx);

  const enabled = () =>
    vscode.workspace.getConfiguration("ibmi-member-workspace").get<boolean>("bob.researchTools", true);

  const connectedFolders = () => context.workspaceState.get<string[]>(CONNECTED_KEY, []);
  const setConnected = async (folder: vscode.WorkspaceFolder, connected: boolean) => {
    const others = connectedFolders().filter((uri) => uri !== folder.uri.toString());
    await context.workspaceState.update(CONNECTED_KEY, connected ? [...others, folder.uri.toString()] : others);
    statusView.refresh();
  };

  const server: ResearchServer = new ResearchServer(ctx, {
    keyPrefix: "bob",
    logTag: "[bob]",
    enabled,
    whereUsedSetting: "ibmi-member-workspace.bob.whereUsedMaxLibraries",
    onStarted: async (port, token) => {
      const offeredBefore = context.workspaceState.get<string[]>(OFFERED_TOOLS_KEY);
      refreshConfiguredEntries(port, token, server.toolNames, offeredBefore, connectedFolders(), log);
      await context.workspaceState.update(OFFERED_TOOLS_KEY, server.toolNames);
    },
    onStateChange: () => statusView.refresh(),
  });
  context.subscriptions.push(server);

  const statusView: BobStatusProvider = new BobStatusProvider({
    enabled,
    port: () => server.port,
    startError: () => server.startError,
    connectedFolders,
  }, MCP_CONFIG);
  // Edits by hand, and Bob turning the server off, show without a refresh.
  const mcpWatcher = vscode.workspace.createFileSystemWatcher("**/.bob/mcp.json");
  mcpWatcher.onDidCreate(() => statusView.refresh());
  mcpWatcher.onDidChange(() => statusView.refresh());
  mcpWatcher.onDidDelete(() => statusView.refresh());
  const statusTree = vscode.window.createTreeView("ibmi-member-workspace.bobView", { treeDataProvider: statusView });
  context.subscriptions.push(
    statusView,
    mcpWatcher,
    statusTree,
    vscode.workspace.onDidChangeWorkspaceFolders(() => statusView.refresh())
  );
  statusView.attach(statusTree);
  onConnectionChange(context, () => statusView.refresh());

  server.startQuietly();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("ibmi-member-workspace.bob.researchTools")) {
        return;
      }
      if (enabled()) {
        server.startQuietly();
      } else {
        server.stop();
        server.clearStartError();
        log.appendLine("[bob] Research tools stopped.");
      }
      statusView.refresh();
    }),

    vscode.commands.registerCommand("ibmi-member-workspace.bob.refreshStatus", () => {
      server.startQuietly();
      statusView.refresh();
    }),

    vscode.commands.registerCommand("ibmi-member-workspace.bob.connectResearchTools", async (arg?: unknown) => {
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
        await server.start();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not start the IBM i research tools: ${errorMessage(err)}`);
        return;
      }
      const folder = folderOf(arg) ?? await pickFolder();
      const { port, token } = server;
      if (!folder || port === undefined || !token) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `Let Bob research IBM i programs in ${folder.name}?`,
        {
          modal: true,
          detail:
            `This adds the "${MCP_SERVER_NAME}" server to .bob/mcp.json with a token that only works on this computer, ` +
            "and, in a Git repository, keeps that file out of commits. Don't commit or share .bob/mcp.json.\n\nThe tools only read the IBM i. Members Bob looks at are " +
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
        // Read again: the server may have restarted with a new token while the dialog was open.
        const current = { port: server.port ?? port, token: server.token ?? token };
        writeFileBelow(root, target, mergeMcpConfig(readFileBelow(root, target), mcpServerEntry(current.port, current.token, server.toolNames)));
        await setConnected(folder, true);
        const excluded = excludeFromGit(root, MCP_CONFIG);
        if (choice === "Connect and Add Bob Rules") {
          const rules = path.join(root, RULES_FILE);
          const existingRules = readFileBelow(root, rules);
          if (existingRules === undefined || shouldRewriteRules(existingRules, RULES, PREVIOUS_RULES)) {
            writeFileBelow(root, rules, RULES, 0o644);
          }
        }
        log.appendLine(`[bob] Connected ${folder.name}: ${target}${excluded === "excluded" ? " (excluded from Git)" : ""}`);
        if (excluded === "notExcluded") {
          vscode.window.showWarningMessage(
            `Bob can now use the IBM i research tools in ${folder.name}, but .bob/mcp.json holds a token and couldn't be ` +
            "kept out of Git in this worktree or submodule. Add .bob/mcp.json to .gitignore so it isn't committed."
          );
        } else {
          vscode.window.showInformationMessage(
            `Bob can now use the IBM i research tools in ${folder.name}. If they don't appear, refresh the MCP servers in Bob's MCP settings.`
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Could not update .bob/mcp.json: ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand("ibmi-member-workspace.bob.disconnectResearchTools", async (arg?: unknown) => {
      const folder = folderOf(arg) ?? await pickFolder();
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
        await setConnected(folder, false);
        log.appendLine(`[bob] Disconnected ${folder.name}`);
        // A new token, so a copy of the old file (a backup, another checkout) no longer works.
        // Other folders of this workspace that stay connected get the new token when the server restarts.
        await server.rotateToken(true);
        vscode.window.showInformationMessage(`Removed the IBM i research tools from ${folder.name}'s .bob/mcp.json.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not update .bob/mcp.json: ${errorMessage(err)}`);
      }
    })
  );
}

/**
 * "Bob, Investigate": right-click prompts that put a ready-made request into Bob's chat. The
 * prompt is not sent; the user reviews it and presses Enter.
 */
function registerInvestigateCommands(ctx: CommandContext): void {
  const { context, log } = ctx;

  // The Explorer menu shows only on checked-out files.
  trackCheckoutPaths(ctx);

  const investigate = (kind: BobPromptKind) => async (arg: unknown, all?: unknown[]) => {
    const found = investigatedMembers(ctx, arg, all);
    if (!hasMembersToInvestigate(found, "Bob, Investigate")) {
      return;
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const { text, skipped } = buildBobPrompt(kind, found.members, roots);
    await sendToBobChat(text, log);
    warnLeftOut(skipped, found.notCheckedOut);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.bob.analyzeRelationships", investigate("relationships")),
    vscode.commands.registerCommand("ibmi-member-workspace.bob.explainProgram", investigate("explain")),
    vscode.commands.registerCommand("ibmi-member-workspace.bob.deepDive", investigate("deepDive"))
  );
}

/** Whether Bob's chat views and commands were written to the log yet. */
let bobChatLogged = false;

/**
 * Puts `prompt` in Bob's chat box without sending it. Bob documents no command that fills the box,
 * so the prompt goes through the clipboard: focus Bob's input, then paste (see `pasteIntoChat`).
 */
async function sendToBobChat(prompt: string, log: vscode.OutputChannel): Promise<void> {
  const views = bobChatViews(vscode.extensions.all);
  const commands = await vscode.commands.getCommands(true);
  const focusInput = bobFocusInputCommand(commands);
  if (!bobChatLogged) {
    bobChatLogged = true;
    log.appendLine(`[bob] Bob chat views: ${views.join(", ") || "none"}; Bob commands: ${bobFocusCandidates(commands).join(", ") || "none"}`);
  }
  await pasteIntoChat(prompt, { name: "Bob", views: views.slice(0, 1), focusInput, logTag: "[bob]" }, log);
}

/**
 * The workspace folder a Bob Research Tools row names (its URI, or the row itself). Only a folder
 * open in this workspace is used; anything else leaves the choice to the user.
 */
function folderOf(arg: unknown): vscode.WorkspaceFolder | undefined {
  const uri = typeof arg === "string" ? arg : (arg as { kind?: unknown; folderUri?: unknown } | undefined)?.folderUri;
  return typeof uri === "string"
    ? vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === uri)
    : undefined;
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

/**
 * Keeps the folders the user connected on this computer pointing at the port and token in use,
 * e.g. after the saved port was taken. An entry in any other folder (one that came with a cloned
 * project) is left alone: writing this user's token into it could get the token committed.
 */
function refreshConfiguredEntries(
  port: number,
  token: string,
  toolNames: readonly string[],
  offeredBefore: readonly string[] | undefined,
  connected: readonly string[],
  log: vscode.OutputChannel
): void {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    const target = path.join(root, MCP_CONFIG);
    try {
      const existing = readFileBelow(root, target);
      const current = configuredEntry(existing);
      if (!current) {
        continue;
      }
      if (!connected.includes(folder.uri.toString())) {
        log.appendLine(
          `[bob] ${target} has an "${MCP_SERVER_NAME}" entry that wasn't connected on this computer; left as it is. ` +
          "Run Connect Bob to IBM i Research Tools to use it."
        );
        continue;
      }
      refreshRulesFile(root, log);
      // Only Connect approves every tool; a refresh keeps the user's choices and adds new tools.
      const entry = mcpServerEntry(port, token, refreshedAlwaysAllow(current.alwaysAllow, toolNames, offeredBefore));
      const headers = current.headers as Record<string, unknown> | undefined;
      const allowed = current.alwaysAllow;
      const sameTools = Array.isArray(allowed) && allowed.length === entry.alwaysAllow.length &&
        allowed.every((tool, index) => tool === entry.alwaysAllow[index]);
      if (current.url === entry.url && headers?.Authorization === entry.headers.Authorization && sameTools) {
        continue;
      }
      writeFileBelow(root, target, mergeMcpConfig(existing, entry));
      log.appendLine(`[bob] Updated ${target} for port ${port}${sameTools ? "" : " and this version's tools"}`);
    } catch (err) {
      log.appendLine(`[bob] Could not update ${target}: ${errorMessage(err)}`);
    }
  }
}

/** Brings a rules file this extension wrote up to date; one the user edited is left alone. */
function refreshRulesFile(root: string, log: vscode.OutputChannel): void {
  const rules = path.join(root, RULES_FILE);
  try {
    if (shouldRewriteRules(readFileBelow(root, rules), RULES, PREVIOUS_RULES)) {
      writeFileBelow(root, rules, RULES, 0o644);
      log.appendLine(`[bob] Updated ${rules} to this version's rules`);
    }
  } catch (err) {
    log.appendLine(`[bob] Could not update ${rules}: ${errorMessage(err)}`);
  }
}
