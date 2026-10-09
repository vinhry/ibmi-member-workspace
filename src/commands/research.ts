import * as vscode from "vscode";
import { MAX_WHERE_USED_LIBRARIES, SYSTEM_LIBRARIES } from "../bobMcpTools";
import {
  OperationCancelledError,
  WhereUsedRow,
  describeFile,
  describeObject,
  findCompiledObject,
  getSystemName,
  jobLogMessages,
  objectSources,
  searchSourceMembers,
  serviceProgramExports,
  whereUsed,
} from "../codeForIBMi";
import { objectKey } from "../dependencySources";
import { errorMessage } from "../errors";
import { foundMembersOf } from "../findMemberView";
import type { BrowserNode, MemberInfo } from "../memberInfo";
import { resolveMember } from "../prompts";
import {
  fileDescriptionReport,
  jobLogReport,
  objectDescriptionReport,
  objectTypeForSourceType,
  serviceProgramExportsReport,
  whereUsedReport,
} from "../researchReport";
import { bringReferenceCopiesFor, memberInfoOf } from "./checkout";
import { CommandContext } from "./context";
import { searchLibraries } from "./dependencies";

/**
 * The research tools for people: Find Where Used, Describe File, Describe Program, Service Program
 * Exports and Show Job Log, run on a member from Checked Out Members, Find Member, the Object
 * Browser, the editor or the Explorer, or on a name typed in. Each result opens as a read-only
 * document, so it can be searched and copied. The same IBM i queries serve the agents' tools.
 */

