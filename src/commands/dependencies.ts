import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  connectionLibraryList,
  findCompiledObject,
  findSourceMembers,
  getSystemName,
  libraryExists,
  objectSources,
  programReferences,
  runCrossReferenceQuery,
  sqlServicesAvailable,
} from "../codeForIBMi";
import { Resolution, librariesToSearch, resolveReferences } from "../dependencyResolve";
import { RawReference, ReferenceKind, scanReferences } from "../dependencyScan";
import {
  DependencyProvider,
  PROVIDER_GROUPS,
  ProviderGroup,
  ProviderOutcome,
  createCrossReferenceProvider,
  createProgramReferencesProvider,
  createSourceScanProvider,
  parseCrossReferenceConfigs,
  runProviders,
  selectProviders,
  summarizeRun,
} from "../dependencySources";
import { errorMessage } from "../errors";
import { MemberInfo } from "../memberInfo";
import { CheckedOutMember, TreeItemType, formatMemberPath, systemKey } from "../types";
import { checkoutMembersBatch } from "./checkout";
import { CommandContext } from "./context";
import { ensureWorkItemForCheckout } from "./git";

const KINDS: ReadonlyArray<{ kind: ReferenceKind; group: string; singular: string; plural: string }> = [
  { kind: "copybook", group: "Copybooks", singular: "copybook", plural: "copybooks" },
  { kind: "program", group: "Called programs", singular: "called program", plural: "called programs" },
  { kind: "file", group: "Referenced files", singular: "referenced file", plural: "referenced files" },
];

/** A valid member name; anything else (e.g. an IFS path) can't be looked up. */
const MEMBER_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/;

type DependencyItem = vscode.QuickPickItem & { member?: MemberInfo };

export function registerDependencyCommands(ctx: CommandContext): void {
  ctx.context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.findDependencies",
      async (item: TreeItemType) => {
        if (item?.kind === "member") {
          await reviewDependencies(ctx, item.entry);
        }
      }
    )
  );
}

/**
 * After a single checkout, offers to review what the member uses. It makes no IBM i
 * calls: it is offered when the local scan finds something, or when a provider that asks
 * the IBM i applies to the member and isn't known to be missing on this system.
 */
export async function suggestDependencies(ctx: CommandContext, entry: CheckedOutMember): Promise<void> {
  const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
  if (!config.get<boolean>("dependencies.suggestAfterCheckout", true)) {
    return;
  }
  let refs: RawReference[];
  try {
    refs = scanReferences(fs.readFileSync(entry.localPath, "utf-8"), entry.extension);
  } catch {
    return;
  }
  const remoteMayHelp = activeProviders(ctx, entry.system).some((provider) =>
    provider.group !== "source" &&
    provider.applies(entry) &&
    ctx.dependencyAvailability.known(entry.system, provider.id)?.ok !== false
  );
  if (refs.length === 0 && !remoteMayHelp) {
    return;
  }
  const memberPath = formatMemberPath(entry);
  const choice = await vscode.window.showInformationMessage(
    refs.length > 0 ? `${memberPath} uses ${describeCounts(refs)}.` : `Look up what ${memberPath} uses?`,
    "Review Dependencies"
  );
  if (choice === "Review Dependencies") {
    await reviewDependencies(ctx, entry);
  }
}

/**
 * Asks every dependency provider available on this system what `entry` uses, lets the
 * user pick which members to bring in, and checks them out as read-only reference copies.
 * Changing one goes through change management instead.
 */
