import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { CheckoutTreeProvider } from "./checkoutTreeProvider";
import { MergeHandler } from "./mergeHandler";
import {
  getSystemName,
  listSourceFileMembers,
  memberUri,
  onConnectionChange,
} from "./codeForIBMi";
import { CheckoutCancelledError, errorMessage } from "./errors";
import {
  BrowserNode,
  MemberInfo,
  SourceFileInfo,
  UriParts,
  extractMemberInfo,
  extractSourceFileInfo,
} from "./memberInfo";
import {
  CheckedOutMember,
  RefreshTally,
  TreeItemType,
  buildLocalFileName,
  formatMemberPath,
} from "./types";

let outputChannel: vscode.OutputChannel;
const checkoutFolderContext = "ibmi-member-workspace:checkoutFolderConfigured";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("IBM i Member Workspace");
  context.subscriptions.push(outputChannel);

  const service = new CheckoutService(context, outputChannel);
  context.subscriptions.push(service);
  await service.initialize();
  await updateCheckoutFolderContext(service);

  const treeProvider = new CheckoutTreeProvider(service);
  context.subscriptions.push(treeProvider);
  const mergeHandler = new MergeHandler();

  const treeView = vscode.window.createTreeView("ibmi-member-workspace.checkoutView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });
  context.subscriptions.push(treeView);

  onConnectionChange(context, () => treeProvider.refresh());

  registerCommands(context, service, treeProvider, mergeHandler, treeView);
  void offerCheckoutFolderSetup(context, service).catch((err) => {
    outputChannel.appendLine(`[setup] Could not show checkout folder setup: ${errorMessage(err)}`);
  });
}

function resolveMemberSelections(
  item: TreeItemType,
  allSelections?: TreeItemType[]
): Extract<TreeItemType, { kind: "member" }>[] {
  const selections = allSelections && allSelections.length > 1 ? allSelections : [item];
  return selections.filter(
    (s): s is Extract<TreeItemType, { kind: "member" }> => s?.kind === "member"
  );
}

