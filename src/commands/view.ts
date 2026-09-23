import * as vscode from "vscode";
import { memberUri } from "../codeForIBMi";
import { errorMessage } from "../errors";
import { resolveMemberSelections } from "../prompts";
import { TreeItemType, formatMemberPath } from "../types";
import { CommandContext } from "./context";

export function registerViewCommands(ctx: CommandContext): void {
  const { context, treeProvider, treeView } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.openLocalFile",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length > 1) {
          const confirm = await vscode.window.showWarningMessage(
            `Open ${selections.length} local files in the editor?`,
            { modal: true },
            "Open"
          );
          if (confirm !== "Open") {
            return;
          }
        }

        const options: vscode.TextDocumentShowOptions | undefined =
          selections.length > 1 ? { preview: false } : undefined;

        for (const sel of selections) {
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(sel.entry.localPath)
            );
            await vscode.window.showTextDocument(doc, options);
          } catch (err) {
            vscode.window.showErrorMessage(
              `Could not open ${formatMemberPath(sel.entry)}: ${errorMessage(err)}`
            );
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.openRemoteFile",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length > 1) {
          const confirm = await vscode.window.showWarningMessage(
            `Open ${selections.length} remote files in the editor? This will contact the IBM i for each file.`,
            { modal: true },
            "Open"
          );
          if (confirm !== "Open") {
            return;
          }
        }

        const options: vscode.TextDocumentShowOptions | undefined =
          selections.length > 1 ? { preview: false } : undefined;

        for (const sel of selections) {
          const entry = sel.entry;
          try {
            const doc = await vscode.workspace.openTextDocument(memberUri(entry));
            await vscode.window.showTextDocument(doc, options);
          } catch {
            vscode.window.showErrorMessage(
              `Could not open remote member ${formatMemberPath(entry)}. It may no longer exist on the IBM i.`
            );
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.runAction",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length > 1) {
          const confirm = await vscode.window.showWarningMessage(
            `Run action against ${selections.length} selected members?`,
            { modal: true },
            "Run"
          );
          if (confirm !== "Run") {
            return;
          }
        }

        for (const sel of selections) {
          const localUri = vscode.Uri.file(sel.entry.localPath);
          await vscode.commands.executeCommand(
            "code-for-ibmi.runAction",
            localUri
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.revealInExplorer",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(item.entry.localPath)
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.copyMemberPath",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const path = formatMemberPath(item.entry);
        await vscode.env.clipboard.writeText(path);
        vscode.window.showInformationMessage(`Copied: ${path}`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.refreshView", () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.expandAll", async () => {
      const roots = treeProvider.getChildren();
      for (const root of roots) {
        await treeView.reveal(root, { expand: true, select: false, focus: false });
      }
    })
  );

  const updateSearchState = () => {
    const term = treeProvider.getSearchTerm();
    vscode.commands.executeCommand(
      "setContext",
      "ibmi-member-workspace:searchActive",
      term.length > 0
    );
    if (term) {
      const count = treeProvider.getFilteredCount();
      treeView.message = `Filtering by "${term}" — ${count} match${count === 1 ? "" : "es"}`;
    } else {
      treeView.message = undefined;
    }
  };

  const applySearchTerm = async (value: string) => {
    treeProvider.setSearchTerm(value);
    updateSearchState();

    // TreeItem.collapsibleState only sets a node's state the first time it
    // renders — VS Code caches expand/collapse per node after that, so
    // toggling collapsibleState alone won't reopen a node that was already
    // collapsed once. Force matching groups open explicitly instead.
    if (value) {
      const roots = treeProvider.getChildren();
      for (const root of roots) {
        await treeView.reveal(root, { expand: true, select: false, focus: false });
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.search", () => {
      const previousTerm = treeProvider.getSearchTerm();
      let accepted = false;

      const input = vscode.window.createInputBox();
      input.title = "Search Checked Out Members";
      input.placeholder = "Filter by member name";
      input.value = previousTerm;

      input.onDidChangeValue((value) => {
        void applySearchTerm(value);
      });

      input.onDidAccept(() => {
        accepted = true;
        input.hide();
      });

      input.onDidHide(() => {
        if (!accepted) {
          void applySearchTerm(previousTerm);
        }
        input.dispose();
      });

      input.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.clearSearch", () => {
      treeProvider.setSearchTerm("");
      updateSearchState();
    })
  );
}
