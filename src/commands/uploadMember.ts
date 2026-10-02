import * as vscode from "vscode";
import { CheckoutService } from "../checkoutService";
import { errorMessage } from "../errors";
import { MergeHandler } from "../mergeHandler";
import { summarizeProblems } from "../sourceCheck";
import { showSourceProblems } from "../sourceDiagnostics";
import { CheckedOutMember, formatMemberPath } from "../types";
import { UploadFlowOutcome, runUploadFlow } from "../uploadFlow";

/**
 * Uploads one checkout with the same prompts for the Upload command and upload
 * on save: changes made on the IBM i, and text the member can't hold, are never
 * uploaded without asking. `quiet` reports success in the status bar instead of
 * a notification, and doesn't wait for an answer about text the member can't hold.
 */
export function uploadWithConflictHandling(
  service: CheckoutService,
  mergeHandler: MergeHandler,
  entry: CheckedOutMember,
  log: vscode.OutputChannel,
  { quiet = false, ignoreSourceProblems = false }: { quiet?: boolean; ignoreSourceProblems?: boolean } = {}
): Promise<UploadFlowOutcome> {
  const memberPath = formatMemberPath(entry);
  return runUploadFlow(entry, {
    upload: (member, options) => service.uploadToRemote(member, options),

    resolveSourceProblems: async (member, isQuiet) => {
      const found = await service.sourceProblemsOf(member);
      const summary = found && found.problems.length > 0
        ? summarizeProblems(found.problems, found.layout)
        : "it has text the member can't hold";
      const detail = "On the IBM i, what doesn't fit on a line is cut off and those characters are replaced. " +
        "Show Problems marks them in the editor.";
      const showProblems = () => showSourceProblems(member, found?.problems[0]);
      if (isQuiet) {
        // An automatic upload doesn't wait: a notification left unanswered would hold up the next save's upload.
        void vscode.window.showWarningMessage(`Not uploaded ${memberPath}: ${summary}. ${detail}`, "Show Problems", "Upload Anyway")
          .then(async (choice) => {
            if (choice === "Show Problems") {
              await showProblems();
            } else if (choice === "Upload Anyway") {
              await uploadWithConflictHandling(service, mergeHandler, member, log, { ignoreSourceProblems: true });
            }
          })
          .then(undefined, (err) => log.appendLine(`[upload] ${memberPath}: ${errorMessage(err)}`));
        return undefined;
      }
      const choice = await vscode.window.showWarningMessage(
        `Upload ${memberPath}? ${summary}.`,
        { modal: true, detail },
        "Upload Anyway",
        "Show Problems"
      );
      if (choice === "Show Problems") {
        await showProblems();
      }
      return choice === "Upload Anyway" ? "upload" : undefined;
    },

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
  }, { quiet, ignoreSourceProblems });
}
