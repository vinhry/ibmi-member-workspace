import * as vscode from "vscode";
import {
  connectionLibraryList,
  downloadMemberContent,
  findCompiledObject,
  findSourceMembers,
  getSystemName,
  libraryExists,
  objectSources,
  programReferences,
  connectedUser,
  runClCommand,
  runCrossReferenceQuery,
  sqlServicesAvailable,
} from "../codeForIBMi";
import {
  Resolution,
  SearchScope,
  SearchScopeKind,
  SourceMemberRow,
  describeScope,
  librariesToSearch,
  resolveReferences,
  scopeReferences,
  searchScopeFrom,
} from "../dependencyResolve";
import { RawReference, ReferenceKind, scanReferences } from "../dependencyScan";
import {
  DependencyProvider,
  DependencySubject,
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
import { WalkLimitReached, WalkUnresolved, mergeOutcomes, walkDependencies } from "../dependencyWalk";
import { ChangeCheckoutResult, nameValueProblem, runChangeManagementCheckout } from "../changeManagement";
import { errorMessage } from "../errors";
import { readCheckoutText } from "../localPath";
import type { BrowserNode, MemberInfo } from "../memberInfo";
import { resolveMember, resolveMemberSelections } from "../prompts";
import { CheckedOutMember, TreeItemType, formatMemberPath, systemKey } from "../types";
import { checkoutMembersBatch, memberInfoOf } from "./checkout";
import { CommandContext } from "./context";
import { foundMembersOf } from "../findMemberView";
import { ensureWorkItemForCheckout } from "./git";

const KINDS: ReadonlyArray<{ kind: ReferenceKind; group: string; singular: string; plural: string }> = [
  { kind: "copybook", group: "Copybooks", singular: "copybook", plural: "copybooks" },
  { kind: "program", group: "Called programs", singular: "called program", plural: "called programs" },
  { kind: "file", group: "Referenced files", singular: "referenced file", plural: "referenced files" },
  { kind: "table", group: "SQL tables and views", singular: "SQL table", plural: "SQL tables" },
  // Procedures are counted but never offered: they have no member of their own.
  { kind: "procedure", group: "Bound procedures", singular: "bound procedure", plural: "bound procedures" },
];

export interface DependencyLookup {
  references: RawReference[];
  outcomes: ProviderOutcome[];
  /** Resolution of every reference except procedures, which are never members. */
  resolution: Resolution;
  /** Bound procedures the member calls, by name. */
  procedures: RawReference[];
  /** The libraries searched, in order; for "everywhere", the order that ranks what was found. */
  libraries: string[];
  scope?: SearchScopeKind;
}

/**
 * Asks every dependency provider available on `system` what a member uses. A member that isn't
 * checked out has its source read from the IBM i, without writing it to disk.
 */
export async function lookupDependencies(
  ctx: CommandContext,
  system: string,
  subject: DependencySubject,
  scope: SearchScope = searchScope(ctx)
): Promise<DependencyLookup> {
  const { libraries } = scope;
  const run = await runProviders(
    activeProviders(ctx, system),
    subject,
    { system, libraries, scope: scope.kind },
    ctx.dependencyAvailability
  );
  const procedures = run.references.filter((ref) => ref.kind === "procedure");
  const { references: members, outside } = scopeReferences(
    run.references.filter((ref) => ref.kind !== "procedure"),
    scope
  );
  for (const { reference, library } of outside) {
    const where = [library, reference.sourceFile].filter(Boolean).join("/");
    ctx.log.appendLine(
      `[dependencies] ${where}(${reference.member}) is outside ${describeScope(scope)}; looked for ${reference.member} there instead`
    );
  }
  const lookup = members.filter((ref) => !ref.unresolvable && MEMBER_NAME.test(ref.member));
  const rows = await findSourceMembers(
    [...new Set(lookup.map((ref) => ref.member))],
    librariesToSearch(scope)
  );
  return { ...run, procedures, resolution: resolveReferences(members, rows, libraries), libraries, scope: scope.kind };
}

/** A valid member name; anything else (e.g. an IFS path) can't be looked up. */
const MEMBER_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/;

type DependencyItem = vscode.QuickPickItem & { member?: MemberInfo };

/** A member offered in the picker; `via` lists the members between the checkout and it. */
interface OfferedDependency {
  reference: RawReference;
  candidates: SourceMemberRow[];
  via?: string[];
}

export function registerDependencyCommands(ctx: CommandContext): void {
  ctx.context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.findDependencies",
      async (item: TreeItemType) => {
        const entry = resolveMember(ctx.service, item);
        if (entry) {
          await reviewDependencies(ctx, entry);
        }
      }
    ),
    vscode.commands.registerCommand(
      "ibmi-member-workspace.findAllDependencies",
      async (item: TreeItemType) => {
        const entry = resolveMember(ctx.service, item);
        if (entry) {
          await reviewAllDependencies(ctx, entry);
        }
      }
    ),
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkoutThroughChangeManagement",
      async (arg: unknown, all?: unknown[]) => {
        const system = getSystemName();
        if (!system) {
          vscode.window.showWarningMessage("Connect to an IBM i first.");
          return;
        }
        const members = selectedMembers(ctx, arg, all);
        if (members.length > 0) {
          await changeThroughChangeManagement(ctx, system, members);
        }
      }
    )
  );
}

