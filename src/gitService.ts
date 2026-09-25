import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { DEFAULT_WORK_ITEM } from "./types";

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

interface RunOptions {
  /** Log a failed command to the output channel (default true). */
  logFailure?: boolean;
  /** Trim stdout (default true); off for NUL-separated output. */
  trimOutput?: boolean;
  /** Written to the command's stdin, e.g. a NUL-separated `--pathspec-from-file=-` list. */
  input?: string;
}

/** `--pathspec-from-file` and `git switch` need Git 2.25. */
const MIN_GIT_VERSION: readonly [number, number] = [2, 25];

/** Large repositories list many paths; the 1 MB default would make inspection fail. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Major and minor version from `git --version` output, e.g. "git version 2.45.1.windows.1". */
export function parseGitVersion(output: string): [number, number] | undefined {
  const match = /(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** Why Local Change History can't use this Git, or undefined when it can. Unknown versions are allowed. */
export function gitVersionProblem(versionOutput: string): string | undefined {
  const version = parseGitVersion(versionOutput);
  if (!version) {
    return undefined;
  }
  const [major, minor] = version;
  const [minMajor, minMinor] = MIN_GIT_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor)
    ? undefined
    : `Git ${minMajor}.${minMinor} or later is required (found ${versionOutput.trim()}).`;
}

/** Repository-relative path in Git's form, for comparing with Git output. */
function gitPath(relative: string): string {
  return relative.split(path.sep).join("/");
}

/** Comparison key for a Git path: macOS and Windows file systems ignore case. */
function pathKey(gitRelative: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? gitRelative.toLowerCase()
    : gitRelative;
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
  /** False when a listing command failed, so the path lists may be incomplete. */
  complete: boolean;
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
  /** Cached result of the Git check: null when Git is usable, otherwise the problem. */
  private gitProblem: string | null | undefined;

  constructor(private readonly log: Pick<vscode.OutputChannel, "appendLine">) {}

  invalidateAvailability(): void {
    this.gitProblem = undefined;
  }

  private async run(
    folder: string,
    args: string[],
    { logFailure = true, trimOutput = true, input }: RunOptions = {}
  ): Promise<CommandResult> {
    try {
      const pending = pExecFile("git", ["-C", folder, ...args], {
        maxBuffer: MAX_OUTPUT_BYTES,
        // Never wait for credentials or other terminal input from a background command.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      // Always close stdin so no command can block waiting for input.
      pending.child.stdin?.end(input ?? "");
      const { stdout, stderr } = await pending;
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
    return (await this.gitAvailabilityProblem()) === undefined;
  }

  /** Why Git can't be used for Local Change History (missing or too old), or undefined when it can. */
  async gitAvailabilityProblem(): Promise<string | undefined> {
    if (this.gitProblem === undefined) {
      try {
        const { stdout } = await pExecFile("git", ["--version"]);
        this.gitProblem = gitVersionProblem(stdout) ?? null;
      } catch {
        this.gitProblem = "Git was not found on PATH.";
      }
    }
    return this.gitProblem ?? undefined;
  }

  async isExactRepository(folder: string): Promise<boolean> {
    return (await this.checkExactRepository(folder)).ok;
  }

  /**
   * Asks Git whether `folder` is a work tree root rather than comparing paths: on Windows,
   * VS Code reports "c:\..." while Git reports "C:/...", and 8.3 short names or subst drives differ too.
   */
  private async checkExactRepository(folder: string): Promise<CommandResult> {
    const result = await this.run(folder, ["rev-parse", "--show-cdup"], { logFailure: false });
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
        complete: true,
      };
    }
    const [head, branches, remotes, tracked, history] = await Promise.all([
      this.run(folder, ["rev-parse", "--verify", "HEAD"], { logFailure: false }),
      this.listBranches(folder),
      this.run(folder, ["remote"], { logFailure: false }),
      this.run(folder, ["ls-files", "--stage", "-z"], { logFailure: false, trimOutput: false }),
      this.run(folder, ["log", "--all", "--format=", "--name-only"], { logFailure: false }),
    ]);
    const trackedPaths = tracked.ok && tracked.stdout
      ? tracked.stdout.split("\0").filter(Boolean).map((record) => {
        const match = /^(\d+)\s+[0-9a-f]+\s+\d+\t([\s\S]+)$/.exec(record);
        return { mode: match?.[1] ?? "", path: match?.[2] ?? record };
      })
      : [];
    // A repository without commits has no history to list; any other failure leaves the lists unknown.
    const complete = remotes.ok && tracked.ok && (history.ok || !head.ok);
    return {
      folder,
      exactRepository,
      complete,
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
    if (!inspection.complete) {
      this.log.appendLine(`[git] Could not list everything in ${inspection.folder}; treating it as unsafe to repair.`);
      return false;
    }
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
      const hasHead = await this.run(system.folder, ["rev-parse", "--verify", "HEAD"], { logFailure: false });
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
      this.run(folder, ["config", "--get", "user.name"], { logFailure: false }),
      this.run(folder, ["config", "--get", "user.email"], { logFailure: false }),
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
    const gitProblem = await this.gitAvailabilityProblem();
    if (gitProblem) {
      return { status: "setupRequired", message: gitProblem };
    }

    try {
      fs.mkdirSync(folder, { recursive: true });
      const existing = await this.checkExactRepository(folder);
      const exactRepository = existing.ok;
      const managedRepository = exactRepository && await this.isManagedRepository(folder);
      const markerPath = path.join(folder, ".git", "ibmi-member-workspace");
      if (!exactRepository) {
        // Never re-initialize a repository Git failed to open: re-pointing HEAD at the default
        // branch would leave the current work item's files to be committed onto it.
        if (fs.existsSync(path.join(folder, ".git"))) {
          return this.repositoryOpenFailure(folder, existing, "Git could not open the history repository in the checkout folder.");
        }
        const init = await this.run(folder, ["init"]);
        const created = init.ok ? await this.checkExactRepository(folder) : init;
        if (!created.ok) {
          return this.repositoryOpenFailure(folder, created, "Could not create an isolated history repository in the checkout folder.");
        }
        await this.run(folder, ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_WORK_ITEM}`]);
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

      const hasHead = await this.run(folder, ["rev-parse", "--verify", "HEAD"], { logFailure: false });
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

  private repositoryOpenFailure(folder: string, result: CommandResult, message: string): GitOperationResult {
    this.log.appendLine(`[git] Repository setup failed: ${result.stderr}`);
    if (result.stderr.includes("dubious ownership")) {
      return {
        status: "failure",
        message: `Git does not trust the checkout folder because another account owns it (common on network drives). Run "git config --global --add safe.directory ${folder.replace(/\\/g, "/")}", then try again.`,
        details: result.stderr,
      };
    }
    return { status: "failure", message, details: result.stderr };
  }

  async currentBranch(folder: string): Promise<string> {
    // Fails quietly on a detached HEAD, which callers treat as "no work item".
    const branch = await this.run(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"], { logFailure: false });
    return branch.ok ? branch.stdout : "";
  }

  /**
   * The commit new work items start from so they do not inherit another work item's members: the
   * repository's first commit, when it holds nothing but the generated `.gitignore`. Repositories
   * adopted with their own history have no such commit.
   */
  async findCleanBase(folder: string): Promise<string | undefined> {
    const roots = await this.run(folder, ["rev-list", "--max-parents=0", "--first-parent", "HEAD"], { logFailure: false });
    const base = roots.ok ? roots.stdout.split("\n").filter(Boolean).at(-1) : undefined;
    if (!base) {
      return undefined;
    }
    const tree = await this.run(folder, ["ls-tree", "--name-only", "-z", base], { logFailure: false, trimOutput: false });
    if (!tree.ok) {
      return undefined;
    }
    const names = tree.stdout.split("\0").filter(Boolean);
    return names.every((name) => name === ".gitignore") ? base : undefined;
  }

  async renameWorkItem(folder: string, from: string, to: string): Promise<GitOperationResult> {
    if (!(await this.validateBranchName(folder, to))) {
      return { status: "invalidName", message: "Use a short name without spaces or special Git characters, such as TICKET-123." };
    }
    const result = await this.run(folder, ["branch", "-m", from, to]);
    return result.ok
      ? { status: "success" }
      : { status: "failure", message: `Could not rename work item “${from}” to “${to}”.`, details: result.stderr };
  }

  /** Creates a work item without switching to it. */
  async createBranch(folder: string, name: string, startPoint: string): Promise<GitOperationResult> {
    if (!(await this.validateBranchName(folder, name))) {
      return { status: "invalidName", message: "Use a short name without spaces or special Git characters, such as TICKET-123." };
    }
    const result = await this.run(folder, ["branch", name, startPoint]);
    return result.ok
      ? { status: "success" }
      : { status: "failure", message: `Could not create work item “${name}”.`, details: result.stderr };
  }

  /** Which of `filePaths` are committed on `branch`. */
  async trackedInBranch(folder: string, branch: string, filePaths: string[]): Promise<string[]> {
    const root = path.resolve(folder);
    const wanted = new Map(filePaths.map((filePath) => [
      pathKey(gitPath(path.relative(root, path.resolve(filePath)))),
      filePath,
    ]));
    // List the whole branch and filter here: passing every path could exceed the command-line limit.
    const result = await this.run(
      folder,
      ["ls-tree", "-r", "--name-only", "-z", branch],
      { trimOutput: false }
    );
    if (!result.ok) {
      throw new Error(`Could not read work item “${branch}”: ${result.stderr}`);
    }
    return result.stdout.split("\0").filter(Boolean).flatMap((name) => {
      const filePath = wanted.get(pathKey(name));
      return filePath === undefined ? [] : [filePath];
    });
  }

  async listBranches(folder: string): Promise<string[]> {
    const result = await this.run(folder, ["branch", "--format=%(refname:short)"]);
    return result.ok && result.stdout
      ? result.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean)
      : [];
  }

  async validateBranchName(folder: string, name: string): Promise<boolean> {
    return (await this.run(folder, ["check-ref-format", "--branch", name], { logFailure: false })).ok;
  }

  async createWorkItem(folder: string, name: string, startPoint?: string): Promise<GitOperationResult> {
    if (!(await this.validateBranchName(folder, name))) {
      return {
        status: "invalidName",
        message: "Use a short name without spaces or special Git characters, such as TICKET-123.",
      };
    }
    // `switch`, unlike `checkout`, never reads a work item named like a file as a path.
    const result = await this.run(folder, ["switch", "--no-guess", "-c", name, ...(startPoint ? [startPoint] : [])]);
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
    const result = await this.run(folder, ["switch", "--no-guess", name]);
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
    const status = await this.run(folder, ["status", "--porcelain", "-z"], { trimOutput: false });
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

    if (!(await this.currentBranch(folder))) {
      return {
        status: "conflict",
        message: "Local Change History is not on a work item (detached HEAD), so the checkpoint was not saved. Use Switch Work Item to choose one.",
      };
    }

    // Paths go through stdin, not the command line: a batch of ~1000 members would exceed
    // Windows' 32K command-line limit. Literal pathspecs keep names like A*B from matching as globs.
    const pathspecs = { input: relativePaths.map(gitPath).join("\0") };
    const fromStdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
    const stage = await this.run(folder, ["--literal-pathspecs", "add", "-A", ...fromStdin], pathspecs);
    if (!stage.ok) {
      return { status: "failure", message: "Could not prepare files for the checkpoint.", details: stage.stderr };
    }
    // `diff` has no --pathspec-from-file, so list everything staged and match the paths here.
    const staged = await this.run(folder, ["diff", "--cached", "--name-only", "-z"], { trimOutput: false });
    if (!staged.ok) {
      return { status: "failure", message: "Could not inspect checkpoint changes.", details: staged.stderr };
    }
    const requested = new Set(relativePaths.map((relative) => pathKey(gitPath(relative))));
    if (!staged.stdout.split("\0").some((name) => name && requested.has(pathKey(name)))) {
      return { status: "noChanges", message: "No changes since the last checkpoint." };
    }

    // Automatic checkpoints must not block on a signing passphrase prompt or be rejected by hooks
    // inherited from the user's global Git config.
    const commit = await this.run(
      folder,
      ["--literal-pathspecs", "-c", "commit.gpgsign=false", "commit", "--only", "--no-verify", "-m", message, ...fromStdin],
      pathspecs
    );
    if (!commit.ok) {
      return { status: "failure", message: "Could not save the checkpoint.", details: commit.stderr };
    }
    this.log.appendLine(`[git] Saved checkpoint: ${message}`);
    return { status: "success" };
  }
}
