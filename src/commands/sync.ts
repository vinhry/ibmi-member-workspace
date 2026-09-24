import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { getSystemName, memberUri } from "../codeForIBMi";
import { LocalFileMissingError, errorMessage } from "../errors";
import { mergeDocumentKey } from "../mergeHandler";
import { countLocalChanges, resolveMemberSelections, saveDirtyLocalFiles } from "../prompts";
import { CheckedOutMember, RefreshTally, TreeItemType, formatMemberPath } from "../types";
import { CommandContext } from "./context";

export function registerSyncCommands(ctx: CommandContext): void {
  const { context, service, mergeHandler, pendingMergeBacks, log } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.mergeBack",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const key = mergeDocumentKey(memberUri(item.entry, { editable: true }));
        try {
          pendingMergeBacks.set(key, item.entry);
          await mergeHandler.openMergeDiff(item.entry);
        } catch (err) {
          pendingMergeBacks.delete(key);
          vscode.window.showErrorMessage(
            `Merge failed: ${errorMessage(err)}`
          );
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
            } else if (result === "uploaded-altered") {
              const choice = await vscode.window.showWarningMessage(
                `Uploaded ${memberPath}, but the IBM i copy differs from your local file (for example, lines longer than the record length were truncated).`,
                "Merge Back"
              );
              if (choice === "Merge Back") {
                await mergeHandler.openMergeDiff(entry);
              }
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
            let altered = 0;
            let skipped = 0;
            let errors = 0;
            let cancelled = false;
            const uploaded: string[] = [];

            await service.runBatch(async () => {
              for (let i = 0; i < selections.length; i++) {
                if (token.isCancellationRequested) {
                  cancelled = true;
                  break;
                }
                const entry = selections[i].entry;
                progress.report({ message: `${entry.memberName} (${i + 1}/${selections.length})` });
                try {
                  const result = await service.uploadToRemote(entry, { deferCheckpointTo: uploaded });
                  if (result === "uploaded") {
                    succeeded++;
                  } else if (result === "uploaded-altered") {
                    succeeded++;
                    altered++;
                  } else if (result === "remote-changed") {
                    skipped++;
                    log.appendLine(
                      `[upload] Skipped ${formatMemberPath(entry)}: changed on the IBM i since checkout — review it with Merge Back`
                    );
                  } else {
                    errors++;
                    log.appendLine(`[upload] Failed for ${formatMemberPath(entry)}`);
                  }
                } catch (err) {
                  errors++;
                  log.appendLine(`[upload] Error for ${formatMemberPath(entry)}: ${errorMessage(err)}`);
                }
              }
              // One checkpoint for the whole batch, including members uploaded before a cancel.
              const system = selections[0].entry.system;
              await service.saveBatchCheckpoint(
                system,
                uploaded,
                `upload: ${uploaded.length} member${uploaded.length === 1 ? "" : "s"} to ${system}`
              );
            });

            if (cancelled) {
              vscode.window.showInformationMessage(
                `Upload cancelled. ${succeeded}/${selections.length} member(s) uploaded before cancelling.`
              );
            } else if (errors > 0 || skipped > 0 || altered > 0) {
              const alteredText = altered > 0
                ? ` ${altered} differ on the IBM i from the local copy (e.g. truncated lines).`
                : "";
              const skippedText = skipped > 0
                ? ` ${skipped} skipped because they changed on the IBM i since checkout.`
                : "";
              const errorText = errors > 0 ? ` ${errors} error(s).` : "";
              vscode.window.showWarningMessage(
                `Uploaded ${succeeded}/${selections.length} member(s) to IBM i.${alteredText}${skippedText}${errorText} See IBM i Member Workspace output panel.`
              );
              log.show();
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

        const withLocalChanges = await countLocalChanges(service, entries, log);
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
