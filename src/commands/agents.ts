import * as path from "node:path";
import * as vscode from "vscode";
import {
  MCP_SERVER_NAME,
  excludeFromGit,
  jsonMcpEntry,
  readFileBelow,
  shouldRewriteRules,
  writeFileBelow,
} from "../agentFiles";
import {
  AGENTS,
  AgentId,
  CLAUDE_LOCAL_SETTINGS,
  availableAgents,
  claudeAddCommand,
  claudeEntryMatches,
  claudePromptQuery,
  claudeServerEntry,
  codexEntryMatches,
  codexEntryState,
  codexServerLines,
  mentionFor,
  mergeClaudeLocalSettings,
  mergeClaudeMcpConfig,
  mergeCodexConfig,
  rulesText,
  serverUrl,
} from "../agentConfig";
import { AgentConnection, AgentStatusProvider, AgentStatusRow } from "../agentStatusView";
import { BobPromptKind, buildInvestigatePrompt } from "../bobPrompts";
import { onConnectionChange } from "../codeForIBMi";
import { errorMessage } from "../errors";
import { pasteIntoChat } from "./chatPaste";
import { CommandContext } from "./context";
import { hasMembersToInvestigate, investigatedMembers, trackCheckoutPaths, warnLeftOut } from "./investigate";
import { ResearchServer } from "./researchServer";

/**
 * workspaceState key of the agents the user connected on this computer. Only their files are kept
 * up to date: a config file that came with a cloned project is never given this user's token.
 */
const CONNECTIONS_KEY = "agents.connections";
/** workspaceState key of the agent Investigate with AI asked last. */
const LAST_AGENT_KEY = "agents.lastInvestigate";
/** Matches `contributes.mcpServerDefinitionProviders` in package.json. */
const MCP_PROVIDER_ID = "ibmi-member-workspace.researchTools";
/** Codex's chat views: in the secondary side bar where VS Code has one, otherwise in its own container. */
const CODEX_VIEWS = ["chatgpt.sidebarSecondaryView", "chatgpt.sidebarView"];
const LOG = "[agents]";

/**
 * VS Code's API for extensions to offer MCP servers to its chat (VS Code 1.101 and later), found at
 * run time so older versions and IBM Bob still install this extension.
 */
interface McpApi {
  register(provider: McpProvider): vscode.Disposable;
  definition(uri: vscode.Uri, headers: Record<string, string>, version: string): unknown;
}

interface McpProvider {
  onDidChangeMcpServerDefinitions: vscode.Event<void>;
  provideMcpServerDefinitions(): Promise<unknown[]>;
  resolveMcpServerDefinition(definition: unknown): Promise<unknown>;
}

function mcpApi(): McpApi | undefined {
  const api = vscode as unknown as {
    lm?: { registerMcpServerDefinitionProvider?: (id: string, provider: McpProvider) => vscode.Disposable };
    McpHttpServerDefinition?: new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => unknown;
  };
  const lm = api.lm;
  const Definition = api.McpHttpServerDefinition;
  if (typeof lm?.registerMcpServerDefinitionProvider !== "function" || typeof Definition !== "function") {
    return undefined;
  }
  return {
    register: (provider) => lm.registerMcpServerDefinitionProvider!(MCP_PROVIDER_ID, provider),
    definition: (uri, headers, version) => new Definition(MCP_SERVER_NAME, uri, headers, version),
  };
}

/**
 * The research tools for VS Code's AI agents: Claude Code, Codex and GitHub Copilot get what IBM
 * Bob's agent gets in Bob. Connect adds the local MCP server to the agent (Claude Code's `.mcp.json`,
 * Codex's `.codex/config.toml`, or VS Code's chat for Copilot), and "Investigate with AI" puts a
 * ready-made prompt in the agent's chat. Called only outside IBM Bob.
 */
