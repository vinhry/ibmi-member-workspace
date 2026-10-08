import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { getSystemName } from "./codeForIBMi";
import {
  FindMemberResults,
  FindMemberRow,
  HISTORY_KEY,
  findMemberRows,
  foundDescription,
  foundIcon,
} from "./findMemberModel";
import { MemberSearch, describeSearch } from "./memberSearch";

export { FindMemberResults, FindMemberRow, HISTORY_KEY, foundMembersOf } from "./findMemberModel";

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
    return findMemberRows(element, this.results, this.history());
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
    const item = new vscode.TreeItem(found.member, vscode.TreeItemCollapsibleState.None);
    item.description = foundDescription(found, entry);
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${found.library}/${found.sourceFile}(${found.member})** ${found.sourceType}\n\n`);
    for (const line of [found.via, found.text, found.lastChanged && `Changed ${found.lastChanged}`]) {
      if (line) {
        tooltip.appendText(`${line}\n\n`);
      }
    }
    tooltip.appendMarkdown("Click to read it. Right-click to check it out.");
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(foundIcon(entry));
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