const SCHEME = "ibmi-research";
const OBJECT_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/i;
const JOB_NAME = /^\d{6}\/[A-Z0-9_$#@]{1,10}\/[A-Z0-9_$#@]{1,10}$/i;
/** Messages Show Job Log reads. */
const JOB_LOG_MESSAGES = 200;

/** An object a research command works on: the member name doubles as the object's. */
interface ResearchTarget {
  name: string;
  sourceType?: string;
}

/** Reports shown as read-only documents; each is kept until its document closes. */
class ReportProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly reports = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private counter = 0;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) {
        this.reports.delete(doc.uri.toString());
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.reports.get(uri.toString()) ?? "This report was closed. Run the command again.\n";
  }

  async open(title: string, text: string): Promise<void> {
    const file = title.replace(/[\\/:*?"<>|]/g, "_");
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${file}.txt`, query: String(++this.counter) });
    this.reports.set(uri.toString(), text);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export function registerResearchCommands(ctx: CommandContext): void {
  const { context } = ctx;
  const reports = new ReportProvider();
  context.subscriptions.push(reports, vscode.workspace.registerTextDocumentContentProvider(SCHEME, reports));

  /** A command on members (or a typed name): the handler for `run`. */
  const onMembers = (
    what: string,
    prompt: string,
    run: (target: ResearchTarget, system: string) => Promise<void>
  ) => async (arg: unknown, all?: unknown[]) => {
        const system = getSystemName();
        if (!system) {
          vscode.window.showWarningMessage(`Connect to an IBM i first: ${what} asks it.`);
          return;
        }
        const targets = arg === undefined || arg === null
          ? await askForName(ctx, what, prompt)
          : targetsOf(ctx, arg, all);
        if (targets.length === 0) {
          return;
        }
        for (const target of targets) {
          try {
            await run(target, system);
          } catch (err) {
            if (!(err instanceof OperationCancelledError)) {
              vscode.window.showErrorMessage(`${what} failed for ${target.name}: ${errorMessage(err)}`);
            }
          }
        }
      };

  context.subscriptions.push(vscode.commands.registerCommand(
    "ibmi-member-workspace.research.findWhereUsed",
    onMembers("Find Where Used", "Program, service program or file name", async (target, system) => {
    const all = searchLibraries().filter((library) => !SYSTEM_LIBRARIES.has(library));
    const searched = all.slice(0, MAX_WHERE_USED_LIBRARIES);
    const leftOut = all.slice(MAX_WHERE_USED_LIBRARIES);
    const objectType = objectTypeForSourceType(target.sourceType ?? "");
    const rows: WhereUsedRow[] = [];
    const failed: Array<{ library: string; error: string }> = [];
    const read: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Finding where ${target.name} is used...`, cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        for (const [index, library] of searched.entries()) {
          if (token.isCancellationRequested) {
            break;
          }
          progress.report({ message: `${library} (${index + 1}/${searched.length})`, increment: 100 / searched.length });
          try {
            rows.push(...(await whereUsed(target.name, library, objectType, { signal: controller.signal })).rows);
          } catch (err) {
            if (err instanceof OperationCancelledError) {
              break;
            }
            failed.push({ library, error: errorMessage(err) });
          }
          read.push(library);
        }
      }
    );
    await reports.open(
      `Where Used ${target.name}`,
      whereUsedReport({ object: target.name, objectType, system, librariesSearched: read, librariesLeftOut: leftOut, librariesNotRead: failed, rows })
    );
    if (rows.length > 0) {
      await offerSourcesForReference(ctx, system, rows);
    }
  })));

  context.subscriptions.push(vscode.commands.registerCommand(
    "ibmi-member-workspace.research.describeFile",
    onMembers("Describe File", "File, table or view name", async (target, system) => {
    const libraries = searchLibraries();
    const file = await withNotification(`Describing ${target.name}...`, () => describeFile(target.name, libraries));
    if (!file) {
      vscode.window.showWarningMessage(`No file or table named ${target.name} in ${libraries.join(", ") || "the search libraries"}.`);
      return;
    }
    await reports.open(`File ${file.library}/${file.systemName}`, fileDescriptionReport(file, system));
  })));

  context.subscriptions.push(vscode.commands.registerCommand(
    "ibmi-member-workspace.research.describeObject",
    onMembers("Describe Program", "Program or service program name", async (target, system) => {
    const libraries = searchLibraries();
    const object = await withNotification(`Describing ${target.name}...`, () => describeObject(target.name, libraries));
    if (!object) {
      vscode.window.showWarningMessage(`No program or service program named ${target.name} in ${libraries.join(", ") || "the search libraries"}.`);
      return;
    }
    await reports.open(`${object.type === "*SRVPGM" ? "Service program" : "Program"} ${object.library}/${object.name}`, objectDescriptionReport(object, system));
  })));

  context.subscriptions.push(vscode.commands.registerCommand(
    "ibmi-member-workspace.research.serviceProgramExports",
    onMembers("Service Program Exports", "Service program name", async (target, system) => {
    const libraries = searchLibraries();
    const program = await withNotification(`Reading the exports of ${target.name}...`, () => serviceProgramExports(target.name, libraries));
    if (!program) {
      vscode.window.showWarningMessage(`No service program named ${target.name} in ${libraries.join(", ") || "the search libraries"}.`);
      return;
    }
    await reports.open(`Exports ${program.library}/${program.name}`, serviceProgramExportsReport(program, system));
  })));

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.research.jobLog", async () => {
      const system = getSystemName();
      if (!system) {
        vscode.window.showWarningMessage("Connect to an IBM i first: Show Job Log reads a job there.");
        return;
      }
      const job = await vscode.window.showInputBox({
        title: "Show Job Log",
        prompt: "Job as number/user/name (as WRKACTJOB shows it), or * for the job this connection runs commands in",
        value: "*",
        validateInput: (value) => (value.trim() === "*" || JOB_NAME.test(value.trim()) ? undefined : "number/user/name, or *"),
      });
      if (!job) {
        return;
      }
      try {
        const log = await withNotification("Reading the job log...", () =>
          jobLogMessages({ job: job.trim().toUpperCase(), maxMessages: JOB_LOG_MESSAGES, minSeverity: 0 })
        );
        await reports.open(`Job log ${log.job.replace(/\//g, "_")}`, jobLogReport(log, system));
      } catch (err) {
        vscode.window.showErrorMessage(`Show Job Log failed: ${errorMessage(err)}`);
      }
    })
  );
}

