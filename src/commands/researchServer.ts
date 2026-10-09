import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { MCP_SERVER_NAME } from "../agentFiles";
import { BobMcpServer, McpTool } from "../bobMcpServer";
import { SERVER_INSTRUCTIONS, createResearchTools } from "../bobMcpTools";
import {
  OperationCancelledError,
  describeFile,
  describeObject,
  downloadMemberContent,
  findSourceMembers,
  getSystemName,
  jobLogMessages,
  listSpooledFiles,
  readSpooledFile,
  runReadOnlyQuery,
  sampleFileRows,
  searchSourceMembers,
  serviceProgramExports,
  whereUsed,
} from "../codeForIBMi";
import { withDeadline } from "../deadline";
import { errorMessage } from "../errors";
import { systemKey } from "../types";
import { readCheckoutText } from "../localPath";
import { bringReferenceCopiesFor } from "./checkout";
import { CommandContext } from "./context";
import { lookupDependencies, searchLibraries } from "./dependencies";

export interface ResearchServerOptions {
  /** Prefix of this host's secret and workspaceState keys: "bob" in IBM Bob, "agents" in VS Code. */
  keyPrefix: string;
  /** Prefix of its lines in the output panel, e.g. "[bob]". */
  logTag: string;
  /** Whether the user's setting lets the tools run. */
  enabled(): boolean;
  /** The full name of the setting that limits `find_where_used`'s libraries, as the tools name it. */
  whereUsedSetting: string;
  /** After each successful start, with the port and token in use: keep connected agents pointing at them. */
  onStarted(port: number, token: string): void | Promise<void>;
  /** Whenever the port or the start error changes. */
  onStateChange(): void;
}

/**
 * The research tools' local MCP server for one workspace: its token (in secret storage, one per
 * workspace, so a token copied from one project opens no other), its port (kept so agents' config
 * files rarely need rewriting), and starting and stopping it. Used by IBM Bob's and VS Code's agents.
 */
export class ResearchServer implements vscode.Disposable {
  private server: BobMcpServer | undefined;
  private starting: Promise<void> | undefined;
  /** Bumped by every stop, so a start still in progress knows it was overtaken. */
  private generation = 0;
  private currentPort: number | undefined;
  private currentToken: string | undefined;
  private lastStartError: string | undefined;
  readonly tools: McpTool[];

  constructor(private readonly ctx: CommandContext, private readonly options: ResearchServerOptions) {
    this.tools = createTools(ctx, options.whereUsedSetting);
  }

  get port(): number | undefined {
    return this.currentPort;
  }

  get token(): string | undefined {
    return this.currentToken;
  }

  /** Why the last start failed, until a start succeeds. */
  get startError(): string | undefined {
    return this.lastStartError;
  }

  get toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  /** Starts the server unless it runs or the setting is off. Concurrent starts share one. */
  start(): Promise<void> {
    if (this.server || !this.options.enabled()) {
      return Promise.resolve();
    }
    if (!this.starting) {
      const promise: Promise<void> = this.startNow().finally(() => {
        if (this.starting === promise) {
          this.starting = undefined;
        }
      });
      this.starting = promise;
    }
    return this.starting;
  }

  /** Starts the server, logging a failure instead of throwing. */
  startQuietly(): void {
    void this.start().catch((err) =>
      this.ctx.log.appendLine(`${this.options.logTag} Could not start the research tools: ${errorMessage(err)}`)
    );
  }

  stop(): void {
    this.halt();
    this.options.onStateChange();
  }

  /** Forgets the start error, e.g. when the setting turned the tools off. */
  clearStartError(): void {
    this.lastStartError = undefined;
  }

  /**
   * Replaces the token and closes open connections, so a copy of an old config file stops working at
   * once. The server comes back with the new token when `restart` is true.
   */
  async rotateToken(restart: boolean): Promise<void> {
    // Deleted before stopping, so a start in between can't bring the server back with the old token.
    await this.ctx.context.secrets.delete(this.tokenKey());
    this.currentToken = undefined;
    this.stop();
    if (restart) {
      this.startQuietly();
    }
  }

  /** Stops without redrawing: on shutdown the views may already be gone. */
  dispose(): void {
    this.halt();
  }

  private halt(): void {
    this.generation++;
    this.starting = undefined;
    this.server?.dispose();
    this.server = undefined;
    this.currentPort = undefined;
  }

