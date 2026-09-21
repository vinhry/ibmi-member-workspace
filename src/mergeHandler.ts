import * as vscode from "vscode";
import { CheckedOutMember, formatMemberPath } from "./types";
import { memberUri } from "./codeForIBMi";

export class MergeHandler {

  async openMergeDiff(entry: CheckedOutMember): Promise<void> {
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
