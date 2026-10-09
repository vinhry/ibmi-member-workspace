import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  ChangeManagementOrigin,
  CheckedOutMember,
  CheckoutIndex,
  DEFAULT_WORK_ITEM,
  SystemCheckoutState,
  RefreshTally,
  WorkItemCarry,
  buildCheckoutId,
  emptyTally,
  formatMemberPath,
  isReferenceCopy,
  memberNameProblem,
  sanitizeSystemName,
  systemKey,
  TrackedGroup,
  trackedGroups,
} from "./types";
import {
  downloadMemberContent,
  uploadMemberContent,
  uploadMemberContentWithDates,
  sourceDatesEnabled,
  sourceFileLayout,
  memberChangeStamps,
  getSystemName,
} from "./codeForIBMi";
import { CheckoutCancelledError, LocalFileMissingError, ReferenceCopyError, RemoteMemberMissingError, errorMessage } from "./errors";
import {
  HASH_VERSION,
  RemoteStatus,
  classifyStatus,
  hashContent,
  migrateLegacyBaseline,
  nextBaseline,
  normalizeForMemberUpload,
  statusAfterLocalSave,
  statusAfterUpload,
} from "./sync";
import { BASELINE_DIR, BaselineFiles, BaselineStore, referencedBaselineHashes } from "./baselineStore";
import { MergeSide, baselineAfterMergeSave } from "./mergePreparation";
import {
  GitOperationResult,
  GitService,
  LegacyMigrationResult,
  RepositoryInspection,
} from "./gitService";
import { RepositoryTrust } from "./repositoryTrust";
import { WorkItemHistory, pathIsInside } from "./workItemHistory";
import { DOWNLOAD_CONCURRENCY } from "./concurrency";
import { assertNoLinkBelow, checkoutFilePath } from "./localPath";
import { runRefreshSteps } from "./refreshRun";
import { GitIntegrationState, gitIntegrationState } from "./workspaceSettings";
import { CheckoutIndexStore, IndexStorage } from "./checkoutIndexStore";
import { SourceLayout, SourceProblem, describeProblem, sourceProblems, summarizeProblems } from "./sourceCheck";
import { TimedOutError, describeDuration, withDeadline } from "./deadline";
import { RefreshPlan, groupBySourceFile, planRefresh } from "./remoteStamps";

/** workspaceState key: the user turned on Local Change History in this workspace. */
const GIT_INTEGRATION_CONFIRMED = "gitIntegrationConfirmed";

/**
 * "uploaded-altered": uploaded, but the IBM i stored content that differs from the local copy.
 * "source-problems": not uploaded, because the local copy has lines too long for the source file or
 * characters its CCSID can't store.
 */
export type UploadResult = "uploaded" | "uploaded-altered" | "failed" | "remote-changed" | "source-problems";

/**
 * How long a download from the IBM i may take. Code for IBM i rejects a pending request only when
 * the connection closes, so without a limit a request that never answers holds the checkout (and
 * everything waiting for it) until the user disconnects.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** How long the source file layout lookup may take; without it, the checks before upload are skipped. */
const LAYOUT_TIMEOUT_MS = 15_000;
/** A wait longer than this is logged, so the output panel shows what a slow checkout waits for. */
const SLOW_WAIT_MS = 10_000;

/** Problems listed in the output panel per member; the editor shows them all. */
const LOGGED_PROBLEMS = 10;

type RefreshProgress = vscode.Progress<{ message?: string; increment?: number }>;

export interface CheckoutOptions {
  redownloadBehavior?: "ask" | "skip" | "force";
  suppressAutoOpen?: boolean;
  /** With "force": overwrite local edits not yet sent to the IBM i instead of skipping the member. */
  discardLocalChanges?: boolean;
  /**
   * Collects the path of each member actually downloaded, for one checkpoint after a batch,
   * instead of saving a checkpoint per member.
   */
  deferCheckpointTo?: string[];
  /**
   * Bring the member in as a read-only reference copy. A member already checked out for
   * change is left as it is.
   */
  reference?: boolean;
  /** The system the caller expects; the checkout is refused if another one is connected. */
  system?: string;
  /** Cancels the checkout, also while it waits for the IBM i; nothing is written then. */
  signal?: AbortSignal;
  /** What the change-management checkout this follows recorded, kept with the member for its check-in. */
  changeManagement?: ChangeManagementOrigin;
}

export class CheckoutService implements vscode.Disposable {
  private readonly storageUri: vscode.Uri | undefined;
  private readonly store: CheckoutIndexStore;
  /** The text behind each checkout's baseline hash, for three-way Merge Back. */
  private readonly baselines: BaselineStore;

