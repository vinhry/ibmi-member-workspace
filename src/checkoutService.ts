import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CheckedOutMember,
  CheckoutIndex,
  DEFAULT_WORK_ITEM,
  SystemCheckoutState,
  RefreshTally,
  WorkItemCarry,
  buildCheckoutId,
  buildLocalFileName,
  emptyTally,
  formatMemberPath,
  isDefaultWorkItem,
  moveEntriesState,
  parseCheckoutIndex,
  sanitizeSystemName,
  startWorkItemState,
  systemKey,
} from "./types";
import {
  downloadMemberContent,
  uploadMemberContent,
  getSystemName,
} from "./codeForIBMi";
import { CheckoutCancelledError, LocalFileMissingError, errorMessage } from "./errors";
import {
  RemoteStatus,
  classifyStatus,
  hashContent,
  nextBaseline,
  statusAfterLocalSave,
  statusAfterUpload,
} from "./sync";
import {
  GitOperationResult,
  GitService,
  LegacyMigrationResult,
  RepositoryInspection,
} from "./gitService";

/** "uploaded-altered": uploaded, but the IBM i stored content that differs from the local copy. */
export type UploadResult = "uploaded" | "uploaded-altered" | "failed" | "remote-changed";

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
}

export class CheckoutService implements vscode.Disposable {
  private index: CheckoutIndex = {
    version: 3,
    systems: {},
    unassignedWorkItems: {},
  };
  private readonly storageUri: vscode.Uri | undefined;
  private readonly indexUri: vscode.Uri | undefined;
  private readonly indexTempUri: vscode.Uri | undefined;