/** The members a right-click stands for: Object Browser members, Checked Out Members items, or Find Member results. */
function selectedMembers(ctx: CommandContext, arg: unknown, all?: unknown[]): MemberInfo[] {
  if ((arg as { kind?: unknown } | undefined)?.kind === "found") {
    return foundMembersOf(arg, all);
  }
  if ((arg as { kind?: unknown } | undefined)?.kind === "member") {
    return resolveMemberSelections(ctx.service, arg as TreeItemType, all as TreeItemType[] | undefined).map(({ entry }) => ({
      library: entry.library,
      sourceFile: entry.sourceFile,
      memberName: entry.memberName,
      extension: entry.extension,
    }));
  }
  const nodes = all && all.length > 1 ? all : [arg];
  return nodes.flatMap((node) => {
    const info = memberInfoOf(node as BrowserNode);
    return info ? [info] : [];
  });
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
    refs = scanReferences(readCheckoutText(ctx.service.getCheckoutRoot()?.fsPath, entry.localPath), entry.extension);
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
export async function reviewDependencies(
  ctx: CommandContext,
  entry: CheckedOutMember,
  scopeOverride?: SearchScopeKind
): Promise<void> {
  const { log } = ctx;
  const memberPath = formatMemberPath(entry);
  const system = connectedSystemFor(entry, memberPath);
  if (!system) {
    return;
  }
  const scope = searchScope(ctx, scopeOverride);
  const rescope = { scope, rerun: (kind: SearchScopeKind) => reviewDependencies(ctx, entry, kind) };
  log.appendLine(`[dependencies] Looking up the dependencies of ${memberPath} in ${describeScope(scope)}`);

  let references: RawReference[];
  let outcomes: ProviderOutcome[];
  let resolution: Resolution;
  try {
    ({ references, outcomes, resolution } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Looking up the dependencies of ${memberPath}${progressScope(scope)}...` },
      () => lookupDependencies(ctx, system, entry, scope)
    ));
  } catch (err) {
    log.appendLine(`[dependencies] Lookup failed for ${memberPath}: ${errorMessage(err)}`);
    vscode.window.showErrorMessage(`Could not look up the dependencies of ${memberPath}: ${errorMessage(err)}`);
    return;
  }

  const summary = summarizeRun(outcomes);
  logOutcomes(ctx, memberPath, outcomes);
  warnFailed(memberPath, outcomes.filter((o) => o.status === "failed").map((o) => o.label));
  if (references.length === 0) {
    vscode.window.showInformationMessage(`No dependencies found for ${memberPath}. ${summary}.`);
    return;
  }
  const unresolved = resolution.unresolved.map((reference) => ({ reference, via: [] }));
  const items = buildItems(ctx, system, resolution.resolved);
  if (items.length === 0) {
    if (unresolved.length === 0) {
      vscode.window.showInformationMessage(`${memberPath} uses ${describeCounts(references)}, with no source members to bring.`);
    }
    reportUnresolved(ctx, memberPath, unresolved, rescope);
    return;
  }
  await pickAndBring(ctx, system, items, {
    title: `Dependencies of ${memberPath}`,
    placeHolder: `Choose the members to bring into your checkout folder — ${summary}`,
    memberPath,
    unresolved,
    rescope,
  });
}

/**
 * Find All Dependencies: walks what `entry` uses, what those members use, and so on, up to the
 * limits in `dependencies.transitive`, then offers every member found in one picker. Members
 * are read from the IBM i while walking; nothing is written until the user brings them.
 */
export async function reviewAllDependencies(
  ctx: CommandContext,
  entry: CheckedOutMember,
  scopeOverride?: SearchScopeKind
): Promise<void> {
  const { log } = ctx;
  const memberPath = formatMemberPath(entry);
  const system = connectedSystemFor(entry, memberPath);
  if (!system) {
    return;
  }
  const scope = searchScope(ctx, scopeOverride);
  const rescope = { scope, rerun: (kind: SearchScopeKind) => reviewAllDependencies(ctx, entry, kind) };
  log.appendLine(`[dependencies] Looking up all dependencies of ${memberPath} in ${describeScope(scope)}`);
  const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
  const limits = {
    maxDepth: clamp(config.get<number>("dependencies.transitive.maxDepth", 3), 1, 10),
    maxMembers: clamp(config.get<number>("dependencies.transitive.maxMembers", 50), 5, 500),
  };

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Looking up all dependencies of ${memberPath}${progressScope(scope)}`, cancellable: true },
    (progress, token) => walkDependencies(entry, {
      lookup: (subject) => lookupDependencies(ctx, system, subject, scope),
      onLimit: (reached) => askToContinue(reached),
      cancelled: () => token.isCancellationRequested,
      progress: ({ members, depth, member }) => progress.report({
        message: `${members} member${members === 1 ? "" : "s"} found · level ${depth + 1} · ${member}`,
      }),
    }, limits)
  );

  const outcomes = mergeOutcomes(result.outcomes);
  const summary = summarizeRun(outcomes);
  for (const { member, outcomes: memberOutcomes } of result.outcomes) {
    logOutcomes(ctx, member, memberOutcomes);
  }
  for (const failure of result.failed) {
    log.appendLine(`[dependencies] Lookup failed for ${failure.member}${describeVia(failure.via, " (via ", ")")}: ${failure.error}`);
  }
  if (result.failed.length > 0 && result.outcomes.length === 0) {
    vscode.window.showErrorMessage(`Could not look up the dependencies of ${memberPath}: ${result.failed[0].error}`);
    return;
  }
  warnFailed(memberPath, [
    ...new Set(result.outcomes.flatMap((member) => member.outcomes.filter((o) => o.status === "failed").map((o) => o.label))),
  ]);
  if (result.failed.length > 0) {
    void vscode.window.showWarningMessage(
      `Could not look up what ${result.failed.map((failure) => failure.member).join(", ")} use${result.failed.length === 1 ? "s" : ""}. ` +
        "See the IBM i Member Workspace output panel."
    );
  }
  if (result.nodes.length === 0 && result.unresolved.length === 0) {
    if (!result.cancelled) {
      vscode.window.showInformationMessage(`No dependencies found for ${memberPath}. ${summary}.`);
    }
    return;
  }
  const items = buildItems(ctx, system, result.nodes);
  if (items.length === 0) {
    reportUnresolved(ctx, memberPath, result.unresolved, rescope);
    return;
  }
  const levels = Math.max(...result.nodes.map((node) => node.depth));
  const partial = result.cancelled ? " · cancelled, partial list" : result.stopped ? " · stopped at the limit, partial list" : "";
  await pickAndBring(ctx, system, items, {
    title: `All dependencies of ${memberPath} (${levels} level${levels === 1 ? "" : "s"})`,
    placeHolder: `Choose the members to bring into your checkout folder — ${summary}${partial}`,
    memberPath,
    unresolved: result.unresolved,
    rescope,
  });
}

/** A search that can be run again in another scope. */
interface Rescope {
  scope: SearchScope;
  rerun(kind: SearchScopeKind): Promise<void>;
}

/** " in all user libraries (…)" for the progress title of a search everywhere; nothing otherwise. */
function progressScope(scope: SearchScope): string {
  return scope.kind === "everywhere" ? " in all user libraries (this can take a while)" : "";
}

/** The connected system, if it is the one `entry` was checked out from; otherwise says why not. */
function connectedSystemFor(entry: CheckedOutMember, memberPath: string): string | undefined {
  const system = getSystemName();
  if (!system) {
    vscode.window.showErrorMessage("Not connected to IBM i.");
    return undefined;
  }
  if (systemKey(system) !== systemKey(entry.system)) {
    vscode.window.showErrorMessage(`Connect to ${entry.system} to find the dependencies of ${memberPath}.`);
    return undefined;
  }
  return system;
}

function warnFailed(memberPath: string, failed: string[]): void {
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(
      `${failed.join(", ")} failed while looking up ${memberPath}. See the IBM i Member Workspace output panel.`
    );
  }
}

