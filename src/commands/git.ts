import * as vscode from "vscode";
import * as path from "node:path";
import { CheckoutService } from "../checkoutService";
import { configureCheckoutFolder } from "../checkoutFolder";
import { getSystemName } from "../codeForIBMi";
import { errorMessage } from "../errors";
import { GitService } from "../gitService";
import { resolveMemberSelections, saveDirtyLocalFiles } from "../prompts";
import {
  TreeItemType,
  WorkItemCarry,
  formatMemberPath,
  isDefaultWorkItem,
  systemKey,
} from "../types";
import { CommandContext } from "./context";

const START_NEW_WORK_ITEM = "$(add)  Start New Work Item…";

interface WorkItemPick extends vscode.QuickPickItem {
  action: "create" | "switch" | "continue";
  name?: string;
}

export function registerGitCommands(ctx: CommandContext): void {
  const { context, service, gitService, refreshGitStatusBar } = ctx;

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

        if (!(await ensureReadyOrOfferSetup(service, system))) {
          return;
        }

        const [branches, currentBranch] = await Promise.all([
          gitService.listBranches(root.fsPath),
          gitService.currentBranch(root.fsPath),
        ]);

        const items: WorkItemPick[] = [
          { label: START_NEW_WORK_ITEM, action: "create" },
          ...branches.map((branch): WorkItemPick => ({
            label: branch === currentBranch ? `$(check)  ${workItemLabel(branch)}` : workItemLabel(branch),
            description: [
              branch === currentBranch ? "current" : undefined,
              memberCountLabel(service.countWorkItemMembers(system, branch)),
            ].filter(Boolean).join(" · "),
            action: "switch",
            name: branch,
          })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
          title: "Local Change History — Switch Work Item",
          placeHolder: currentBranch && !isDefaultWorkItem(currentBranch)
            ? `Current work item: ${currentBranch}`
            : "No work item yet",
        });

        if (!picked) {
          return;
        }

        if (picked.action === "create") {
          await startNewWorkItemFlow(ctx, system, root, currentBranch, branches);
        } else if (picked.name === currentBranch) {
          service.confirmWorkItem(system);
          vscode.window.showInformationMessage(`Already using work item “${currentBranch}”.`);
        } else if (picked.name) {
          await switchWorkItemFlow(ctx, system, root, currentBranch, picked.name);
        }

        await refreshGitStatusBar();
      }
    )
  );

  // ── Local Change History: move members between work items ────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-member-workspace.moveToWorkItem",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const entries = resolveMemberSelections(item, allSelections).map((selection) => selection.entry);
        if (entries.length === 0) {
          return;
        }
        const system = entries[0].system;
        const root = service.getGitRoot(system);
        if (!root || entries.some((entry) => systemKey(entry.system) !== systemKey(system))) {
          return;
        }
        if (!(await ensureReadyOrOfferSetup(service, system))) {
          return;
        }
        if (!(await saveDirtyLocalFiles(entries))) {
          return;
        }

        const [branches, currentBranch] = await Promise.all([
          gitService.listBranches(root.fsPath),
          gitService.currentBranch(root.fsPath),
        ]);
        if (!currentBranch) {
          vscode.window.showWarningMessage("Switch to a work item before moving members.");
          return;
        }
        const label = entries.length === 1 ? formatMemberPath(entries[0]) : `${entries.length} members`;
        const picked = await vscode.window.showQuickPick<WorkItemPick>(
          [
            { label: START_NEW_WORK_ITEM, action: "create" },
            ...branches
              .filter((branch) => branch !== currentBranch && !isDefaultWorkItem(branch))
              .map((branch): WorkItemPick => ({
                label: branch,
                description: memberCountLabel(service.countWorkItemMembers(system, branch)),
                action: "switch",
                name: branch,
              })),
          ],
          {
            title: `Move ${label} to Work Item`,
            placeHolder: `Move out of “${currentBranch}” into…`,
          }
        );
        if (!picked) {
          return;
        }
        const target = picked.action === "create"
          ? await promptWorkItemName(gitService, root.fsPath, branches)
          : picked.name;
        if (!target) {
          return;
        }
        if (!(await prepareForWorkItemChange(ctx, root, system, currentBranch, "Save Checkpoint and Move"))) {
          return;
        }

        let result;
        try {
          result = await service.moveEntriesToWorkItem(system, entries, target, {
            create: picked.action === "create",
          });
        } catch (err) {
          vscode.window.showErrorMessage(`Move failed: ${errorMessage(err)}`);
          return;
        } finally {
          await refreshGitStatusBar();
        }
        if (result.status !== "success") {
          vscode.window.showErrorMessage(result.message ?? `Could not move ${label} to “${target}”.`);
          return;
        }
        const switchLabel = `Switch to ${target}`;
        const choice = await vscode.window.showInformationMessage(
          `Moved ${label} to work item “${target}”.`,
          switchLabel
        );
        if (choice === switchLabel) {
          await switchWorkItemFlow(ctx, system, root, currentBranch, target);
          await refreshGitStatusBar();
        }
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

