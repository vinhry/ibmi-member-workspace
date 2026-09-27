import * as vscode from "vscode";
import { resolveMember } from "../prompts";
import { TreeItemType, buildLocalFileName } from "../types";
import { CommandContext } from "./context";

export function registerCompareCommands(ctx: CommandContext): void {
  const { context, service, treeProvider } = ctx;

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
      "ibmi-member-workspace.selectForCompare",
      async (item: TreeItemType) => {
        const entry = resolveMember(service, item);
        if (!entry) {
          return;
        }
        selectedForCompareId = entry.id;
        await vscode.commands.executeCommand("setContext", "ibmi-member-workspace:hasCompareSelection", true);
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(
          `Selected for compare: ${buildLocalFileName(entry)}`,
          3000
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithActive",
      async (item: TreeItemType) => {
        const entry = resolveMember(service, item);
        if (!entry) {
          return;
        }
        const rightUri = vscode.window.activeTextEditor?.document.uri;
        if (!rightUri) {
          vscode.window.showErrorMessage("No active editor to compare with.");
          return;
        }
        const localUri = vscode.Uri.file(entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          rightUri,
          `${buildLocalFileName(entry)} ↔ Active File`
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
        const entry = resolveMember(service, item);
        if (!entry || !selectedForCompare) {
          return;
        }
        const leftUri = vscode.Uri.file(selectedForCompare.localPath);
        const rightUri = vscode.Uri.file(entry.localPath);
        const leftLabel = buildLocalFileName(selectedForCompare);
        const rightLabel = buildLocalFileName(entry);
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
        const entry = resolveMember(service, item);
        if (!entry) {
          return;
        }
        const picks = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Compare",
        });
        if (!picks?.length) {
          return;
        }
        const localUri = vscode.Uri.file(entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          picks[0],
          `${buildLocalFileName(entry)} ↔ Local File`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithIfsFile",
      async (item: TreeItemType) => {
        const entry = resolveMember(service, item);
        if (!entry) {
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
        const localUri = vscode.Uri.file(entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          ifsUri,
          `${buildLocalFileName(entry)} ↔ IFS`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.compareWithMember",
      async (item: TreeItemType) => {
        const entry = resolveMember(service, item);
        if (!entry) {
          return;
        }
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
}