function registerCommands(
  context: vscode.ExtensionContext,
  service: CheckoutService,
  treeProvider: CheckoutTreeProvider,
  mergeHandler: MergeHandler,
  treeView: vscode.TreeView<TreeItemType>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.configureCheckoutFolder",
      async () => {
        await configureCheckoutFolder(context, service);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkoutMember",
      async (node: BrowserNode, allSelections?: BrowserNode[]) => {
        if (!(await ensureCheckoutFolder(context, service))) {
          return;
        }

        const selections = allSelections && allSelections.length > 1 ? allSelections : [node];
        const isBatch = selections.length > 1;

        if (!isBatch) {
          // Single item — existing behaviour
          try {
            const memberInfo = memberInfoOf(node);
            if (!memberInfo) {
              outputChannel.appendLine(
                `[checkout] ERROR: Could not extract member info — raw node keys: ${node ? Object.keys(node).join(", ") : "null/undefined"}`
              );
              outputChannel.show();
              vscode.window.showErrorMessage(
                "Could not determine member details from selection. Check 'IBM i Member Workspace' output panel for details."
              );
              return;
            }
            await service.checkoutMember(
              memberInfo.library,
              memberInfo.sourceFile,
              memberInfo.memberName,
              memberInfo.extension
            );
          } catch (err) {
            if (!(err instanceof CheckoutCancelledError)) {
              outputChannel.appendLine(`Checkout error: ${errorMessage(err)}`);
              outputChannel.appendLine((err instanceof Error && err.stack) || "");
              outputChannel.show();
              vscode.window.showErrorMessage(`Checkout failed: ${errorMessage(err)}`);
            }
          }
          return;
        }

        // Batch — multi-select
        const system = getSystemName();
        if (!system) {
          vscode.window.showErrorMessage("Not connected to IBM i.");
          return;
        }

        const memberInfoList = selections
          .map((s) => memberInfoOf(s))
          .filter((m): m is MemberInfo => m !== undefined);

        if (memberInfoList.length === 0) {
          vscode.window.showErrorMessage("Could not determine member details from the selection.");
          return;
        }

        await checkoutMembersBatch(service, system, memberInfoList, outputChannel);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkoutAllMembers",
      async (node: BrowserNode) => {
        if (!(await ensureCheckoutFolder(context, service))) {
          return;
        }

        const sourceFileInfo = sourceFileInfoOf(node);
        if (!sourceFileInfo) {
          outputChannel.appendLine(
            `[checkout] ERROR: Could not extract source file info — raw node keys: ${node ? Object.keys(node).join(", ") : "null/undefined"}`
          );
          outputChannel.show();
          vscode.window.showErrorMessage(
            "Could not determine source file details from selection. Check 'IBM i Member Workspace' output panel for details."
          );
          return;
        }

        const system = getSystemName();
        if (!system) {
          vscode.window.showErrorMessage("Not connected to IBM i.");
          return;
        }

        let members: Awaited<ReturnType<typeof listSourceFileMembers>>;
        try {
          members = await listSourceFileMembers(sourceFileInfo.library, sourceFileInfo.sourceFile);
        } catch (err) {
          outputChannel.appendLine(`[checkout] Could not list members: ${errorMessage(err)}`);
          vscode.window.showErrorMessage(
            `Could not list members of ${sourceFileInfo.library}/${sourceFileInfo.sourceFile}: ${errorMessage(err)}`
          );
          return;
        }

        if (members.length === 0) {
          vscode.window.showInformationMessage(
            `${sourceFileInfo.library}/${sourceFileInfo.sourceFile} has no members.`
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Check out all ${members.length} member(s) from ${sourceFileInfo.library}/${sourceFileInfo.sourceFile}?`,
          {
            modal: true,
            detail:
              "Downloading a large source file can take a considerable amount of time depending on the number and size of its members and your connection speed.",
          },
          "Check Out All"
        );
        if (confirm !== "Check Out All") {
          return;
        }

        const memberInfoList = members.map((m) => ({
          library: sourceFileInfo.library,
          sourceFile: sourceFileInfo.sourceFile,
          memberName: m.name,
          extension: (m.extension || "mbr").toLowerCase(),
        }));

        await checkoutMembersBatch(service, system, memberInfoList, outputChannel);
      }
    )
  );

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
      "ibmi-member-workspace.mergeBack",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        try {
          await mergeHandler.openMergeDiff(item.entry);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Merge failed: ${errorMessage(err)}`
          );
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
      "ibmi-member-workspace.uploadToRemote",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length === 1) {
          const entry = selections[0].entry;
          const memberPath = formatMemberPath(entry);

          const confirm = await vscode.window.showWarningMessage(
            `Upload local copy of ${memberPath} to the IBM i? This will overwrite the remote member and source dates will not be preserved.`,
            { modal: true },
            "Upload"
          );

          if (confirm !== "Upload") {
            return;
          }

          try {
            let result = await service.uploadToRemote(entry);
            if (result === "remote-changed") {
              const choice = await vscode.window.showWarningMessage(
                `${memberPath} has changed on the IBM i since it was checked out. Uploading will overwrite those remote changes.`,
                {
                  modal: true,
                  detail: "Use Show Diff to review and combine the remote changes instead.",
                },
                "Overwrite Anyway",
                "Show Diff"
              );
              if (choice === "Show Diff") {
                await mergeHandler.openMergeDiff(entry);
                return;
              }
              if (choice !== "Overwrite Anyway") {
                return;
              }
              result = await service.uploadToRemote(entry, { overwriteRemoteChanges: true });
            }

            if (result === "uploaded") {
              vscode.window.showInformationMessage(
                `Successfully uploaded ${memberPath} to IBM i.`
              );
            } else {
              vscode.window.showErrorMessage(
                `Failed to upload ${memberPath} to IBM i.`
              );
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Upload failed: ${errorMessage(err)}`
            );
          }
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Upload ${selections.length} local files to the IBM i? This will overwrite the remote members and source dates will not be preserved.`,
          { modal: true },
          "Upload All"
        );
        if (confirm !== "Upload All") {
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Uploading to IBM i...", cancellable: true },
          async (progress, token) => {
            let succeeded = 0;
            let skipped = 0;
            let errors = 0;
            let cancelled = false;

            await service.runBatch(async () => {
              for (let i = 0; i < selections.length; i++) {
                if (token.isCancellationRequested) {
                  cancelled = true;
                  break;
                }
                const entry = selections[i].entry;
                progress.report({ message: `${entry.memberName} (${i + 1}/${selections.length})` });
                try {
                  const result = await service.uploadToRemote(entry);
                  if (result === "uploaded") {
                    succeeded++;
                  } else if (result === "remote-changed") {
                    skipped++;
                    outputChannel.appendLine(
                      `[upload] Skipped ${formatMemberPath(entry)}: changed on the IBM i since checkout — review it with Merge Back`
                    );
                  } else {
                    errors++;
                    outputChannel.appendLine(`[upload] Failed for ${formatMemberPath(entry)}`);
                  }
                } catch (err) {
                  errors++;
                  outputChannel.appendLine(`[upload] Error for ${formatMemberPath(entry)}: ${errorMessage(err)}`);
                }
              }
            });

            if (cancelled) {
              vscode.window.showInformationMessage(
                `Upload cancelled. ${succeeded}/${selections.length} member(s) uploaded before cancelling.`
              );
            } else if (errors > 0 || skipped > 0) {
              const skippedText = skipped > 0
                ? ` ${skipped} skipped because they changed on the IBM i since checkout.`
                : "";
              const errorText = errors > 0 ? ` ${errors} error(s).` : "";
              vscode.window.showWarningMessage(
                `Uploaded ${succeeded}/${selections.length} member(s) to IBM i.${skippedText}${errorText} See IBM i Member Workspace output panel.`
              );
              outputChannel.show();
            } else {
              vscode.window.showInformationMessage(
                `Successfully uploaded ${succeeded} member(s) to IBM i.`
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.refreshAllRemote",
      async () => {
        const system = getSystemName();
        if (!system) {
          vscode.window.showErrorMessage("Not connected to IBM i.");
          return;
        }
        const entries = service.getEntriesForSystem(system);
        if (entries.length === 0) {
          vscode.window.showInformationMessage("No checkouts to refresh.");
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing remote status...",
            cancellable: true,
          },
          async (progress, token) => {
            const tally = await service.refreshAllRemoteStatus(progress, token);
            showRefreshSummary(tally, undefined, token.isCancellationRequested);
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.refreshSourceFileRemote",
      async (item: TreeItemType) => {
        if (item?.kind !== "sourceFile") {
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Refreshing ${item.library}/${item.sourceFile}...`,
            cancellable: true,
          },
          async (progress, token) => {
            const tally = await service.refreshSourceFileRemoteStatus(
              item.system,
              item.library,
              item.sourceFile,
              progress,
              token
            );
            showRefreshSummary(
              tally,
              `${item.library}/${item.sourceFile}`,
              token.isCancellationRequested
            );
          }
        );
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
      "ibmi-member-workspace.refreshRemote",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length === 1) {
          const entry = selections[0].entry;
          try {
            const result = await service.refreshRemoteStatus(entry);
            const memberPath = formatMemberPath(entry);

            if (result === "in-sync") {
              vscode.window.showInformationMessage(
                `${memberPath} is in sync with the remote.`
              );
            } else if (result === "modified") {
              vscode.window.showInformationMessage(
                `${memberPath} has local changes not yet merged back. Remote is unchanged.`
              );
            } else if (result === "remote-changed") {
              const choice = await vscode.window.showInformationMessage(
                `${memberPath} has changed on the IBM i. Your local copy has no changes, so re-checking out is safe.`,
                "Re-checkout",
                "Show Diff"
              );
              if (choice === "Re-checkout") {
                await service.recheckout(entry);
                vscode.window.showInformationMessage(
                  `Re-checked out ${memberPath} from IBM i.`
                );
              } else if (choice === "Show Diff") {
                await mergeHandler.openMergeDiff(entry);
              }
            } else {
              const choice = await vscode.window.showWarningMessage(
                `${memberPath} has changed both locally and on the IBM i.`,
                {
                  detail:
                    "Re-checkout will discard your local changes. Use Merge Back to review and combine the differences instead.",
                },
                "Merge Back",
                "Re-checkout (discard local changes)",
                "Cancel"
              );
              if (choice === "Re-checkout (discard local changes)") {
                await service.recheckout(entry);
                vscode.window.showInformationMessage(
                  `Re-checked out ${memberPath} from IBM i.`
                );
              } else if (choice === "Merge Back") {
                await mergeHandler.openMergeDiff(entry);
              }
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Refresh failed: ${errorMessage(err)}`
            );
          }
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Refresh remote status for ${selections.length} selected members? This will contact the IBM i for each one.`,
          { modal: true },
          "Refresh"
        );
        if (confirm !== "Refresh") {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing remote status...",
            cancellable: true,
          },
          async (progress, token) => {
            const entries = selections.map((s) => s.entry);
            const tally = await service.refreshEntries(entries, progress, token);
            showRefreshSummary(tally, undefined, token.isCancellationRequested);
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.discardCheckout",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        const entries = selections.map((s) => s.entry);

        if (entries.length === 1) {
          try {
            await service.discardCheckout(entries[0]);
          } catch (err) {
            vscode.window.showErrorMessage(
              `Discard failed: ${errorMessage(err)}`
            );
          }
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete ${entries.length} checked-out members and remove them from checkouts?`,
          {
            modal: true,
            detail: "Make sure you've already merged any changes back to the IBM i.",
          },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }

        try {
          await service.discardEntries(entries);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Discard failed: ${errorMessage(err)}`
          );
        }
      }
    )
  );

  let selectedForCompare: CheckedOutMember | undefined;

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
      "ibmi-member-workspace.selectForCompare",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        selectedForCompare = item.entry;
        await vscode.commands.executeCommand("setContext", "ibmi-member-workspace:hasCompareSelection", true);
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(
          `Selected for compare: ${buildLocalFileName(item.entry)}`,
          3000
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithActive",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const rightUri = vscode.window.activeTextEditor?.document.uri;
        if (!rightUri) {
          vscode.window.showErrorMessage("No active editor to compare with.");
          return;
        }
        const localUri = vscode.Uri.file(item.entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          rightUri,
          `${buildLocalFileName(item.entry)} ↔ Active File`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithSelected",
      async (item: TreeItemType) => {
        if (item?.kind !== "member" || !selectedForCompare) {
          return;
        }
        const leftUri = vscode.Uri.file(selectedForCompare.localPath);
        const rightUri = vscode.Uri.file(item.entry.localPath);
        const leftLabel = buildLocalFileName(selectedForCompare);
        const rightLabel = buildLocalFileName(item.entry);
        await vscode.commands.executeCommand(
          "vscode.diff",
          leftUri,
          rightUri,
          `${leftLabel} ↔ ${rightLabel}`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithLocalFile",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const picks = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Compare",
        });
        if (!picks?.length) {
          return;
        }
        const localUri = vscode.Uri.file(item.entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          picks[0],
          `${buildLocalFileName(item.entry)} ↔ Local File`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithIfsFile",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const ifsPath = await vscode.window.showInputBox({
          prompt: "Enter the IFS file path (requires active IBM i connection)",
          placeHolder: "/home/user/file.rpgle",
        });
        if (!ifsPath?.trim()) {
          return;
        }
        const ifsUri = vscode.Uri.from({ scheme: "streamfile", path: ifsPath.trim() });
        const localUri = vscode.Uri.file(item.entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          ifsUri,
          `${buildLocalFileName(item.entry)} ↔ IFS`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithMember",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const entry = item.entry;
        const defaultValue = `${entry.library}/${entry.sourceFile}/${buildLocalFileName(entry)}`;
        const input = await vscode.window.showInputBox({
          prompt: "Enter member path (LIBRARY/FILE/NAME.EXT or ASP/LIBRARY/FILE/NAME.EXT)",
          placeHolder: "MYLIB/QRPGLESRC/MYPROG.RPGLE",
          value: defaultValue,
        });
        if (!input?.trim()) {
          return;
        }
        const parts = input.trim().toUpperCase().split("/");
        let memberUri: vscode.Uri;
        if (parts.length === 3) {
          memberUri = vscode.Uri.from({ scheme: "member", path: `/${parts[0]}/${parts[1]}/${parts[2]}` });
        } else if (parts.length === 4) {
          memberUri = vscode.Uri.from({ scheme: "member", path: `/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}` });
        } else {
          vscode.window.showErrorMessage("Invalid member path. Use format: LIBRARY/FILE/NAME.EXT");
          return;
        }
        const localUri = vscode.Uri.file(entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          memberUri,
          `${buildLocalFileName(entry)} ↔ Member`
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

function hasOpenWorkspace(context: vscode.ExtensionContext): boolean {
  return Boolean(context.storageUri && vscode.workspace.workspaceFolders?.length);
}

async function updateCheckoutFolderContext(service: CheckoutService): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    checkoutFolderContext,
    Boolean(service.getCheckoutRoot())
  );
}

async function promptToOpenWorkspace(modal: boolean): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Open a folder or workspace before configuring IBM i member checkouts.",
    { modal },
    "Open Folder"
  );
  if (choice === "Open Folder") {
    await vscode.commands.executeCommand("workbench.action.files.openFolder");
  }
}

async function configureCheckoutFolder(
  context: vscode.ExtensionContext,
  service: CheckoutService
): Promise<boolean> {
  if (!hasOpenWorkspace(context)) {
    await promptToOpenWorkspace(true);
    return false;
  }

  const currentRoot = service.getCheckoutRoot();
  if (currentRoot && service.hasEntries()) {
    vscode.window.showWarningMessage(
      `The checkout folder cannot be changed while members are tracked. Merge or discard all checkouts first. Current folder: ${currentRoot.fsPath}`
    );
    return false;
  }

  const picks = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: currentRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: "Use as Checkout Folder",
    title: "Choose a checkout folder for this workspace",
  });
  const selected = picks?.[0];
  if (!selected) {
    return false;
  }

  try {
    await service.setCheckoutRoot(selected);
    await updateCheckoutFolderContext(service);
    vscode.window.showInformationMessage(
      `Checkout folder configured for this workspace: ${selected.fsPath}`
    );
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not use ${selected.fsPath} as the checkout folder: ${errorMessage(err)}`
    );
    return false;
  }
}

async function ensureCheckoutFolder(
  context: vscode.ExtensionContext,
  service: CheckoutService
): Promise<boolean> {
  if (!hasOpenWorkspace(context)) {
    await promptToOpenWorkspace(true);
    return false;
  }

  if (!service.getCheckoutRoot()) {
    const choice = await vscode.window.showWarningMessage(
      "Choose where checked-out member files will be stored before continuing.",
      {
        modal: true,
        detail: "No member will be downloaded until a checkout folder is selected for this workspace.",
      },
      "Choose Folder"
    );
    if (choice !== "Choose Folder") {
      return false;
    }
    return configureCheckoutFolder(context, service);
  }

  try {
    await service.validateCheckoutRoot();
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(
      `The configured checkout folder is not accessible: ${errorMessage(err)}`
    );
    return false;
  }
}

async function offerCheckoutFolderSetup(
  context: vscode.ExtensionContext,
  service: CheckoutService
): Promise<void> {
  if (service.getCheckoutRoot()) {
    return;
  }

  if (!hasOpenWorkspace(context)) {
    const choice = await vscode.window.showInformationMessage(
      "IBM i Member Workspace requires an open folder or workspace before members can be checked out.",
      "Open Folder",
      "Later"
    );
    if (choice === "Open Folder") {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
    }
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Choose a local folder for IBM i member checkouts in this workspace.",
    "Choose Folder",
    "Later"
  );
  if (choice === "Choose Folder") {
    await configureCheckoutFolder(context, service);
  }
}

async function checkoutMembersBatch(
  service: CheckoutService,
  system: string,
  memberInfoList: MemberInfo[],
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const alreadyCheckedOut = memberInfoList.filter(
    (m) => service.findEntry(system, m.library, m.sourceFile, m.memberName)
  );

  let redownloadBehavior: "skip" | "force" = "force";
  if (alreadyCheckedOut.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${alreadyCheckedOut.length} of ${memberInfoList.length} selected member(s) are already checked out. What would you like to do?`,
      "Re-download All",
      "Skip Existing",
      "Cancel"
    );
    if (!choice || choice === "Cancel") {
      return;
    }
    redownloadBehavior = choice === "Re-download All" ? "force" : "skip";
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking out members...", cancellable: true },
    async (progress, token) => {
      let succeeded = 0;
      let errors = 0;
      let cancelled = false;

      await service.runBatch(async () => {
        for (let i = 0; i < memberInfoList.length; i++) {
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          const m = memberInfoList[i];
          progress.report({ message: `${m.memberName} (${i + 1}/${memberInfoList.length})` });
          try {
            await service.checkoutMember(
              m.library, m.sourceFile, m.memberName, m.extension,
              { redownloadBehavior, suppressAutoOpen: true }
            );
            succeeded++;
          } catch (err) {
            if (!(err instanceof CheckoutCancelledError)) {
              errors++;
              outputChannel.appendLine(`[checkout] Error for ${m.memberName}: ${errorMessage(err)}`);
            }
          }
        }
      });

      if (cancelled) {
        vscode.window.showInformationMessage(
          `Checkout cancelled. ${succeeded}/${memberInfoList.length} member(s) checked out from ${system} before cancelling.`
        );
      } else if (errors > 0) {
        vscode.window.showWarningMessage(
          `Checked out ${succeeded}/${memberInfoList.length} members from ${system}. ${errors} error(s) — see IBM i Member Workspace output panel.`
        );
        outputChannel.show();
      } else {
        vscode.window.showInformationMessage(
          `Checked out ${succeeded} member(s) from ${system}.`
        );
      }
    }
  );
}

function showRefreshSummary(
  tally: RefreshTally,
  scope: string | undefined,
  cancelled: boolean
): void {
  const prefix = scope ? `${scope}: ` : "";
  const { inSync, modified, remoteChanged, conflict, errors } = tally;
  const counts = [
    inSync > 0 && `${inSync} in sync`,
    modified > 0 && `${modified} with local changes`,
    remoteChanged > 0 && `${remoteChanged} changed on the IBM i`,
    conflict > 0 && `${conflict} in conflict`,
    errors > 0 && `${errors} error(s)`,
  ]
    .filter(Boolean)
    .join(", ");

  if (cancelled) {
    vscode.window.showInformationMessage(
      `${prefix}Refresh cancelled${counts ? ` — ${counts}` : ""}.`
    );
  } else if (errors > 0 || conflict > 0) {
    const hint = errors > 0
      ? " See IBM i Member Workspace output panel."
      : " Review conflicts with Merge Back.";
    vscode.window.showWarningMessage(`${prefix}Refresh complete: ${counts}.${hint}`);
  } else if (modified > 0 || remoteChanged > 0) {
    vscode.window.showInformationMessage(`${prefix}Refresh complete: ${counts}.`);
  } else {
    vscode.window.showInformationMessage(
      `${prefix}All ${inSync} member(s) are in sync with the remote.`
    );
  }
}

/** Normalizes a node's resourceUri (a vscode.Uri, or something that stringifies to one). */
function resourceUriOf(node: BrowserNode | undefined): UriParts | undefined {
  const resourceUri = node?.resourceUri;
  if (!resourceUri) {
    return undefined;
  }
  return resourceUri instanceof vscode.Uri
    ? resourceUri
    : vscode.Uri.parse(String(resourceUri));
}

function sourceFileInfoOf(node: BrowserNode | undefined): SourceFileInfo | undefined {
  return extractSourceFileInfo(node, resourceUriOf(node));
}

function memberInfoOf(node: BrowserNode | undefined): MemberInfo | undefined {
  return extractMemberInfo(node, resourceUriOf(node));
}

export function deactivate(): void {
  // cleanup handled by disposables
}