async function askToContinue({ reason, members, depth }: WalkLimitReached): Promise<boolean> {
  const found = `Found ${members} member${members === 1 ? "" : "s"}, ${depth} level${depth === 1 ? "" : "s"} deep.`;
  const choice = await vscode.window.showWarningMessage(
    `${found} Keep going?`,
    {
      modal: true,
      detail: reason === "depth"
        ? "The members on the last level use more members that haven't been looked up yet."
        : "More members were found than dependencies.transitive.maxMembers allows. Shared copybooks and " +
          "utility programs can reach a large part of the system.",
    },
    "Continue",
    "Show What Was Found"
  );
  return choice === "Continue";
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

/** Lets the user pick members, then brings them as reference copies or points to change management. */
async function pickAndBring(
  ctx: CommandContext,
  system: string,
  items: DependencyItem[],
  { title, placeHolder, memberPath, unresolved, rescope }: {
    title: string;
    placeHolder: string;
    memberPath: string;
    unresolved: WalkUnresolved[];
    rescope: Rescope;
  }
): Promise<void> {
  const outcome = await pickDependencies(items, `${title} · ${capitalize(describeScope(rescope.scope))}`, placeHolder);
  if (outcome === "changeScope") {
    const kind = await pickSearchScope(ctx, rescope.scope);
    if (kind) {
      await rescope.rerun(kind);
    }
    return;
  }
  const members = (outcome ?? []).flatMap((item) => (item.member ? [item.member] : []));
  if (members.length === 0) {
    reportUnresolved(ctx, memberPath, unresolved, rescope);
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
    await changeThroughChangeManagement(ctx, system, members);
    return;
  }
  if (choice !== "Bring for Reference" || !(await ensureWorkItemForCheckout(ctx, system))) {
    return;
  }
  await checkoutMembersBatch(ctx.service, system, members, ctx.log, { reference: true });
  reportUnresolved(ctx, memberPath, unresolved, rescope);
}

/**
 * The dependency list, with a title button to search in another scope. Resolves with the chosen
 * items, "changeScope", or undefined when dismissed.
 */
function pickDependencies<T extends vscode.QuickPickItem>(
  items: T[],
  title: string,
  placeholder: string
): Promise<readonly T[] | "changeScope" | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<T>();
    const scopeButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("library"),
      tooltip: "Search in Other Libraries…",
    };
    let result: readonly T[] | "changeScope" | undefined;
    quickPick.items = items;
    quickPick.selectedItems = items.filter((item) => item.picked);
    quickPick.canSelectMany = true;
    quickPick.title = title;
    quickPick.placeholder = placeholder;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.buttons = [scopeButton];
    quickPick.onDidTriggerButton(() => {
      result = "changeScope";
      quickPick.hide();
    });
    quickPick.onDidAccept(() => {
      result = quickPick.selectedItems;
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(result);
    });
    quickPick.show();
  });
}

