import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { CommandContext } from "./commands/context";
import { errorMessage } from "./errors";
import { describeTrackedGroup } from "./types";

const checkoutFolderContext = "ibmi-member-workspace:checkoutFolderConfigured";

export function registerCheckoutFolderCommands(ctx: CommandContext): void {
  ctx.context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.configureCheckoutFolder",
      async () => {
        await configureCheckoutFolder(ctx);
      }
    )
  );
}

function hasOpenWorkspace(context: vscode.ExtensionContext): boolean {
  return Boolean(context.storageUri && vscode.workspace.workspaceFolders?.length);
}

export async function updateCheckoutFolderContext(service: CheckoutService): Promise<void> {
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

export async function configureCheckoutFolder(ctx: CommandContext): Promise<boolean> {
  const { context, service } = ctx;
  if (!hasOpenWorkspace(context)) {
    await promptToOpenWorkspace(true);
    return false;
  }

  const currentRoot = service.getCheckoutRoot();
  const tracked = currentRoot ? service.trackedGroups() : [];
  if (tracked.length > 0) {
    // They may be in work items or on systems the view doesn't show, so say where they are.
    const total = tracked.reduce((sum, group) => sum + group.count, 0);
    const changed = await service.countLocalChangesEverywhere();
    const stop = "Stop Tracking and Change Folder";
    const choice = await vscode.window.showWarningMessage(
      `${total} member${total === 1 ? " is" : "s are"} still tracked in the checkout folder ${currentRoot!.fsPath}: ` +
      `${tracked.map(describeTrackedGroup).join(", ")}.`,
      {
        modal: true,
        detail: (changed > 0
          ? `${changed} of them ${changed === 1 ? "has" : "have"} changes that weren't sent to the IBM i. `
          : "") +
          "Stop tracking them to choose another folder: their files stay in the current folder, and Local Change " +
          "History keeps its checkpoints, but they're no longer listed, refreshed or uploaded. To keep them, switch " +
          "to their work item or system and merge or discard them first.",
      },
      stop
    );
    if (choice !== stop) {
      return false;
    }
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

  if (currentRoot && selected.fsPath === currentRoot.fsPath) {
    // The same folder: its checkouts stay tracked.
    return true;
  }

  try {
    await service.setCheckoutRoot(selected);
    if (tracked.length > 0) {
      await service.forgetAllEntries();
      ctx.log.appendLine(`[setup] Stopped tracking ${tracked.map(describeTrackedGroup).join(", ")} to change the checkout folder`);
    }
    ctx.fileWatcher.setRoot(selected);
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

export async function ensureCheckoutFolder(ctx: CommandContext): Promise<boolean> {
  const { context, service } = ctx;
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
    return configureCheckoutFolder(ctx);
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

export async function offerCheckoutFolderSetup(ctx: CommandContext): Promise<void> {
  if (ctx.service.getCheckoutRoot()) {
    return;
  }

  if (!hasOpenWorkspace(ctx.context)) {
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
    await configureCheckoutFolder(ctx);
  }
}
