import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { errorMessage } from "../errors";
import { MergeHandler } from "../mergeHandler";
import { CheckedOutMember, formatMemberPath } from "../types";
import { UploadFlowOutcome, runUploadFlow } from "../uploadFlow";

/**
 * Uploads one checkout with the same prompts for the Upload command and upload
 * on save: changes made on the IBM i are never overwritten without asking.
 * `quiet` reports success in the status bar instead of a notification.
 */
export function uploadWithConflictHandling(
  service: CheckoutService,
  mergeHandler: MergeHandler,
  entry: CheckedOutMember,
  log: vscode.OutputChannel,
  { quiet = false }: { quiet?: boolean } = {}
): Promise<UploadFlowOutcome> {
  const memberPath = formatMemberPath(entry);
  return runUploadFlow(entry, {
    upload: (member, options) => service.uploadToRemote(member, options),

    resolveRemoteChange: async () => {
      const choice = await vscode.window.showWarningMessage(
        `${memberPath} has changed on the IBM i since it was checked out. Uploading will overwrite those remote changes.`,
        {
          modal: true,
          detail: "Use Show Diff to review and combine the remote changes instead.",
        },
        "Overwrite Anyway",
        "Show Diff"
      );
      return choice === "Overwrite Anyway" ? "overwrite" : choice === "Show Diff" ? "diff" : undefined;
    },

    openMerge: (member) => mergeHandler.openMergeDiff(member),

    notifyUploaded: (_member, isQuiet) => {
      log.appendLine(`[upload] Uploaded ${memberPath}`);
      if (isQuiet) {
        vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${memberPath} to IBM i`, 4000);
      } else {
        vscode.window.showInformationMessage(`Successfully uploaded ${memberPath} to IBM i.`);
      }
    },

    notifyAltered: async () =>
      (await vscode.window.showWarningMessage(
        `Uploaded ${memberPath}, but the IBM i copy differs from your local file (for example, lines longer than the record length were truncated).`,
        "Merge Back"
      )) === "Merge Back",

    notifyFailed: (_member, error) => {
      if (error === undefined) {
        vscode.window.showErrorMessage(`Failed to upload ${memberPath} to IBM i.`);
      } else {
        log.appendLine(`[upload] Error for ${memberPath}: ${errorMessage(error)}`);
        vscode.window.showErrorMessage(`Upload failed: ${errorMessage(error)}`);
      }
    },
  }, { quiet });
}