/**
 * Before a checkout, makes sure the member lands in the intended work item: always asks while no
 * work item is selected, otherwise confirms the active one once per session. Returns false if the
 * user cancels. Without Local Change History, checkouts proceed as before.
 */
export async function ensureWorkItemForCheckout(ctx: CommandContext, system: string): Promise<boolean> {
  const { service, gitService, refreshGitStatusBar } = ctx;
  const enabled = vscode.workspace
    .getConfiguration("ibmi-member-workspace")
    .get<boolean>("gitIntegration", false);
  const root = service.getGitRoot(system);
  if (!enabled || !root) {
    return true;
  }
  // When history cannot be saved, the checkout itself reports why and continues without it.
  if ((await service.ensureGitReady(system)).status !== "success") {
    return true;
  }
  if (!(await service.needsWorkItemChoice(system))) {
    return true;
  }

  const [branches, currentBranch] = await Promise.all([
    gitService.listBranches(root.fsPath),
    gitService.currentBranch(root.fsPath),
  ]);
  const hasWorkItem = Boolean(currentBranch) && !isDefaultWorkItem(currentBranch);
  const items: WorkItemPick[] = [
    ...(hasWorkItem
      ? [{
        label: `$(check)  Continue in ${currentBranch}`,
        description: memberCountLabel(service.countWorkItemMembers(system, currentBranch)),
        action: "continue" as const,
        name: currentBranch,
      }]
      : []),
    { label: START_NEW_WORK_ITEM, action: "create" },
    ...branches
      .filter((branch) => branch !== currentBranch && !isDefaultWorkItem(branch))
      .map((branch): WorkItemPick => ({
        label: `$(git-branch)  ${branch}`,
        description: memberCountLabel(service.countWorkItemMembers(system, branch)),
        action: "switch",
        name: branch,
      })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Which work item is this checkout for?",
    placeHolder: hasWorkItem
      ? `Checkouts are currently saved in work item “${currentBranch}”`
      : "Choose or start a work item (ticket) before checking out",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return false;
  }

  let ready: boolean;
  if (picked.action === "continue") {
    service.confirmWorkItem(system);
    ready = true;
  } else if (picked.action === "create") {
    ready = await startNewWorkItemFlow(ctx, system, root, currentBranch, branches);
  } else {
    ready = await switchWorkItemFlow(ctx, system, root, currentBranch, picked.name!);
  }
  await refreshGitStatusBar();
  return ready;
}

async function ensureReadyOrOfferSetup(service: CheckoutService, system: string): Promise<boolean> {
  const ready = await service.ensureGitReady(system);
  if (ready.status === "success") {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    ready.message ?? "Set up Local Change History before managing work items.",
    "Set Up"
  );
  if (choice === "Set Up") {
    await vscode.commands.executeCommand("ibmi-member-workspace.setupGitIntegration");
  }
  return false;
}

/** Asks for a new work-item name, rejecting names Git refuses or that already exist. */
async function promptWorkItemName(
  gitService: GitService,
  folder: string,
  branches: string[]
): Promise<string | undefined> {
  // Case-insensitive: branch refs are files, which collide by case on Windows and macOS.
  const existing = new Set(branches.map((branch) => branch.toLowerCase()));
  const name = await vscode.window.showInputBox({
    title: "Start New Work Item",
    prompt: "Use a ticket or project name. Git stores this as a local branch.",
    placeHolder: "e.g. TICKET-123 or payroll-fix",
    ignoreFocusOut: true,
    validateInput: async (value) => {
      const candidate = value.trim();
      if (!candidate) {
        return "Enter a work item name";
      }
      if (existing.has(candidate.toLowerCase())) {
        return "A work item with this name already exists. Choose it from the list instead.";
      }
      return (await gitService.validateBranchName(folder, candidate))
        ? undefined
        : "Use a short name without spaces or special Git characters, such as TICKET-123.";
    },
  });
  return name?.trim() || undefined;
}

/**
 * Starts a new work item. It begins empty, from the repository's clean first commit, unless the
 * user chooses to copy the current members or, from the default work item, move them.
 */
async function startNewWorkItemFlow(
  ctx: CommandContext,
  system: string,
  root: vscode.Uri,
  currentBranch: string,
  branches: string[]
): Promise<boolean> {
  const { service, gitService } = ctx;
  if (!canChangeWorkItem(ctx)) {
    return false;
  }
  const name = await promptWorkItemName(gitService, root.fsPath, branches);
  if (!name) {
    return false;
  }

  const count = currentBranch ? service.countWorkItemMembers(system, currentBranch) : 0;
  let carry: WorkItemCarry = "empty";
  if (count > 0) {
    const members = memberCountLabel(count);
    const choices: Array<vscode.QuickPickItem & { carry: WorkItemCarry }> = [
      {
        label: "$(circle-large-outline)  Start empty",
        description: `“${currentBranch}” keeps its ${members}`,
        carry: "empty",
      },
      {
        label: "$(copy)  Copy current members",
        description: `Both work items get the ${members} of “${currentBranch}”`,
        carry: "copy",
      },
      ...(isDefaultWorkItem(currentBranch)
        ? [{
          label: "$(arrow-right)  Move current members",
          description: `The ${members} checked out without a work item move into “${name}”`,
          carry: "move" as const,
        }]
        : []),
    ];
    const choice = await vscode.window.showQuickPick(choices, {
      title: `Start Work Item “${name}”`,
      placeHolder: "How should the new work item begin?",
      ignoreFocusOut: true,
    });
    if (!choice) {
      return false;
    }
    carry = choice.carry;
  }

  let startedEmpty = true;
  if (carry === "move") {
    // Renaming keeps every checkpoint and uncommitted edit; the working tree does not change.
    const renamed = await gitService.renameWorkItem(root.fsPath, currentBranch, name);
    if (renamed.status !== "success") {
      vscode.window.showErrorMessage(renamed.message ?? `Could not start work item “${name}”.`);
      return false;
    }
  } else {
    if (!(await prepareForWorkItemChange(ctx, root, system, currentBranch))) {
      return false;
    }
    const base = carry === "empty" ? await gitService.findCleanBase(root.fsPath) : undefined;
    startedEmpty = carry === "empty" && base !== undefined;
    const result = await gitService.createWorkItem(root.fsPath, name, base);
    if (result.status !== "success") {
      vscode.window.showErrorMessage(result.message ?? `Could not start work item “${name}”.`);
      return false;
    }
  }
  await service.startWorkItem(system, name, carry);
  service.confirmWorkItem(system);
  vscode.window.showInformationMessage(
    carry === "empty" && !startedEmpty && count > 0
      ? `Started work item “${name}”. This repository has its own history, so its existing files stay; they are not listed as checkouts.`
      : `Started work item “${name}”.`
  );
  return true;
}

async function switchWorkItemFlow(
  ctx: CommandContext,
  system: string,
  root: vscode.Uri,
  currentBranch: string,
  name: string
): Promise<boolean> {
  const { service, gitService, treeProvider } = ctx;
  if (!(await prepareForWorkItemChange(ctx, root, system, currentBranch))) {
    return false;
  }
  const result = await gitService.switchWorkItem(root.fsPath, name);
  if (result.status !== "success") {
    vscode.window.showErrorMessage(result.message ?? `Could not switch to work item “${name}”.`);
    return false;
  }
  await service.activateWorkItem(system, name);
  service.confirmWorkItem(system);
  treeProvider.refresh();
  vscode.window.showInformationMessage(`Switched to work item “${name}”.`);
  return true;
}

function canChangeWorkItem(ctx: CommandContext): boolean {
  if (ctx.pendingMergeBacks.size > 0) {
    vscode.window.showWarningMessage(
      "Finish or close the open Merge Back comparison before changing work items."
    );
    return false;
  }
  if (ctx.service.isBusy()) {
    vscode.window.showWarningMessage(
      "Wait for the running checkout, upload, or other member operation to finish before changing work items."
    );
    return false;
  }
  return true;
}

function workItemLabel(name: string): string {
  return isDefaultWorkItem(name) ? `${name} (no work item)` : name;
}

function memberCountLabel(count: number): string {
  return `${count} member${count === 1 ? "" : "s"}`;
}

async function prepareForWorkItemChange(
  ctx: CommandContext,
  root: vscode.Uri,
  system: string,
  currentWorkItem: string,
  confirmLabel = "Save Checkpoint and Switch"
): Promise<boolean> {
  const { service, gitService } = ctx;
  if (!canChangeWorkItem(ctx)) {
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
      { modal: true, detail: "Save them before changing work items so no edits are lost." },
      "Save All and Continue"
    );
    if (choice !== "Save All and Continue") {
      return false;
    }
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    if (dirtyDocuments.some((document) => document.isDirty)) {
      vscode.window.showWarningMessage(
        "Some checkout files could not be saved. The work item was not changed."
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
        detail: "Save a checkpoint first so the changes remain available in this work item.",
      },
      confirmLabel
    );
    if (choice !== confirmLabel) {
      return false;
    }
    const checkpoint = await service.saveCheckpoint(
      system,
      managedChanges,
      `checkpoint: before leaving ${currentWorkItem || "work item"}`
    );
    if (checkpoint.status !== "success" && checkpoint.status !== "noChanges") {
      vscode.window.showErrorMessage(checkpoint.message ?? "Could not save a checkpoint before changing work items.");
      return false;
    }
  }
  const remaining = await gitService.changedPaths(root.fsPath);
  if (remaining.length > 0) {
    vscode.window.showWarningMessage(
      "The work item was not changed because this system repository still has unrelated changes. Commit or stash them in Source Control, then try again."
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
