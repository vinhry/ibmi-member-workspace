import * as vscode from "vscode";
import { CheckedOutMember, formatMemberPath } from "./types";
import { assertEditable } from "./checkoutService";
import { memberUri } from "./codeForIBMi";

/** Identifies a member document regardless of query options such as `readonly=false`. */
export function mergeDocumentKey(uri: vscode.Uri): string {
  return uri.with({ query: "", fragment: "" }).toString();
}

export class MergeHandler {

  async openMergeDiff(entry: CheckedOutMember): Promise<void> {
    assertEditable(entry);
    const memberPath = formatMemberPath(entry);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Opening merge diff for ${memberPath}...`,
        cancellable: false,
      },
      async () => {
        const localUri = vscode.Uri.file(entry.localPath);

        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          memberUri(entry, { editable: true }),
          `${entry.memberName} — Local ↔ Remote`
        );
      }
    );
  }
}
