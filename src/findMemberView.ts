import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { getSystemName } from "./codeForIBMi";
import { FoundMember, MemberSearch, describeSearch, foundMemberInfo } from "./memberSearch";
import { MemberInfo } from "./memberInfo";

/** workspaceState key of Find Member's recent searches, newest first. */
export const HISTORY_KEY = "findMember.history";

/** The last search and what it found, shown until the next search or Clear Results. */
export interface FindMemberResults {
  search: MemberSearch;
  /** Where it searched, e.g. "the library list". */
  scopeLabel: string;
  /** Whether the search ran in all user libraries, so that isn't offered again. */
  everywhere: boolean;
  state: "searching" | "done" | "failed";
  found: FoundMember[];
  error?: string;
}

export type FindMemberRow =
  | { kind: "results" }
  | { kind: "found"; member: MemberInfo; found: FoundMember }
  | { kind: "suggestion"; label: string; search: MemberSearch }
  | { kind: "message"; label: string }
  | { kind: "history" }
  | { kind: "past"; search: MemberSearch };

/**
 * The Find Member panel below Checked Out Members: the last search's results, to act on one after
 * another, and the recent searches, to run again. It shows no rows until a search was made, which
 * leaves room for the Find Member button of its welcome content.
 */
export class FindMemberProvider implements vscode.TreeDataProvider<FindMemberRow>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FindMemberRow | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private results: FindMemberResults | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly service: CheckoutService, private readonly state: vscode.Memento) {
    // A result's "checked out" mark follows checkouts made from it, here or elsewhere.
    this.subscription = service.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  get current(): FindMemberResults | undefined {
    return this.results;
  }

  setResults(results: FindMemberResults | undefined): void {
    this.results = results;
    this._onDidChangeTreeData.fire();
  }

  history(): MemberSearch[] {
    return this.state.get<MemberSearch[]>(HISTORY_KEY, []);
  }

  async setHistory(history: MemberSearch[]): Promise<void> {
    await this.state.update(HISTORY_KEY, history);
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: FindMemberRow): FindMemberRow[] {
    if (!element) {
      return [
        ...(this.results ? [{ kind: "results" as const }] : []),
        ...(this.history().length > 0 ? [{ kind: "history" as const }] : []),
      ];
    }
    if (element.kind === "history") {
      return this.history().map((search) => ({ kind: "past", search }));
    }
    if (element.kind !== "results" || !this.results) {
      return [];
    }
    const { search, state, found, error, everywhere } = this.results;
    if (state === "searching") {
      return [{ kind: "message", label: "Searching…" }];
    }
    if (state === "failed") {
      return [{ kind: "message", label: `Search failed: ${error ?? "unknown error"}` }];
    }
    if (found.length > 0) {
      return found.map((member) => ({ kind: "found", member: foundMemberInfo(member), found: member }));
    }
    return [
      { kind: "message", label: search.byText ? "No member text contains it." : "No source member or program has this name." },
      ...(search.byText ? [] : [{ kind: "suggestion" as const, label: `Search member text for "${search.input}"`, search: { ...search, byText: true } }]),
      ...(everywhere ? [] : [{ kind: "suggestion" as const, label: "Search all user libraries", search: { ...search, scope: "everywhere" as const } }]),
    ];
  }

  getTreeItem(row: FindMemberRow): vscode.TreeItem {
    switch (row.kind) {
      case "results":
        return this.resultsItem();
      case "found":
        return this.foundItem(row);
      case "suggestion": {
        const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("search");
        item.command = { command: "ibmi-member-workspace.findMember.rerun", title: "Search", arguments: [row] };
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "history": {
        const item = new vscode.TreeItem("Recent Searches", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = "findMember:history";
        item.iconPath = new vscode.ThemeIcon("history");
        item.contextValue = "searchHistoryGroup";
        return item;
      }
      case "past": {
        const item = new vscode.TreeItem(describeSearch(row.search), vscode.TreeItemCollapsibleState.None);
        item.description = row.search.scope === "everywhere" ? "all user libraries" : undefined;
        item.iconPath = new vscode.ThemeIcon(row.search.byText ? "whole-word" : "search");
        item.tooltip = "Click to search again";
        item.contextValue = "searchHistory";
        item.command = { command: "ibmi-member-workspace.findMember.rerun", title: "Search Again", arguments: [row] };
        return item;
      }
    }
  }

  private resultsItem(): vscode.TreeItem {
    const { search, scopeLabel, state, found } = this.results!;
    const count = state === "searching" ? "searching…" : state === "failed" ? "failed" : `${found.length} found`;
    const item = new vscode.TreeItem(describeSearch(search), vscode.TreeItemCollapsibleState.Expanded);
    // A new id per search, so the group opens expanded again after the user collapsed an earlier one.
    item.id = `findMember:results:${describeSearch(search)}:${scopeLabel}:${state}`;
    item.description = `${scopeLabel} · ${count}`;
    item.iconPath = new vscode.ThemeIcon(state === "searching" ? "loading~spin" : "list-unordered");
    item.contextValue = "searchResults";
    return item;
  }

  private foundItem(row: Extract<FindMemberRow, { kind: "found" }>): vscode.TreeItem {
    const { found, member } = row;
    const system = getSystemName();
    const entry = system ? this.service.findEntry(system, member.library, member.sourceFile, member.memberName) : undefined;
    const state = entry ? (entry.kind === "reference" ? "reference copy" : "checked out") : undefined;
    const item = new vscode.TreeItem(found.member, vscode.TreeItemCollapsibleState.None);
    item.description = [`${found.library}/${found.sourceFile}`, found.sourceType, state].filter(Boolean).join(" · ");
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${found.library}/${found.sourceFile}(${found.member})** ${found.sourceType}\n\n`);
    for (const line of [found.via, found.text, found.lastChanged && `Changed ${found.lastChanged}`]) {
      if (line) {
        tooltip.appendText(`${line}\n\n`);
      }
    }
    tooltip.appendMarkdown("Click to read it. Right-click to check it out.");
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(entry ? (entry.kind === "reference" ? "lock" : "check") : "file-code");
    item.contextValue = "foundMember";
    item.command = {
      command: "vscode.open",
      title: "Open Read-Only",
      arguments: [vscode.Uri.from({
        scheme: "member",
        path: `/${member.library}/${member.sourceFile}/${member.memberName}.${member.extension}`.toUpperCase(),
        query: "readonly=true",
      })],
    };
    return item;
  }
}

/** The members of the Find Member results a command was run on: the selection, or the row clicked. */
export function foundMembersOf(arg: unknown, all?: unknown[]): MemberInfo[] {
  const rows = all && all.length > 1 ? all : [arg];
  return rows.flatMap((row) => {
    const found = row as Partial<Extract<FindMemberRow, { kind: "found" }>> | undefined;
    return found?.kind === "found" && found.found ? [foundMemberInfo(found.found)] : [];
  });
}
