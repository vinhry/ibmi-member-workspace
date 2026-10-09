import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { getSystemName, sourceDatesEnabled } from "../codeForIBMi";
import { LocalFileMissingError, RemoteMemberMissingError, errorMessage } from "../errors";
import { selectMergeCandidates } from "../mergePreparation";
import { countLocalChanges, resolveMemberSelections, saveDirtyLocalFiles } from "../prompts";
import { CheckedOutMember, RefreshTally, TreeItemType, formatMemberPath, isReferenceCopy } from "../types";
import { CommandContext } from "./context";
import { reportRemoteMissing } from "./remoteMissing";
import { offerCheckin, uploadWithConflictHandling } from "./uploadMember";

export function registerSyncCommands(ctx: CommandContext): void {
  const { context, service, mergeHandler, log } = ctx;

  /** Runs a per-member comparison, reporting a missing local file or member the usual way. */
  const forEachMember = async (
    entries: CheckedOutMember[],
    what: string,
    run: (entry: CheckedOutMember) => Promise<void>
  ) => {
    for (const entry of entries) {
      try {
        await run(entry);
      } catch (err) {
        if (err instanceof LocalFileMissingError) {
          await handleMissingLocalFile(service, entry);
        } else if (err instanceof RemoteMemberMissingError) {
          await reportRemoteMissing(service, [entry]);
        } else {
          vscode.window.showErrorMessage(`${what} failed for ${formatMemberPath(entry)}: ${errorMessage(err)}`);
        }
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.mergeBack",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const entries = resolveMemberSelections(service, item, allSelections).map((s) => s.entry);
        if (entries.length === 0) {
          return;
        }
        const chosen = entries.length === 1 ? entries : await pickMembersToMerge(entries);
        await forEachMember(chosen, "Merge Back", (entry) => mergeHandler.openMergeEditor(entry));
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithRemote",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const entries = resolveMemberSelections(service, item, allSelections).map((s) => s.entry);
        if (!(await saveDirtyLocalFiles(entries))) {
          return;
        }
        await forEachMember(entries, "Compare with IBM i", (entry) => mergeHandler.compareWithRemote(entry));
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.showChangesSinceCheckout",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const entries = resolveMemberSelections(service, item, allSelections).map((s) => s.entry);
        if (!(await saveDirtyLocalFiles(entries))) {
          return;
        }
        await forEachMember(entries, "Show Changes Since Checkout", (entry) => mergeHandler.showChangesSinceCheckout(entry));
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.uploadToRemote",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(service, item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length === 1) {
          const entry = selections[0].entry;
          const memberPath = formatMemberPath(entry);

          const confirm = await vscode.window.showWarningMessage(
            `Upload local copy of ${memberPath} to the IBM i? This will overwrite the remote member.`,
            { modal: true, detail: sourceDatesDetail() },
            "Upload"
          );

          if (confirm !== "Upload") {
            return;
          }
          if (!(await saveDirtyLocalFiles([entry]))) {
            return;
          }

          await uploadWithConflictHandling(service, mergeHandler, entry, log);
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Upload ${selections.length} local files to the IBM i? This will overwrite the remote members.`,
          { modal: true, detail: sourceDatesDetail() },
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
            let withProblems = 0;
            let references = 0;
            let missing = 0;
            let errors = 0;
            let cancelled = false;
            const uploaded: string[] = [];
            const uploadedEntries: CheckedOutMember[] = [];

            await service.runBatch(async () => {
              for (let i = 0; i < selections.length; i++) {
                if (token.isCancellationRequested) {
                  cancelled = true;
                  break;
                }
                const entry = selections[i].entry;
                progress.report({ message: `${entry.memberName} (${i + 1}/${selections.length})` });
                if (isReferenceCopy(entry)) {
                  references++;
                  log.appendLine(`[upload] Skipped ${formatMemberPath(entry)}: read-only reference copy`);
                  continue;
                }
                try {
                  const result = await service.uploadToRemote(entry, { deferCheckpointTo: uploaded });
                  if (result === "uploaded") {
                    succeeded++;
                    uploadedEntries.push(entry);
                  } else if (result === "uploaded-altered") {
                    succeeded++;
                    altered++;
                  } else if (result === "remote-changed") {
                    skipped++;
                    log.appendLine(
                      `[upload] Skipped ${formatMemberPath(entry)}: changed on the IBM i since checkout — review it with Merge Back`
                    );
                  } else if (result === "source-problems") {
                    // CheckoutService logged which lines.
                    withProblems++;
                  } else {
                    errors++;
                    log.appendLine(`[upload] Failed for ${formatMemberPath(entry)}`);
                  }
                } catch (err) {
                  if (err instanceof RemoteMemberMissingError) {
                    // The service marked it; the local copy is kept.
                    missing++;
                  } else {
                    errors++;
                  }
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
            } else if (errors > 0 || skipped > 0 || withProblems > 0 || altered > 0 || references > 0 || missing > 0) {
              const alteredText = altered > 0
                ? ` ${altered} differ on the IBM i from the local copy (e.g. truncated lines).`
                : "";
              const skippedText = skipped > 0
                ? ` ${skipped} skipped because they changed on the IBM i since checkout.`
                : "";
              const problemText = withProblems > 0
                ? ` ${withProblems} skipped because they have lines too long for their source file or characters the IBM i can't store; upload them one at a time to see why.`
                : "";
              const referenceText = references > 0
                ? ` ${references} skipped because they are read-only reference copies.`
                : "";
              const missingText = missing > 0
                ? ` ${missing} no longer exist on the IBM i; their local copies are kept.`
                : "";
              const errorText = errors > 0 ? ` ${errors} error(s).` : "";
              vscode.window.showWarningMessage(
                `Uploaded ${succeeded}/${selections.length} member(s) to IBM i.${alteredText}${skippedText}${problemText}${referenceText}${missingText}${errorText} See IBM i Member Workspace output panel.`
              );
              log.show();
            } else {
              offerCheckin(`Successfully uploaded ${succeeded} member(s) to IBM i.`, uploadedEntries, log);
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
        const selections = resolveMemberSelections(service, item, allSelections);
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

            if (result === "remote-missing") {
              await reportRemoteMissing(service, [entry]);
            } else if (isReferenceCopy(entry) && result !== "in-sync") {
              const choice = await vscode.window.showInformationMessage(
                `The reference copy of ${memberPath} differs from the IBM i.`,
                "Update Reference Copy"
              );
              if (choice === "Update Reference Copy") {
                await service.recheckout(entry);
                vscode.window.showInformationMessage(`Updated the reference copy of ${memberPath}.`);
              }
            } else if (result === "in-sync") {
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
                "Compare with IBM i"
              );
              if (choice === "Re-checkout") {
                if (await confirmRecheckout(service, entry)) {
                  await service.recheckout(entry);
                  vscode.window.showInformationMessage(
                    `Re-checked out ${memberPath} from IBM i.`
                  );
                }
              } else if (choice === "Compare with IBM i") {
                await mergeHandler.compareWithRemote(entry);
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
                await mergeHandler.openMergeEditor(entry);
              }
            }
          } catch (err) {
            if (err instanceof LocalFileMissingError) {
              await handleMissingLocalFile(service, entry);
            } else if (err instanceof RemoteMemberMissingError) {
              await reportRemoteMissing(service, [entry]);
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
        const selections = resolveMemberSelections(service, item, allSelections);
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

/**
 * Which of a multi-selection to merge: members changed on the IBM i are preselected; reference
 * copies and members deleted on the IBM i can't be merged and are left out.
 */
async function pickMembersToMerge(entries: CheckedOutMember[]): Promise<CheckedOutMember[]> {
  const candidates = selectMergeCandidates(entries);
  const skipped = candidates.filter((candidate) => candidate.skip);
  const items = candidates
    .filter((candidate) => !candidate.skip)
    .map((candidate) => ({
      label: formatMemberPath(candidate.entry),
      description: candidate.entry.status,
      picked: candidate.picked,
      entry: candidate.entry,
    }));
  if (items.length === 0) {
    vscode.window.showWarningMessage(
      "None of the selected members can be merged: reference copies are read-only, and a member deleted on the IBM i has nothing to merge with."
    );
    return [];
  }
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Merge Back",
    placeHolder: skipped.length > 0
      ? `Members to merge (${skipped.length} left out: reference copies or deleted on the IBM i)`
      : "Members to merge; each opens in its own merge editor",
  });
  return chosen?.map((item) => item.entry) ?? [];
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
      if (await confirmRecheckout(service, entry)) {
        await service.recheckout(entry);
        vscode.window.showInformationMessage(`Re-checked out ${memberPath} from IBM i.`);
      }
    } else if (choice === "Remove from Checkouts") {
      await service.forgetEntries([entry]);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`${choice} failed: ${errorMessage(err)}`);
  }
}