  private batchDepth = 0;
  private dirty = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private gitWarningShown = false;
  private readonly gitSetupDeclinedSystems = new Set<string>();
  private gitOperationWarningShown = false;
  private readonly gitPreparations = new Map<string, Promise<GitOperationResult>>();
  /** Successful repository preparation, reused until the running batch ends. */
  private readonly batchGitReady = new Map<string, GitOperationResult>();
  /** Lifecycle operations in progress; work items must not change underneath them. */
  private inFlight = 0;
  /** Work item the user confirmed for checkouts this session, per system. */
  private readonly confirmedWorkItems = new Map<string, string>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
    private readonly gitService?: GitService
  ) {
    this.storageUri = context.storageUri;
    this.indexUri = this.storageUri
      ? vscode.Uri.joinPath(this.storageUri, "checkout-index.json")
      : undefined;
    this.indexTempUri = this.storageUri
      ? vscode.Uri.joinPath(this.storageUri, "checkout-index.json.tmp")
      : undefined;
  }

  async initialize(): Promise<void> {
    if (!this.storageUri) {
      this.index = this.emptyIndex();
      return;
    }
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await this.loadIndex();
    const system = getSystemName();
    if (system && Object.keys(this.index.unassignedWorkItems).length > 0) {
      this.ensureSystemState(system);
      await this.saveIndex();
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * Returns true when git integration is enabled in settings AND git is available.
   * Shows a one-time warning notification if the setting is on but git is not found.
   */
  async isGitEnabled(): Promise<boolean> {
    const enabled = vscode.workspace
      .getConfiguration("ibmi-member-workspace")
      .get<boolean>("gitIntegration", false);
    if (!enabled) {
      return false;
    }
    const available = await this.gitService?.checkGitAvailable();
    if (!available) {
      if (!this.gitWarningShown) {
        this.gitWarningShown = true;
        vscode.window.showWarningMessage(
          "Local Change History is enabled, but Git was not found on PATH. Install Git, then run Set Up Local Change History again."
        );
      }
      return false;
    }
    return true;
  }

  private get entries(): CheckedOutMember[] {
    const system = getSystemName();
    if (!system) {
      return [];
    }
    const state = this.ensureSystemState(system);
    return state.workItems[state.activeWorkItem] ??= [];
  }

  getActiveWorkItem(system = getSystemName()): string {
    return system ? this.ensureSystemState(system).activeWorkItem : DEFAULT_WORK_ITEM;
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

  /** Records that the user chose the active work item for checkouts in this session. */
  confirmWorkItem(system: string): void {
    this.confirmedWorkItems.set(systemKey(system), this.ensureSystemState(system).activeWorkItem);
  }

  /**
   * Whether a checkout must first ask which work item it belongs to: always on the default
   * work item or a detached HEAD, otherwise once per session.
   */
  async needsWorkItemChoice(system: string): Promise<boolean> {
    const root = this.getGitRoot(system);
    if (!root || !this.gitService) {
      return false;
    }
    const active = this.ensureSystemState(system).activeWorkItem;
    const branch = await this.gitService.currentBranch(root.fsPath);
    return !branch ||
      isDefaultWorkItem(active) ||
      this.confirmedWorkItems.get(systemKey(system)) !== active;
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

  async inspectRepository(folder: string): Promise<RepositoryInspection | undefined> {
    return this.gitService?.inspectRepository(folder);
  }

  async detectMisplacedParentRepository(): Promise<RepositoryInspection | undefined> {
    const root = this.getCheckoutRoot();
    return root && this.gitService
      ? this.gitService.detectMisplacedParentRepository(root.fsPath)
      : undefined;
  }

  async migrateLegacyRepository(): Promise<LegacyMigrationResult> {
    const checkoutRoot = this.getCheckoutRoot();
    if (!checkoutRoot || !this.gitService) {
      return { status: "setupRequired", message: "Choose a checkout folder first." };
    }
    const connected = getSystemName();
    if (connected) {
      this.ensureSystemState(connected);
    }
    const systems = this.getKnownSystems();
    const result = await this.gitService.migrateLegacyRepository(
      checkoutRoot.fsPath,
      systems.map((state) => ({
        system: state.system,
        folder: this.getGitRoot(state.system)!.fsPath,
        workItems: Object.keys(state.workItems),
      }))
    );
    if (result.status !== "success") {
      return result;
    }

    for (const [system, workItems] of Object.entries(result.restoredBranches ?? {})) {
      const restoredState = this.index.systems[systemKey(system)];
      if (restoredState) {
        for (const workItem of workItems) {
          restoredState.workItems[workItem] ??= [];
        }
      }
    }

    if (!connected) {
      await this.persist();
      return result;
    }

    const state = this.ensureSystemState(connected);
    const gitRoot = this.getGitRoot(connected)!;
    const changed = await this.gitService.changedPaths(gitRoot.fsPath);
    const managed = new Set(this.getManagedPaths(connected).map((value) => path.resolve(value)));
    const unrelated = changed.filter((value) => !managed.has(path.resolve(value)));
    if (unrelated.length === 0) {
      const branch = await this.gitService.currentBranch(gitRoot.fsPath);
      if (branch !== state.activeWorkItem && (await this.gitService.listBranches(gitRoot.fsPath)).includes(state.activeWorkItem)) {
        const switched = await this.gitService.switchWorkItem(gitRoot.fsPath, state.activeWorkItem, true);
        if (switched.status !== "success") {
          return switched;
        }
      }
      if (changed.length > 0) {
        const checkpoint = await this.gitService.saveCheckpoint(
          gitRoot.fsPath,
          changed.filter((value) => managed.has(path.resolve(value))),
          `checkpoint: recovered ${state.activeWorkItem}`,
          false
        );
        if (checkpoint.status !== "success" && checkpoint.status !== "noChanges") {
          return checkpoint;
        }
      }
    }
    await this.persist();
    return result;
  }

  async archiveMisplacedRepository(): Promise<{ gitBackup: string; gitignoreBackup?: string }> {
    const root = this.getCheckoutRoot();
    if (!root || !this.gitService) {
      throw new Error("Choose a checkout folder first.");
    }
    const inspection = await this.gitService.detectMisplacedParentRepository(root.fsPath);
    const directories = this.getKnownSystems().map((state) => state.directory);
    if (!inspection || !this.gitService.isSafeMisplacedRepository(inspection, directories)) {
      throw new Error("The parent repository changed after repair and was not archived.");
    }
    return this.gitService.archiveMisplacedRepository(root.fsPath);
  }

  getGitRoot(system: string): vscode.Uri | undefined {
    const checkoutRoot = this.getCheckoutRoot();
    return checkoutRoot
      ? vscode.Uri.joinPath(checkoutRoot, sanitizeSystemName(system))
      : undefined;
  }

  getGitRootForEntry(entry: CheckedOutMember): vscode.Uri {
    const root = this.getGitRoot(entry.system);
    if (!root || !this.pathIsInside(root.fsPath, entry.localPath)) {
      throw new Error(`The checkout path for ${formatMemberPath(entry)} is outside its system repository.`);
    }
    return root;
  }

  async ensureGitReady(system = getSystemName()): Promise<GitOperationResult> {
    if (!system) {
      return { status: "setupRequired", message: "Connect to an IBM i system first." };
    }
    const key = systemKey(system);
    if (!this.index.systems[key]) {
      this.ensureSystemState(system);
      await this.persist();
    } else {
      this.ensureSystemState(system);
    }
    const prepared = this.batchGitReady.get(key);
    if (prepared) {
      return prepared;
    }
    const existing = this.gitPreparations.get(key);
    if (existing) {
      return existing;
    }
    const preparation = this.prepareGitRepository(system);
    this.gitPreparations.set(key, preparation);
    try {
      const result = await preparation;
      if (this.batchDepth > 0 && result.status === "success") {
        this.batchGitReady.set(key, result);
      }
      return result;
    } finally {
      if (this.gitPreparations.get(key) === preparation) {
        this.gitPreparations.delete(key);
      }
    }
  }

  private async prepareGitRepository(system: string): Promise<GitOperationResult> {
    const enabled = vscode.workspace
      .getConfiguration("ibmi-member-workspace")
      .get<boolean>("gitIntegration", false);
    if (!enabled || !this.gitService) {
      return {
        status: "setupRequired",
        message: "Enable Local Change History before saving checkpoints.",
      };
    }
    if (!(await this.gitService.checkGitAvailable())) {
      if (!this.gitWarningShown) {
        this.gitWarningShown = true;
        vscode.window.showWarningMessage(
          "Local Change History is enabled, but Git was not found on PATH. Install Git, then run Set Up Local Change History again."
        );
      }
      return {
        status: "setupRequired",
        message: "Install Git, then run Set Up Local Change History again.",
      };
    }
    const root = this.getGitRoot(system);
    if (!root) {
      return { status: "setupRequired", message: "Choose a checkout folder first." };
    }

    let result = await this.gitService.prepareRepository(root.fsPath);
    if (result.status !== "setupRequired" || this.gitSetupDeclinedSystems.has(systemKey(system))) {
      if (result.status === "success") {
        await this.synchronizeWorkItem(system);
      }
      return result;
    }

    // Git is available at this point, so setupRequired means author identity is missing.
    const name = await vscode.window.showInputBox({
      title: "Set Up Local Change History",
      prompt: "Your name for local checkpoints (saved only in this checkout folder)",
      placeHolder: "Jane Developer",
      validateInput: (value) => value.trim() ? undefined : "Enter a name",
      ignoreFocusOut: true,
    });
    if (!name) {
      this.gitSetupDeclinedSystems.add(systemKey(system));
      return { status: "setupRequired", message: "Git author setup was cancelled." };
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
    if (!email) {
      this.gitSetupDeclinedSystems.add(systemKey(system));
      return { status: "setupRequired", message: "Git author setup was cancelled." };
    }
    result = await this.gitService.configureLocalIdentity(root.fsPath, name.trim(), email.trim());
    if (result.status === "success") {
      result = await this.gitService.prepareRepository(root.fsPath);
      if (result.status === "success") {
        await this.synchronizeWorkItem(system);
      }
    }
    return result;
  }

  resetGitSetupState(): void {
    this.gitWarningShown = false;
    this.gitSetupDeclinedSystems.clear();
    this.gitOperationWarningShown = false;
    this.gitService?.invalidateAvailability();
  }

  async synchronizeWorkItem(system = getSystemName()): Promise<void> {
    if (!system) {
      return;
    }
    const root = this.getGitRoot(system);
    if (!root || !this.gitService) {
      return;
    }
    const state = this.ensureSystemState(system);
    const branch = await this.gitService.currentBranch(root.fsPath);
    if (!branch || branch === state.activeWorkItem) {
      return;
    }
    if (
      isDefaultWorkItem(state.activeWorkItem) &&
      !state.workItems[branch] &&
      Object.keys(state.workItems).length === 1
    ) {
      state.workItems[branch] = state.workItems[DEFAULT_WORK_ITEM];
      delete state.workItems[DEFAULT_WORK_ITEM];
    } else if (!state.workItems[branch]) {
      state.workItems[branch] = [];
    }
    state.activeWorkItem = branch;
    state.workItems[branch] = state.workItems[branch].filter((entry) =>
      fs.existsSync(entry.localPath)
    );
    await this.persist();
  }

  /** Makes an existing work item active after its branch was checked out. */
  async activateWorkItem(system: string, name: string): Promise<void> {
    const state = this.ensureSystemState(system);
    state.activeWorkItem = name;
    state.workItems[name] = (state.workItems[name] ?? []).filter((entry) =>
      fs.existsSync(entry.localPath)
    );
    await this.persist();
  }

  /** Makes a work item whose branch was just created (or renamed, for "move") active. */
  async startWorkItem(system: string, name: string, carry: WorkItemCarry): Promise<void> {
    const state = this.ensureSystemState(system);
    startWorkItemState(state, name, carry);
    state.workItems[name] = state.workItems[name].filter((entry) =>
      fs.existsSync(entry.localPath)
    );
    await this.persist();
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
    return this.track(() => this.moveEntriesNow(system, entries, target, options.create));
  }

  private async moveEntriesNow(
    system: string,
    entries: CheckedOutMember[],
    target: string,
    create: boolean
  ): Promise<GitOperationResult> {
    const ready = await this.ensureGitReady(system);
    const root = this.getGitRoot(system);
    if (ready.status !== "success" || !this.gitService || !root) {
      return ready.status === "success" ? { status: "setupRequired", message: "Choose a checkout folder first." } : ready;
    }
    const git = this.gitService;
    const folder = root.fsPath;
    const state = this.ensureSystemState(system);
    const source = state.activeWorkItem;
    if (target === source || entries.length === 0) {
      return { status: "noChanges", message: "Nothing to move." };
    }
    for (const entry of entries) {
      await this.assertEntryInActiveWorkItem(entry);
    }
    const paths = entries.map((entry) => entry.localPath);
    if (paths.some((candidate) => !this.pathIsInside(folder, candidate))) {
      return { status: "failure", message: "A checkout path belongs to another system repository." };
    }
    const clean = await git.getWorkingTreeState(folder);
    if (clean.status !== "success") {
      return clean;
    }

    const contents = new Map<string, Uint8Array>();
    for (const entry of entries) {
      try {
        contents.set(entry.id, await vscode.workspace.fs.readFile(vscode.Uri.file(entry.localPath)));
      } catch (err) {
        return { status: "failure", message: `Could not read ${formatMemberPath(entry)}.`, details: errorMessage(err) };
      }
    }

    const ids = new Set(entries.map((entry) => entry.id));
    const exists = (await git.listBranches(folder)).includes(target);
    if (create && exists) {
      return { status: "conflict", message: `A work item named “${target}” already exists.` };
    }
    if (!create && !exists) {
      return { status: "failure", message: `Work item “${target}” no longer exists.` };
    }
    if (create) {
      const created = await git.createBranch(folder, target, (await git.findCleanBase(folder)) ?? "HEAD");
      if (created.status !== "success") {
        return created;
      }
      state.workItems[target] = [];
    } else if (
      (state.workItems[target] ?? []).some((entry) => ids.has(entry.id)) ||
      (await git.trackedInBranch(folder, target, paths)).length > 0
    ) {
      return {
        status: "conflict",
        message: `“${target}” already has ${entries.length === 1 ? "this member" : "some of these members"}. Discard ${entries.length === 1 ? "it" : "them"} there first.`,
      };
    }
    // Only a work item created from HEAD (no clean base) already has these files.
    const presentOnTarget = new Set(create ? await git.trackedInBranch(folder, target, paths) : []);

    const label = entries.length === 1 ? formatMemberPath(entries[0]) : `${entries.length} members`;
    const toTarget = await git.switchWorkItem(folder, target);
    if (toTarget.status !== "success") {
      return toTarget;
    }
    const written: string[] = [];
    try {
      for (const entry of entries) {
        const uri = vscode.Uri.file(entry.localPath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
        await vscode.workspace.fs.writeFile(uri, contents.get(entry.id)!);
        written.push(entry.localPath);
      }
      const committed = await git.saveCheckpoint(folder, paths, `move: ${label} from ${source}`, false);
      if (committed.status !== "success" && committed.status !== "noChanges") {
        throw new Error(`${committed.message ?? "Could not save the checkpoint."}${committed.details ? ` ${committed.details}` : ""}`);
      }
    } catch (err) {
      for (const localPath of written.filter((candidate) => !presentOnTarget.has(candidate))) {
        fs.rmSync(localPath, { force: true });
      }
      const back = await git.switchWorkItem(folder, source, true);
      this.log.appendLine(`[git] Move to ${target} failed: ${errorMessage(err)}`);
      return {
        status: "failure",
        message: back.status === "success"
          ? `Could not move ${label} to “${target}”. Nothing was changed in “${source}”.`
          : `Could not move ${label} to “${target}”, and Git could not return to “${source}”. Use Switch Work Item to return to it.`,
        details: errorMessage(err),
      };
    }
    moveEntriesState(state, ids, source, target);
    const back = await git.switchWorkItem(folder, source);
    await this.persist();
    if (back.status !== "success") {
      return {
        status: "failure",
        message: `${label} ${entries.length === 1 ? "was" : "were"} copied to “${target}”, but Git could not return to “${source}” to remove ${entries.length === 1 ? "it" : "them"}. Use Switch Work Item to return to it.`,
        details: back.details,
      };
    }
    for (const localPath of paths) {
      fs.rmSync(localPath, { force: true });
    }
    const removed = await git.saveCheckpoint(folder, paths, `move: ${label} to ${target}`, false);
    if (removed.status !== "success" && removed.status !== "noChanges") {
      return {
        status: "failure",
        message: `${label} ${entries.length === 1 ? "was" : "were"} copied to “${target}”, but the removal from “${source}” was not saved. Save a checkpoint in Source Control to finish.`,
        details: removed.details,
      };
    }
    return { status: "success" };
  }

  /** Saves the paths collected with `deferCheckpointTo` as one checkpoint, if there are any. */
  async saveBatchCheckpoint(system: string, paths: string[], message: string): Promise<void> {
    if (paths.length > 0) {
      this.logGitFailure(await this.saveCheckpoint(system, paths, message));
    }
  }

  async saveCheckpoint(system: string, paths: string[], message: string): Promise<GitOperationResult> {
    const ready = await this.ensureGitReady(system);
    if (ready.status !== "success" || !this.gitService) {
      return ready;
    }
    const root = this.getGitRoot(system);
    if (!root) {
      return { status: "setupRequired", message: "Choose a checkout folder first." };
    }
    if (paths.some((candidate) => !this.pathIsInside(root.fsPath, candidate))) {
      return { status: "failure", message: "A checkpoint path belongs to another system repository." };
    }
    return this.gitService.saveCheckpoint(root.fsPath, paths, message, false);
  }

  recordMergeBack(entry: CheckedOutMember, content: string): Promise<GitOperationResult> {
    return this.track(() => this.recordMergeBackNow(entry, content));
  }

  private async recordMergeBackNow(entry: CheckedOutMember, content: string): Promise<GitOperationResult> {
    await this.assertEntryInActiveWorkItem(entry);
    const localUri = vscode.Uri.file(entry.localPath);
    await vscode.workspace.fs.writeFile(localUri, Buffer.from(content, "utf-8"));
    entry.remoteHashAtCheckout = this.hash(content, localUri);
    entry.lastCheckedAt = new Date().toISOString();
    entry.status = "merged";
    await this.persist();
    return this.saveCheckpoint(entry.system,
      [entry.localPath],
      `merge-back: ${formatMemberPath(entry)} to ${entry.system}`
    );
  }

  /**
   * Runs `fn` with index saves deferred until it finishes, so a batch
   * operation writes the index once instead of once per member.
   */
  async runBatch<T>(fn: () => Promise<T>): Promise<T> {
    this.batchDepth++;
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.batchDepth--;
      if (this.batchDepth === 0) {
        this.batchGitReady.clear();
      }
      if (this.batchDepth === 0 && this.dirty) {
        try {
          await this.saveIndex();
        } catch (err) {
          this.log.appendLine(`[index] Could not save checkout index: ${errorMessage(err)}`);
          vscode.window.showErrorMessage(`Could not save the checkout index: ${errorMessage(err)}`);
        }
      }
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
    return Object.values(this.index.systems).some((state) =>
      Object.values(state.workItems).some((entries) => entries.length > 0)
    );
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
    } = options ?? {};
    const checkoutRoot = this.getCheckoutRoot();
    if (!checkoutRoot) {
      throw new Error("Choose a checkout folder before checking out members.");
    }

    const system = getSystemName();
    if (!system) {
      throw new Error("Not connected to IBM i");
    }

    this.ensureSystemState(system);
    const gitReady = await this.ensureGitReady(system);
    this.logGitFailure(gitReady);

    const existing = this.findEntry(system, library, sourceFile, memberName);
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

    const content = await downloadMemberContent(
      library,
      sourceFile,
      memberName
    );

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
      status: "checked-out",
    };

    const localPath = existing?.localPath ?? await this.getLocalPath(checkoutRoot, entry);
    entry.localPath = localPath;

    const hash = this.hash(content, vscode.Uri.file(localPath));
    entry.remoteHashAtCheckout = hash;

    this.log.appendLine(
      `[checkout] ${library}/${sourceFile}/${memberName}  remoteHashAtCheckout=${hash.substring(0, 12)}`
    );

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(localPath),
      Buffer.from(content, "utf-8")
    );

    if (deferCheckpointTo) {
      deferCheckpointTo.push(localPath);
    } else if (gitReady.status === "success" && this.gitService) {
      const gitRoot = this.getGitRoot(system)!;
      const result = await this.gitService.saveCheckpoint(
        gitRoot.fsPath,
        [localPath],
        `checkout: ${formatMemberPath(entry)} from ${entry.system}`,
        false
      );
      this.logGitFailure(result);
    }

    if (existing) {
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
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

  async refreshRemoteStatus(entry: CheckedOutMember): Promise<RemoteStatus> {
    await this.assertEntryInActiveWorkItem(entry);
    const localUri = vscode.Uri.file(entry.localPath);

    const remoteContent = await downloadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName
    );
    const remoteHash = this.hash(remoteContent, localUri);
    const localHash = this.hash(await this.readLocal(localUri), localUri);

    const status = classifyStatus(localHash, remoteHash, entry.remoteHashAtCheckout);
    entry.remoteHashAtCheckout = nextBaseline(localHash, remoteHash, entry.remoteHashAtCheckout);

    this.log.appendLine(
      `[refresh] ${entry.library}/${entry.sourceFile}/${entry.memberName}` +
      `  local=${localHash.substring(0, 12)}` +
      `  remote=${remoteHash.substring(0, 12)}` +
      `  baseline=${entry.remoteHashAtCheckout?.substring(0, 12)}` +
      `  → ${status}`
    );

    entry.status = status;
    entry.lastCheckedAt = new Date().toISOString();
    await this.persist();

    return status;
  }

  recheckout(entry: CheckedOutMember): Promise<void> {
    return this.track(() => this.recheckoutNow(entry));
  }

  private async recheckoutNow(entry: CheckedOutMember): Promise<void> {
    await this.assertEntryInActiveWorkItem(entry);
    const content = await downloadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName
    );
    const localUri = vscode.Uri.file(entry.localPath);
    const hash = this.hash(content, localUri);

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localUri, ".."));
    await vscode.workspace.fs.writeFile(
      localUri,
      Buffer.from(content, "utf-8")
    );

    entry.remoteHashAtCheckout = hash;
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
      /** Collects the path for one checkpoint after a batch instead of saving one per member. */
      deferCheckpointTo?: string[];
    }
  ): Promise<UploadResult> {
    return this.track(() => this.uploadToRemoteNow(entry, options));
  }

  private async uploadToRemoteNow(
    entry: CheckedOutMember,
    options?: { overwriteRemoteChanges?: boolean; deferCheckpointTo?: string[] }
  ): Promise<UploadResult> {
    await this.assertEntryInActiveWorkItem(entry);
    const localUri = vscode.Uri.file(entry.localPath);
    const localContent = await this.readLocal(localUri);
    const localHash = this.hash(localContent, localUri);

    if (!options?.overwriteRemoteChanges) {
      const remoteContent = await downloadMemberContent(
        entry.library,
        entry.sourceFile,
        entry.memberName
      );
      const remoteHash = this.hash(remoteContent, localUri);
      entry.remoteHashAtCheckout = nextBaseline(localHash, remoteHash, entry.remoteHashAtCheckout);
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

    const success = await uploadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName,
      localContent
    );

    if (!success) {
      return "failed";
    }

    let after = statusAfterUpload(localHash, localHash);
    try {
      const storedContent = await downloadMemberContent(
        entry.library,
        entry.sourceFile,
        entry.memberName
      );
      after = statusAfterUpload(localHash, this.hash(storedContent, localUri));
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

    entry.remoteHashAtCheckout = after.baseline;
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
    return this.refreshEntries(entries, progress, token);
  }

  async refreshAllRemoteStatus(
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const system = getSystemName();
    if (!system) {
      return emptyTally();
    }

    return this.refreshEntries(this.getEntriesForSystem(system), progress, token);
  }

  async refreshEntries(
    entries: CheckedOutMember[],
    progress?: RefreshProgress,
    token?: vscode.CancellationToken
  ): Promise<RefreshTally> {
    const tally = emptyTally();

    await this.runBatch(async () => {
      for (let i = 0; i < entries.length; i++) {
        if (token?.isCancellationRequested) {
          break;
        }
        const entry = entries[i];
        progress?.report({ message: `${entry.memberName} (${i + 1}/${entries.length})` });
        try {
          const result = await this.refreshRemoteStatus(entry);
          switch (result) {
            case "in-sync":
              tally.inSync++;
              break;
            case "modified":
              tally.modified++;
              break;
            case "remote-changed":
              tally.remoteChanged++;
              break;
            case "conflict":
              tally.conflict++;
              break;
          }
        } catch (err) {
          tally.errors++;
          this.log.appendLine(`[refresh] Error for ${formatMemberPath(entry)}: ${errorMessage(err)}`);
        }
        progress?.report({ increment: 100 / entries.length });
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
    }
    for (const entry of entries) {
      try {
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
      return this.hash(await this.readLocal(localUri), localUri) !== entry.remoteHashAtCheckout;
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
    return this.entries.find((e) => vscode.Uri.file(e.localPath).fsPath === target);
  }

  /** Updates a checkout's status after its local file is written, without contacting the IBM i. */
  async updateStatusFromLocalFile(entry: CheckedOutMember): Promise<void> {
    const status = statusAfterLocalSave(entry.status, await this.localFileDiffersFromBaseline(entry));
    if (status !== entry.status) {
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
  }

  private hash(content: string, resource: vscode.Uri): string {
    const trimTrailingWhitespace = vscode.workspace
      .getConfiguration("files", resource)
      .get<boolean>("trimTrailingWhitespace", false);
    return hashContent(content, trimTrailingWhitespace);
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

  private logGitFailure(result: GitOperationResult): void {
    if (result.status === "failure" || result.status === "conflict") {
      this.log.appendLine(
        `[git] ${result.message ?? "Local history operation failed"}${result.details ? `: ${result.details}` : ""}`
      );
      if (!this.gitOperationWarningShown) {
        this.gitOperationWarningShown = true;
        vscode.window.showWarningMessage(
          `${result.message ?? "Local Change History could not save this operation."} Your IBM i operation can continue; see the output panel for details.`
        );
      }
    }
  }

  private async assertEntryInActiveWorkItem(entry: CheckedOutMember): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration("ibmi-member-workspace")
      .get<boolean>("gitIntegration", false);
    if (!enabled) {
      return;
    }
    const ready = await this.ensureGitReady(entry.system);
    this.logGitFailure(ready);
    if (ready.status === "success" && !this.entries.includes(entry)) {
      throw new Error(
        "The active work item changed. The checkout list was refreshed; select the member again before continuing."
      );
    }
  }

  private async getLocalPath(
    checkoutRoot: vscode.Uri,
    entry: CheckedOutMember
  ): Promise<string> {
    const systemFolder = sanitizeSystemName(entry.system);
    const fileName = buildLocalFileName(entry);
    const baseDir = vscode.Uri.joinPath(
      checkoutRoot,
      systemFolder,
      entry.library,
      entry.sourceFile
    );

    await vscode.workspace.fs.createDirectory(baseDir);

    return vscode.Uri.joinPath(baseDir, fileName).fsPath;
  }

  private emptyIndex(): CheckoutIndex {
    return { version: 3, systems: {}, unassignedWorkItems: {} };
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

  private pathIsInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
  }

  private async loadIndex(): Promise<void> {
    if (!this.storageUri || !this.indexUri) {
      this.index = this.emptyIndex();
      return;
    }

    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(this.indexUri);
    } catch {
      // no index yet
      this.index = this.emptyIndex();
      return;
    }

    try {
      const json = Buffer.from(data).toString("utf-8");
      const storedVersion = (JSON.parse(json) as { version?: number }).version ?? 1;
      this.index = parseCheckoutIndex(json);
      if (storedVersion !== 3) {
        const backupUri = vscode.Uri.joinPath(this.storageUri, `checkout-index.v${storedVersion}-backup.json`);
        try {
          await vscode.workspace.fs.writeFile(backupUri, data);
          await this.saveIndex();
          this.log.appendLine(`[index] Migrated checkout index to work-item storage; backup: ${backupUri.fsPath}`);
        } catch (migrationError) {
          this.log.appendLine(`[index] Could not save checkout-index migration backup: ${errorMessage(migrationError)}`);
        }
      }
    } catch (err) {
      this.index = this.emptyIndex();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupUri = vscode.Uri.joinPath(this.storageUri, `checkout-index.corrupt-${stamp}.json`);
      try {
        await vscode.workspace.fs.writeFile(backupUri, data);
      } catch (backupErr) {
        this.log.appendLine(`[index] Could not back up unreadable index: ${errorMessage(backupErr)}`);
      }
      this.log.appendLine(
        `[index] ${this.indexUri.fsPath} is unreadable (${errorMessage(err)}); backed up to ${backupUri.fsPath}`
      );
      vscode.window.showWarningMessage(
        `The IBM i checkout index could not be read and was reset. A backup was saved to ${backupUri.fsPath}.`
      );
    }
  }

  /** Notifies listeners and saves the index, or defers the save while a batch is running. */
  private async persist(): Promise<void> {
    this._onDidChange.fire();
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }
    await this.saveIndex();
  }

  /** Writes the index atomically (temp file + rename), one write at a time. */
  private saveIndex(): Promise<void> {
    this.dirty = false;
    if (!this.indexUri || !this.indexTempUri) {
      return Promise.reject(new Error("Open a folder or workspace before saving checkouts."));
    }
    const indexUri = this.indexUri;
    const indexTempUri = this.indexTempUri;
    const data = Buffer.from(JSON.stringify(this.index, null, 2), "utf-8");
    const write = async () => {
      await vscode.workspace.fs.writeFile(indexTempUri, data);
      await vscode.workspace.fs.rename(indexTempUri, indexUri, { overwrite: true });
    };
    const result = this.saveQueue.then(write);
    result.catch(() => {
      this.dirty = true;
    });
    this.saveQueue = result.catch(() => undefined);
    return result;
  }
}
