import * as vscode from "vscode";
import { findCompiledObject, getSystemName, objectSources, searchSourceMembers } from "../codeForIBMi";
import { describeScope } from "../dependencyResolve";
import { objectKey } from "../dependencySources";
import { errorMessage } from "../errors";
import { FindMemberProvider, FindMemberRow, foundMembersOf } from "../findMemberView";
import {
  FoundMember,
  MemberSearch,
  addToHistory,
  describeSearch,
  isWildcard,
  memberPattern,
  memberPatternProblem,
  orderFound,
  sameSearch,
} from "../memberSearch";
import { checkoutMembersBatch } from "./checkout";
import { CommandContext } from "./context";
import { pickSearchScope, searchScope } from "./dependencies";
import { ensureWorkItemForCheckout } from "./git";

const VIEW_ID = "ibmi-member-workspace.findMemberView";

/**
 * The Find Member panel: search source members by name (or a program's source, or member text) in
 * the search scope, keep the results to act on, and keep recent searches to run again. A result is
 * checked out through change management (the command `checkoutThroughChangeManagement`), brought
 * as a reference copy, or checked out for change.
 */
export function registerFindMemberCommands(ctx: CommandContext): void {
  const { context } = ctx;
  const provider = new FindMemberProvider(ctx.service, context.workspaceState);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, canSelectMany: true });
  context.subscriptions.push(provider, view);

  const search = async (wanted: MemberSearch) => {
    if (!getSystemName()) {
      vscode.window.showWarningMessage("Connect to an IBM i first: Find Member searches its source files.");
      return;
    }
    const scope = searchScope(ctx, wanted.scope);
    const base = {
      search: wanted,
      scopeLabel: describeScope(scope),
      everywhere: scope.kind === "everywhere",
    };
    provider.setResults({ ...base, state: "searching", found: [] });
    await provider.setHistory(addToHistory(provider.history(), wanted));
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    try {
      const found = await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => runSearch(ctx, wanted));
      // A newer search started meanwhile: its results win.
      if (provider.current && sameSearch(provider.current.search, wanted)) {
        provider.setResults({ ...base, state: "done", found });
      }
    } catch (err) {
      if (provider.current && sameSearch(provider.current.search, wanted)) {
        provider.setResults({ ...base, state: "failed", found: [], error: errorMessage(err) });
      }
    }
  };

  /** The members a result action was run on; a warning when it was run on nothing. */
  const membersOf = (arg: unknown, all?: unknown[]) => {
    const members = foundMembersOf(arg, all);
    if (members.length === 0) {
      vscode.window.showInformationMessage("Select members in the Find Member results first.");
    }
    return members;
  };

  const checkOut = async (arg: unknown, all: unknown[] | undefined, reference: boolean) => {
    const system = getSystemName();
    const members = membersOf(arg, all);
    if (!system || members.length === 0 || !(await ensureWorkItemForCheckout(ctx, system))) {
      return;
    }
    await checkoutMembersBatch(ctx.service, system, members, ctx.log, { reference });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.findMember", async () => {
      const typed = await vscode.window.showInputBox({
        title: "Find Member",
        prompt: "Member or program name, with * for any characters (for example VU0005CC, ORD* or *ENT)",
        value: provider.current?.search.byText === false ? provider.current.search.input : undefined,
        ignoreFocusOut: true,
        validateInput: (value) => memberPatternProblem(value),
      });
      if (typed) {
        await search({ input: memberPattern(typed), byText: false });
      }
    }),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.rerun", async (row?: FindMemberRow) => {
      if (row && (row.kind === "past" || row.kind === "suggestion")) {
        await search(row.search);
      }
    }),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.searchOtherLibraries", async () => {
      const current = provider.current?.search ?? provider.history()[0];
      if (!current) {
        await vscode.commands.executeCommand("ibmi-member-workspace.findMember");
        return;
      }
      const kind = await pickSearchScope(ctx, searchScope(ctx, current.scope));
      if (kind) {
        await search({ ...current, scope: kind });
      }
    }),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.clearResults", () => provider.setResults(undefined)),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.clearHistory", () => provider.setHistory([])),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.removeFromHistory", async (row?: FindMemberRow) => {
      if (row?.kind === "past") {
        await provider.setHistory(provider.history().filter((past) => !sameSearch(past, row.search)));
      }
    }),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.bringForReference", (arg: unknown, all?: unknown[]) =>
      checkOut(arg, all, true)
    ),
    vscode.commands.registerCommand("ibmi-member-workspace.findMember.checkoutForChange", async (arg: unknown, all?: unknown[]) => {
      const members = membersOf(arg, all);
      if (members.length === 0) {
        return;
      }
      const what = members.length === 1 ? `${members[0].library}/${members[0].sourceFile}(${members[0].memberName})` : `${members.length} members`;
      const choice = await vscode.window.showWarningMessage(
        `Check out ${what} for change here?`,
        {
          modal: true,
          detail: "Do this only for members already in your development library. To change a production member, " +
            "use Check Out Through Change Management… so your change-management system (for example, Rocket LMI) tracks the change.",
        },
        "Check Out"
      );
      if (choice === "Check Out") {
        await checkOut(arg, all, false);
      }
    })
  );
}

/** Runs a search in its scope; members in the scope's order, exact name first. */
async function runSearch(ctx: CommandContext, wanted: MemberSearch): Promise<FoundMember[]> {
  const scope = searchScope(ctx, wanted.scope);
  const libraries = scope.kind === "everywhere" ? undefined : scope.libraries;
  const pattern = memberPattern(wanted.input);
  const found = wanted.byText
    ? (await searchSourceMembers("*", libraries, { text: pattern, limit: 200 })).map((row) => ({ ...row }))
    : await searchByName(ctx, pattern, libraries, scope.libraries);
  ctx.log.appendLine(`[find member] ${describeSearch(wanted)} in ${describeScope(scope)}: ${found.length} found`);
  return orderFound(found, { pattern, libraries: scope.libraries });
}

/**
 * Source members named `pattern`; for a name without wildcards, also the member the program of that
 * name was compiled from, which may have another name.
 */
async function searchByName(
  ctx: CommandContext,
  pattern: string,
  libraries: string[] | undefined,
  programLibraries: string[]
): Promise<FoundMember[]> {
  const rows = await searchSourceMembers(pattern, libraries, { limit: 200 });
  const found: FoundMember[] = rows.map((row) => ({ ...row }));
  if (isWildcard(pattern)) {
    return found;
  }
  try {
    const program = await findCompiledObject(pattern, programLibraries);
    if (program) {
      const sources = await objectSources([{ library: program.library, name: program.name, type: program.type, kind: "program" }]);
      const source = sources.get(objectKey({ library: program.library, name: program.name, type: program.type }));
      if (source) {
        const [row] = await searchSourceMembers(source.member, [source.library], { sourceFile: source.sourceFile, limit: 1 });
        if (row) {
          found.push({ ...row, via: `source of program ${program.library}/${program.name}` });
        }
      }
    }
  } catch (err) {
    ctx.log.appendLine(`[find member] Could not look up program ${pattern}: ${errorMessage(err)}`);
  }
  return found;
}
