import * as vscode from "vscode";
import * as path from "node:path";
import { CheckoutService } from "../checkoutService";
import { configureCheckoutFolder } from "../checkoutFolder";
import { getSystemName } from "../codeForIBMi";
import { errorMessage } from "../errors";
import { GitService } from "../gitService";
import { CheckedOutMember, TreeItemType, formatMemberPath } from "../types";
import { CommandContext } from "./context";

export function registerGitCommands(ctx: CommandContext): void {
  const { context, service, treeProvider, gitService, refreshGitStatusBar, pendingMergeBacks } = ctx;

  // ── Local Change History: setup ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.setupGitIntegration",
      async () => {
        if (!service.getCheckoutRoot()) {
          const configured = await configureCheckoutFolder(ctx);
          if (!configured) {
            return;
          }
        }
        await vscode.workspace
          .getConfiguration("ibmi-member-workspace")
          .update("gitIntegration", true, vscode.ConfigurationTarget.Workspace);
        service.resetGitSetupState();
        const result = await service.ensureGitReady();
        if (result.status === "success") {
          vscode.window.showInformationMessage(
            "Local Change History is ready. Checkpoints stay on this computer until you choose to share them."
          );
        } else if (result.message) {
          vscode.window.showWarningMessage(result.message);
        }
        await refreshGitStatusBar();
      }
    )
  );

  // ── Local Change History: work items ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.selectGitBranch",
      async () => {
        const system = getSystemName();
        const root = system ? service.getGitRoot(system) : undefined;
        if (!system || !root) {
          vscode.window.showWarningMessage(
            "Connect to an IBM i system and choose a checkout folder before managing work items."
          );
          return;
        }

        const ready = await service.ensureGitReady(system);
        if (ready.status !== "success") {
          const choice = await vscode.window.showInformationMessage(
            ready.message ?? "Set up Local Change History before managing work items.",
            "Set Up"
          );
          if (choice === "Set Up") {
            await vscode.commands.executeCommand("ibmi-member-workspace.setupGitIntegration");
          }
          return;
        }

        const [branches, currentBranch] = await Promise.all([
          gitService.listBranches(root.fsPath),
          gitService.currentBranch(root.fsPath),
        ]);

        const CREATE_ITEM = "$(add)  Start New Work Item\u2026";

        const items: vscode.QuickPickItem[] = [
          { label: CREATE_ITEM },
          ...branches.map((b) => ({
            label: b === currentBranch ? `$(check)  ${b}` : b,
            description: b === currentBranch ? "current" : undefined,
          })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
          title: "Local Change History — Switch Work Item",
          placeHolder: currentBranch ? `Current work item: ${currentBranch}` : "No work item yet",
        });

        if (!picked) {
          return;
        }

        if (picked.label === CREATE_ITEM) {
          const name = await vscode.window.showInputBox({
            title: "Start New Work Item",
            prompt: "Use a ticket or project name. Git stores this as a local branch.",
            placeHolder: "e.g. TICKET-123 or payroll-fix",
            validateInput: (v) => (v.trim() ? undefined : "Branch name cannot be empty"),
          });
          if (!name?.trim()) {
            return;
          }
          if (!(await prepareForWorkItemChange(
            root,
            system,
            service,
            gitService,
            currentBranch,
            pendingMergeBacks
          ))) {
            return;
          }
          const result = await gitService.createWorkItem(root.fsPath, name.trim());
          if (result.status === "success") {
            await service.activateWorkItem(system, name.trim(), true);
            vscode.window.showInformationMessage(
              `Started work item “${name.trim()}”.`
            );
          } else {
            vscode.window.showErrorMessage(result.message ?? `Could not start work item “${name.trim()}”.`);
          }
        } else {
          // Strip the $(check) prefix if it was the current branch label
          const rawName = picked.label.replace(/^\$\(check\)\s+/, "");
          if (rawName === currentBranch) {
            vscode.window.showInformationMessage(`Already using work item “${currentBranch}”.`);
          } else {
            if (!(await prepareForWorkItemChange(
              root,
              system,
              service,
              gitService,
              currentBranch,
              pendingMergeBacks
            ))) {
              return;
            }
            const result = await gitService.switchWorkItem(root.fsPath, rawName);
            if (result.status === "success") {
              await service.activateWorkItem(system, rawName, false);
              treeProvider.refresh();
              vscode.window.showInformationMessage(`Switched to work item “${rawName}”.`);
            } else {
              vscode.window.showErrorMessage(result.message ?? `Could not switch to work item “${rawName}”.`);
            }
          }
        }

        await refreshGitStatusBar();
      }
    )
  );

  // ── Local Change History: save checkpoint ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.commitNow",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }

        const entry = item.entry;
        const defaultMessage = `snapshot: ${formatMemberPath(entry)}`;

        const userMessage = await vscode.window.showInputBox({
          title: "Save Checkpoint",
          prompt: "Describe this local history point. This does not upload to IBM i.",
          placeHolder: defaultMessage,
        });

        if (userMessage === undefined) {
          // cancelled
          return;
        }

        const message = userMessage.trim() || defaultMessage;

        const result = await service.saveCheckpoint(entry.system, [entry.localPath], message);
        if (result.status === "success") {
          vscode.window.showInformationMessage(`Checkpoint saved for ${formatMemberPath(entry)}.`);
        } else if (result.status === "noChanges") {
          vscode.window.showInformationMessage("No changes since the last checkpoint.");
        } else {
          vscode.window.showErrorMessage(result.message ?? "Could not save the checkpoint.");
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-member-workspace.viewGitHistory", async () => {
      await vscode.commands.executeCommand("workbench.view.scm");
    })
  );
}

