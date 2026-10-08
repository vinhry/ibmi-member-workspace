import * as path from "node:path";
import { errorMessage } from "./errors";
import type { GitOperationResult, GitService, LegacyMigrationResult, RepositoryInspection } from "./gitService";
import type { RepositoryTrust } from "./repositoryTrust";
import {
  CheckedOutMember,
  DEFAULT_WORK_ITEM,
  SystemCheckoutState,
  WorkItemCarry,
  formatMemberPath,
  isDefaultWorkItem,
  isReferenceCopy,
  moveEntriesState,
  startWorkItemState,
  systemKey,
} from "./types";

/**
 * Local Change History's work items: preparing each system folder's Git repository (once per
 * session, with the user's consent for a repository the extension didn't create), keeping the
 * active work item in step with the checked-out branch, moving members between work items, and
 * saving checkpoints. Git, the file system, the prompts and the checkout index are injected, so
 * this has no `vscode` dependency and can be unit tested. `CheckoutService` owns one and delegates.
 */

/** The part of `GitService` work items need. */
export type HistoryGit = Pick<
  GitService,
  | "gitAvailabilityProblem"
  | "invalidateAvailability"
  | "isExactRepository"
  | "prepareRepository"
  | "configureLocalIdentity"
  | "currentBranch"
  | "listBranches"
  | "createBranch"
  | "findCleanBase"
  | "trackedInBranch"
  | "switchWorkItem"
  | "getWorkingTreeState"
  | "changedPaths"
  | "saveCheckpoint"
  | "migrateLegacyRepository"
  | "detectMisplacedParentRepository"
  | "isSafeMisplacedRepository"
  | "archiveMisplacedRepository"
  | "inspectRepository"
>;

export interface HistoryFiles {
  exists(localPath: string): boolean;
  read(localPath: string): Promise<Uint8Array>;
  /** Writes the file, creating its folder. */
  write(localPath: string, content: Uint8Array): Promise<void>;
  /** Deletes the file if it exists. */
  remove(localPath: string): void;
  /** Makes a file read-only (reference copies) or writable again; a missing file is ignored. */
  setReadOnly(localPath: string, readOnly: boolean): Promise<void>;
}

export interface HistoryUi {
  /** Asks for the Git author's name and email; undefined when either is not given. */
  askIdentity(): Promise<{ name: string; email: string } | undefined>;
  /** Asks whether a repository the extension didn't create may be used for `system`. */
  confirmRepositoryUse(system: string, folder: string): Promise<boolean>;
  warn(message: string): void;
}

export interface WorkItemHistoryDeps {
  git: HistoryGit | undefined;
  files: HistoryFiles;
  ui: HistoryUi;
  trust: Pick<RepositoryTrust, "isTrusted" | "trust">;
  gitIntegrationOn(): boolean;
  connectedSystem(): string | undefined;
  /** The checkout folder, as a file-system path. */
  checkoutRoot(): string | undefined;
  /** The system's folder under the checkout folder (its repository), as a file-system path. */
  gitRoot(system: string): string | undefined;
  /** The stored state of a system, or undefined when it has none yet. */
  systemState(system: string): SystemCheckoutState | undefined;
  ensureSystemState(system: string): SystemCheckoutState;
  knownSystems(): SystemCheckoutState[];
  /** The stored checkouts of `system`'s active work item. */
  activeEntries(system: string): CheckedOutMember[];
  managedPaths(system: string): string[];
  /** Whether a batch is running, so a successful preparation can be reused until it ends. */
  inBatch(): boolean;
  persist(): Promise<void>;
  /** Refuses a local path that goes through a link. */
  assertLocalPathSafe(localPath: string): void;
  log(message: string): void;
}