export function registerAgentCommands(ctx: CommandContext): void {
  const { context, log, gitService } = ctx;
  const api = mcpApi();
  const version = String(context.extension.packageJSON.version ?? "");

  const enabled = () =>
    vscode.workspace.getConfiguration("ibmi-member-workspace").get<boolean>("agents.researchTools", true);
  const available = () => availableAgents(vscode.extensions.all.map((extension) => extension.id), api !== undefined);
  const connections = () => context.workspaceState.get<AgentConnection[]>(CONNECTIONS_KEY, []);
  const isConnected = (agent: AgentId) => connections().some((connection) => connection.agent === agent);

  const copilotChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(copilotChanged);

  const server: ResearchServer = new ResearchServer(ctx, {
    keyPrefix: "agents",
    logTag: LOG,
    enabled,
    whereUsedSetting: "ibmi-member-workspace.agents.whereUsedMaxLibraries",
    onStarted: (port, token) => {
      refreshConnectedFiles(connections(), port, token, log);
      copilotChanged.fire();
    },
    onStateChange: () => statusView.refresh(),
  });
  context.subscriptions.push(server);

  const statusView: AgentStatusProvider = new AgentStatusProvider({
    enabled,
    available,
    connections,
    port: () => server.port,
    startError: () => server.startError,
  });
  const statusTree = vscode.window.createTreeView("ibmi-member-workspace.agentsView", { treeDataProvider: statusView });
  // Edits by hand, and an agent turning the server off, show without a refresh.
  const watchers = ["**/.mcp.json", "**/.codex/config.toml"].map((pattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(() => statusView.refresh());
    watcher.onDidChange(() => statusView.refresh());
    watcher.onDidDelete(() => statusView.refresh());
    return watcher;
  });
  context.subscriptions.push(statusView, statusTree, ...watchers, vscode.workspace.onDidChangeWorkspaceFolders(() => statusView.refresh()));
  statusView.attach(statusTree);
  onConnectionChange(context, () => statusView.refresh());

  const updateAvailable = () =>
    void vscode.commands.executeCommand("setContext", "ibmi-member-workspace:agentAvailable", available().length > 0);
  updateAvailable();
  context.subscriptions.push(vscode.extensions.onDidChange(() => {
    updateAvailable();
    statusView.refresh();
  }));

  const setConnection = async (connection: AgentConnection, connected: boolean) => {
    // One connection per agent and folder; Copilot's is for the whole workspace.
    const others = connections().filter((existing) =>
      existing.agent !== connection.agent || (connection.agent !== "copilot" && existing.folder !== connection.folder)
    );
    await context.workspaceState.update(CONNECTIONS_KEY, connected ? [...others, connection] : others);
    statusView.refresh();
    copilotChanged.fire();
  };

  // No port is opened in VS Code until the user connects an agent.
  if (connections().length > 0) {
    server.startQuietly();
  }

  if (api) {
    const definition = () => server.port !== undefined && server.token
      ? api.definition(vscode.Uri.parse(serverUrl(server.port)), { Authorization: `Bearer ${server.token}` }, version)
      : undefined;
    context.subscriptions.push(api.register({
      onDidChangeMcpServerDefinitions: copilotChanged.event,
      provideMcpServerDefinitions: async () => {
        if (!enabled() || !isConnected("copilot")) {
          return [];
        }
        await server.start().catch((err) => log.appendLine(`${LOG} Could not start the research tools: ${errorMessage(err)}`));
        const current = definition();
        return current ? [current] : [];
      },
      // Called as VS Code starts the server: the port or token may have changed since it was listed.
      resolveMcpServerDefinition: async () => {
        if (!enabled() || !isConnected("copilot")) {
          return undefined;
        }
        await server.start();
        return definition();
      },
    }));
  }

  const connect = async (arg?: unknown) => {
    if (!enabled()) {
      const choice = await vscode.window.showWarningMessage(
        "The IBM i research tools for AI agents are turned off in your user settings.",
        "Open Settings"
      );
      if (choice) {
        void vscode.commands.executeCommand("workbench.action.openSettings", "ibmi-member-workspace.agents.researchTools");
      }
      return;
    }
    const agent = agentOf(arg) ?? await pickAgent(available(), connections(), "Which AI agent should research your IBM i programs?");
    if (!agent) {
      return;
    }
    try {
      await server.start();
    } catch (err) {
      vscode.window.showErrorMessage(`Could not start the IBM i research tools: ${errorMessage(err)}`);
      return;
    }
    if (server.port === undefined || !server.token) {
      return;
    }
    if (agent === "copilot") {
      await connectCopilot(arg);
      return;
    }
    const folder = folderOf(arg) ?? await pickFolder(AGENTS[agent].name);
    if (!folder) {
      return;
    }
    await (agent === "claude" ? connectClaude(folder) : connectCodex(folder));
  };

  /** Whether `file` must not get the token because it's committed; offers Claude Code's own command instead. */
  const refuseCommitted = async (folder: vscode.WorkspaceFolder, agent: AgentId, file: string): Promise<boolean> => {
    if (!(await gitService.isTracked(folder.uri.fsPath, file))) {
      return false;
    }
    const message = `${folder.name}'s ${file} is committed to Git, so the research tools' token can't go in it.`;
    if (agent !== "claude" || server.port === undefined || !server.token) {
      vscode.window.showWarningMessage(`${message} Add the "${MCP_SERVER_NAME}" server in ${AGENTS[agent].name}'s settings instead.`);
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `${message} Add the server to Claude Code for this project on this computer only, with a command you run in a terminal in ${folder.name}.`,
      "Copy Command"
    );
    if (choice) {
      await vscode.env.clipboard.writeText(claudeAddCommand(server.port, server.token));
      vscode.window.showInformationMessage(
        "The command is on the clipboard: run it in a terminal in the project folder, then start a new Claude Code conversation. " +
        "It holds your token, so don't share it."
      );
    }
    return true;
  };

  const connectClaude = async (folder: vscode.WorkspaceFolder) => {
    if (await refuseCommitted(folder, "claude", ".mcp.json")) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Let Claude Code research IBM i programs in ${folder.name}?`,
      {
        modal: true,
        detail:
          `This adds the "${MCP_SERVER_NAME}" server to .mcp.json with a token that only works on this computer, and, in a Git ` +
          "repository, keeps that file out of commits. Don't commit or share .mcp.json. It also lets Claude Code use the tools " +
          `without asking, in ${CLAUDE_LOCAL_SETTINGS}.\n\nThe tools only read the IBM i. Members Claude Code looks at are brought ` +
          "into your checkout folder as read-only reference copies, which can't be uploaded or merged back.",
      },
      "Connect",
      "Connect and Add Claude Rules"
    );
    if (!choice || server.port === undefined || !server.token) {
      return;
    }
    const root = folder.uri.fsPath;
    try {
      const target = path.join(root, ".mcp.json");
      writeFileBelow(root, target, mergeClaudeMcpConfig(readFileBelow(root, target), claudeServerEntry(server.port, server.token)));
      const excluded = excludeFromGit(root, ".mcp.json");
      const settings = path.join(root, ...CLAUDE_LOCAL_SETTINGS.split("/"));
      writeFileBelow(root, settings, mergeClaudeLocalSettings(readFileBelow(root, settings), true), 0o644);
      excludeFromGit(root, CLAUDE_LOCAL_SETTINGS);
      await setConnection({ agent: "claude", folder: folder.uri.toString() }, true);
      if (choice === "Connect and Add Claude Rules") {
        writeRules(root, "claude");
      }
      log.appendLine(`${LOG} Connected Claude Code in ${folder.name}: ${target}${excluded === "excluded" ? " (excluded from Git)" : ""}`);
      reportConnected("Claude Code", folder, ".mcp.json", excluded, "Start a new Claude Code conversation to load them.");
    } catch (err) {
      vscode.window.showErrorMessage(`Could not connect Claude Code: ${errorMessage(err)}`);
    }
  };

  const connectCodex = async (folder: vscode.WorkspaceFolder) => {
    const file = ".codex/config.toml";
    if (await refuseCommitted(folder, "codex", file)) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Let Codex research IBM i programs in ${folder.name}?`,
      {
        modal: true,
        detail:
          `This adds the "${MCP_SERVER_NAME}" server to ${file} with a token that only works on this computer, lets Codex use its ` +
          "tools without asking, and, in a Git repository, keeps that file out of commits. Don't commit or share it. Codex reads " +
          `${file} only in projects you trust.\n\nThe tools only read the IBM i. Members Codex looks at are brought into your ` +
          "checkout folder as read-only reference copies, which can't be uploaded or merged back.",
      },
      "Connect"
    );
    if (!choice || server.port === undefined || !server.token) {
      return;
    }
    const root = folder.uri.fsPath;
    try {
      const target = path.join(root, ".codex", "config.toml");
      writeFileBelow(root, target, mergeCodexConfig(readFileBelow(root, target), codexServerLines(server.port, server.token)));
      const excluded = excludeFromGit(root, file);
      await setConnection({ agent: "codex", folder: folder.uri.toString() }, true);
      log.appendLine(`${LOG} Connected Codex in ${folder.name}: ${target}${excluded === "excluded" ? " (excluded from Git)" : ""}`);
      reportConnected("Codex", folder, file, excluded, "Start a new Codex thread to load them; Codex reads the file only in projects you trust.");
    } catch (err) {
      vscode.window.showErrorMessage(`Could not connect Codex: ${errorMessage(err)}`);
    }
  };

  const connectCopilot = async (arg?: unknown) => {
    const choice = await vscode.window.showInformationMessage(
      "Let GitHub Copilot research IBM i programs in this workspace?",
      {
        modal: true,
        detail:
          `This offers the "${MCP_SERVER_NAME}" server to VS Code's chat in this workspace. Nothing is written to your files, and ` +
          "the token stays in VS Code. VS Code asks before a tool runs until you allow it.\n\nThe tools only read the IBM i. " +
          "Members Copilot looks at are brought into your checkout folder as read-only reference copies, which can't be uploaded or merged back.",
      },
      "Connect",
      "Connect and Add Copilot Instructions"
    );
    if (!choice) {
      return;
    }
    let folder: vscode.WorkspaceFolder | undefined;
    if (choice === "Connect and Add Copilot Instructions") {
      folder = folderOf(arg) ?? await pickFolder("GitHub Copilot");
      if (!folder) {
        return;
      }
      try {
        writeRules(folder.uri.fsPath, "copilot");
      } catch (err) {
        vscode.window.showErrorMessage(`Could not write Copilot's instructions: ${errorMessage(err)}`);
        return;
      }
    }
    await setConnection({ agent: "copilot", folder: folder?.uri.toString() }, true);
    log.appendLine(`${LOG} Connected GitHub Copilot`);
    vscode.window.showInformationMessage(
      `GitHub Copilot can now use the IBM i research tools in this workspace: they're listed under "${MCP_SERVER_NAME}" ` +
      "in Copilot Chat's tools, in agent mode. VS Code may ask you to trust the server first."
    );
  };

  const disconnect = async (arg?: unknown) => {
    const all = connections();
    const connection = connectionOf(arg, all) ?? await pickConnection(all);
    if (!connection) {
      if (all.length === 0) {
        vscode.window.showInformationMessage("No AI agent is connected to the IBM i research tools in this workspace.");
      }
      return;
    }
    const folder = connection.folder ? workspaceFolder(connection.folder) : undefined;
    try {
      if (folder && connection.agent === "claude") {
        const root = folder.uri.fsPath;
        const target = path.join(root, ".mcp.json");
        const existing = readFileBelow(root, target);
        if (jsonMcpEntry(existing)) {
          writeFileBelow(root, target, mergeClaudeMcpConfig(existing, undefined));
        }
        const settings = path.join(root, ...CLAUDE_LOCAL_SETTINGS.split("/"));
        const current = readFileBelow(root, settings);
        if (current !== undefined) {
          writeFileBelow(root, settings, mergeClaudeLocalSettings(current, false), 0o644);
        }
      } else if (folder && connection.agent === "codex") {
        const root = folder.uri.fsPath;
        const target = path.join(root, ".codex", "config.toml");
        const existing = readFileBelow(root, target);
        if (codexEntryState(existing) !== "none") {
          writeFileBelow(root, target, mergeCodexConfig(existing, undefined));
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Could not disconnect ${AGENTS[connection.agent].name}: ${errorMessage(err)}`);
      return;
    }
    await setConnection(connection, false);
    log.appendLine(`${LOG} Disconnected ${AGENTS[connection.agent].name}${folder ? ` in ${folder.name}` : ""}`);
    // A new token, so a copy of an old config file (a backup, another checkout) no longer works. Agents
    // that stay connected get the new token when the server restarts; with none left it stays stopped.
    await server.rotateToken(connections().length > 0);
    vscode.window.showInformationMessage(
      `Removed the IBM i research tools from ${AGENTS[connection.agent].name}${folder ? ` in ${folder.name}` : ""}.`
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("ibmi-member-workspace.agents.researchTools")) {
        return;
      }
      if (enabled()) {
        if (connections().length > 0) {
          server.startQuietly();
        }
      } else {
        server.stop();
        server.clearStartError();
        log.appendLine(`${LOG} Research tools stopped.`);
      }
      copilotChanged.fire();
      statusView.refresh();
    }),
    vscode.commands.registerCommand("ibmi-member-workspace.agents.refreshStatus", () => {
      if (connections().length > 0) {
        server.startQuietly();
      }
      statusView.refresh();
    }),
    vscode.commands.registerCommand("ibmi-member-workspace.agents.connect", connect),
    vscode.commands.registerCommand("ibmi-member-workspace.agents.disconnect", disconnect)
  );

  registerInvestigateWithAi(ctx, { available, connections, enabled });
}

/** Writes an agent's rules file unless the user edited it; one this extension wrote is brought up to date. */
function writeRules(root: string, agent: AgentId): void {
  const file = AGENTS[agent].rulesFile;
  if (!file) {
    return;
  }
  const target = path.join(root, ...file.split("/"));
  const existing = readFileBelow(root, target);
  if (existing === undefined || shouldRewriteRules(existing, rulesText(agent), [])) {
    writeFileBelow(root, target, rulesText(agent), 0o644);
  }
}

function reportConnected(
  name: string,
  folder: vscode.WorkspaceFolder,
  file: string,
  excluded: ReturnType<typeof excludeFromGit>,
  next: string
): void {
  if (excluded === "notExcluded") {
    vscode.window.showWarningMessage(
      `${name} can now use the IBM i research tools in ${folder.name}, but ${file} holds a token and couldn't be kept out of ` +
      `Git in this worktree or submodule. Add ${file} to .gitignore so it isn't committed.`
    );
  } else {
    vscode.window.showInformationMessage(`${name} can now use the IBM i research tools in ${folder.name}. ${next}`);
  }
}

/**
 * Keeps the agents the user connected on this computer pointing at the port and token in use, e.g.
 * after the saved port was taken or the token was replaced, and their rules files up to date. A
 * file this extension's entry was removed from is left alone.
 */
function refreshConnectedFiles(
  connections: readonly AgentConnection[],
  port: number,
  token: string,
  log: vscode.OutputChannel
): void {
  for (const connection of connections) {
    const folder = connection.folder ? workspaceFolder(connection.folder) : undefined;
    if (!folder) {
      continue;
    }
    const root = folder.uri.fsPath;
    try {
      if (connection.agent === "claude") {
        const target = path.join(root, ".mcp.json");
        const existing = readFileBelow(root, target);
        if (jsonMcpEntry(existing) && !claudeEntryMatches(existing, port, token)) {
          writeFileBelow(root, target, mergeClaudeMcpConfig(existing, claudeServerEntry(port, token)));
          log.appendLine(`${LOG} Updated ${target} for port ${port}`);
        }
      } else if (connection.agent === "codex") {
        const target = path.join(root, ".codex", "config.toml");
        const existing = readFileBelow(root, target);
        if (codexEntryState(existing) !== "none" && !codexEntryMatches(existing, port, token)) {
          writeFileBelow(root, target, mergeCodexConfig(existing, codexServerLines(port, token)));
          log.appendLine(`${LOG} Updated ${target} for port ${port}`);
        }
      }
      refreshRules(root, connection.agent, log);
    } catch (err) {
      log.appendLine(`${LOG} Could not update ${AGENTS[connection.agent].name}'s files in ${folder.name}: ${errorMessage(err)}`);
    }
  }
}

/** Brings a rules file this extension wrote up to date; a missing one, or one the user edited, is left alone. */
function refreshRules(root: string, agent: AgentId, log: vscode.OutputChannel): void {
  const file = AGENTS[agent].rulesFile;
  if (!file) {
    return;
  }
  const target = path.join(root, ...file.split("/"));
  if (shouldRewriteRules(readFileBelow(root, target), rulesText(agent), [])) {
    writeFileBelow(root, target, rulesText(agent), 0o644);
    log.appendLine(`${LOG} Updated ${target} to this version's rules`);
  }
}

/**
 * "Investigate with AI": right-click prompts that put a ready-made request into an agent's chat.
 * The prompt is not sent; the user reviews it and presses Enter.
 */
function registerInvestigateWithAi(
  ctx: CommandContext,
  state: { available(): AgentId[]; connections(): AgentConnection[]; enabled(): boolean }
): void {
  const { context, log } = ctx;

  // The Explorer menu shows only on checked-out files.
  trackCheckoutPaths(ctx);

  const investigate = (kind: BobPromptKind) => async (arg: unknown, all?: unknown[]) => {
    const found = investigatedMembers(ctx, arg, all);
    if (!hasMembersToInvestigate(found, "Investigate with AI")) {
      return;
    }
    const agents = state.available();
    if (agents.length === 0) {
      vscode.window.showInformationMessage("Install Claude Code, Codex or GitHub Copilot Chat to investigate members with an AI agent.");
      return;
    }
    const last = context.workspaceState.get<AgentId>(LAST_AGENT_KEY);
    const agent = agents.length === 1
      ? agents[0]
      : await pickAgent(agents, state.connections(), "Which AI agent should investigate?", last);
    if (!agent) {
      return;
    }
    await context.workspaceState.update(LAST_AGENT_KEY, agent);
    const { name } = AGENTS[agent];
    if (state.enabled() && !state.connections().some((connection) => connection.agent === agent)) {
      const choice = await vscode.window.showWarningMessage(
        `${name} isn't connected to the IBM i research tools, which the prompt asks it to use.`,
        "Connect",
        "Send Anyway"
      );
      if (choice === "Connect") {
        await vscode.commands.executeCommand("ibmi-member-workspace.agents.connect", { agent });
        if (!state.connections().some((connection) => connection.agent === agent)) {
          return;
        }
      } else if (choice !== "Send Anyway") {
        return;
      }
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const { text, skipped } = buildInvestigatePrompt(kind, found.members, roots, {
      mention: (relative) => mentionFor(agent, relative),
    });
    await sendPrompt(agent, text, log);
    warnLeftOut(skipped, found.notCheckedOut);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.agents.analyzeRelationships", investigate("relationships")),
    vscode.commands.registerCommand("ibmi-member-workspace.agents.explainProgram", investigate("explain")),
    vscode.commands.registerCommand("ibmi-member-workspace.agents.deepDive", investigate("deepDive"))
  );
}

/** Puts `prompt` in the agent's chat without sending it. It is also left on the clipboard. */
async function sendPrompt(agent: AgentId, prompt: string, log: vscode.OutputChannel): Promise<void> {
  const onClipboard = (name: string) =>
    `The prompt is on the clipboard. Open ${name}, paste it, review it, and press Enter.`;
  if (agent === "codex") {
    // Codex has no command that fills its input box, so the prompt is pasted, as into Bob's chat.
    await pasteIntoChat(prompt, { name: "Codex", views: CODEX_VIEWS, logTag: LOG }, log);
    return;
  }
  await vscode.env.clipboard.writeText(prompt);
  try {
    if (agent === "claude") {
      // Claude Code's documented link opens a new conversation with the prompt in its input box, not sent.
      const opened = await vscode.env.openExternal(vscode.Uri.from({
        scheme: vscode.env.uriScheme,
        authority: "anthropic.claude-code",
        path: "/open",
        query: claudePromptQuery(prompt),
      }));
      vscode.window.showInformationMessage(opened
        ? "The prompt is in a new Claude Code tab: review it and press Enter. It's also on the clipboard."
        : onClipboard("Claude Code"));
      return;
    }
    await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt, isPartialQuery: true, mode: "agent" });
    vscode.window.showInformationMessage("The prompt is in Copilot Chat: review it and press Enter. It's also on the clipboard.");
  } catch (err) {
    log.appendLine(`${LOG} Could not open ${AGENTS[agent].name} with the prompt: ${errorMessage(err)}`);
    vscode.window.showInformationMessage(onClipboard(AGENTS[agent].name));
  }
}

