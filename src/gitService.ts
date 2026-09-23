import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";

const pExecFile = promisify(execFile);

export const GITIGNORE_CONTENT = `# OS / editor noise
.DS_Store
Thumbs.db
desktop.ini
*.log

# IBM i member files are intentionally tracked
`;

export type GitResultStatus =
  | "success"
  | "noChanges"
  | "setupRequired"
  | "dirtyWorktree"
  | "invalidName"
  | "conflict"
  | "failure";

export interface GitOperationResult {
  status: GitResultStatus;
  message?: string;
  details?: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number;
}

export interface RepositoryInspection {
  folder: string;
  exactRepository: boolean;
  managedByExtension: boolean;
  hasHead: boolean;
  branches: string[];
  remotes: string[];
  trackedPaths: Array<{ mode: string; path: string }>;
  historicalPaths: string[];
}

export interface LegacySystemMigration {
  system: string;
  folder: string;
  workItems: string[];
}

export interface LegacyMigrationResult extends GitOperationResult {
  restoredBranches?: Record<string, string[]>;
}

export class GitService {
  private gitAvailable: boolean | undefined;

  constructor(private readonly log: Pick<vscode.OutputChannel, "appendLine">) {}

  invalidateAvailability(): void {
    this.gitAvailable = undefined;
  }