  private readonly repositoryTrust: RepositoryTrust;
  /** Local Change History's work items and checkpoints; the service delegates to it. */
  private readonly history: WorkItemHistory;
  /** Lifecycle operations in progress; work items must not change underneath them. */
  private inFlight = 0;
  /** Source file layouts read this connection, by SYSTEM/LIBRARY/FILE; a batch reads each file once. */
  private readonly sourceLayouts = new Map<string, Promise<SourceLayout | undefined>>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
    private readonly gitService?: GitService
  ) {
    this.storageUri = context.storageUri;
    this.repositoryTrust = new RepositoryTrust(context.globalState);
    this.store = new CheckoutIndexStore({
      storage: this.storageUri ? workspaceIndexStorage(this.storageUri) : undefined,
      onChange: () => this._onDidChange.fire(),
      log: (message) => this.log.appendLine(message),
      showWarning: (message) => void vscode.window.showWarningMessage(message),
      showError: (message) => void vscode.window.showErrorMessage(message),
    });
    this.baselines = new BaselineStore(
      this.storageUri ? workspaceBaselineFiles(this.storageUri) : undefined,
      (message) => this.log.appendLine(message)
    );
    this.history = new WorkItemHistory({
      git: gitService,
      files: {
        exists: (localPath) => fs.existsSync(localPath),
        read: async (localPath) => vscode.workspace.fs.readFile(vscode.Uri.file(localPath)),
        write: async (localPath, content) => {
          const uri = vscode.Uri.file(localPath);
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
          await vscode.workspace.fs.writeFile(uri, content);
        },
        remove: (localPath) => fs.rmSync(localPath, { force: true }),
        setReadOnly: (localPath, readOnly) => this.setReadOnly(localPath, readOnly),
      },
      ui: {
        askIdentity: askGitIdentity,
        confirmRepositoryUse: async (system, folder) => {
          const choice = await vscode.window.showWarningMessage(
            `${folder} already has a Git repository that IBM i Member Workspace didn't create. Use it for Local Change History of ${system}?`,
            {
              modal: true,
              detail: "Checkpoints will be saved as commits in that repository. Only use it if you trust where it came from: a repository's settings can make Git run programs.",
            },
            "Use This Repository"
          );
          return choice === "Use This Repository";
        },
        warn: (message) => void vscode.window.showWarningMessage(message),
      },
      trust: this.repositoryTrust,
      gitIntegrationOn: () => this.gitIntegrationOn(),
      connectedSystem: getSystemName,
      checkoutRoot: () => this.getCheckoutRoot()?.fsPath,
      gitRoot: (system) => this.getGitRoot(system)?.fsPath,
      systemState: (system) => this.index.systems[systemKey(system)],
      ensureSystemState: (system) => this.ensureSystemState(system),
      knownSystems: () => this.getKnownSystems(),
      activeEntries: (system) => this.activeEntries(system),
      managedPaths: (system) => this.getManagedPaths(system),
      inBatch: () => this.store.inBatch,
      persist: () => this.persist(),
      assertLocalPathSafe: (localPath) => this.assertLocalPathSafe(localPath),
      log: (message) => this.log.appendLine(message),
    });
  }

  /** The checkout index; the store replaces it when it loads. */
  private get index(): CheckoutIndex {
    return this.store.index;
  }

  async initialize(): Promise<void> {
    if (!this.storageUri) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await this.store.load();
    await this.trustRepositoriesInUse();
    const system = getSystemName();
    if (system && Object.keys(this.index.unassignedWorkItems).length > 0) {
      this.ensureSystemState(system);
      await this.store.save();
    }
    await this.pruneBaselines();
  }

  dispose(): void {
    this.store.dispose();
    this._onDidChange.dispose();
  }

  // Local Change History: the work items and checkpoints live in `WorkItemHistory`; these keep the
  // service's API for the commands, so nothing changes for them.

  /** Whether Local Change History is on and Git is available; warns once when it isn't. */
  isGitEnabled(): Promise<boolean> {
    return this.history.isGitEnabled();
  }

  /** Records that the user chose the active work item for checkouts in this session. */
  confirmWorkItem(system: string): void {
    this.history.confirmWorkItem(system);
  }

  /** Whether a checkout must first ask which work item it belongs to. */
  needsWorkItemChoice(system: string): Promise<boolean> {
    return this.history.needsWorkItemChoice(system);
  }

  inspectRepository(folder: string): Promise<RepositoryInspection | undefined> {
    return this.history.inspectRepository(folder);
  }

  detectMisplacedParentRepository(): Promise<RepositoryInspection | undefined> {
    return this.history.detectMisplacedParentRepository();
  }

  migrateLegacyRepository(): Promise<LegacyMigrationResult> {
    return this.history.migrateLegacyRepository();
  }

  archiveMisplacedRepository(): Promise<{ gitBackup: string; gitignoreBackup?: string }> {
    return this.history.archiveMisplacedRepository();
  }

  ensureGitReady(system?: string): Promise<GitOperationResult> {
    return this.history.ensureGitReady(system);
  }

  resetGitSetupState(): void {
    this.history.resetSetupState();
  }

  synchronizeWorkItem(system?: string): Promise<void> {
    return this.history.synchronizeWorkItem(system);
  }

  /** Makes an existing work item active after its branch was checked out. */
  activateWorkItem(system: string, name: string): Promise<void> {
    return this.history.activateWorkItem(system, name);
  }

  /** Makes a work item whose branch was just created (or renamed, for "move") active. */
  startWorkItem(system: string, name: string, carry: WorkItemCarry): Promise<void> {
    return this.history.startWorkItem(system, name, carry);
  }

  /** Saves the paths collected with `deferCheckpointTo` as one checkpoint, if there are any. */
  saveBatchCheckpoint(system: string, paths: string[], message: string): Promise<void> {
    return this.history.saveBatchCheckpoint(system, paths, message);
  }

  saveCheckpoint(system: string, paths: string[], message: string): Promise<GitOperationResult> {
    return this.history.saveCheckpoint(system, paths, message);
  }

  private logGitFailure(result: GitOperationResult): void {
    this.history.logGitFailure(result);
  }

  private assertEntryInActiveWorkItem(entry: CheckedOutMember): Promise<void> {
    return this.history.assertEntryInActiveWorkItem(entry);
  }

  private get entries(): CheckedOutMember[] {
    const system = getSystemName();
    return system ? this.activeEntries(system) : [];
  }

  /** The stored checkouts of `system`'s active work item, whichever system is connected now. */
  private activeEntries(system: string): CheckedOutMember[] {
    const state = this.ensureSystemState(system);
    return state.workItems[state.activeWorkItem] ??= [];
  }

  getActiveWorkItem(system = getSystemName()): string {
    return system ? this.ensureSystemState(system).activeWorkItem : DEFAULT_WORK_ITEM;
  }

  /** Local Change History's setting for this workspace; see {@link gitIntegrationState}. */
  gitIntegrationState(): GitIntegrationState {
    return gitIntegrationState(
      vscode.workspace.getConfiguration("ibmi-member-workspace").inspect<boolean>("gitIntegration"),
      this.context.workspaceState.get<boolean>(GIT_INTEGRATION_CONFIRMED, false)
    );
  }

  gitIntegrationOn(): boolean {
    return this.gitIntegrationState() === "on";
  }

  /** Records that the user turned on Local Change History in this workspace. */
  async confirmGitIntegration(): Promise<void> {
    await this.context.workspaceState.update(GIT_INTEGRATION_CONFIRMED, true);
  }

  /** Whether a checkout, upload, or other operation that records history is running. */
  isBusy(): boolean {
    return this.inFlight > 0;
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
    }
  }

  countWorkItemMembers(system: string, name: string): number {
    return this.ensureSystemState(system).workItems[name]?.length ?? 0;
  }

  getKnownWorkItems(): string[] {
    const system = getSystemName();
    return system ? Object.keys(this.ensureSystemState(system).workItems) : [];
  }

  getKnownSystems(): SystemCheckoutState[] {
    const connected = getSystemName();
    if (connected) {
      this.ensureSystemState(connected);
    }
    return Object.values(this.index.systems);
  }

  getGitRoot(system: string): vscode.Uri | undefined {
    const checkoutRoot = this.getCheckoutRoot();
    return checkoutRoot
      ? vscode.Uri.joinPath(checkoutRoot, sanitizeSystemName(system))
      : undefined;
  }

  getGitRootForEntry(entry: CheckedOutMember): vscode.Uri {
    const root = this.getGitRoot(entry.system);
    if (!root || !pathIsInside(root.fsPath, entry.localPath)) {
      throw new Error(`The checkout path for ${formatMemberPath(entry)} is outside its system repository.`);
    }
    return root;
  }

  /**
   * Once per workspace, keeps Local Change History as it was before a workspace setting needed
   * confirming and repositories needed trusting, so upgrading doesn't ask about either. A workspace
   * opened for the first time has no checkout folder yet, so it confirms and trusts nothing here.
   */
  private async trustRepositoriesInUse(): Promise<void> {
    const migrated = "repositoryTrustMigrated";
    if (this.context.workspaceState.get<boolean>(migrated, false)) {
      return;
    }
    await this.context.workspaceState.update(migrated, true);
    const enabled = vscode.workspace
      .getConfiguration("ibmi-member-workspace")
      .get<boolean>("gitIntegration", false);
    if (!enabled || !this.gitService || !this.getCheckoutRoot()) {
      return;
    }
    await this.confirmGitIntegration();
    for (const state of Object.values(this.index.systems)) {
      const root = this.getGitRoot(state.system);
      if (root && await this.gitService.isExactRepository(root.fsPath)) {
        await this.repositoryTrust.trust(root.fsPath);
      }
    }
  }

  /**
   * Moves checkouts from the active work item to `target`, creating it from the clean base when
   * `create` is set. The members are committed on the target before they are removed from the
   * active work item, so a failure part-way leaves them in both work items, never in neither.
   * The active work item stays active. The caller must leave the repository clean first.
   */
  moveEntriesToWorkItem(
    system: string,
    entries: CheckedOutMember[],
    target: string,
    options: { create: boolean }
  ): Promise<GitOperationResult> {
    return this.track(() => this.history.moveEntries(system, entries, target, options.create));
  }

  /**
   * Records that the merge editor's result (`savedText`) was saved over the local copy of a Merge
   * Back against `remote`. The IBM i's text becomes the baseline once something was merged (see
   * `baselineAfterMergeSave`), so the upload that follows doesn't ask about those remote changes;
   * the member is then "modified" (or in sync) rather than in conflict.
   */
  adoptMergeBaseline(
    entry: CheckedOutMember,
    remote: MergeSide,
    localSnapshotHash: string,
    savedText: string
  ): Promise<GitOperationResult> {
    return this.track(async () => {
      assertEditable(entry);
      await this.assertEntryInActiveWorkItem(entry);
      const savedHash = hashContent(savedText);
      const next = baselineAfterMergeSave(savedHash, localSnapshotHash, remote.hash, entry.remoteHashAtCheckout);
      if (next !== entry.remoteHashAtCheckout) {
        await this.setBaseline(entry, next, remote.text);
      }
      entry.status = classifyStatus(savedHash, remote.hash, entry.remoteHashAtCheckout);
      entry.lastCheckedAt = new Date().toISOString();
      this.log.appendLine(
        `[merge] ${formatMemberPath(entry)} saved from the merge editor` +
        `  baseline=${entry.remoteHashAtCheckout.substring(0, 12)}  → ${entry.status}`
      );
      await this.persist();
      return this.saveCheckpoint(entry.system,
        [entry.localPath],
        `merge: ${formatMemberPath(entry)} with ${entry.system}`
      );
    });
  }

  /** The member's text on the IBM i now, for Merge Back and Compare with IBM i. */
  readRemoteText(entry: CheckedOutMember, signal?: AbortSignal): Promise<string> {
    this.assertConnectedTo(entry.system);
    return this.downloadForEntry(entry, signal);
  }

  /** The local copy's text, never read through a link. */
  readLocalText(entry: CheckedOutMember): Promise<string> {
    this.assertLocalPathSafe(entry.localPath);
    return this.readLocal(vscode.Uri.file(entry.localPath));
  }

  /**
   * The text the checkout's baseline hash stands for, when it is kept. A `candidate` (the live
   * remote or local text) that hashes to the baseline is kept for next time: checkouts made before
   * 1.8.10 have a hash but no text.
   */
  async baselineText(entry: CheckedOutMember, candidates: readonly string[] = []): Promise<string | undefined> {
    const before = entry.remoteHashAtCheckout;
    await this.upgradeBaseline(entry, candidates);
    if (entry.remoteHashAtCheckout !== before) {
      await this.persist();
    }
    await this.baselines.ensure(entry.remoteHashAtCheckout, candidates);
    return this.baselines.read(entry.remoteHashAtCheckout);
  }

  /**
   * Runs `fn` with index saves deferred until it finishes, so a batch
   * operation writes the index once instead of once per member.
   */
  async runBatch<T>(fn: () => Promise<T>): Promise<T> {
    this.store.beginBatch();
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      const ended = this.store.endBatch();
      if (!this.store.inBatch) {
        this.history.endBatch();
      }
      await ended;
    }
  }

  getEntriesForSystem(system: string): CheckedOutMember[] {
    const state = this.index.systems[systemKey(system)];
    return state?.workItems[state.activeWorkItem] ?? [];
  }

  getManagedPaths(system: string): string[] {
    return this.getEntriesForSystem(system).map((entry) => entry.localPath);
  }

  hasEntries(): boolean {
    return trackedGroups(this.index).length > 0;
  }

  /** Where checkouts are still tracked: every work item of every system, not only what the view shows. */
  trackedGroups(): TrackedGroup[] {
    return trackedGroups(this.index);
  }

  /** How many tracked checkouts, in every work item of every system, have changes not sent to the IBM i. */
  async countLocalChangesEverywhere(): Promise<number> {
    const all = [
      ...Object.values(this.index.systems).flatMap((state) => Object.values(state.workItems).flat()),
      ...Object.values(this.index.unassignedWorkItems).flat(),
    ];
    let changed = 0;
    for (const entry of all) {
      if (await this.hasLocalChanges(entry).catch(() => false)) {
        changed++;
      }
    }
    return changed;
  }

  /**
   * Stops tracking every checkout, in every work item of every system, to change the checkout
   * folder. Local files and Local Change History are left as they are.
   */
  async forgetAllEntries(): Promise<void> {
    for (const state of Object.values(this.index.systems)) {
      for (const workItem of Object.keys(state.workItems)) {
        state.workItems[workItem] = [];
      }
    }
    for (const workItem of Object.keys(this.index.unassignedWorkItems)) {
      this.index.unassignedWorkItems[workItem] = [];
    }
    await this.persist();
  }

  getCheckoutRoot(): vscode.Uri | undefined {
    const folder = this.context.workspaceState.get<string>("checkoutRoot");
    return folder ? vscode.Uri.file(folder) : undefined;
  }

  async setCheckoutRoot(folder: vscode.Uri): Promise<void> {
    await this.assertWritableFolder(folder);
    await this.context.workspaceState.update("checkoutRoot", folder.fsPath);
    this.resetGitSetupState();
  }

  async validateCheckoutRoot(): Promise<vscode.Uri> {
    const root = this.getCheckoutRoot();
    if (!root) {
      throw new Error("Choose a checkout folder before checking out members.");
    }
    await this.assertWritableFolder(root);
    return root;
  }

  private async assertWritableFolder(folder: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(folder);
    const probe = vscode.Uri.joinPath(
      folder,
      `.ibmi-member-workspace-write-test-${randomUUID()}`
    );
    await vscode.workspace.fs.writeFile(probe, new Uint8Array());
    await vscode.workspace.fs.delete(probe);
  }

  findEntry(
    system: string,
    library: string,
    sourceFile: string,
    memberName: string
  ): CheckedOutMember | undefined {
    const id = buildCheckoutId(system, library, sourceFile, memberName);
    return this.entries.find((e) => e.id === id);
  }

  checkoutMember(
    library: string,
    sourceFile: string,
    memberName: string,
    memberExtension: string,
    options?: CheckoutOptions
  ): Promise<CheckedOutMember> {
    return this.track(() =>
      this.checkoutMemberNow(library, sourceFile, memberName, memberExtension, options)
    );
  }

  private async checkoutMemberNow(
    library: string,
    sourceFile: string,
    memberName: string,
    memberExtension: string,
    options?: CheckoutOptions
  ): Promise<CheckedOutMember> {
    const {
      redownloadBehavior = "ask",
      suppressAutoOpen = false,
      discardLocalChanges = false,
      deferCheckpointTo,
      reference = false,
      system: expectedSystem,
      signal,
      changeManagement,
    } = options ?? {};
    const checkoutRoot = this.getCheckoutRoot();
    if (!checkoutRoot) {
      throw new Error("Choose a checkout folder before checking out members.");
    }
    const nameProblem = memberNameProblem({ library, sourceFile, memberName, extension: memberExtension });
    if (nameProblem) {
      throw new Error(`Can't check out ${library}/${sourceFile}(${memberName}): ${nameProblem}`);
    }

    const system = getSystemName();
    if (!system) {
      throw new Error("Not connected to IBM i");
    }
    // A batch decided what to overwrite for its own system; another one may be connected by now.
    if (expectedSystem) {
      this.assertConnectedTo(expectedSystem);
    }

    this.ensureSystemState(system);
    const gitReady = await this.ensureGitReady(system);
    this.logGitFailure(gitReady);

    const existing = this.findEntry(system, library, sourceFile, memberName);
    if (existing && reference && !isReferenceCopy(existing)) {
      this.log.appendLine(`[reference] Kept ${formatMemberPath(existing)}: already checked out for change`);
      return existing;
    }
    if (existing) {
      if (redownloadBehavior === "skip") {
        return existing;
      }

      if (redownloadBehavior === "ask") {
        const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
        const warn = config.get<boolean>("warnOnRedownload", true);

        if (warn) {
          const choice = await vscode.window.showWarningMessage(
            `${formatMemberPath(existing)} is already checked out since ${new Date(existing.checkedOutAt).toLocaleDateString()}. What would you like to do?`,
            "Open Existing",
            "Re-download",
            "Cancel"
          );

          if (choice === "Open Existing") {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(existing.localPath)
            );
            await vscode.window.showTextDocument(doc);
            return existing;
          }

          if (choice !== "Re-download") {
            throw new CheckoutCancelledError();
          }
        }

        if (await this.hasLocalChanges(existing)) {
          const confirm = await vscode.window.showWarningMessage(
            `${formatMemberPath(existing)} has local changes that have not been sent to the IBM i.`,
            { modal: true, detail: "Re-downloading will discard them." },
            "Discard Local Changes"
          );
          if (confirm !== "Discard Local Changes") {
            throw new CheckoutCancelledError();
          }
        }
      } else if (!discardLocalChanges && (await this.hasLocalChanges(existing))) {
        this.log.appendLine(
          `[checkout] Skipped ${formatMemberPath(existing)}: local changes not yet sent to the IBM i`
        );
        return existing;
      }
      // Otherwise re-download below
    }

    // The prompts above leave time to connect elsewhere; this checkout belongs to `system`.
    this.assertConnectedTo(system);
    const content = await this.download(library, sourceFile, memberName, signal);

    const sourceLayout = await this.lookupSourceLayout(system, library, sourceFile) ?? existing?.sourceLayout;
    // A cancel during the lookup: nothing has been written yet, and nothing will be.
    if (signal?.aborted) {
      throw new CheckoutCancelledError();
    }
    const entry: CheckedOutMember = {
      id: buildCheckoutId(system, library, sourceFile, memberName),
      system,
      library: library.toUpperCase(),
      sourceFile: sourceFile.toUpperCase(),
      memberName: memberName.toUpperCase(),
      extension: memberExtension.toLowerCase(),
      localPath: "",
      checkedOutAt: new Date().toISOString(),
      remoteHashAtCheckout: "",
      ...(reference ? { kind: "reference" as const } : {}),
      // A re-download keeps the member's own upload-on-save choice, and where change management got it from.
      ...(!reference && existing?.uploadOnSave ? { uploadOnSave: existing.uploadOnSave } : {}),
      ...(!reference && (changeManagement ?? existing?.changeManagement)
        ? { changeManagement: changeManagement ?? existing?.changeManagement }
        : {}),
      ...(sourceLayout ? { sourceLayout } : {}),
      status: "checked-out",
    };

    const localPath = existing?.localPath ?? await this.getLocalPath(checkoutRoot, entry);
    entry.localPath = localPath;

    const hash = hashContent(content);
    await this.setBaseline(entry, hash, content);

    this.log.appendLine(
      `[checkout] ${library}/${sourceFile}/${memberName}  remoteHashAtCheckout=${hash.substring(0, 12)}`
    );

    this.assertLocalPathSafe(localPath);
    await this.setReadOnly(localPath, false);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(localPath),
      Buffer.from(content, "utf-8")
    );
    if (reference) {
      await this.setReadOnly(localPath, true);
    }

    if (deferCheckpointTo) {
      deferCheckpointTo.push(localPath);
    } else if (gitReady.status === "success" && this.gitService) {
      const gitRoot = this.getGitRoot(system)!;
      const result = await this.gitService.saveCheckpoint(
        gitRoot.fsPath,
        [localPath],
        `${reference ? "reference" : "checkout"}: ${formatMemberPath(entry)} from ${entry.system}`,
        false
      );
      this.logGitFailure(result);
    }

    // Recorded under `system` even if the connection dropped meanwhile. Looked up again now: with
    // several checkouts at once, another may have recorded the same member since `existing` was read.
    const entries = this.activeEntries(system);
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }

    await this.persist();

    if (!suppressAutoOpen) {
      const config = vscode.workspace.getConfiguration("ibmi-member-workspace");
      if (config.get<boolean>("autoOpenOnCheckout", true)) {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(localPath)
        );
        await vscode.window.showTextDocument(doc);
      }

      vscode.window.showInformationMessage(
        `Checked out ${formatMemberPath(entry)} from ${system}`
      );
    }

    return entry;
  }

  /**
   * Compares the local copy, the remote member and the baseline. `stamp` is the member's change stamp,
   * read before the download; it is recorded so a quick refresh can skip the member while it's unchanged.
   */
  async refreshRemoteStatus(entry: CheckedOutMember, stamp?: string): Promise<RemoteStatus> {
    this.assertConnectedTo(entry.system);
    await this.assertEntryInActiveWorkItem(entry);
    const localUri = vscode.Uri.file(entry.localPath);

    let remoteContent: string;
    try {
      remoteContent = await this.downloadForEntry(entry);
    } catch (err) {
      if (err instanceof RemoteMemberMissingError) {
        return "remote-missing";
      }
      throw err;
    }
    const localContent = await this.readLocal(localUri);
    await this.upgradeBaseline(entry, [remoteContent, localContent]);
    const remoteHash = hashContent(remoteContent);
    const localHash = hashContent(localContent);

    const status = classifyStatus(localHash, remoteHash, entry.remoteHashAtCheckout);
    await this.adoptNextBaseline(entry, localHash, remoteHash, remoteContent);
    // A checkout made before baselines were kept gets its text from whichever side is still the base.
    await this.baselines.ensure(entry.remoteHashAtCheckout, [remoteContent, localContent]);
    // Read again in case the source file changed; one query per source file per connection.
    await this.fillSourceLayout(entry, { replace: true });

    this.log.appendLine(
      `[refresh] ${entry.library}/${entry.sourceFile}/${entry.memberName}` +
      `  local=${localHash.substring(0, 12)}` +
      `  remote=${remoteHash.substring(0, 12)}` +
      `  baseline=${entry.remoteHashAtCheckout?.substring(0, 12)}` +
      `  → ${status}`
    );

    entry.status = status;
    entry.lastCheckedAt = new Date().toISOString();
    if (stamp !== undefined) {
      entry.remoteSeen = { stamp, hash: remoteHash };
    }
    await this.persist();

    return status;
  }

  /**
   * Like {@link refreshRemoteStatus} for a member the catalog says is unchanged on the IBM i since its
   * last full comparison: only the local copy is read, and `remoteHash` stands for the remote.
   */
  private async refreshFromSeen(entry: CheckedOutMember, remoteHash: string): Promise<RemoteStatus> {
    await this.assertEntryInActiveWorkItem(entry);
    const localContent = await this.readLocal(vscode.Uri.file(entry.localPath));
    const localHash = hashContent(localContent);
    const status = classifyStatus(localHash, remoteHash, entry.remoteHashAtCheckout);
    // When local and remote match, the local text is the remote's.
    await this.adoptNextBaseline(entry, localHash, remoteHash, localContent);
    await this.baselines.ensure(entry.remoteHashAtCheckout, [localContent]);
    this.log.appendLine(
      `[refresh] ${entry.library}/${entry.sourceFile}/${entry.memberName}  unchanged on the IBM i` +
      `  local=${localHash.substring(0, 12)}  → ${status}`
    );
    entry.status = status;
    entry.lastCheckedAt = new Date().toISOString();
    await this.persist();
    return status;
  }

  /**
   * Splits `entries` into members to download and members unchanged on the IBM i, with one catalog
   * query per source file. A source file whose query fails is compared in full.
   */
  private async planQuickRefresh(entries: CheckedOutMember[]): Promise<RefreshPlan<CheckedOutMember>> {
    const plan: RefreshPlan<CheckedOutMember> = { download: [], unchanged: [], missing: [] };
    const system = getSystemName();
    for (const group of groupBySourceFile(entries)) {
      const sameSystem = group.entries.filter((entry) => system && systemKey(entry.system) === systemKey(system));
      let stamps: Map<string, string> | undefined;
      if (sameSystem.length > 0) {
        try {
          stamps = await memberChangeStamps(group.library, group.sourceFile, sameSystem.map((entry) => entry.memberName));
        } catch (err) {
          this.log.appendLine(
            `[refresh] Could not read the change times of ${group.library}/${group.sourceFile}; comparing its members in full: ${errorMessage(err)}`
          );
        }
      }
      const groupPlan = planRefresh(sameSystem, stamps);
      // Members of another system are downloaded, so refreshRemoteStatus refuses them as before.
      const others = group.entries.filter((entry) => !sameSystem.includes(entry)).map((entry) => ({ entry }));
      plan.download.push(...groupPlan.download, ...others);
      plan.unchanged.push(...groupPlan.unchanged);
      plan.missing.push(...groupPlan.missing);
    }
    return plan;
  }

  /**
   * Records that the member no longer exists on the IBM i. The local file and baseline are kept, and
   * `remoteSeen` is dropped so the next refresh compares the member in full if it comes back.
   */
  private async markRemoteMissing(entry: CheckedOutMember): Promise<RemoteStatus> {
    await this.assertEntryInActiveWorkItem(entry);
    this.log.appendLine(`[refresh] ${formatMemberPath(entry)} no longer exists on the IBM i; the local copy is kept`);
    entry.status = "remote-missing";
    entry.lastCheckedAt = new Date().toISOString();
    delete entry.remoteSeen;
    await this.persist();
    return "remote-missing";
  }

  /**
   * Downloads the checkout's member. When the download fails for another reason than a timeout or a
   * cancel, the catalog decides whether the member is gone: if it no longer lists it, the checkout is
   * marked {@link markRemoteMissing} and {@link RemoteMemberMissingError} is thrown; otherwise the
   * download's own error is, so a busy or dropped connection is still an error, not a deletion.
   */
  private async downloadForEntry(entry: CheckedOutMember, signal?: AbortSignal): Promise<string> {
    try {
      return await this.download(entry.library, entry.sourceFile, entry.memberName, signal);
    } catch (err) {
      if (err instanceof TimedOutError || err instanceof CheckoutCancelledError) {
        throw err;
      }
      const stamps = await memberChangeStamps(entry.library, entry.sourceFile, [entry.memberName]).catch(() => undefined);
      if (stamps === undefined || stamps.has(entry.memberName.toUpperCase())) {
        throw err;
      }
      await this.markRemoteMissing(entry);
      throw new RemoteMemberMissingError(formatMemberPath(entry));
    }
  }

  recheckout(entry: CheckedOutMember): Promise<void> {
    return this.track(() => this.recheckoutNow(entry));
  }

  private async recheckoutNow(entry: CheckedOutMember): Promise<void> {
    this.assertConnectedTo(entry.system);
    await this.assertEntryInActiveWorkItem(entry);
    const content = await this.downloadForEntry(entry);
    const localUri = vscode.Uri.file(entry.localPath);
    this.assertLocalPathSafe(entry.localPath);

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localUri, ".."));
    await this.setReadOnly(entry.localPath, false);
    await vscode.workspace.fs.writeFile(
      localUri,
      Buffer.from(content, "utf-8")
    );
    if (isReferenceCopy(entry)) {
      await this.setReadOnly(entry.localPath, true);
    }

    await this.setBaseline(entry, hashContent(content), content);
    delete entry.remoteSeen;
    entry.checkedOutAt = new Date().toISOString();
    entry.lastCheckedAt = entry.checkedOutAt;
    entry.status = "in-sync";
    await this.persist();
    const result = await this.saveCheckpoint(entry.system,
      [entry.localPath],
      `recheckout: ${formatMemberPath(entry)} from ${entry.system}`
    );
    this.logGitFailure(result);
  }

  /**
   * Overwrites the remote member with the local copy. Unless
   * `overwriteRemoteChanges` is set, refuses (returning "remote-changed")
   * when the member was changed on the IBM i since it was checked out.
   */
  uploadToRemote(
    entry: CheckedOutMember,
    options?: {
      overwriteRemoteChanges?: boolean;
      /** Uploads even when the local copy has text the source member can't hold. */
      ignoreSourceProblems?: boolean;
      /** Collects the path for one checkpoint after a batch instead of saving one per member. */
      deferCheckpointTo?: string[];
    }
  ): Promise<UploadResult> {
    return this.track(() => this.uploadToRemoteNow(entry, options));
  }

  private async uploadToRemoteNow(
    entry: CheckedOutMember,
    options?: { overwriteRemoteChanges?: boolean; ignoreSourceProblems?: boolean; deferCheckpointTo?: string[] }
  ): Promise<UploadResult> {
    assertEditable(entry);
    this.assertConnectedTo(entry.system);
    await this.assertEntryInActiveWorkItem(entry);
    // Uploading through a link would send whatever file it points at to the IBM i.
    this.assertLocalPathSafe(entry.localPath);
    const localUri = vscode.Uri.file(entry.localPath);
    const localContent = await this.readLocal(localUri);
    const localHash = hashContent(localContent);

    if (!options?.ignoreSourceProblems) {
      const layout = await this.sourceLayoutFor(entry);
      const problems = layout ? sourceProblems(localContent, layout) : [];
      if (layout && problems.length > 0) {
        this.logSourceProblems(entry, layout, problems);
        return "source-problems";
      }
    }

    if (!options?.overwriteRemoteChanges) {
      const remoteContent = await this.downloadForEntry(entry);
      await this.upgradeBaseline(entry, [remoteContent, localContent]);
      const remoteHash = hashContent(remoteContent);
      await this.adoptNextBaseline(entry, localHash, remoteHash, remoteContent);
      await this.baselines.ensure(entry.remoteHashAtCheckout, [remoteContent, localContent]);
      if (remoteHash !== entry.remoteHashAtCheckout) {
        this.log.appendLine(
          `[upload] ${formatMemberPath(entry)} changed on the remote since checkout — not uploaded`
        );
        entry.status = classifyStatus(localHash, remoteHash, entry.remoteHashAtCheckout);
        entry.lastCheckedAt = new Date().toISOString();
        await this.persist();
        return "remote-changed";
      }
    }

    const uploadContent = normalizeForMemberUpload(localContent);
    // Checked again: the connection may have changed during the remote check.
    this.assertConnectedTo(entry.system);
    // A write the IBM i never answers would otherwise hold the upload (and upload on save) until a disconnect.
    const what = `uploading ${formatMemberPath(entry)}`;
    const deadline = {
      ms: DOWNLOAD_TIMEOUT_MS,
      what,
      slowMs: SLOW_WAIT_MS,
      onSlow: () => this.log.appendLine(
        `[ibmi] Still waiting for the IBM i after ${describeDuration(SLOW_WAIT_MS)} while ${what}; giving up after ${describeDuration(DOWNLOAD_TIMEOUT_MS)}.`
      ),
    };
    if (sourceDatesEnabled()) {
      await withDeadline(uploadMemberContentWithDates(entry, uploadContent), deadline);
      this.log.appendLine(`[upload] ${formatMemberPath(entry)} uploaded with source dates`);
    } else {
      const success = await withDeadline(
        uploadMemberContent(entry.library, entry.sourceFile, entry.memberName, uploadContent),
        deadline
      );
      if (!success) {
        return "failed";
      }
      this.log.appendLine(
        `[upload] ${formatMemberPath(entry)} uploaded without source dates (disabled in Code for IBM i)`
      );
    }

    let after = statusAfterUpload(localHash, localHash);
    let storedContent: string | undefined;
    try {
      storedContent = await this.download(entry.library, entry.sourceFile, entry.memberName);
      after = statusAfterUpload(localHash, hashContent(storedContent));
    } catch (err) {
      this.log.appendLine(
        `[upload] Could not re-read ${formatMemberPath(entry)} after upload; assuming it matches the local copy: ${errorMessage(err)}`
      );
    }
    if (after.altered) {
      this.log.appendLine(
        `[upload] ${formatMemberPath(entry)} on the IBM i differs from the uploaded local copy ` +
        `(e.g. lines longer than the record length were truncated)`
      );
    }

    // Without a read-back the baseline is the local text, which was sent as it is.
    await this.setBaseline(entry, after.baseline, storedContent ?? localContent);
    // The upload changed the member's stamp; the next refresh compares it in full.
    delete entry.remoteSeen;
    entry.lastCheckedAt = new Date().toISOString();
    entry.status = after.status;
    await this.persist();

    if (options?.deferCheckpointTo) {
      options.deferCheckpointTo.push(entry.localPath);
    } else {
      const result = await this.saveCheckpoint(entry.system,
        [entry.localPath],
        `upload: ${formatMemberPath(entry)} to ${entry.system}`
      );
      this.logGitFailure(result);
    }

    return after.altered ? "uploaded-altered" : "uploaded";
  }

  async refreshSourceFileRemoteStatus(
    system: string,
    library: string,
    sourceFile: string,
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const entries = this.getEntriesForSystem(system).filter(
      (e) =>
        e.library.toUpperCase() === library.toUpperCase() &&
        e.sourceFile.toUpperCase() === sourceFile.toUpperCase()
    );
    return this.refreshEntries(entries, progress, token, { quick: true });
  }

  async refreshAllRemoteStatus(
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const system = getSystemName();
    if (!system) {
      return emptyTally();
    }

    return this.refreshEntries(this.getEntriesForSystem(system), progress, token, { quick: true });
  }

  /**
   * Refreshes each entry's status. `quick` first asks the catalog which members changed on the IBM i
   * since their last full comparison and downloads only those; the rest only have their local copy read.
   */
  async refreshEntries(
    entries: CheckedOutMember[],
    progress?: RefreshProgress,
    token?: vscode.CancellationToken,
    { quick = false }: { quick?: boolean } = {}
  ): Promise<RefreshTally> {
    const tally = emptyTally();

    await this.runBatch(async () => {
      const plan: RefreshPlan<CheckedOutMember> = quick
        ? await this.planQuickRefresh(entries)
        : { download: entries.map((entry) => ({ entry })), unchanged: [], missing: [] };
      if (quick) {
        this.log.appendLine(
          `[refresh] ${plan.unchanged.length} of ${entries.length} member(s) unchanged on the IBM i since they were last compared`
        );
      }
      const steps: Array<{ entry: CheckedOutMember; run: () => Promise<RemoteStatus> }> = [
        ...plan.unchanged.map(({ entry, hash }) => ({ entry, run: () => this.refreshFromSeen(entry, hash) })),
        ...plan.missing.map(({ entry }) => ({ entry, run: () => this.markRemoteMissing(entry) })),
        ...plan.download.map(({ entry, stamp }) => ({ entry, run: () => this.refreshRemoteStatus(entry, stamp) })),
      ];
      // A few members at once, as batch checkouts download them; Cancel lets those under way finish.
      const controller = new AbortController();
      const cancel = token?.onCancellationRequested(() => controller.abort());
      try {
        const result = await runRefreshSteps(
          steps.map(({ entry, run }) => ({ label: entry.memberName, detail: formatMemberPath(entry), run })),
          {
            concurrency: DOWNLOAD_CONCURRENCY,
            signal: controller.signal,
            onProgress: (message, increment) => progress?.report({ message, increment }),
            onError: (step, err) => this.log.appendLine(`[refresh] Error for ${step.detail}: ${errorMessage(err)}`),
          }
        );
        Object.assign(tally, result);
      } finally {
        cancel?.dispose();
      }
    });

    return tally;
  }

  async discardCheckout(entry: CheckedOutMember): Promise<void> {
    const detail = (await this.hasLocalChanges(entry))
      ? "This member has local changes that have not been sent to the IBM i. They will be lost."
      : "Make sure you've already merged any changes back to the IBM i.";
    const choice = await vscode.window.showWarningMessage(
      `Delete ${formatMemberPath(entry)} and remove from checkouts?`,
      { detail, modal: true },
      "Delete"
    );

    if (choice !== "Delete") {
      return;
    }

    await this.discardEntries([entry]);
  }

  discardEntries(entries: CheckedOutMember[]): Promise<void> {
    return this.track(() => this.discardEntriesNow(entries));
  }

  private async discardEntriesNow(entries: CheckedOutMember[]): Promise<void> {
    for (const entry of entries) {
      await this.assertEntryInActiveWorkItem(entry);
      this.assertLocalPathSafe(entry.localPath);
    }
    for (const entry of entries) {
      try {
        // Windows can't delete a read-only file.
        await this.setReadOnly(entry.localPath, false);
        await vscode.workspace.fs.delete(vscode.Uri.file(entry.localPath));
      } catch {
        // file may already be gone
      }
    }

    const system = entries[0]?.system;
    const result = system ? await this.saveCheckpoint(system,
      entries.map((entry) => entry.localPath),
      entries.length === 1
        ? `discard: ${formatMemberPath(entries[0])}`
        : `discard: ${entries.length} checked-out members`
    ) : { status: "noChanges" as const };
    this.logGitFailure(result);

    await this.forgetEntries(entries);
  }

  /**
   * The line length and CCSID of the checkout's source file: the stored ones, or else read from the
   * IBM i (and stored) while connected to its system. Undefined when they can't be known.
   */
  async sourceLayoutFor(entry: CheckedOutMember): Promise<SourceLayout | undefined> {
    const stored = this.findEntryById(entry.id) ?? entry;
    if (!stored.sourceLayout && await this.fillSourceLayout(stored)) {
      await this.persist();
    }
    return stored.sourceLayout;
  }

  /** What in the checkout's local file its source member can't hold; undefined when its layout isn't known. */
  async sourceProblemsOf(
    entry: CheckedOutMember
  ): Promise<{ layout: SourceLayout; problems: SourceProblem[] } | undefined> {
    const layout = await this.sourceLayoutFor(entry);
    if (!layout) {
      return undefined;
    }
    this.assertLocalPathSafe(entry.localPath);
    return { layout, problems: sourceProblems(await this.readLocal(vscode.Uri.file(entry.localPath)), layout) };
  }

  /** Forgets the source file layouts read so far; a reconnect may reach a changed file or another system. */
  clearSourceLayouts(): void {
    this.sourceLayouts.clear();
  }

  /**
   * Reads the layout while connected to the checkout's system: only a missing one, or also a stored
   * one with `replace`. True when one was found; a failed read keeps the stored one. The caller persists.
   */
  private async fillSourceLayout(entry: CheckedOutMember, { replace = false } = {}): Promise<boolean> {
    const system = getSystemName();
    if ((entry.sourceLayout && !replace) || !system || systemKey(system) !== systemKey(entry.system)) {
      return false;
    }
    const layout = await this.lookupSourceLayout(entry.system, entry.library, entry.sourceFile);
    if (layout) {
      entry.sourceLayout = layout;
    }
    return layout !== undefined;
  }

  /**
   * Downloads a member, giving up after {@link DOWNLOAD_TIMEOUT_MS} or when `signal` aborts (as a
   * cancelled checkout). Code for IBM i's request may still finish later; its result is ignored.
   */
  private download(library: string, sourceFile: string, member: string, signal?: AbortSignal): Promise<string> {
    const what = `downloading ${library}/${sourceFile}(${member})`;
    const started = Date.now();
    return withDeadline(downloadMemberContent(library, sourceFile, member), {
      ms: DOWNLOAD_TIMEOUT_MS,
      what,
      signal,
      cancelled: () => new CheckoutCancelledError(),
      slowMs: SLOW_WAIT_MS,
      onSlow: () => this.log.appendLine(
        `[ibmi] Still waiting for the IBM i after ${describeDuration(SLOW_WAIT_MS)} while ${what}; ` +
        `giving up after ${describeDuration(DOWNLOAD_TIMEOUT_MS)}.`
      ),
    }).then((content) => {
      const elapsed = Date.now() - started;
      if (elapsed >= SLOW_WAIT_MS) {
        this.log.appendLine(`[ibmi] Finished ${what} after ${Math.round(elapsed / 1000)} seconds.`);
      }
      return content;
    });
  }

  /** The layout of a source file of the connected `system`, read once per connection. A failed read isn't kept. */
  private lookupSourceLayout(system: string, library: string, sourceFile: string): Promise<SourceLayout | undefined> {
    const key = `${systemKey(system)}/${library.toUpperCase()}/${sourceFile.toUpperCase()}`;
    let layout = this.sourceLayouts.get(key);
    if (!layout) {
      layout = withDeadline(sourceFileLayout(library, sourceFile), {
        ms: LAYOUT_TIMEOUT_MS,
        what: `reading the line length and CCSID of ${library}/${sourceFile}`,
      }).catch((err) => {
        this.sourceLayouts.delete(key);
        this.log.appendLine(
          `[check] Could not read the line length and CCSID of ${library}/${sourceFile}; its members aren't checked before upload: ${errorMessage(err)}`
        );
        return undefined;
      });
      this.sourceLayouts.set(key, layout);
    }
    return layout;
  }

  private logSourceProblems(entry: CheckedOutMember, layout: SourceLayout, problems: SourceProblem[]): void {
    this.log.appendLine(`[upload] ${formatMemberPath(entry)} not uploaded: ${summarizeProblems(problems, layout)}`);
    for (const problem of problems.slice(0, LOGGED_PROBLEMS)) {
      this.log.appendLine(`  line ${problem.line + 1}: ${describeProblem(problem, layout)}`);
    }
    if (problems.length > LOGGED_PROBLEMS) {
      this.log.appendLine(`  and ${problems.length - LOGGED_PROBLEMS} more; see the Problems view`);
    }
  }

  /**
   * Whether the checkout has edits that would be lost by overwriting or deleting
   * its local file: unsaved edits in an open editor, or a file that differs from the baseline.
   */
  async hasLocalChanges(entry: CheckedOutMember): Promise<boolean> {
    return this.hasUnsavedEdits(entry) || (await this.localFileDiffersFromBaseline(entry));
  }

  private hasUnsavedEdits(entry: CheckedOutMember): boolean {
    const target = vscode.Uri.file(entry.localPath).fsPath;
    return vscode.workspace.textDocuments.some(
      (doc) => doc.isDirty && doc.uri.scheme === "file" && doc.uri.fsPath === target
    );
  }

  /** Whether the file on disk differs from the baseline. A missing local file has nothing to lose. */
  private async localFileDiffersFromBaseline(entry: CheckedOutMember): Promise<boolean> {
    const localUri = vscode.Uri.file(entry.localPath);
    try {
      const localContent = await this.readLocal(localUri);
      await this.upgradeBaseline(entry, [localContent]);
      return hashContent(localContent) !== entry.remoteHashAtCheckout;
    } catch (err) {
      if (err instanceof LocalFileMissingError) {
        return false;
      }
      throw err;
    }
  }

  findEntryById(id: string): CheckedOutMember | undefined {
    return this.entries.find((e) => e.id === id);
  }

  findEntryByLocalPath(localPath: string): CheckedOutMember | undefined {
    const target = vscode.Uri.file(localPath).fsPath;
    // Stored paths are already fsPaths, so an exact match needs no Uri per entry. This runs on every
    // save and every file event in the checkout folder.
    const entries = this.entries;
    return entries.find((e) => e.localPath === target) ??
      entries.find((e) => vscode.Uri.file(e.localPath).fsPath === target);
  }

  /**
   * Sets upload on save for one checkout; undefined follows the setting again. Only the stored
   * checkout is changed, never one passed in from elsewhere.
   */
  async setUploadOnSave(id: string, mode: CheckedOutMember["uploadOnSave"]): Promise<void> {
    const entry = this.findEntryById(id);
    if (!entry) {
      throw new Error("That member is no longer checked out.");
    }
    assertEditable(entry);
    if (mode) {
      entry.uploadOnSave = mode;
    } else {
      delete entry.uploadOnSave;
    }
    await this.persist();
  }

  /** Updates a checkout's status after its local file is written, without contacting the IBM i. */
  async updateStatusFromLocalFile(entry: CheckedOutMember): Promise<void> {
    const hashVersion = entry.hashVersion;
    const status = statusAfterLocalSave(entry.status, await this.localFileDiffersFromBaseline(entry));
    if (status !== entry.status || hashVersion !== entry.hashVersion) {
      entry.status = status;
      await this.persist();
    }
  }

  /** Removes checkouts from their system's active work item without touching their local files. */
  async forgetEntries(entries: CheckedOutMember[]): Promise<void> {
    const ids = new Set(entries.map((e) => e.id));
    for (const system of new Set(entries.map((e) => e.system))) {
      const state = this.ensureSystemState(system);
      state.workItems[state.activeWorkItem] = (state.workItems[state.activeWorkItem] ?? [])
        .filter((entry) => !ids.has(entry.id));
    }
    await this.persist();
    await this.pruneBaselines();
  }

  /** Drops the baseline texts no checkout refers to any more. */
  private async pruneBaselines(): Promise<void> {
    const deleted = await this.baselines.prune(referencedBaselineHashes(this.index));
    if (deleted > 0) {
      this.log.appendLine(`[baseline] Removed ${deleted} baseline text(s) no checkout uses`);
    }
  }

  /**
   * Makes a local file read-only (reference copies) or writable again before it is rewritten or
   * deleted. chmod sets the read-only attribute on Windows. A missing file is ignored.
   */
  private async setReadOnly(localPath: string, readOnly: boolean): Promise<void> {
    try {
      // chmod follows links; a linked path was refused before it was written, so leave it alone.
      this.assertLocalPathSafe(localPath);
      if (!readOnly) {
        try {
          // Leave the permissions of an already writable file (every ordinary checkout) alone.
          await fs.promises.access(localPath, fs.constants.W_OK);
          return;
        } catch {
          // Missing or read-only: fall through.
        }
      }
      await fs.promises.chmod(localPath, readOnly ? 0o444 : 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.appendLine(`[reference] Could not make ${localPath} ${readOnly ? "read-only" : "writable"}: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Records a baseline computed with the current {@link hashContent}, keeping its text for Merge
   * Back when given (the text must hash to it).
   */
  private async setBaseline(entry: CheckedOutMember, hash: string, content?: string): Promise<void> {
    entry.remoteHashAtCheckout = hash;
    entry.hashVersion = HASH_VERSION;
    if (content !== undefined) {
      await this.baselines.write(hash, content);
    }
  }

  /** Adopts the shared content (`sharedText`, hashing to `remoteHash`) as the new baseline when local and remote match. */
  private async adoptNextBaseline(entry: CheckedOutMember, localHash: string, remoteHash: string, sharedText: string): Promise<void> {
    const next = nextBaseline(localHash, remoteHash, entry.remoteHashAtCheckout);
    if (next !== entry.remoteHashAtCheckout) {
      await this.setBaseline(entry, next, sharedText);
    }
  }

  /**
   * Converts a baseline stored before 1.2.2 (whose hash depended on the
   * `files.trimTrailingWhitespace` setting and kept a BOM) to the current hash,
   * using whichever of `texts` is unchanged since checkout. When none is, both
   * sides changed and the legacy baseline correctly yields "conflict" until a
   * Merge Back or matching content replaces it.
   */
  private async upgradeBaseline(entry: CheckedOutMember, texts: readonly string[]): Promise<void> {
    if (entry.hashVersion === HASH_VERSION) {
      return;
    }
    const migrated = migrateLegacyBaseline(entry.remoteHashAtCheckout, texts);
    if (migrated !== undefined) {
      await this.setBaseline(entry, migrated, texts.find((text) => hashContent(text) === migrated));
      this.log.appendLine(`[status] Upgraded the sync baseline of ${formatMemberPath(entry)}`);
    }
  }

  /**
   * Refuses to reach the IBM i for a checkout of `system` while connected to another one: a
   * connection switched during a batch must not send members to, or read them from, the wrong system.
   */
  private assertConnectedTo(system: string): void {
    const connected = getSystemName();
    if (!connected) {
      throw new Error("Not connected to IBM i");
    }
    if (systemKey(connected) !== systemKey(system)) {
      throw new Error(`Connected to ${connected}, not ${system}. Connect to ${system} first.`);
    }
  }

  /** Refuses a checkout path that leaves the checkout folder or passes through a link inside it. */
  assertLocalPathSafe(localPath: string): void {
    const root = this.getCheckoutRoot();
    if (!root) {
      throw new Error("Choose a checkout folder first.");
    }
    assertNoLinkBelow(root.fsPath, localPath);
  }

  private async readLocal(localUri: vscode.Uri): Promise<string> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(localUri)).toString("utf-8");
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") {
        throw new LocalFileMissingError(localUri.fsPath);
      }
      throw err;
    }
  }

  private async getLocalPath(
    checkoutRoot: vscode.Uri,
    entry: CheckedOutMember
  ): Promise<string> {
    const { systemRoot, directory, localPath } = checkoutFilePath(checkoutRoot.fsPath, entry);
    // path.join resolves "..", so this also catches any name the validation above let through.
    if (!pathIsInside(systemRoot, localPath)) {
      throw new Error(`The checkout path for ${formatMemberPath(entry)} is outside the checkout folder.`);
    }
    this.assertLocalPathSafe(localPath);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));

    return localPath;
  }

  private ensureSystemState(system: string): SystemCheckoutState {
    const key = systemKey(system);
    let state = this.index.systems[key];
    if (!state) {
      const inherited = this.index.unassignedWorkItems;
      const names = Object.keys(inherited);
      const activeWorkItem = names.includes(DEFAULT_WORK_ITEM)
        ? DEFAULT_WORK_ITEM
        : names[0] ?? DEFAULT_WORK_ITEM;
      state = {
        system,
        directory: sanitizeSystemName(system),
        activeWorkItem,
        workItems: names.length > 0
          ? Object.fromEntries(names.map((name) => [name, []]))
          : { [DEFAULT_WORK_ITEM]: [] },
      };
      this.index.systems[key] = state;
    }
    for (const workItem of Object.keys(this.index.unassignedWorkItems)) {
      state.workItems[workItem] ??= [];
    }
    this.index.unassignedWorkItems = {};
    return state;
  }

  /** Redraws the checkout views, e.g. after a checked-out file was deleted outside VS Code. */
  notifyLocalFileChanged(): void {
    this._onDidChange.fire();
  }

  /** Notifies listeners and saves the index; during a batch the save waits for its end. */
  private persist(): Promise<void> {
    return this.store.persist();
  }
}

/** Asks for the Git author's name and email for local checkpoints; undefined when either is not given. */
async function askGitIdentity(): Promise<{ name: string; email: string } | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Set Up Local Change History",
    prompt: "Your name for local checkpoints (saved only in this checkout folder)",
    placeHolder: "Jane Developer",
    validateInput: (value) => value.trim() ? undefined : "Enter a name",
    ignoreFocusOut: true,
  });
  if (!name) {
    return undefined;
  }
  const email = await vscode.window.showInputBox({
    title: "Set Up Local Change History",
    prompt: "Your email for local checkpoints (saved only in this checkout folder)",
    placeHolder: "jane@example.com",
    validateInput: (value) => /^\S+@\S+\.\S+$/.test(value.trim())
      ? undefined
      : "Enter a valid email address",
    ignoreFocusOut: true,
  });
  return email ? { name, email } : undefined;
}

/** Refuses actions that would send a read-only reference copy to the IBM i. */
export function assertEditable(entry: CheckedOutMember): void {
  if (isReferenceCopy(entry)) {
    throw new ReferenceCopyError(formatMemberPath(entry));
  }
}

/** The baseline texts' files in the workspace's extension storage. */
function workspaceBaselineFiles(folder: vscode.Uri): BaselineFiles {
  const dir = vscode.Uri.joinPath(folder, BASELINE_DIR);
  const file = (name: string) => vscode.Uri.joinPath(dir, name);
  return {
    exists: async (name) => {
      try {
        await vscode.workspace.fs.stat(file(name));
        return true;
      } catch {
        return false;
      }
    },
    read: async (name) => vscode.workspace.fs.readFile(file(name)),
    write: async (name, data) => {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(file(name), data);
    },
    rename: async (from, to) => vscode.workspace.fs.rename(file(from), file(to), { overwrite: true }),
    delete: async (name) => vscode.workspace.fs.delete(file(name), { useTrash: false }),
    list: async () => {
      try {
        return (await vscode.workspace.fs.readDirectory(dir))
          .filter(([, type]) => type === vscode.FileType.File)
          .map(([name]) => name);
      } catch {
        return [];
      }
    },
  };
}

/** The checkout index's files in the workspace's extension storage. */
function workspaceIndexStorage(folder: vscode.Uri): IndexStorage {
  const file = (name: string) => vscode.Uri.joinPath(folder, name);
  return {
    read: async (name) => vscode.workspace.fs.readFile(file(name)),
    write: async (name, data) => vscode.workspace.fs.writeFile(file(name), data),
    rename: async (from, to) => vscode.workspace.fs.rename(file(from), file(to), { overwrite: true }),
    location: (name) => file(name).fsPath,
  };
}
