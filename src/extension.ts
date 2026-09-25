import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { CheckoutTreeProvider } from "./checkoutTreeProvider";
import { MergeHandler, mergeDocumentKey } from "./mergeHandler";
import { GitService } from "./gitService";
import { getSystemName, onConnectionChange } from "./codeForIBMi";
import { errorMessage } from "./errors";
import { ProviderAvailabilityCache } from "./dependencySources";
import { LocalFileWatcher } from "./localFileWatcher";
import { extractMemberInfo } from "./memberInfo";
import { CheckedOutMember, formatMemberPath, isDefaultWorkItem } from "./types";
import {
  offerCheckoutFolderSetup,
  registerCheckoutFolderCommands,
  updateCheckoutFolderContext,
} from "./checkoutFolder";
import { CommandContext } from "./commands/context";
import { registerCheckoutCommands } from "./commands/checkout";
import { registerCompareCommands } from "./commands/compare";
import { registerDependencyCommands } from "./commands/dependencies";
import { offerLegacyRepositoryRepair, registerGitCommands } from "./commands/git";
import { registerAutoUpload } from "./commands/autoUpload";
import { registerSyncCommands } from "./commands/sync";
import { registerViewCommands } from "./commands/view";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const log = vscode.window.createOutputChannel("IBM i Member Workspace");
  context.subscriptions.push(log);

  const gitService = new GitService(log);
  const service = new CheckoutService(context, log, gitService);
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
    // Until the system directory is its own repository, Git would report an enclosing repository's branch.
    if (
      !system ||
      !root ||
      !(await service.isGitEnabled()) ||
      !(await gitService.isExactRepository(root.fsPath))
    ) {
      gitBranchStatusBar.hide();
      treeView.description = undefined;
      return;
    }
    const branch = await gitService.currentBranch(root.fsPath);
    const repository = `Local Change History for ${system}\nRepository: ${root.fsPath}`;
    if (branch && !isDefaultWorkItem(branch)) {
      gitBranchStatusBar.text = `$(git-branch) Work Item: ${branch}`;
      gitBranchStatusBar.tooltip = repository;
      gitBranchStatusBar.backgroundColor = undefined;
      treeView.description = branch;
    } else {
      gitBranchStatusBar.text = "$(warning) No Work Item";
      gitBranchStatusBar.tooltip = `${branch ? "No work item is selected" : "The repository is on a detached commit"}. The next checkout asks which work item it belongs to.\n${repository}`;
      gitBranchStatusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      treeView.description = "no work item";
    }
    gitBranchStatusBar.show();
  };

  const dependencyAvailability = new ProviderAvailabilityCache();
  onConnectionChange(context, () => {
    // A reconnect may reach a different system, or one whose tools changed.
    dependencyAvailability.reset();
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

  const fileWatcher = new LocalFileWatcher(service, log);
  context.subscriptions.push(fileWatcher);
  fileWatcher.setRoot(service.getCheckoutRoot());

  // Only documents opened by the explicit Merge Back command are tracked here.
  const pendingMergeBacks = new Map<string, CheckedOutMember>();
  // Only editor saves upload; files written by other tools (see LocalFileWatcher) never do.
  const autoUpload = registerAutoUpload({ context, service, mergeHandler, pendingMergeBacks, log });
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme === "file") {
        const entry = service.findEntryByLocalPath(doc.uri.fsPath);
        if (!entry) {
          return;
        }
        try {
          await service.updateStatusFromLocalFile(entry);
        } catch (err) {
          log.appendLine(`[status] Could not update ${formatMemberPath(entry)}: ${errorMessage(err)}`);
        }
        autoUpload.schedule(doc.uri.fsPath);
        return;
      }
      if (doc.uri.scheme !== "member") {
        return;
      }
      const entry = pendingMergeBacks.get(mergeDocumentKey(doc.uri));
      if (!entry) {
        // The remote member was saved some other way, e.g. from Show Diff.
        await refreshAfterRemoteSave(service, doc.uri, log);
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

  const ctx: CommandContext = {
    context,
    service,
    treeProvider,
    mergeHandler,
    treeView,
    fileWatcher,
    gitService,
    refreshGitStatusBar,
    pendingMergeBacks,
    log,
    dependencyAvailability,
  };
  registerCheckoutFolderCommands(ctx);
  registerCheckoutCommands(ctx);
  registerSyncCommands(ctx);
  registerCompareCommands(ctx);
  registerDependencyCommands(ctx);
  registerViewCommands(ctx);
  registerGitCommands(ctx);

  void offerCheckoutFolderSetup(ctx).catch((err) => {
    log.appendLine(`[setup] Could not show checkout folder setup: ${errorMessage(err)}`);
  });
  void offerLegacyRepositoryRepair(service, gitService).catch((err) => {
    log.appendLine(`[git] Could not inspect legacy repository layout: ${errorMessage(err)}`);
  });
}

/** Re-checks a checkout's status when its remote member is saved from VS Code. */
async function refreshAfterRemoteSave(
  service: CheckoutService,
  uri: vscode.Uri,
  log: vscode.OutputChannel
): Promise<void> {
  const system = getSystemName();
  const info = extractMemberInfo({}, uri);
  if (!system || !info) {
    return;
  }
  const entry = service.findEntry(system, info.library, info.sourceFile, info.memberName);
  if (!entry) {
    return;
  }
  try {
    await service.refreshRemoteStatus(entry);
  } catch (err) {
    log.appendLine(`[status] Could not refresh ${formatMemberPath(entry)} after remote save: ${errorMessage(err)}`);
  }
}

export function deactivate(): void {
  // cleanup handled by disposables
}
