import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { ensureCheckoutFolder } from "../checkoutFolder";
import { getSystemName, listSourceFileMembers } from "../codeForIBMi";
import { CheckoutCancelledError, errorMessage } from "../errors";
import {
  BrowserNode,
  MemberInfo,
  SourceFileInfo,
  UriParts,
  extractMemberInfo,
  extractSourceFileInfo,
} from "../memberInfo";
import { countLocalChanges, saveDirtyLocalFiles } from "../prompts";
import { CheckedOutMember } from "../types";
import { CommandContext } from "./context";
import { suggestDependencies } from "./dependencies";
import { ensureWorkItemForCheckout } from "./git";

export function registerCheckoutCommands(ctx: CommandContext): void {
  const { context, service, log } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkoutMember",
      async (node: BrowserNode, allSelections?: BrowserNode[]) => {
        if (!(await ensureCheckoutFolder(ctx))) {
          return;
        }

        const selections = allSelections && allSelections.length > 1 ? allSelections : [node];
        const isBatch = selections.length > 1;

        if (!isBatch) {
          // Single item — existing behaviour
          try {
            const memberInfo = memberInfoOf(node);
            if (!memberInfo) {
              log.appendLine(
                `[checkout] ERROR: Could not extract member info — raw node keys: ${node ? Object.keys(node).join(", ") : "null/undefined"}`
              );
              log.show();
              vscode.window.showErrorMessage(
                "Could not determine member details from selection. Check 'IBM i Member Workspace' output panel for details."
              );
              return;
            }
            const system = getSystemName();
            if (system && !(await ensureWorkItemForCheckout(ctx, system))) {
              return;
            }
            const entry = await service.checkoutMember(
              memberInfo.library,
              memberInfo.sourceFile,
              memberInfo.memberName,
              memberInfo.extension
            );
            void suggestDependencies(ctx, entry);
          } catch (err) {
            if (!(err instanceof CheckoutCancelledError)) {
              log.appendLine(`Checkout error: ${errorMessage(err)}`);
              log.appendLine((err instanceof Error && err.stack) || "");
              log.show();
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
        if (!(await ensureWorkItemForCheckout(ctx, system))) {
          return;
        }

        await checkoutMembersBatch(service, system, memberInfoList, log);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.checkoutAllMembers",
      async (node: BrowserNode) => {
        if (!(await ensureCheckoutFolder(ctx))) {
          return;
        }

        const sourceFileInfo = sourceFileInfoOf(node);
        if (!sourceFileInfo) {
          log.appendLine(
            `[checkout] ERROR: Could not extract source file info — raw node keys: ${node ? Object.keys(node).join(", ") : "null/undefined"}`
          );
          log.show();
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
          log.appendLine(`[checkout] Could not list members: ${errorMessage(err)}`);
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
        if (!(await ensureWorkItemForCheckout(ctx, system))) {
          return;
        }

        const memberInfoList = members.map((m) => ({
          library: sourceFileInfo.library,
          sourceFile: sourceFileInfo.sourceFile,
          memberName: m.name,
          extension: (m.extension || "mbr").toLowerCase(),
        }));

        await checkoutMembersBatch(service, system, memberInfoList, log);
      }
    )
  );
}

/**
 * Checks out several members with one progress notification and one checkpoint. With
 * `reference`, they become read-only reference copies: existing reference copies are refreshed
 * without asking, and members already checked out for change are left alone.
 */
export async function checkoutMembersBatch(
  service: CheckoutService,
  system: string,
  memberInfoList: MemberInfo[],
  log: vscode.OutputChannel,
  { reference = false }: { reference?: boolean } = {}
): Promise<void> {
  const alreadyCheckedOut = memberInfoList.filter(
    (m) => service.findEntry(system, m.library, m.sourceFile, m.memberName)
  );

  let redownloadBehavior: "skip" | "force" = "force";
  // A reference copy has nothing worth keeping locally.
  let discardLocalChanges = reference;
  if (alreadyCheckedOut.length > 0 && !reference) {
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
      const withLocalChanges = await countLocalChanges(service, existingEntries, log);
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
    {
      location: vscode.ProgressLocation.Notification,
      title: reference ? "Bringing reference copies..." : "Checking out members...",
      cancellable: true,
    },
    async (progress, token) => {
      let succeeded = 0;
      let errors = 0;
      let cancelled = false;
      const downloaded: string[] = [];

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
              { redownloadBehavior, suppressAutoOpen: true, discardLocalChanges, deferCheckpointTo: downloaded, reference }
            );
            succeeded++;
          } catch (err) {
            if (!(err instanceof CheckoutCancelledError)) {
              errors++;
              log.appendLine(`[checkout] Error for ${m.memberName}: ${errorMessage(err)}`);
            }
          }
        }
        // One checkpoint for the whole batch, including members downloaded before a cancel.
        await service.saveBatchCheckpoint(
          system,
          downloaded,
          `${reference ? "reference" : "checkout"}: ${describeBatch(memberInfoList, downloaded.length)} from ${system}`
        );
      });

      const done = reference ? "Brought" : "Checked out";
      const noun = (count: number) => reference ? `reference cop${count === 1 ? "y" : "ies"}` : "member(s)";
      if (cancelled) {
        vscode.window.showInformationMessage(
          `${reference ? "Reference copies" : "Checkout"} cancelled. ${succeeded}/${memberInfoList.length} ${noun(memberInfoList.length)} ${done.toLowerCase()} from ${system} before cancelling.`
        );
      } else if (errors > 0) {
        vscode.window.showWarningMessage(
          `${done} ${succeeded}/${memberInfoList.length} ${noun(memberInfoList.length)} from ${system}. ${errors} error(s) — see IBM i Member Workspace output panel.`
        );
        log.show();
      } else {
        vscode.window.showInformationMessage(
          `${done} ${succeeded} ${noun(succeeded)} from ${system}.`
        );
      }
    }
  );
}

/** "LIB/SRC(MEMBER)", "3 members of LIB/SRC", or "3 members" for a checkpoint message. */
function describeBatch(members: MemberInfo[], count: number): string {
  if (count === 1 && members.length === 1) {
    const [m] = members;
    return `${m.library.toUpperCase()}/${m.sourceFile.toUpperCase()}(${m.memberName.toUpperCase()})`;
  }
  const sourceFiles = new Set(members.map((m) => `${m.library}/${m.sourceFile}`.toUpperCase()));
  const noun = `${count} member${count === 1 ? "" : "s"}`;
  return sourceFiles.size === 1 ? `${noun} of ${[...sourceFiles][0]}` : noun;
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