/** The objects a right-click stands for: checkouts, files in the Explorer or editor, Find Member results, Object Browser members. */
function targetsOf(ctx: CommandContext, arg: unknown, all?: unknown[]): ResearchTarget[] {
  const selections = all && all.length > 1 ? all : [arg];
  const targets: ResearchTarget[] = [];
  for (const item of selections) {
    const entry = resolveMember(ctx.service, item);
    if (entry) {
      targets.push({ name: entry.memberName, sourceType: entry.extension });
      continue;
    }
    const found = foundMembersOf(item, undefined);
    if (found.length > 0) {
      targets.push(...found.map((member: MemberInfo) => ({ name: member.memberName, sourceType: member.extension })));
      continue;
    }
    const info = memberInfoOf(item as BrowserNode);
    if (info) {
      targets.push({ name: info.memberName, sourceType: info.extension });
    }
  }
  if (targets.length === 0) {
    vscode.window.showInformationMessage("Select a member first.");
  }
  return targets;
}

/** Asks for a name, suggesting the member open in the editor. */
async function askForName(ctx: CommandContext, what: string, prompt: string): Promise<ResearchTarget[]> {
  const active = resolveMember(ctx.service, undefined);
  const typed = await vscode.window.showInputBox({
    title: what,
    prompt: `${prompt} (looked for in the dependency search libraries)`,
    value: active?.memberName,
    validateInput: (value) => (OBJECT_NAME.test(value.trim()) ? undefined : "An IBM i object name of up to 10 characters"),
  });
  if (!typed) {
    return [];
  }
  const name = typed.trim().toUpperCase();
  return [{ name, sourceType: active && active.memberName === name ? active.extension : undefined }];
}

async function withNotification<T>(title: string, run: () => Promise<T>): Promise<T> {
  return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, run);
}

/** Offers to bring the source of the programs found as read-only reference copies. */
async function offerSourcesForReference(ctx: CommandContext, system: string, rows: WhereUsedRow[]): Promise<void> {
  const programs = [...new Map(rows.map((row) => [`${row.library}/${row.program}`, row])).values()];
  const chosen = await vscode.window.showQuickPick(
    programs.map((row) => ({ label: `${row.library}/${row.program}`, description: row.text, row })),
    { canPickMany: true, title: "Bring the source of these programs for reference?", placeHolder: "Programs whose source to bring as read-only reference copies" }
  );
  if (!chosen || chosen.length === 0) {
    return;
  }
  const members: MemberInfo[] = [];
  const notFound: string[] = [];
  await withNotification("Finding the programs' source...", async () => {
    for (const { row } of chosen) {
      const member = await sourceOfProgram(row.library, row.program).catch((err) => {
        ctx.log.appendLine(`[research] Could not find the source of ${row.library}/${row.program}: ${errorMessage(err)}`);
        return undefined;
      });
      if (member) {
        members.push(member);
      } else {
        notFound.push(`${row.library}/${row.program}`);
      }
    }
  });
  if (members.length > 0) {
    const results = await bringReferenceCopiesFor(ctx, system, members);
    const brought = results.filter((result) => result.status === "brought").length;
    vscode.window.showInformationMessage(
      `Brought ${brought} member(s) for reference` +
      (results.length - brought > 0 ? `; ${results.length - brought} already checked out or failed (see the output panel)` : "") +
      (notFound.length > 0 ? `. No source found for ${notFound.join(", ")}.` : ".")
    );
  } else {
    vscode.window.showWarningMessage(`No source member found for ${notFound.join(", ")}.`);
  }
}

/** The source member a program was compiled from, with its source type. */
async function sourceOfProgram(library: string, program: string): Promise<MemberInfo | undefined> {
  const object = await findCompiledObject(program, [library]);
  if (!object) {
    return undefined;
  }
  const sources = await objectSources([{ library: object.library, name: object.name, type: object.type, kind: "program" }]);
  const source = sources.get(objectKey(object));
  if (!source) {
    return undefined;
  }
  const [row] = await searchSourceMembers(source.member, [source.library], { sourceFile: source.sourceFile, limit: 1 });
  return row
    ? { library: row.library, sourceFile: row.sourceFile, memberName: row.member, extension: (row.sourceType || "mbr").toLowerCase() }
    : undefined;
}