async function prepareForWorkItemChange(
  root: vscode.Uri,
  system: string,
  service: CheckoutService,
  gitService: GitService,
  currentWorkItem: string,
  pendingMergeBacks: Map<string, CheckedOutMember>
): Promise<boolean> {
  if (pendingMergeBacks.size > 0) {
    vscode.window.showWarningMessage(
      "Finish or close the open Merge Back comparison before switching work items."
    );
    return false;
  }
  const dirtyDocuments = vscode.workspace.textDocuments.filter(
    (document) =>
      document.isDirty &&
      document.uri.scheme === "file" &&
      pathIsInside(root.fsPath, document.uri.fsPath)
  );
  if (dirtyDocuments.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${dirtyDocuments.length} checkout file(s) have unsaved editor changes.`,
      { modal: true, detail: "Save them before switching work items so no edits are lost." },
      "Save All and Continue"
    );
    if (choice !== "Save All and Continue") {
      return false;
    }
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    if (dirtyDocuments.some((document) => document.isDirty)) {
      vscode.window.showWarningMessage(
        "Some checkout files could not be saved. Work item switching was cancelled."
      );
      return false;
    }
  }

  const state = await gitService.getWorkingTreeState(root.fsPath);
  if (state.status === "success") {
    return true;
  }
  if (state.status !== "dirtyWorktree") {
    vscode.window.showErrorMessage(state.message ?? "Could not inspect local changes.");
    return false;
  }
  const changedPaths = await gitService.changedPaths(root.fsPath);
  const managed = new Set(service.getManagedPaths(system).map((value) => path.resolve(value)));
  const managedChanges = changedPaths.filter((value) => managed.has(path.resolve(value)));
  if (managedChanges.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      "This work item has managed member changes that are not in a checkpoint.",
      {
        modal: true,
        detail: "Save a checkpoint before switching so the changes remain available in this work item.",
      },
      "Save Checkpoint and Switch"
    );
    if (choice !== "Save Checkpoint and Switch") {
      return false;
    }
    const checkpoint = await service.saveCheckpoint(
      system,
      managedChanges,
      `checkpoint: before leaving ${currentWorkItem || "work item"}`
    );
    if (checkpoint.status !== "success" && checkpoint.status !== "noChanges") {
      vscode.window.showErrorMessage(checkpoint.message ?? "Could not save a checkpoint before switching.");
      return false;
    }
  }
  const remaining = await gitService.changedPaths(root.fsPath);
  if (remaining.length > 0) {
    vscode.window.showWarningMessage(
      "Work item switching was cancelled because this system repository still has unrelated changes. Commit or stash them in Source Control, then try again."
    );
    return false;
  }
  return true;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export async function offerLegacyRepositoryRepair(
  service: CheckoutService,
  gitService: GitService
): Promise<void> {
  const inspection = await service.detectMisplacedParentRepository();
  if (!inspection) {
    return;
  }
  const systems = service.getKnownSystems();
  const directories = systems.map((state) => state.directory);
  if (!gitService.isSafeMisplacedRepository(inspection, directories)) {
    vscode.window.showWarningMessage(
      "The checkout container contains an older extension-created Git repository with unrelated files or history. It will not be used. Preserve it and recover any needed commits manually; each system directory is now its own repository."
    );
    return;
  }
  const repair = await vscode.window.showInformationMessage(
    "An older Local Change History repository was found at the checkout container. Repair work-item branches in the per-system repositories? The old repository will be preserved.",
    "Repair Now",
    "Keep for Now"
  );
  if (repair !== "Repair Now") {
    return;
  }
  const migrated = await service.migrateLegacyRepository();
  if (migrated.status !== "success") {
    vscode.window.showWarningMessage(
      `${migrated.message ?? "The legacy repository could not be repaired."} The parent repository was preserved for manual recovery.`
    );
    return;
  }
  const archive = await vscode.window.showInformationMessage(
    "Per-system Local Change History is ready. The misplaced parent repository is still preserved at the checkout container.",
    "Archive Misplaced Repository",
    "Keep for Now"
  );
  if (archive !== "Archive Misplaced Repository") {
    return;
  }
  try {
    const backups = await service.archiveMisplacedRepository();
    const paths = [backups.gitBackup, backups.gitignoreBackup].filter(Boolean).join(" and ");
    vscode.window.showInformationMessage(
      `Archived the misplaced repository to ${paths}. Restore it by renaming the backup path(s) to their original .git and .gitignore names.`
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `The misplaced repository was not archived: ${errorMessage(err)}`
    );
  }
}