/** Whether `candidate` is strictly inside `root`. */
export function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export class WorkItemHistory {
  private gitWarningShown = false;
  private readonly gitSetupDeclinedSystems = new Set<string>();
  /** Systems whose existing, untrusted repository the user chose not to use this session. */
  private readonly repositoryDeclinedSystems = new Set<string>();
  private gitOperationWarningShown = false;
  private readonly gitPreparations = new Map<string, Promise<GitOperationResult>>();
  /** Successful repository preparation, reused until the running batch ends. */
  private readonly batchGitReady = new Map<string, GitOperationResult>();
  /** Work item the user confirmed for checkouts this session, per system. */
  private readonly confirmedWorkItems = new Map<string, string>();

  constructor(private readonly deps: WorkItemHistoryDeps) {}

  private get git(): HistoryGit | undefined {
    return this.deps.git;
  }

  /**
   * Returns true when git integration is enabled in settings AND git is available.
   * Shows a one-time warning notification if the setting is on but git is not found.
   */
  async isGitEnabled(): Promise<boolean> {
    if (!this.deps.gitIntegrationOn()) {
      return false;
    }
    const problem = this.git
      ? await this.git.gitAvailabilityProblem()
      : "Git was not found on PATH.";
    if (problem) {
      this.warnGitUnavailable(problem);
      return false;
    }
    return true;
  }

  /** Records that the user chose the active work item for checkouts in this session. */
  confirmWorkItem(system: string): void {
    this.confirmedWorkItems.set(systemKey(system), this.deps.ensureSystemState(system).activeWorkItem);
  }

  /**
   * Whether a checkout must first ask which work item it belongs to: always on the default
   * work item or a detached HEAD, otherwise once per session.
   */
  async needsWorkItemChoice(system: string): Promise<boolean> {
    const root = this.deps.gitRoot(system);
    if (!root || !this.git) {
      return false;
    }
    const active = this.deps.ensureSystemState(system).activeWorkItem;
    const branch = await this.git.currentBranch(root);
    return !branch ||
      isDefaultWorkItem(active) ||
      this.confirmedWorkItems.get(systemKey(system)) !== active;
  }

  async inspectRepository(folder: string): Promise<RepositoryInspection | undefined> {
    return this.git?.inspectRepository(folder);
  }

  async detectMisplacedParentRepository(): Promise<RepositoryInspection | undefined> {
    const root = this.deps.checkoutRoot();
    return root && this.git
      ? this.git.detectMisplacedParentRepository(root)
      : undefined;
  }

  async migrateLegacyRepository(): Promise<LegacyMigrationResult> {
    const checkoutRoot = this.deps.checkoutRoot();
    if (!checkoutRoot || !this.git) {
      return { status: "setupRequired", message: "Choose a checkout folder first." };
    }
    const connected = this.deps.connectedSystem();
    if (connected) {
      this.deps.ensureSystemState(connected);
    }
    const systems = this.deps.knownSystems();
    for (const state of systems) {
      const folder = this.deps.gitRoot(state.system)!;
      if (!(await this.confirmRepositoryUse(state.system, folder))) {
        return this.repositoryDeclined(state.system, folder);
      }
    }
    const result = await this.git.migrateLegacyRepository(
      checkoutRoot,
      systems.map((state) => ({
        system: state.system,
        folder: this.deps.gitRoot(state.system)!,
        workItems: Object.keys(state.workItems),
      }))
    );
    for (const state of systems) {
      await this.trustCreatedRepository(this.deps.gitRoot(state.system)!);
    }
    if (result.status !== "success") {
      return result;
    }

    for (const [system, workItems] of Object.entries(result.restoredBranches ?? {})) {
      const restoredState = this.deps.systemState(system);
      if (restoredState) {
        for (const workItem of workItems) {
          restoredState.workItems[workItem] ??= [];
        }
      }
    }

    if (!connected) {
      await this.deps.persist();
      return result;
    }

    const state = this.deps.ensureSystemState(connected);
    const gitRoot = this.deps.gitRoot(connected)!;
    const changed = await this.git.changedPaths(gitRoot);
    const managed = new Set(this.deps.managedPaths(connected).map((value) => path.resolve(value)));
    const unrelated = changed.filter((value) => !managed.has(path.resolve(value)));
    if (unrelated.length === 0) {
      const branch = await this.git.currentBranch(gitRoot);
      if (branch !== state.activeWorkItem && (await this.git.listBranches(gitRoot)).includes(state.activeWorkItem)) {
        const switched = await this.git.switchWorkItem(gitRoot, state.activeWorkItem, true);
        if (switched.status !== "success") {
          return switched;
        }
      }
      if (changed.length > 0) {
        const checkpoint = await this.git.saveCheckpoint(
          gitRoot,
          changed.filter((value) => managed.has(path.resolve(value))),
          `checkpoint: recovered ${state.activeWorkItem}`,
          false
        );
        if (checkpoint.status !== "success" && checkpoint.status !== "noChanges") {
          return checkpoint;
        }
      }
    }
    await this.deps.persist();
    return result;
  }

  async archiveMisplacedRepository(): Promise<{ gitBackup: string; gitignoreBackup?: string }> {
    const root = this.deps.checkoutRoot();
    if (!root || !this.git) {
      throw new Error("Choose a checkout folder first.");
    }
    const inspection = await this.git.detectMisplacedParentRepository(root);
    const directories = this.deps.knownSystems().map((state) => state.directory);
    if (!inspection || !this.git.isSafeMisplacedRepository(inspection, directories)) {
      throw new Error("The parent repository changed after repair and was not archived.");
    }
    return this.git.archiveMisplacedRepository(root);
  }

  async ensureGitReady(system = this.deps.connectedSystem()): Promise<GitOperationResult> {
    if (!system) {
      return { status: "setupRequired", message: "Connect to an IBM i system first." };
    }
    const key = systemKey(system);
    if (!this.deps.systemState(system)) {
      this.deps.ensureSystemState(system);
      await this.deps.persist();
    } else {
      this.deps.ensureSystemState(system);
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
      if (this.deps.inBatch() && result.status === "success") {
        this.batchGitReady.set(key, result);
      }
      return result;
    } finally {
      if (this.gitPreparations.get(key) === preparation) {
        this.gitPreparations.delete(key);
      }
    }
  }

  /** Forgets the preparations a batch reused; called when the batch ends. */
  endBatch(): void {
    this.batchGitReady.clear();
  }

  private async prepareGitRepository(system: string): Promise<GitOperationResult> {
    if (!this.deps.gitIntegrationOn() || !this.git) {
      return {
        status: "setupRequired",
        message: "Enable Local Change History before saving checkpoints.",
      };
    }
    const problem = await this.git.gitAvailabilityProblem();
    if (problem) {
      this.warnGitUnavailable(problem);
      return {
        status: "setupRequired",
        message: `${problem} Install or update Git, then run Set Up Local Change History again.`,
      };
    }
    const root = this.deps.gitRoot(system);
    if (!root) {
      return { status: "setupRequired", message: "Choose a checkout folder first." };
    }

    if (!(await this.confirmRepositoryUse(system, root))) {
      return this.repositoryDeclined(system, root);
    }
    let result = await this.git.prepareRepository(root);
    await this.trustCreatedRepository(root);
    if (result.status !== "setupRequired" || this.gitSetupDeclinedSystems.has(systemKey(system))) {
      if (result.status === "success") {
        await this.synchronizeWorkItem(system);
      }
      return result;
    }

    // Git is available at this point, so setupRequired means author identity is missing.
    const identity = await this.deps.ui.askIdentity();
    if (!identity) {
      this.gitSetupDeclinedSystems.add(systemKey(system));
      return { status: "setupRequired", message: "Git author setup was cancelled." };
    }
    result = await this.git.configureLocalIdentity(root, identity.name.trim(), identity.email.trim());
    if (result.status === "success") {
      result = await this.git.prepareRepository(root);
      if (result.status === "success") {
        await this.synchronizeWorkItem(system);
      }
    }
    return result;
  }

  /**
   * Whether Git may run in a system folder: it holds no repository yet (one is created), holds one
   * this extension created or the user chose, or the user chooses the one it holds now. A cloned or
   * shared folder can carry a repository whose settings make Git run programs.
   */
  private async confirmRepositoryUse(system: string, folder: string): Promise<boolean> {
    if (
      !this.git ||
      this.deps.trust.isTrusted(folder) ||
      !(await this.git.isExactRepository(folder))
    ) {
      return true;
    }
    if (this.repositoryDeclinedSystems.has(systemKey(system))) {
      return false;
    }
    if (!(await this.deps.ui.confirmRepositoryUse(system, folder))) {
      this.repositoryDeclinedSystems.add(systemKey(system));
      return false;
    }
    await this.deps.trust.trust(folder);
    return true;
  }

  private repositoryDeclined(system: string, folder: string): GitOperationResult {
    return {
      status: "setupRequired",
      message: `Local Change History is off for ${system}: ${folder} has a Git repository you haven't chosen to use. Run Set Up Local Change History to choose again.`,
    };
  }

  /** Records a repository that was just created in a system folder as one this extension may use. */
  private async trustCreatedRepository(folder: string): Promise<void> {
    if (this.git && !this.deps.trust.isTrusted(folder) && await this.git.isExactRepository(folder)) {
      await this.deps.trust.trust(folder);
    }
  }

  resetSetupState(): void {
    this.gitWarningShown = false;
    this.gitSetupDeclinedSystems.clear();
    this.repositoryDeclinedSystems.clear();
    this.gitOperationWarningShown = false;
    this.git?.invalidateAvailability();
  }

  async synchronizeWorkItem(system = this.deps.connectedSystem()): Promise<void> {
    if (!system) {
      return;
    }
    const root = this.deps.gitRoot(system);
    if (!root || !this.git) {
      return;
    }
    const state = this.deps.ensureSystemState(system);
    const branch = await this.git.currentBranch(root);
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
      this.deps.files.exists(entry.localPath)
    );
    await this.protectReferenceCopies(state.workItems[branch]);
    await this.deps.persist();
  }

  /** Makes an existing work item active after its branch was checked out. */
  async activateWorkItem(system: string, name: string): Promise<void> {
    const state = this.deps.ensureSystemState(system);
    state.activeWorkItem = name;
    state.workItems[name] = (state.workItems[name] ?? []).filter((entry) =>
      this.deps.files.exists(entry.localPath)
    );
    await this.protectReferenceCopies(state.workItems[name]);
    await this.deps.persist();
  }

  /** Makes a work item whose branch was just created (or renamed, for "move") active. */
  async startWorkItem(system: string, name: string, carry: WorkItemCarry): Promise<void> {
    const state = this.deps.ensureSystemState(system);
    startWorkItemState(state, name, carry);
    state.workItems[name] = state.workItems[name].filter((entry) =>
      this.deps.files.exists(entry.localPath)
    );
    await this.protectReferenceCopies(state.workItems[name]);
    await this.deps.persist();
  }

  /**
   * Moves checkouts from the active work item to `target`, creating it from the clean base when
   * `create` is set. The members are committed on the target before they are removed from the
   * active work item, so a failure part-way leaves them in both work items, never in neither.
   * The active work item stays active. The caller must leave the repository clean first.
   */
  async moveEntries(
    system: string,
    entries: CheckedOutMember[],
    target: string,
    create: boolean
  ): Promise<GitOperationResult> {
    const ready = await this.ensureGitReady(system);
    const folder = this.deps.gitRoot(system);
    if (ready.status !== "success" || !this.git || !folder) {
      return ready.status === "success" ? { status: "setupRequired", message: "Choose a checkout folder first." } : ready;
    }
    const git = this.git;
    const state = this.deps.ensureSystemState(system);
    const source = state.activeWorkItem;
    if (target === source || entries.length === 0) {
      return { status: "noChanges", message: "Nothing to move." };
    }
    for (const entry of entries) {
      await this.assertEntryInActiveWorkItem(entry);
    }
    const paths = entries.map((entry) => entry.localPath);
    if (paths.some((candidate) => !pathIsInside(folder, candidate))) {
      return { status: "failure", message: "A checkout path belongs to another system repository." };
    }
    paths.forEach((candidate) => this.deps.assertLocalPathSafe(candidate));
    const clean = await git.getWorkingTreeState(folder);
    if (clean.status !== "success") {
      return clean;
    }

    const contents = new Map<string, Uint8Array>();
    for (const entry of entries) {
      try {
        contents.set(entry.id, await this.deps.files.read(entry.localPath));
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
        await this.deps.files.write(entry.localPath, contents.get(entry.id)!);
        written.push(entry.localPath);
      }
      const committed = await git.saveCheckpoint(folder, paths, `move: ${label} from ${source}`, false);
      if (committed.status !== "success" && committed.status !== "noChanges") {
        throw new Error(`${committed.message ?? "Could not save the checkpoint."}${committed.details ? ` ${committed.details}` : ""}`);
      }
    } catch (err) {
      for (const localPath of written.filter((candidate) => !presentOnTarget.has(candidate))) {
        this.deps.files.remove(localPath);
      }
      const back = await git.switchWorkItem(folder, source, true);
      this.deps.log(`[git] Move to ${target} failed: ${errorMessage(err)}`);
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
    await this.deps.persist();
    if (back.status !== "success") {
      return {
        status: "failure",
        message: `${label} ${entries.length === 1 ? "was" : "were"} copied to “${target}”, but Git could not return to “${source}” to remove ${entries.length === 1 ? "it" : "them"}. Use Switch Work Item to return to it.`,
        details: back.details,
      };
    }
    for (const localPath of paths) {
      this.deps.files.remove(localPath);
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
    if (ready.status !== "success" || !this.git) {
      return ready;
    }
    const root = this.deps.gitRoot(system);
    if (!root) {
      return { status: "setupRequired", message: "Choose a checkout folder first." };
    }
    if (paths.some((candidate) => !pathIsInside(root, candidate))) {
      return { status: "failure", message: "A checkpoint path belongs to another system repository." };
    }
    return this.git.saveCheckpoint(root, paths, message, false);
  }

  private warnGitUnavailable(problem: string): void {
    if (this.gitWarningShown) {
      return;
    }
    this.gitWarningShown = true;
    this.deps.ui.warn(
      `Local Change History is enabled, but ${problem} Install or update Git, then run Set Up Local Change History again.`
    );
  }

  /** Git restores files as writable when it switches work items, so reference copies are protected again. */
  async protectReferenceCopies(entries: CheckedOutMember[]): Promise<void> {
    for (const entry of entries.filter(isReferenceCopy)) {
      await this.deps.files.setReadOnly(entry.localPath, true);
    }
  }

  /** Logs a failed Git operation and, once per session, tells the user; the IBM i operation goes on. */
  logGitFailure(result: GitOperationResult): void {
    if (result.status === "failure" || result.status === "conflict") {
      this.deps.log(
        `[git] ${result.message ?? "Local history operation failed"}${result.details ? `: ${result.details}` : ""}`
      );
      if (!this.gitOperationWarningShown) {
        this.gitOperationWarningShown = true;
        this.deps.ui.warn(
          `${result.message ?? "Local Change History could not save this operation."} Your IBM i operation can continue; see the output panel for details.`
        );
      }
    }
  }

  /** Prepares the repository and refuses an entry the active work item no longer holds. */
  async assertEntryInActiveWorkItem(entry: CheckedOutMember): Promise<void> {
    if (!this.deps.gitIntegrationOn()) {
      return;
    }
    const ready = await this.ensureGitReady(entry.system);
    this.logGitFailure(ready);
    const connected = this.deps.connectedSystem();
    const entries = connected ? this.deps.activeEntries(connected) : [];
    if (ready.status === "success" && !entries.includes(entry)) {
      throw new Error(
        "The active work item changed. The checkout list was refreshed; select the member again before continuing."
      );
    }
  }
}