/** Asks where to search this time; the setting is left as it is. */
export async function pickSearchScope(ctx: CommandContext, current: SearchScope): Promise<SearchScopeKind | undefined> {
  const configured = configuredSearchLibraries();
  const libraryList = connectionLibraryList();
  type Item = vscode.QuickPickItem & { scope?: SearchScopeKind; openSetting?: boolean };
  const items: Item[] = [
    {
      scope: "libraryList",
      label: "Library List",
      description: current.kind === "libraryList" ? "current" : undefined,
      detail: libraryList.join(", ") || "The connection's current library and library list",
    },
    configured.length > 0
      ? {
        scope: "specific",
        label: "Search Libraries",
        description: current.kind === "specific" ? "current" : undefined,
        detail: configured.join(", "),
      }
      : {
        openSetting: true,
        label: "Search Libraries…",
        detail: "None set yet. Opens ibmi-member-workspace.dependencies.searchLibraries.",
      },
    {
      scope: "everywhere",
      label: "All User Libraries",
      description: current.kind === "everywhere" ? "current" : undefined,
      detail: "Every library except IBM's, library list first. Can take a while on a large system.",
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Search Dependencies In",
    placeHolder: "Only this search; the dependencies.searchScope setting is unchanged",
  });
  if (picked?.openSetting) {
    void vscode.commands.executeCommand("workbench.action.openSettings", "ibmi-member-workspace.dependencies.search");
    return undefined;
  }
  if (picked?.scope) {
    ctx.log.appendLine(`[dependencies] Searching again in ${picked.label}`);
  }
  return picked?.scope;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  const readSource = async (subject: DependencySubject): Promise<string> => {
    const checkout = "localPath" in subject
      ? subject as CheckedOutMember
      : ctx.service.findEntry(system, subject.library, subject.sourceFile, subject.memberName);
    return checkout
      ? readCheckoutText(ctx.service.getCheckoutRoot()?.fsPath, checkout.localPath)
      : downloadMemberContent(subject.library, subject.sourceFile, subject.memberName);
  };
  const providers: DependencyProvider[] = [
    createSourceScanProvider(readSource),
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

function configuredSearchLibraries(): string[] {
  return vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .get<string[]>("dependencies.searchLibraries", [])
    .map((library) => String(library).trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Where to look for dependencies: `override` for one search, else `dependencies.searchScope`
 * (or, when that isn't set, the search libraries if any, else the library list).
 */
export function searchScope(ctx?: CommandContext, override?: SearchScopeKind): SearchScope {
  const { scope, note } = searchScopeFrom({
    setting: override ?? vscode.workspace.getConfiguration("ibmi-member-workspace").get<unknown>("dependencies.searchScope"),
    searchLibraries: configuredSearchLibraries(),
    libraryList: connectionLibraryList(),
  });
  if (note) {
    ctx?.log.appendLine(`[dependencies] ${note}`);
  }
  return scope;
}

/**
 * The libraries Bob's tools read when a call names none. They always read a bounded list, so
 * "everywhere" gives them the library list.
 */
export function searchLibraries(): string[] {
  return searchScope().libraries;
}

/**
 * One item per member found, grouped by kind, in the order given (for a walk, nearest first).
 * Copybooks not yet checked out are preselected.
 */
function buildItems(ctx: CommandContext, system: string, offered: readonly OfferedDependency[]): DependencyItem[] {
  const items: DependencyItem[] = [];
  const seen = new Set<string>();
  for (const { kind, group } of KINDS) {
    const groupItems: DependencyItem[] = [];
    for (const { reference, candidates, via } of offered.filter((r) => r.reference.kind === kind)) {
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
        detail: `${describeVia(via ?? [], "via ", " · ")}${where}${foundBy}${alsoIn}`,
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

/** workspaceState key: the development library last named for a change-management checkout. */
const LAST_DEV_LIBRARY = "changeManagement.lastDevLibrary";
/** workspaceState key: the project last named for a change-management checkout (&PROJECT). */
const LAST_PROJECT = "changeManagement.lastProject";

const CHECKOUT_COMMAND_SETTING = "changeManagement.checkoutCommand";

/**
 * "I Need to Change Some…": runs the change-management checkout command when one is set, then
 * offers to check out the development library's copies; otherwise explains the steps.
 */
export async function changeThroughChangeManagement(ctx: CommandContext, system: string, members: MemberInfo[]): Promise<void> {
  const template = vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .inspect<string>(CHECKOUT_COMMAND_SETTING)?.globalValue?.trim();
  if (!template) {
    await showChangeGuide(members);
    return;
  }

  let result: ChangeCheckoutResult | undefined;
  try {
    result = await runChangeManagementCheckout(members, system, template, {
      askDevLibrary: async () => vscode.window.showInputBox({
        title: "Change-Management Checkout",
        prompt: "The development library your change-management system checks the members out to (&DEVLIB)",
        value: ctx.context.workspaceState.get<string>(LAST_DEV_LIBRARY) ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/i.test(value.trim())
          ? undefined
          : "Enter an IBM i library name.",
      }),
      askProject: async () => vscode.window.showInputBox({
        title: "Change-Management Checkout",
        prompt: "The change-management project (task) the members are checked out for (&PROJECT)",
        value: ctx.context.workspaceState.get<string>(LAST_PROJECT) ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => nameValueProblem("project", value.trim()),
      }),
      confirm: async (commands, devLibrary, project) => {
        await ctx.context.workspaceState.update(LAST_DEV_LIBRARY, devLibrary);
        if (project) {
          await ctx.context.workspaceState.update(LAST_PROJECT, project);
        }
        const choice = await vscode.window.showWarningMessage(
          `Run ${commands.length === 1 ? "this command" : `these ${commands.length} commands`} on ${system}?`,
          { modal: true, detail: commands.join("\n") },
          "Run"
        );
        return choice === "Run";
      },
      connectedSystem: getSystemName,
      currentUser: connectedUser,
      runCommand: runClCommand,
      log: (message) => ctx.log.appendLine(message),
    });
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Could not run the change-management checkout: ${errorMessage(err)}`,
      "Open Setting"
    );
    if (choice) {
      void vscode.commands.executeCommand("workbench.action.openSettings", `ibmi-member-workspace.${CHECKOUT_COMMAND_SETTING}`);
    }
    return;
  }
  if (!result) {
    return;
  }

  const { devLibrary, succeeded, failed } = result;
  if (failed.length > 0) {
    const names = failed.map(({ member, error }) => `${member.memberName} (${error})`).join(", ");
    void vscode.window
      .showErrorMessage(`Change-management checkout failed for ${names}`, "Show Output")
      .then((choice) => choice && ctx.log.show());
  }
  if (succeeded.length === 0) {
    return;
  }
  const count = succeeded.length === 1 ? "1 member" : `${succeeded.length} members`;
  const checkOut = `Check Out from ${devLibrary}`;
  const choice = await vscode.window.showInformationMessage(
    `Checked out ${count} in change management. Check out the ${devLibrary} copies here to change them?`,
    checkOut
  );
  if (choice !== checkOut || !(await ensureWorkItemForCheckout(ctx, system))) {
    return;
  }
  await checkoutMembersBatch(ctx.service, system, succeeded.map((member) => ({ ...member, library: devLibrary })), ctx.log);
}

async function showChangeGuide(members: MemberInfo[]): Promise<void> {
  const paths = members.map((m) => `${m.library}/${m.sourceFile}(${m.memberName})`);
  const choice = await vscode.window.showInformationMessage(
    "Change these members through your change-management system",
    {
      modal: true,
      detail: `Check out ${paths.length === 1 ? "this member" : "these members"} in your change-management system ` +
        "(for example, Rocket LMI) so the change is tracked, then use Check Out Member on the copy in your " +
        `development library:\n\n${paths.join("\n")}\n\n` +
        "To run your change-management checkout command from here, set " +
        `ibmi-member-workspace.${CHECKOUT_COMMAND_SETTING} in your user settings.`,
    },
    "Copy Member Paths",
    "Open Setting"
  );
  if (choice === "Copy Member Paths") {
    await vscode.env.clipboard.writeText(paths.join("\n"));
  } else if (choice === "Open Setting") {
    void vscode.commands.executeCommand("workbench.action.openSettings", `ibmi-member-workspace.${CHECKOUT_COMMAND_SETTING}`);
  }
}

/** "via A → B" with the given affixes, or nothing for a direct dependency. */
function describeVia(via: readonly string[], prefix: string, suffix: string): string {
  return via.length > 0 ? `${prefix}${via.join(" → ")}${suffix}` : "";
}

function reportUnresolved(
  ctx: CommandContext,
  memberPath: string,
  unresolved: readonly WalkUnresolved[],
  rescope?: Rescope
): void {
  if (unresolved.length === 0) {
    return;
  }
  const names = [...new Set(unresolved.map(({ reference: ref }) => ref.unresolvable ? `${ref.member} (${ref.unresolvable})` : ref.member))];
  ctx.log.appendLine(`[dependencies] Source not found for dependencies of ${memberPath}:`);
  for (const { reference: ref, via } of unresolved) {
    const where = ref.line !== undefined ? `line ${ref.line}: ` : "";
    ctx.log.appendLine(`  ${describeVia(via, "in ", ", ")}${where}${ref.text}${ref.unresolvable ? ` (${ref.unresolvable})` : ""} → ${ref.member}`);
  }
  const everywhere = "Search All User Libraries";
  const settings = "Search Settings…";
  const buttons = rescope && rescope.scope.kind !== "everywhere" ? [everywhere, settings] : [settings];
  void vscode.window
    .showWarningMessage(
      `Source not found for: ${names.join(", ")}. It may be in libraries that were not searched ` +
        `(searched ${describeScope(rescope?.scope ?? searchScope())}).`,
      ...buttons
    )
    .then((choice) => {
      if (choice === everywhere && rescope) {
        void rescope.rerun("everywhere");
      } else if (choice === settings) {
        void vscode.commands.executeCommand("workbench.action.openSettings", "ibmi-member-workspace.dependencies.search");
      }
    });
}

function describeCounts(refs: RawReference[]): string {
  return KINDS.flatMap(({ kind, singular, plural }) => {
    const count = refs.filter((ref) => ref.kind === kind).length;
    return count === 0 ? [] : [`${count} ${count === 1 ? singular : plural}`];
  }).join(", ");
}