/**
 * Whether a re-checkout offered by a notification may go ahead. The notification can stay open
 * while the local copy is edited (or restored), so changes made since the check are never
 * overwritten without asking.
 */
async function confirmRecheckout(service: CheckoutService, entry: CheckedOutMember): Promise<boolean> {
  if (!(await service.hasLocalChanges(entry))) {
    return true;
  }
  const discard = "Re-checkout (discard local changes)";
  const choice = await vscode.window.showWarningMessage(
    `${formatMemberPath(entry)} has local changes that are not on the IBM i.`,
    {
      modal: true,
      detail: "Re-checkout will discard them. Use Merge Back to review and combine the differences instead.",
    },
    discard
  );
  return choice === discard;
}

function showRefreshSummary(
  tally: RefreshTally,
  scope: string | undefined,
  cancelled: boolean
): void {
  const prefix = scope ? `${scope}: ` : "";
  const { inSync, modified, remoteChanged, conflict, remoteMissing, errors } = tally;
  const counts = [
    inSync > 0 && `${inSync} in sync`,
    modified > 0 && `${modified} with local changes`,
    remoteChanged > 0 && `${remoteChanged} changed on the IBM i`,
    conflict > 0 && `${conflict} in conflict`,
    remoteMissing > 0 && `${remoteMissing} deleted on the IBM i`,
    errors > 0 && `${errors} error(s)`,
  ]
    .filter(Boolean)
    .join(", ");

  if (cancelled) {
    vscode.window.showInformationMessage(
      `${prefix}Refresh cancelled${counts ? ` — ${counts}` : ""}.`
    );
  } else if (errors > 0 || conflict > 0 || remoteMissing > 0) {
    const hints = [
      errors > 0 && " See IBM i Member Workspace output panel.",
      conflict > 0 && " Review conflicts with Merge Back.",
      remoteMissing > 0 && " Members deleted on the IBM i keep their local copies; Refresh one to remove it from checkouts.",
    ].filter(Boolean).join("");
    vscode.window.showWarningMessage(`${prefix}Refresh complete: ${counts}.${hints}`);
  } else if (modified > 0 || remoteChanged > 0) {
    vscode.window.showInformationMessage(`${prefix}Refresh complete: ${counts}.`);
  } else {
    vscode.window.showInformationMessage(
      `${prefix}All ${inSync} member(s) are in sync with the remote.`
    );
  }
}

function sourceDatesDetail(): string {
  return sourceDatesEnabled()
    ? "Source dates are kept for unchanged lines; changed lines are dated today."
    : "Source dates will not be preserved: every line's date is reset to 0. " +
      "Turn on \"Enable source dates\" in Code for IBM i's connection settings (Source Code) to keep them.";
}
