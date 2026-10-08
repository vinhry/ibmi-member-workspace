import * as fs from "node:fs";
import * as vscode from "vscode";
import { CheckedOutMember, TreeItemType, buildLocalFileName } from "./types";
import { CheckoutService } from "./checkoutService";
import {
  DateFormat,
  IconSpec,
  contextValueFor,
  matchesSearch,
  memberDescription,
  memberIcon,
  memberTooltip,
  membersOf,
  sourceFileGroups,
} from "./checkoutTreeModel";
import { getSystemName } from "./codeForIBMi";

/** Dates as VS Code's locale shows them. */
const LOCAL_DATES: DateFormat = {
  date: (iso) => new Date(iso).toLocaleDateString(),
  dateTime: (iso) => new Date(iso).toLocaleString(),
};

function themeIcon({ id, colorId }: IconSpec): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, colorId ? new vscode.ThemeColor(colorId) : undefined);
}

export class CheckoutTreeProvider
  implements vscode.TreeDataProvider<TreeItemType>, vscode.Disposable
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TreeItemType | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private searchTerm = "";
  private readonly serviceSubscription: vscode.Disposable;

  constructor(private readonly service: CheckoutService) {
    this.serviceSubscription = service.onDidChange(() => this.refresh());
  }

  dispose(): void {
    this.serviceSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setSearchTerm(term: string): void {
    this.searchTerm = term.trim().toLowerCase();
    this.refresh();
  }

  getSearchTerm(): string {
    return this.searchTerm;
  }

  getFilteredCount(): number {
    if (!this.searchTerm) {
      return 0;
    }
    const system = getSystemName();
    if (!system) {
      return 0;
    }
    return this.service
      .getEntriesForSystem(system)
      .filter((e) => matchesSearch(e, this.searchTerm)).length;
  }

  getTreeItem(element: TreeItemType): vscode.TreeItem {
    switch (element.kind) {
      case "sourceFile":
        return this.buildSourceFileItem(element.library, element.sourceFile);
      case "member":
        return this.buildMemberItem(element.entry);
    }
  }

  getParent(element: TreeItemType): TreeItemType | undefined {
    if (element.kind !== "member") {
      return undefined;
    }

    const system = getSystemName();
    if (!system) {
      return undefined;
    }

    return {
      kind: "sourceFile",
      system,
      library: element.entry.library,
      sourceFile: element.entry.sourceFile,
    };
  }

  getChildren(element?: TreeItemType): TreeItemType[] {
    if (!element) {
      return this.getRootChildren();
    }

    switch (element.kind) {
      case "sourceFile":
        return this.getMembersForSourceFile(
          element.system,
          element.library,
          element.sourceFile
        );
      case "member":
        return [];
    }
  }

  private getRootChildren(): TreeItemType[] {
    const system = getSystemName();
    if (!system) {
      return [];
    }
    return sourceFileGroups(this.service.getEntriesForSystem(system), this.searchTerm)
      .map(({ library, sourceFile }) => ({ kind: "sourceFile" as const, system, library, sourceFile }));
  }

  private getMembersForSourceFile(
    system: string,
    library: string,
    sourceFile: string
  ): TreeItemType[] {
    return membersOf(this.service.getEntriesForSystem(system), library, sourceFile, this.searchTerm)
      .map((entry) => ({ kind: "member" as const, entry }));
  }

  private buildSourceFileItem(
    library: string,
    sourceFile: string
  ): vscode.TreeItem {
    const collapsibleState = this.searchTerm
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(
      `${library}/${sourceFile}`,
      collapsibleState
    );
    item.id = `sourceFile:${library}/${sourceFile}`;
    item.contextValue = "sourceFileGroup";
    item.iconPath = new vscode.ThemeIcon("folder-library");
    return item;
  }

  private buildMemberItem(entry: CheckedOutMember): vscode.TreeItem {
    const item = new vscode.TreeItem(
      buildLocalFileName(entry),
      vscode.TreeItemCollapsibleState.None
    );

    item.id = `member:${entry.id}`;
    item.resourceUri = vscode.Uri.file(entry.localPath);
    const localMissing = !fs.existsSync(entry.localPath);
    item.description = memberDescription(entry, localMissing, LOCAL_DATES);
    item.tooltip = new vscode.MarkdownString(memberTooltip(entry, localMissing, LOCAL_DATES));
    item.iconPath = themeIcon(memberIcon(entry, localMissing));
    // Reference copies get their own prefix so Upload, Merge Back and Run Action don't apply.
    item.contextValue = contextValueFor(entry);

    item.command = {
      command: "ibmi-member-workspace.openLocalFile",
      title: "Open Local File",
      arguments: [{ kind: "member", entry }],
    };

    return item;
  }
}
