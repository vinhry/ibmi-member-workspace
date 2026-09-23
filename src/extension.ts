import * as vscode from "vscode";
import * as path from "node:path";
import { CheckoutService } from "./checkoutService";
import { CheckoutTreeProvider } from "./checkoutTreeProvider";
import { MergeHandler } from "./mergeHandler";
import { GitService } from "./gitService";
import {
  getSystemName,
  listSourceFileMembers,
  memberUri,
  onConnectionChange,
} from "./codeForIBMi";
import { CheckoutCancelledError, LocalFileMissingError, errorMessage } from "./errors";
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

  const gitService = new GitService(outputChannel);
  const service = new CheckoutService(context, outputChannel, gitService);
  context.subscriptions.push(service);
  await service.initialize();
  const initialSystem = getSystemName();
  const initialRoot = initialSystem ? service.getGitRoot(initialSystem) : undefined;
  if (
    initialRoot &&
    vscode.workspace.getConfiguration("ibmi-member-workspace").get("gitIntegration", false) &&
    await gitService.isExactRepository(initialRoot.fsPath)
  ) {
    await service.synchronizeWorkItem(initialSystem);
  }
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

  // Status bar item showing the active local-history work item.
  const gitBranchStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  gitBranchStatusBar.tooltip = "Local Change History work item (stored as a local Git branch)";
  gitBranchStatusBar.command = "ibmi-member-workspace.selectGitBranch";
  context.subscriptions.push(gitBranchStatusBar);

  const refreshGitStatusBar = async () => {
    const system = getSystemName();
    const root = system ? service.getGitRoot(system) : undefined;
    if (!system || !root || !(await service.isGitEnabled())) {
      gitBranchStatusBar.hide();
      return;
    }
    const branch = await gitService.currentBranch(root.fsPath);
    if (branch) {
      gitBranchStatusBar.text = `$(git-branch) Work Item: ${branch}`;
      gitBranchStatusBar.tooltip = `Local Change History for ${system}\nRepository: ${root.fsPath}`;
      gitBranchStatusBar.show();
    } else {
      gitBranchStatusBar.hide();
    }
  };

  onConnectionChange(context, () => {
    treeProvider.refresh();
    const system = getSystemName();
    if (system && vscode.workspace.getConfiguration("ibmi-member-workspace").get("gitIntegration", false)) {
      void service.ensureGitReady(system);
    }
    void refreshGitStatusBar();
  });
  service.onDidChange(() => void refreshGitStatusBar());
  void refreshGitStatusBar();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("ibmi-member-workspace.gitIntegration")) {
        return;
      }
      service.resetGitSetupState();
      if (vscode.workspace.getConfiguration("ibmi-member-workspace").get("gitIntegration", false)) {
        const result = await service.ensureGitReady();
        if (result.status !== "success" && result.message) {
          vscode.window.showWarningMessage(result.message);
        }
      }
      await refreshGitStatusBar();
    })
  );

  // Only documents opened by the explicit Merge Back command are tracked here.
  const pendingMergeBacks = new Map<string, CheckedOutMember>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme === "file") {
        const saved = service.findEntryByLocalPath(doc.uri.fsPath);
        if (!saved) {
          return;
        }
        try {
          await service.updateStatusAfterLocalSave(saved);
        } catch (err) {
          outputChannel.appendLine(`[status] Could not update ${formatMemberPath(saved)}: ${errorMessage(err)}`);
        }
        return;
      }
      const entry = pendingMergeBacks.get(mergeDocumentKey(doc.uri));
      if (!entry) {
        return;
      }
      pendingMergeBacks.delete(mergeDocumentKey(doc.uri));
      try {
        const result = await service.recordMergeBack(entry, doc.getText());
        if (result.status !== "success" && result.status !== "noChanges") {
          vscode.window.showWarningMessage(result.message ?? "The merge was saved, but its local checkpoint failed.");
        }
      } catch (err) {
        vscode.window.showWarningMessage(
          `The remote member was saved, but its local checkout was not updated: ${errorMessage(err)}`
        );
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      pendingMergeBacks.delete(mergeDocumentKey(doc.uri));
    })
  );

  registerCommands(
    context,
    service,
    treeProvider,
    mergeHandler,
    treeView,
    gitService,
    refreshGitStatusBar,
    pendingMergeBacks
  );
  void offerCheckoutFolderSetup(context, service).catch((err) => {
    outputChannel.appendLine(`[setup] Could not show checkout folder setup: ${errorMessage(err)}`);
  });
  void offerLegacyRepositoryRepair(service, gitService).catch((err) => {
    outputChannel.appendLine(`[git] Could not inspect legacy repository layout: ${errorMessage(err)}`);
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
  treeView: vscode.TreeView<TreeItemType>,
  gitService: GitService,
  refreshGitStatusBar: () => Promise<void>,
  pendingMergeBacks: Map<string, CheckedOutMember>
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
          pendingMergeBacks.set(
            mergeDocumentKey(memberUri(item.entry, { editable: true })),
            item.entry
          );
          await mergeHandler.openMergeDiff(item.entry);
        } catch (err) {
          pendingMergeBacks.delete(mergeDocumentKey(memberUri(item.entry, { editable: true })));
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
          if (!(await saveDirtyLocalFiles([entry]))) {
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
        if (!(await saveDirtyLocalFiles(selections.map((s) => s.entry)))) {
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
        if (!(await saveDirtyLocalFiles(entries))) {
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
        const groupEntries = service
          .getEntriesForSystem(item.system)
          .filter((e) => e.library === item.library && e.sourceFile === item.sourceFile);
        if (!(await saveDirtyLocalFiles(groupEntries))) {
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

        if (!(await saveDirtyLocalFiles(selections.map((s) => s.entry)))) {
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
            if (err instanceof LocalFileMissingError) {
              await handleMissingLocalFile(service, entry);
            } else {
              vscode.window.showErrorMessage(
                `Refresh failed: ${errorMessage(err)}`
              );
            }
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

        const withLocalChanges = await countLocalChanges(service, entries);
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${entries.length} checked-out members and remove them from checkouts?`,
          {
            modal: true,
            detail: withLocalChanges > 0
              ? `${withLocalChanges} of them have local changes that have not been sent to the IBM i. Those changes will be lost.`
              : "Make sure you've already merged any changes back to the IBM i.",
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

  let selectedForCompareId: string | undefined;
  const clearCompareSelectionIfGone = () => {
    if (selectedForCompareId && !service.findEntryById(selectedForCompareId)) {
      selectedForCompareId = undefined;
      void vscode.commands.executeCommand("setContext", "ibmi-member-workspace:hasCompareSelection", false);
    }
  };
  context.subscriptions.push(service.onDidChange(clearCompareSelectionIfGone));

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
        selectedForCompareId = item.entry.id;
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
        const selectedForCompare = selectedForCompareId
          ? service.findEntryById(selectedForCompareId)
          : undefined;
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
        let otherMemberUri: vscode.Uri;
        if (parts.length === 3) {
          otherMemberUri = vscode.Uri.from({ scheme: "member", path: `/${parts[0]}/${parts[1]}/${parts[2]}` });
        } else if (parts.length === 4) {
          otherMemberUri = vscode.Uri.from({ scheme: "member", path: `/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}` });
        } else {
          vscode.window.showErrorMessage("Invalid member path. Use format: LIBRARY/FILE/NAME.EXT");
          return;
        }
        const localUri = vscode.Uri.file(entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          otherMemberUri,
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

  // ── Local Change History: setup ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.setupGitIntegration",
      async () => {
        if (!service.getCheckoutRoot()) {
          const configured = await configureCheckoutFolder(context, service);
          if (!configured) {
            return;
          }
        }
        await vscode.workspace
          .getConfiguration("ibmi-member-workspace")
          .update("gitIntegration", true, vscode.ConfigurationTarget.Workspace);
        service.resetGitSetupState();
        const result = await service.ensureGitReady();
        if (result.status === "success") {
          vscode.window.showInformationMessage(
            "Local Change History is ready. Checkpoints stay on this computer until you choose to share them."
          );
        } else if (result.message) {
          vscode.window.showWarningMessage(result.message);
        }
        await refreshGitStatusBar();
      }
    )
  );

  // ── Local Change History: work items ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.selectGitBranch",
      async () => {
        const system = getSystemName();
        const root = system ? service.getGitRoot(system) : undefined;
        if (!system || !root) {
          vscode.window.showWarningMessage(
            "Connect to an IBM i system and choose a checkout folder before managing work items."
          );
          return;
        }

        const ready = await service.ensureGitReady(system);
        if (ready.status !== "success") {
          const choice = await vscode.window.showInformationMessage(
            ready.message ?? "Set up Local Change History before managing work items.",
            "Set Up"
          );
          if (choice === "Set Up") {
            await vscode.commands.executeCommand("ibmi-member-workspace.setupGitIntegration");
          }
          return;
        }

        const [branches, currentBranch] = await Promise.all([
          gitService.listBranches(root.fsPath),
          gitService.currentBranch(root.fsPath),
        ]);

        const CREATE_ITEM = "$(add)  Start New Work Item\u2026";

        const items: vscode.QuickPickItem[] = [
          { label: CREATE_ITEM },
          ...branches.map((b) => ({
            label: b === currentBranch ? `$(check)  ${b}` : b,
            description: b === currentBranch ? "current" : undefined,
          })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
          title: "Local Change History — Switch Work Item",
          placeHolder: currentBranch ? `Current work item: ${currentBranch}` : "No work item yet",
        });

        if (!picked) {
          return;
        }

        if (picked.label === CREATE_ITEM) {
          const name = await vscode.window.showInputBox({
            title: "Start New Work Item",
            prompt: "Use a ticket or project name. Git stores this as a local branch.",
            placeHolder: "e.g. TICKET-123 or payroll-fix",
            validateInput: (v) => (v.trim() ? undefined : "Branch name cannot be empty"),
          });
          if (!name?.trim()) {
            return;
          }
          if (!(await prepareForWorkItemChange(
            root,
            system,
            service,
            gitService,
            currentBranch,
            pendingMergeBacks
          ))) {
            return;
          }
          const result = await gitService.createWorkItem(root.fsPath, name.trim());
          if (result.status === "success") {
            await service.activateWorkItem(system, name.trim(), true);
            vscode.window.showInformationMessage(
              `Started work item “${name.trim()}”.`
            );
          } else {
            vscode.window.showErrorMessage(result.message ?? `Could not start work item “${name.trim()}”.`);
          }
        } else {
          // Strip the $(check) prefix if it was the current branch label
          const rawName = picked.label.replace(/^\$\(check\)\s+/, "");
          if (rawName === currentBranch) {
            vscode.window.showInformationMessage(`Already using work item “${currentBranch}”.`);
          } else {
            if (!(await prepareForWorkItemChange(
              root,
              system,
              service,
              gitService,
              currentBranch,
              pendingMergeBacks
            ))) {
              return;
            }
            const result = await gitService.switchWorkItem(root.fsPath, rawName);
            if (result.status === "success") {
              await service.activateWorkItem(system, rawName, false);
              treeProvider.refresh();
              vscode.window.showInformationMessage(`Switched to work item “${rawName}”.`);
            } else {
              vscode.window.showErrorMessage(result.message ?? `Could not switch to work item “${rawName}”.`);
            }
          }
        }

        await refreshGitStatusBar();
      }
    )
  );

  // ── Local Change History: save checkpoint ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.commitNow",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }

        const entry = item.entry;
        const defaultMessage = `snapshot: ${formatMemberPath(entry)}`;

        const userMessage = await vscode.window.showInputBox({
          title: "Save Checkpoint",
          prompt: "Describe this local history point. This does not upload to IBM i.",
          placeHolder: defaultMessage,
        });

        if (userMessage === undefined) {
          // cancelled
          return;
        }

        const message = userMessage.trim() || defaultMessage;

        const result = await service.saveCheckpoint(entry.system, [entry.localPath], message);
        if (result.status === "success") {
          vscode.window.showInformationMessage(`Checkpoint saved for ${formatMemberPath(entry)}.`);
        } else if (result.status === "noChanges") {
          vscode.window.showInformationMessage("No changes since the last checkpoint.");
        } else {
          vscode.window.showErrorMessage(result.message ?? "Could not save the checkpoint.");
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.viewGitHistory", async () => {
      await vscode.commands.executeCommand("workbench.view.scm");
    })
  );
}

async function prepareForWorkItemChange(
  root: vscode.Uri,
  system: string,
  service: CheckoutService,
  gitService: GitService,
  currentWorkItem: string,
  pendingMergeBacks: Map<string, CheckedOutMember>
): Promise<boolean> {
  if (pendingMergeBacks.size > 0) {
    vscode.window.showWarningMessage(
      "Finish or close the open Merge Back comparison before switching work items."
    );
    return false;
  }
  const dirtyDocuments = vscode.workspace.textDocuments.filter(
    (document) =>
      document.isDirty &&
      document.uri.scheme === "file" &&
      pathIsInside(root.fsPath, document.uri.fsPath)
  );
  if (dirtyDocuments.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${dirtyDocuments.length} checkout file(s) have unsaved editor changes.`,
      { modal: true, detail: "Save them before switching work items so no edits are lost." },
      "Save All and Continue"
    );
    if (choice !== "Save All and Continue") {
      return false;
    }
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    if (dirtyDocuments.some((document) => document.isDirty)) {
      vscode.window.showWarningMessage(
        "Some checkout files could not be saved. Work item switching was cancelled."
      );
      return false;
    }
  }

  const state = await gitService.getWorkingTreeState(root.fsPath);
  if (state.status === "success") {
    return true;
  }
  if (state.status !== "dirtyWorktree") {
    vscode.window.showErrorMessage(state.message ?? "Could not inspect local changes.");
    return false;
  }
  const changedPaths = await gitService.changedPaths(root.fsPath);
  const managed = new Set(service.getManagedPaths(system).map((value) => path.resolve(value)));
  const managedChanges = changedPaths.filter((value) => managed.has(path.resolve(value)));
  if (managedChanges.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      "This work item has managed member changes that are not in a checkpoint.",
      {
        modal: true,
        detail: "Save a checkpoint before switching so the changes remain available in this work item.",
      },
      "Save Checkpoint and Switch"
    );
    if (choice !== "Save Checkpoint and Switch") {
      return false;
    }
    const checkpoint = await service.saveCheckpoint(
      system,
      managedChanges,
      `checkpoint: before leaving ${currentWorkItem || "work item"}`
    );
    if (checkpoint.status !== "success" && checkpoint.status !== "noChanges") {
      vscode.window.showErrorMessage(checkpoint.message ?? "Could not save a checkpoint before switching.");
      return false;
    }
  }
  const remaining = await gitService.changedPaths(root.fsPath);
  if (remaining.length > 0) {
    vscode.window.showWarningMessage(
      "Work item switching was cancelled because this system repository still has unrelated changes. Commit or stash them in Source Control, then try again."
    );
    return false;
  }
  return true;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function mergeDocumentKey(uri: vscode.Uri): string {
  return uri.with({ query: "", fragment: "" }).toString();
}

async function offerLegacyRepositoryRepair(
  service: CheckoutService,
  gitService: GitService
): Promise<void> {
  const inspection = await service.detectMisplacedParentRepository();
  if (!inspection) {
    return;
  }
  const systems = service.getKnownSystems();
  const directories = systems.map((state) => state.directory);
  if (!gitService.isSafeMisplacedRepository(inspection, directories)) {
    vscode.window.showWarningMessage(
      "The checkout container contains an older extension-created Git repository with unrelated files or history. It will not be used. Preserve it and recover any needed commits manually; each system directory is now its own repository."
    );
    return;
  }
  const repair = await vscode.window.showInformationMessage(
    "An older Local Change History repository was found at the checkout container. Repair work-item branches in the per-system repositories? The old repository will be preserved.",
    "Repair Now",
    "Keep for Now"
  );
  if (repair !== "Repair Now") {
    return;
  }
  const migrated = await service.migrateLegacyRepository();
  if (migrated.status !== "success") {
    vscode.window.showWarningMessage(
      `${migrated.message ?? "The legacy repository could not be repaired."} The parent repository was preserved for manual recovery.`
    );
    return;
  }
  const archive = await vscode.window.showInformationMessage(
    "Per-system Local Change History is ready. The misplaced parent repository is still preserved at the checkout container.",
    "Archive Misplaced Repository",
    "Keep for Now"
  );
  if (archive !== "Archive Misplaced Repository") {
    return;
  }
  try {
    const backups = await service.archiveMisplacedRepository();
    const paths = [backups.gitBackup, backups.gitignoreBackup].filter(Boolean).join(" and ");
    vscode.window.showInformationMessage(
      `Archived the misplaced repository to ${paths}. Restore it by renaming the backup path(s) to their original .git and .gitignore names.`
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `The misplaced repository was not archived: ${errorMessage(err)}`
    );
  }
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

/**
 * Offers to save open editors with unsaved edits to the given checkouts, so
 * operations that read the local file see what the user sees. Returns false if
 * the user cancels.
 */
async function saveDirtyLocalFiles(entries: CheckedOutMember[]): Promise<boolean> {
  const paths = new Set(entries.map((e) => vscode.Uri.file(e.localPath).fsPath));
  const dirty = vscode.workspace.textDocuments.filter(
    (doc) => doc.isDirty && doc.uri.scheme === "file" && paths.has(doc.uri.fsPath)
  );
  if (dirty.length === 0) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    dirty.length === 1
      ? `${vscode.workspace.asRelativePath(dirty[0].uri)} has unsaved changes.`
      : `${dirty.length} checked-out files have unsaved changes.`,
    { modal: true, detail: "Save them before continuing so the IBM i is compared with your latest edits." },
    "Save and Continue"
  );
  if (choice !== "Save and Continue") {
    return false;
  }

  for (const doc of dirty) {
    if (!(await doc.save())) {
      vscode.window.showErrorMessage(`Could not save ${doc.uri.fsPath}.`);
      return false;
    }
  }
  return true;
}

async function countLocalChanges(
  service: CheckoutService,
  entries: CheckedOutMember[]
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    try {
      if (await service.hasLocalChanges(entry)) {
        count++;
      }
    } catch (err) {
      outputChannel.appendLine(`[status] Could not read ${entry.localPath}: ${errorMessage(err)}`);
    }
  }
  return count;
}

async function handleMissingLocalFile(
  service: CheckoutService,
  entry: CheckedOutMember
): Promise<void> {
  const memberPath = formatMemberPath(entry);
  const choice = await vscode.window.showWarningMessage(
    `The local copy of ${memberPath} no longer exists.`,
    { detail: entry.localPath },
    "Re-checkout",
    "Remove from Checkouts"
  );
  try {
    if (choice === "Re-checkout") {
      await service.recheckout(entry);
      vscode.window.showInformationMessage(`Re-checked out ${memberPath} from IBM i.`);
    } else if (choice === "Remove from Checkouts") {
      await service.forgetEntries([entry]);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`${choice} failed: ${errorMessage(err)}`);
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
  let discardLocalChanges = false;
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

    if (redownloadBehavior === "force") {
      const existingEntries = alreadyCheckedOut
        .map((m) => service.findEntry(system, m.library, m.sourceFile, m.memberName))
        .filter((e): e is CheckedOutMember => e !== undefined);
      if (!(await saveDirtyLocalFiles(existingEntries))) {
        return;
      }
      const withLocalChanges = await countLocalChanges(service, existingEntries);
      if (withLocalChanges > 0) {
        const discard = await vscode.window.showWarningMessage(
          `${withLocalChanges} of the already checked-out member(s) have local changes that have not been sent to the IBM i.`,
          { modal: true, detail: "Discarding re-downloads them and loses those changes. Keeping skips them." },
          "Discard Local Changes",
          "Keep Local Changes"
        );
        if (!discard) {
          return;
        }
        discardLocalChanges = discard === "Discard Local Changes";
      }
    }
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
              { redownloadBehavior, suppressAutoOpen: true, discardLocalChanges }
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