async function pickAgent(
  agents: readonly AgentId[],
  connections: readonly AgentConnection[],
  placeHolder: string,
  first?: AgentId
): Promise<AgentId | undefined> {
  if (agents.length === 0) {
    vscode.window.showInformationMessage("Install Claude Code, Codex or GitHub Copilot Chat to let an AI agent research your IBM i programs.");
    return undefined;
  }
  if (agents.length === 1) {
    return agents[0];
  }
  const connected = (agent: AgentId) => connections.some((connection) => connection.agent === agent);
  const ordered = [...agents].sort((a, b) =>
    Number(b === first) - Number(a === first) || Number(connected(b)) - Number(connected(a))
  );
  const choice = await vscode.window.showQuickPick(
    ordered.map((agent) => ({ label: AGENTS[agent].name, description: connected(agent) ? "connected" : undefined, agent })),
    { placeHolder }
  );
  return choice?.agent;
}

async function pickConnection(connections: readonly AgentConnection[]): Promise<AgentConnection | undefined> {
  if (connections.length <= 1) {
    return connections[0];
  }
  const choice = await vscode.window.showQuickPick(
    connections.map((connection) => {
      const folder = connection.folder ? workspaceFolder(connection.folder) : undefined;
      return { label: AGENTS[connection.agent].name, description: folder?.name, connection };
    }),
    { placeHolder: "Which AI agent should no longer use the IBM i research tools?" }
  );
  return choice?.connection;
}

