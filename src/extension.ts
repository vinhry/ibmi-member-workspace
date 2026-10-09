import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { CheckoutTreeProvider } from "./checkoutTreeProvider";
import { MergeHandler } from "./mergeHandler";
import { GitService } from "./gitService";
import { isBobProduct } from "./bobIde";
import { getSystemName, onConnectionChange, resetWhereUsedSnapshots } from "./codeForIBMi";
import { errorMessage } from "./errors";
import { ProviderAvailabilityCache } from "./dependencySources";
import { LocalFileWatcher } from "./localFileWatcher";
import { registerSourceDiagnostics } from "./sourceDiagnostics";
import { CheckoutDecorations } from "./checkoutDecorations";
import { extractMemberInfo } from "./memberInfo";
import { formatMemberPath, isDefaultWorkItem } from "./types";
import {
  offerCheckoutFolderSetup,
  registerCheckoutFolderCommands,
  updateCheckoutFolderContext,
} from "./checkoutFolder";
import { CommandContext } from "./commands/context";
import { registerCheckoutCommands } from "./commands/checkout";
import { registerCompareCommands } from "./commands/compare";
import { registerDependencyCommands } from "./commands/dependencies";
import { registerChangeManagementCommands } from "./commands/changeManagement";
import { registerFindMemberCommands } from "./commands/findMember";
import { offerLegacyRepositoryRepair, registerGitCommands } from "./commands/git";
import { registerAutoUpload } from "./commands/autoUpload";
import { registerBackgroundRefresh } from "./commands/backgroundRefresh";
import { registerAgentCommands } from "./commands/agents";
import { registerBobCommands } from "./commands/bob";
import { registerSyncCommands } from "./commands/sync";
import { registerViewCommands } from "./commands/view";
import { registerResearchCommands } from "./commands/research";

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
    service.gitIntegrationOn() &&
    await gitService.isExactRepository(initialRoot.fsPath)
  ) {
    await service.synchronizeWorkItem(initialSystem);
  }
  await updateCheckoutFolderContext(service);

  const treeProvider = new CheckoutTreeProvider(service);
  context.subscriptions.push(treeProvider);
  const decorations = new CheckoutDecorations(service);
  context.subscriptions.push(decorations, vscode.window.registerFileDecorationProvider(decorations));
  const mergeHandler = new MergeHandler(service, context.storageUri, log);
  context.subscriptions.push(mergeHandler);
  await mergeHandler.initialize();

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

  // One refresh at a time: each asks Git twice, and overlapping ones could finish out of order.
  // A request made while one runs is folded into a single rerun after it.
  let statusBarRefresh: Promise<void> | undefined;
  let statusBarRerun = false;
  const refreshGitStatusBar = (): Promise<void> => {
    if (statusBarRefresh) {
      statusBarRerun = true;
      return statusBarRefresh;
    }
    statusBarRefresh = (async () => {
      try {
        do {
          statusBarRerun = false;
          await updateGitStatusBar();
        } while (statusBarRerun);
      } finally {
        statusBarRefresh = undefined;
      }
    })();
    return statusBarRefresh;
  };

  const updateGitStatusBar = async () => {
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
    // A reconnect may reach a different system, or one whose tools changed; QTEMP starts empty.
    dependencyAvailability.reset();
    resetWhereUsedSnapshots();
    service.clearSourceLayouts();
    treeProvider.refresh();
    const system = getSystemName();
    if (system && service.gitIntegrationOn()) {
      void service.ensureGitReady(system);
    }
    void refreshGitStatusBar();
  });
  service.onDidChange(() => void refreshGitStatusBar());
  void refreshGitStatusBar();

  // A workspace's settings turn Local Change History on only after the user agrees, once per workspace.
  let gitIntegrationOffered = false;
  const confirmWorkspaceGitIntegration = async () => {
    if (gitIntegrationOffered || service.gitIntegrationState() !== "needsConfirmation") {
      return;
    }
    gitIntegrationOffered = true;
    const choice = await vscode.window.showInformationMessage(
      "This workspace's settings turn on Local Change History, which runs Git to keep checkpoints of your checkouts in the checkout folder. Turn it on for this workspace?",
      "Turn On",
      "Not Now"
    );
    if (choice !== "Turn On") {
      return;
    }
    await service.confirmGitIntegration();
    service.resetGitSetupState();
    const result = await service.ensureGitReady();
    if (result.status !== "success" && result.message) {
      vscode.window.showWarningMessage(result.message);
    }
    await refreshGitStatusBar();
  };
  void confirmWorkspaceGitIntegration();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("ibmi-member-workspace.gitIntegration")) {
        return;
      }
      service.resetGitSetupState();
      if (service.gitIntegrationOn()) {
        const result = await service.ensureGitReady();
        if (result.status !== "success" && result.message) {
          vscode.window.showWarningMessage(result.message);
        }
      } else {
        void confirmWorkspaceGitIntegration();
      }
      await refreshGitStatusBar();
    })
  );

  const fileWatcher = new LocalFileWatcher(service, log);
  context.subscriptions.push(fileWatcher);
  fileWatcher.setRoot(service.getCheckoutRoot());

  // Only editor saves upload; files written by other tools (see LocalFileWatcher) never do.
  const autoUpload = registerAutoUpload({ context, service, mergeHandler, log });
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
        // The first save of a Merge Back's result adopts the IBM i's text as the baseline, before
        // upload on save sends the result.
        await mergeHandler.onDidSaveLocal(entry, doc.getText());
        autoUpload.schedule(doc.uri.fsPath);
        return;
      }
      if (doc.uri.scheme === "member") {
        // The member was saved from Open Remote File (or Code for IBM i's own editor).
        await refreshAfterRemoteSave(service, doc.uri, log);
      }
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
    log,
    dependencyAvailability,
  };
  registerCheckoutFolderCommands(ctx);
  registerCheckoutCommands(ctx);
  registerSyncCommands(ctx);
  registerCompareCommands(ctx);
  registerDependencyCommands(ctx);
  registerChangeManagementCommands(ctx);
  registerFindMemberCommands(ctx);
  registerViewCommands(ctx);
  registerResearchCommands(ctx);
  registerGitCommands(ctx);
  registerSourceDiagnostics(context, service);
  registerBackgroundRefresh(ctx);

  // In IBM Bob, Bob's agent uses the research tools, and so can Claude Code and Codex; in VS Code,
  // Claude Code, Codex and GitHub Copilot can.
  const inBob = isBobProduct(vscode.env.appName, vscode.env.uriScheme);
  void vscode.commands.executeCommand("setContext", "ibmi-member-workspace:isBobIde", inBob);
  if (inBob) {
    log.appendLine(`[bob] Running in ${vscode.env.appName}`);
    registerBobCommands(ctx);
  }
  registerAgentCommands(ctx, { inBob });

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