export async function reviewDependencies(ctx: CommandContext, entry: CheckedOutMember): Promise<void> {
  const { service, log } = ctx;
  const memberPath = formatMemberPath(entry);
  const system = getSystemName();
  if (!system) {
    vscode.window.showErrorMessage("Not connected to IBM i.");
    return;
  }
  if (systemKey(system) !== systemKey(entry.system)) {
    vscode.window.showErrorMessage(`Connect to ${entry.system} to find the dependencies of ${memberPath}.`);
    return;
  }

  const libraryOrder = searchLibraries();
  let references: RawReference[];
  let outcomes: ProviderOutcome[];
  let resolution: Resolution;
  try {
    ({ references, outcomes, resolution } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Looking up the dependencies of ${memberPath}...` },
      async () => {
        const run = await runProviders(
          activeProviders(ctx, system),
          entry,
          { system, libraries: libraryOrder },
          ctx.dependencyAvailability
        );
        const lookup = run.references.filter((ref) => !ref.unresolvable && MEMBER_NAME.test(ref.member));
        const rows = await findSourceMembers(
          [...new Set(lookup.map((ref) => ref.member))],
          librariesToSearch(lookup, libraryOrder)
        );
        return { ...run, resolution: resolveReferences(run.references, rows, libraryOrder) };
      }
    ));
  } catch (err) {
    log.appendLine(`[dependencies] Lookup failed for ${memberPath}: ${errorMessage(err)}`);
    vscode.window.showErrorMessage(`Could not look up the dependencies of ${memberPath}: ${errorMessage(err)}`);
    return;
  }

  const summary = summarizeRun(outcomes);
  logOutcomes(ctx, memberPath, outcomes);
  const failed = outcomes.filter((o) => o.status === "failed").map((o) => o.label);
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(
      `${failed.join(", ")} failed while looking up ${memberPath}. See the IBM i Member Workspace output panel.`
    );
  }
  if (references.length === 0) {
    vscode.window.showInformationMessage(`No dependencies found for ${memberPath}. ${summary}.`);
    return;
  }

  const items = buildItems(ctx, system, resolution);
  if (items.length === 0) {
    reportUnresolved(ctx, memberPath, resolution.unresolved);
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Dependencies of ${memberPath}`,
    placeHolder: `Choose the members to bring into your checkout folder — ${summary}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  const members = (picked ?? []).flatMap((item) => (item.member ? [item.member] : []));
  if (members.length === 0) {
    reportUnresolved(ctx, memberPath, resolution.unresolved);
    return;
  }

  const count = members.length === 1 ? "1 member" : `${members.length} members`;
  const choice = await vscode.window.showInformationMessage(
    `Bring ${count} as read-only reference copies?`,
    {
      modal: true,
      detail: "Reference copies are for reading: they can't be uploaded or merged back. " +
        "To change a member, check it out through your change-management system (for example, Rocket LMI) instead.",
    },
    "Bring for Reference",
    "I Need to Change Some…"
  );
  if (choice === "I Need to Change Some…") {
    await showChangeGuide(members);
    return;
  }
  if (choice !== "Bring for Reference" || !(await ensureWorkItemForCheckout(ctx, system))) {
    return;
  }
  await checkoutMembersBatch(service, system, members, log, { reference: true });
  reportUnresolved(ctx, memberPath, resolution.unresolved);
}

/** Every provider the settings turn on for `system`; availability is checked when they run. */
function activeProviders(ctx: CommandContext, system: string): DependencyProvider[] {
  const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
  const { configs, problems } = parseCrossReferenceConfigs(config.get<unknown>("dependencies.crossReferences", []));
  for (const problem of problems) {
    ctx.log.appendLine(`[dependencies] dependencies.crossReferences: ${problem}`);
  }
  const enabled = new Set(
    config.get<string[]>("dependencies.sources", [...PROVIDER_GROUPS])
      .filter((group): group is ProviderGroup => (PROVIDER_GROUPS as readonly string[]).includes(group))
  );
  const providers: DependencyProvider[] = [
    createSourceScanProvider((entry) => fs.readFileSync(entry.localPath, "utf-8")),
    createProgramReferencesProvider({ sqlServicesAvailable, findCompiledObject, programReferences, objectSources }),
    ...configs.map((xref) => createCrossReferenceProvider(xref, {
      libraryExists,
      runQuery: runCrossReferenceQuery,
      log: (message) => ctx.log.appendLine(message),
    })),
  ];
  return selectProviders(providers, { enabled, system });
}

function logOutcomes(ctx: CommandContext, memberPath: string, outcomes: ProviderOutcome[]): void {
  ctx.log.appendLine(`[dependencies] ${memberPath}:`);
  for (const outcome of outcomes) {
    ctx.log.appendLine(`  ${outcome.label}: ${
      outcome.status === "ran" ? `${outcome.count} found${outcome.note ? ` (${outcome.note})` : ""}`
        : outcome.status === "unavailable" ? `not available on this system (${outcome.reason})`
          : `failed: ${outcome.error}`
    }`);
  }
}

/** The configured libraries, or the connection's library list. */
function searchLibraries(): string[] {
  const configured = vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .get<string[]>("dependencies.searchLibraries", [])
    .map((library) => library.trim().toUpperCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : connectionLibraryList();
}

/** One item per member found, grouped by kind. Copybooks not yet checked out are preselected. */
function buildItems(ctx: CommandContext, system: string, resolution: Resolution): DependencyItem[] {
  const items: DependencyItem[] = [];
  const seen = new Set<string>();
  for (const { kind, group } of KINDS) {
    const groupItems: DependencyItem[] = [];
    for (const { reference, candidates } of resolution.resolved.filter((r) => r.reference.kind === kind)) {
      const [best, ...others] = candidates;
      const key = `${best.library}/${best.sourceFile}/${best.member}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const existing = ctx.service.findEntry(system, best.library, best.sourceFile, best.member);
      const where = reference.line !== undefined ? `Line ${reference.line}: ${reference.text}` : reference.text;
      const foundBy = reference.foundBy?.length ? ` · found by ${reference.foundBy.join(", ")}` : "";
      const alsoIn = others.length > 0
        ? ` · also in ${others.length} other source file${others.length === 1 ? "" : "s"}`
        : "";
      groupItems.push({
        label: best.member,
        description: `${best.library}/${best.sourceFile}${existing ? " · already checked out" : ""}`,
        detail: `${where}${foundBy}${alsoIn}`,
        picked: kind === "copybook" && !existing,
        member: {
          library: best.library,
          sourceFile: best.sourceFile,
          memberName: best.member,
          extension: (best.sourceType || "mbr").toLowerCase(),
        },
      });
    }
    if (groupItems.length > 0) {
      items.push({ label: group, kind: vscode.QuickPickItemKind.Separator }, ...groupItems);
    }
  }
  return items;
}