  private async startNow(): Promise<void> {
    try {
      await this.listen();
      this.lastStartError = undefined;
    } catch (err) {
      this.lastStartError = errorMessage(err);
      throw err;
    } finally {
      this.options.onStateChange();
    }
  }

  private async listen(): Promise<void> {
    const { context, log } = this.ctx;
    const mine = this.generation;
    if (this.options.keyPrefix === "bob") {
      // The single token 1.6.0 builds used, before there was one per workspace.
      await context.secrets.delete("bob.mcpToken");
    }
    let token = await context.secrets.get(this.tokenKey());
    if (!token) {
      token = crypto.randomBytes(32).toString("hex");
      await context.secrets.store(this.tokenKey(), token);
    }
    const candidate = new BobMcpServer(this.tools, token, {
      name: MCP_SERVER_NAME,
      version: String(context.extension.packageJSON.version ?? ""),
      instructions: SERVER_INSTRUCTIONS,
    }, (message) => log.appendLine(message));
    const listening = await candidate.start(context.workspaceState.get<number>(this.portKey()));
    // Stopped (turned off, or Disconnect) while this start was under way: don't come back up.
    if (mine !== this.generation || !this.options.enabled()) {
      candidate.dispose();
      return;
    }
    this.server = candidate;
    this.currentPort = listening;
    this.currentToken = token;
    await context.workspaceState.update(this.portKey(), listening);
    log.appendLine(`${this.options.logTag} Research tools listening on 127.0.0.1:${listening}`);
    await this.options.onStarted(listening, token);
  }

  /** Secret storage key of the token, one per workspace: a token copied from one project opens no other. */
  private tokenKey(): string {
    const identity = vscode.workspace.workspaceFile?.toString() ??
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).join("|");
    return `${this.options.keyPrefix}.mcpToken.${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  }

  /** workspaceState key of the port, kept so config files rarely need rewriting. */
  private portKey(): string {
    return `${this.options.keyPrefix}.mcpPort`;
  }
}

let referenceQueue: Promise<unknown> = Promise.resolve();

function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = referenceQueue.then(fn, fn);
  referenceQueue = run.catch(() => undefined);
  return run;
}

function createTools(ctx: CommandContext, whereUsedSetting: string): McpTool[] {
  const { service } = ctx;
  const [section, ...rest] = whereUsedSetting.split(".");
  return createResearchTools({
    connectedSystem: getSystemName,
    entries: (system) => service.getEntriesForSystem(system),
    findEntry: (system, library, sourceFile, member) => service.findEntry(system, library, sourceFile, member),
    findMembers: findSourceMembers,
    // One batch at a time, so two calls can't both download (and index) the same member.
    bringReferenceCopies: (system, members, signal) => serially(() => bringReferenceCopiesFor(ctx, system, members, signal)),
    // Research tools may run without asking, so a link planted at a checkout path must not turn
    // them into a way to read any file on this computer.
    readLocal: (localPath) => readCheckoutText(service.getCheckoutRoot()?.fsPath, localPath),
    lookupDependencies: (system, entry) => lookupDependencies(ctx, system, entry),
    searchLibraries,
    whereUsedLibraryLimit: () => vscode.workspace.getConfiguration(section).get<number>(rest.join(".")),
    whereUsedSetting,
    whereUsed,
    searchSourceMembers,
    describeFile,
    serviceProgramExports,
    downloadMember: (system, library, sourceFile, member, signal) => {
      const connected = getSystemName();
      if (!connected || systemKey(connected) !== systemKey(system)) {
        return Promise.reject(new Error(`Not connected to ${system}.`));
      }
      return withDeadline(downloadMemberContent(library, sourceFile, member), {
        ms: DOWNLOAD_TIMEOUT_MS,
        what: `downloading ${library}/${sourceFile}(${member})`,
        signal,
        cancelled: () => new OperationCancelledError(),
      });
    },
    describeObject,
    jobLogMessages,
    sampleFileRows,
    allowDataSamples: () => vscode.workspace.getConfiguration("ibmi-member-workspace").get<boolean>("researchTools.allowDataSamples", false),
    dataSamplesSetting: "ibmi-member-workspace.researchTools.allowDataSamples",
    runQuery: runReadOnlyQuery,
    listSpooledFiles,
    readSpooledFile,
  });
}

/** How long a tool waits for a member download, as the checkout service does. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