  private async run(
    folder: string,
    args: string[],
    logFailure = true,
    trimOutput = true
  ): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await pExecFile("git", ["-C", folder, ...args]);
      return {
        ok: true,
        stdout: trimOutput ? stdout.trim() : stdout,
        stderr: stderr.trim(),
      };
    } catch (err: unknown) {
      const commandError = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      const stderr = String(commandError.stderr ?? "").trim();
      const details = stderr || commandError.message || String(err);
      if (logFailure) {
        this.log.appendLine(`[git] git ${args.join(" ")} failed: ${details}`);
      }
      return {
        ok: false,
        stdout: String(commandError.stdout ?? "").trim(),
        stderr: details,
        code: typeof commandError.code === "number" ? commandError.code : undefined,
      };
    }
  }

  async checkGitAvailable(): Promise<boolean> {
    if (this.gitAvailable !== undefined) {
      return this.gitAvailable;
    }
    try {
      await pExecFile("git", ["--version"]);
      this.gitAvailable = true;
    } catch {
      this.gitAvailable = false;
    }
    return this.gitAvailable;
  }

  async isExactRepository(folder: string): Promise<boolean> {
    return (await this.checkExactRepository(folder)).ok;
  }

  /**
   * Asks Git whether `folder` is a work tree root rather than comparing paths: on Windows,
   * VS Code reports "c:\..." while Git reports "C:/...", and 8.3 short names or subst drives differ too.
   */
  private async checkExactRepository(folder: string): Promise<CommandResult> {
    const result = await this.run(folder, ["rev-parse", "--show-cdup"], false);
    return result.ok && result.stdout !== ""
      ? { ok: false, stdout: result.stdout, stderr: "The folder is inside another repository." }
      : result;
  }

  async isManagedRepository(folder: string): Promise<boolean> {
    if (!(await this.isExactRepository(folder))) {
      return false;
    }
    const markerPath = path.join(folder, ".git", "ibmi-member-workspace");
    const gitignorePath = path.join(folder, ".gitignore");
    return fs.existsSync(markerPath) || (
      fs.existsSync(gitignorePath) &&
      fs.readFileSync(gitignorePath, "utf-8").includes("IBM i member files")
    );
  }

  async inspectRepository(folder: string): Promise<RepositoryInspection> {
    const exactRepository = await this.isExactRepository(folder);
    if (!exactRepository) {
      return {
        folder,
        exactRepository: false,
        managedByExtension: false,
        hasHead: false,
        branches: [],
        remotes: [],
        trackedPaths: [],
        historicalPaths: [],
      };
    }
    const [head, branches, remotes, tracked, history] = await Promise.all([
      this.run(folder, ["rev-parse", "--verify", "HEAD"], false),
      this.listBranches(folder),
      this.run(folder, ["remote"], false),
      this.run(folder, ["ls-files", "--stage", "-z"], false, false),
      this.run(folder, ["log", "--all", "--format=", "--name-only"], false),
    ]);
    const trackedPaths = tracked.ok && tracked.stdout
      ? tracked.stdout.split("\0").filter(Boolean).map((record) => {
        const match = /^(\d+)\s+[0-9a-f]+\s+\d+\t([\s\S]+)$/.exec(record);
        return { mode: match?.[1] ?? "", path: match?.[2] ?? record };
      })
      : [];
    return {
      folder,
      exactRepository,
      managedByExtension: await this.isManagedRepository(folder),
      hasHead: head.ok,
      branches,
      remotes: remotes.ok && remotes.stdout ? remotes.stdout.split("\n").filter(Boolean) : [],
      trackedPaths,
      historicalPaths: history.ok && history.stdout
        ? [...new Set(history.stdout.split("\n").map((value) => value.trim()).filter(Boolean))]
        : [],
    };
  }

  async detectMisplacedParentRepository(folder: string): Promise<RepositoryInspection | undefined> {
    const inspection = await this.inspectRepository(folder);
    return inspection.exactRepository && inspection.managedByExtension ? inspection : undefined;
  }

  isSafeMisplacedRepository(
    inspection: RepositoryInspection,
    systemDirectories: string[]
  ): boolean {
    const allowed = (candidate: string, mode?: string) => {
      if (candidate === ".gitignore") {
        const ignore = path.join(inspection.folder, candidate);
        return fs.existsSync(ignore) && fs.readFileSync(ignore, "utf-8") === GITIGNORE_CONTENT;
      }
      const normalized = candidate.split(path.sep).join("/");
      return systemDirectories.some((directory) => {
        const prefix = `${directory}/`;
        if (normalized === directory) {
          return mode === undefined || mode === "160000";
        }
        if (!normalized.startsWith(prefix)) {
          return false;
        }
        const memberPath = normalized.slice(prefix.length).split("/");
        return memberPath.length === 3 && memberPath.every(Boolean);
      });
    };
    return inspection.managedByExtension &&
      inspection.trackedPaths.every((entry) => allowed(entry.path, entry.mode)) &&
      inspection.historicalPaths.every((entry) => allowed(entry));
  }

  async migrateLegacyRepository(
    parentFolder: string,
    systems: LegacySystemMigration[]
  ): Promise<LegacyMigrationResult> {
    const inspection = await this.detectMisplacedParentRepository(parentFolder);
    const directories = systems.map((item) => path.basename(item.folder));
    if (!inspection || !this.isSafeMisplacedRepository(inspection, directories)) {
      return {
        status: "conflict",
        message: "The misplaced checkout repository contains unrelated files or history and requires manual recovery.",
      };
    }
    const restoredBranches: Record<string, string[]> = {};
    for (const system of systems) {
      const prepared = await this.prepareRepository(system.folder);
      if (prepared.status !== "success" && prepared.status !== "setupRequired") {
        return prepared;
      }
      const hasHead = await this.run(system.folder, ["rev-parse", "--verify", "HEAD"], false);
      if (!hasHead.ok) {
        continue;
      }
      const existing = new Set(await this.listBranches(system.folder));
      const workItems = new Set([...inspection.branches, ...system.workItems]);
      for (const workItem of workItems) {
        if (existing.has(workItem) || !(await this.validateBranchName(system.folder, workItem))) {
          continue;
        }
        const created = await this.run(system.folder, ["branch", workItem, "HEAD"]);
        if (!created.ok) {
          return { status: "failure", message: `Could not restore work item “${workItem}”.`, details: created.stderr };
        }
        (restoredBranches[system.system] ??= []).push(workItem);
      }
    }
    return { status: "success", restoredBranches };
  }

  async archiveMisplacedRepository(folder: string): Promise<{
    gitBackup: string;
    gitignoreBackup?: string;
  }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const gitPath = path.join(folder, ".git");
    const gitBackup = path.join(folder, `.git.ibmi-member-workspace-backup-${stamp}`);
    fs.renameSync(gitPath, gitBackup);
    const gitignorePath = path.join(folder, ".gitignore");
    let gitignoreBackup: string | undefined;
    if (fs.existsSync(gitignorePath) && fs.readFileSync(gitignorePath, "utf-8") === GITIGNORE_CONTENT) {
      gitignoreBackup = path.join(folder, `.gitignore.ibmi-member-workspace-backup-${stamp}`);
      fs.renameSync(gitignorePath, gitignoreBackup);
    }
    return { gitBackup, gitignoreBackup };
  }

  async getIdentity(folder: string): Promise<GitIdentity | undefined> {
    const [name, email] = await Promise.all([
      this.run(folder, ["config", "--get", "user.name"], false),
      this.run(folder, ["config", "--get", "user.email"], false),
    ]);
    if (!name.ok || !email.ok || !name.stdout || !email.stdout) {
      return undefined;
    }
    return { name: name.stdout, email: email.stdout };
  }

  async configureLocalIdentity(
    folder: string,
    name: string,
    email: string
  ): Promise<GitOperationResult> {
    const nameResult = await this.run(folder, ["config", "--local", "user.name", name]);
    const emailResult = await this.run(folder, ["config", "--local", "user.email", email]);
    if (!nameResult.ok || !emailResult.ok) {
      return {
        status: "failure",
        message: "Could not save the Git author for this checkout folder.",
        details: nameResult.stderr || emailResult.stderr,
      };
    }
    return { status: "success" };
  }

  async prepareRepository(folder: string): Promise<GitOperationResult> {
    if (!(await this.checkGitAvailable())) {
      return {
        status: "setupRequired",
        message: "Git is not installed or is not available on PATH.",
      };
    }

    try {
      fs.mkdirSync(folder, { recursive: true });
      const exactRepository = await this.isExactRepository(folder);
      const managedRepository = exactRepository && await this.isManagedRepository(folder);
      const markerPath = path.join(folder, ".git", "ibmi-member-workspace");
      if (!exactRepository) {
        const init = await this.run(folder, ["init"]);
        const created = init.ok ? await this.checkExactRepository(folder) : init;
        if (!created.ok) {
          if (created.stderr.includes("dubious ownership")) {
            this.log.appendLine(`[git] Repository setup failed: ${created.stderr}`);
            return {
              status: "failure",
              message: `Git does not trust the checkout folder because another account owns it (common on network drives). Run "git config --global --add safe.directory ${folder.replace(/\\/g, "/")}", then try again.`,
              details: created.stderr,
            };
          }
          return {
            status: "failure",
            message: "Could not create an isolated history repository in the checkout folder.",
            details: created.stderr,
          };
        }
        await this.run(folder, ["symbolic-ref", "HEAD", "refs/heads/workspace"]);
        fs.writeFileSync(markerPath, "Local Change History repository\n", "utf-8");
      }

      const gitignorePath = path.join(folder, ".gitignore");
      if (!exactRepository && !fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf-8");
      }

      if (!(await this.getIdentity(folder))) {
        return {
          status: "setupRequired",
          message: "Git needs your name and email before it can save local history.",
        };
      }

      const hasHead = await this.run(folder, ["rev-parse", "--verify", "HEAD"], false);
      if (!hasHead.ok && (!exactRepository || managedRepository)) {
        const initial = await this.saveCheckpoint(folder, [gitignorePath], "Initialize local change history", false);
        if (initial.status !== "success" && initial.status !== "noChanges") {
          return initial;
        }
      }
      return { status: "success" };
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[git] Repository setup failed: ${details}`);
      return {
        status: "failure",
        message: "Could not set up Local Change History.",
        details,
      };
    }
  }

  async currentBranch(folder: string): Promise<string> {
    const branch = await this.run(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return branch.ok ? branch.stdout : "";
  }

  async listBranches(folder: string): Promise<string[]> {
    const result = await this.run(folder, ["branch", "--format=%(refname:short)"]);
    return result.ok && result.stdout
      ? result.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean)
      : [];
  }

  async validateBranchName(folder: string, name: string): Promise<boolean> {
    return (await this.run(folder, ["check-ref-format", "--branch", name], false)).ok;
  }

  async createWorkItem(folder: string, name: string): Promise<GitOperationResult> {
    if (!(await this.validateBranchName(folder, name))) {
      return {
        status: "invalidName",
        message: "Use a short name without spaces or special Git characters, such as TICKET-123.",
      };
    }
    const result = await this.run(folder, ["checkout", "-b", name]);
    if (!result.ok) {
      return {
        status: result.stderr.includes("already exists") ? "conflict" : "failure",
        message: result.stderr.includes("already exists")
          ? `A work item named “${name}” already exists.`
          : `Could not start work item “${name}”.`,
        details: result.stderr,
      };
    }
    return { status: "success" };
  }

  async switchWorkItem(folder: string, name: string, allowDirty = false): Promise<GitOperationResult> {
    if (!allowDirty) {
      const state = await this.getWorkingTreeState(folder);
      if (state.status !== "success") {
        return state;
      }
    }
    const result = await this.run(folder, ["checkout", name]);
    if (!result.ok) {
      return {
        status: result.stderr.includes("would be overwritten") ? "conflict" : "failure",
        message: `Could not switch to work item “${name}”.`,
        details: result.stderr,
      };
    }
    return { status: "success" };
  }

  async getWorkingTreeState(folder: string): Promise<GitOperationResult> {
    const status = await this.run(folder, ["status", "--porcelain"]);
    if (!status.ok) {
      return { status: "failure", message: "Could not inspect local changes.", details: status.stderr };
    }
    return status.stdout
      ? { status: "dirtyWorktree", message: "This work item has changes that are not in a checkpoint." }
      : { status: "success" };
  }

  async changedPaths(folder: string): Promise<string[]> {
    const status = await this.run(folder, ["status", "--porcelain", "-z"], true, false);
    if (!status.ok || !status.stdout) {
      return [];
    }
    const records = status.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const state = record.slice(0, 2);
      paths.push(path.join(folder, record.slice(3)));
      if ((state.includes("R") || state.includes("C")) && i + 1 < records.length) {
        paths.push(path.join(folder, records[++i]));
      }
    }
    return [...new Set(paths)];
  }

  async saveCheckpoint(
    folder: string,
    filePaths: string[],
    message: string,
    prepare = true
  ): Promise<GitOperationResult> {
    if (prepare) {
      const ready = await this.prepareRepository(folder);
      if (ready.status !== "success") {
        return ready;
      }
    }

    const root = path.resolve(folder);
    const relativePaths = [...new Set(filePaths.map((filePath) => path.relative(root, path.resolve(filePath))))];
    if (
      relativePaths.length === 0 ||
      relativePaths.some((relative) =>
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
    ) {
      return { status: "failure", message: "A checkpoint path is outside the checkout folder." };
    }

    const stage = await this.run(folder, ["add", "-A", "--", ...relativePaths]);
    if (!stage.ok) {
      return { status: "failure", message: "Could not prepare files for the checkpoint.", details: stage.stderr };
    }
    const changed = await this.run(
      folder,
      ["diff", "--cached", "--quiet", "--", ...relativePaths],
      false
    );
    if (changed.ok) {
      return { status: "noChanges", message: "No changes since the last checkpoint." };
    }
    if (changed.code !== 1) {
      return { status: "failure", message: "Could not inspect checkpoint changes.", details: changed.stderr };
    }

    const commit = await this.run(folder, ["commit", "--only", "-m", message, "--", ...relativePaths]);
    if (!commit.ok) {
      return { status: "failure", message: "Could not save the checkpoint.", details: commit.stderr };
    }
    this.log.appendLine(`[git] Saved checkpoint: ${message}`);
    return { status: "success" };
  }
}