async function showChangeGuide(members: MemberInfo[]): Promise<void> {
  const paths = members.map((m) => `${m.library}/${m.sourceFile}(${m.memberName})`);
  const choice = await vscode.window.showInformationMessage(
    "Change these members through your change-management system",
    {
      modal: true,
      detail: `Check out ${paths.length === 1 ? "this member" : "these members"} in your change-management system ` +
        "(for example, Rocket LMI) so the change is tracked, then use Check Out Member on the copy in your " +
        `development library:\n\n${paths.join("\n")}`,
    },
    "Copy Member Paths"
  );
  if (choice === "Copy Member Paths") {
    await vscode.env.clipboard.writeText(paths.join("\n"));
  }
}

function reportUnresolved(ctx: CommandContext, memberPath: string, unresolved: RawReference[]): void {
  if (unresolved.length === 0) {
    return;
  }
  const names = [...new Set(unresolved.map((ref) => ref.unresolvable ? `${ref.member} (${ref.unresolvable})` : ref.member))];
  ctx.log.appendLine(`[dependencies] Source not found for dependencies of ${memberPath}:`);
  for (const ref of unresolved) {
    const where = ref.line !== undefined ? `line ${ref.line}: ` : "";
    ctx.log.appendLine(`  ${where}${ref.text}${ref.unresolvable ? ` (${ref.unresolvable})` : ""} → ${ref.member}`);
  }
  void vscode.window
    .showWarningMessage(
      `Source not found for: ${names.join(", ")}. It may be in libraries that were not searched.`,
      "Search Libraries…"
    )
    .then((choice) => {
      if (choice) {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "ibmi-member-workspace.dependencies.searchLibraries"
        );
      }
    });
}

function describeCounts(refs: RawReference[]): string {
  return KINDS.flatMap(({ kind, singular, plural }) => {
    const count = refs.filter((ref) => ref.kind === kind).length;
    return count === 0 ? [] : [`${count} ${count === 1 ? singular : plural}`];
  }).join(", ");
}