async function pickFolder(agentName: string): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage(`Open a folder or workspace first: ${agentName} reads its settings from there.`);
    return undefined;
  }
  return folders.length === 1
    ? folders[0]
    : vscode.window.showWorkspaceFolderPick({ placeHolder: `Which folder should ${agentName} use the IBM i research tools in?` });
}

function workspaceFolder(uri: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === uri);
}

/** The agent a command argument names (a view row, or `{ agent }` from another command); anything else is ignored. */
function agentOf(arg: unknown): AgentId | undefined {
  const agent = (arg as { agent?: unknown } | undefined)?.agent;
  return agent === "claude" || agent === "codex" || agent === "copilot" ? agent : undefined;
}

/** The workspace folder a command argument names; only a folder open in this workspace is used. */
function folderOf(arg: unknown): vscode.WorkspaceFolder | undefined {
  const uri = (arg as { folderUri?: unknown } | undefined)?.folderUri;
  return typeof uri === "string" ? workspaceFolder(uri) : undefined;
}

/** The stored connection a view row stands for. */
function connectionOf(arg: unknown, connections: readonly AgentConnection[]): AgentConnection | undefined {
  const row = arg as Partial<Extract<AgentStatusRow, { kind: "agent" }>> | undefined;
  const agent = agentOf(row);
  if (!agent) {
    return undefined;
  }
  return connections.find((connection) =>
    connection.agent === agent && (agent === "copilot" || connection.folder === row?.folderUri)
  );
}
