import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GitService } from "../gitService";

function git(folder: string, ...args: string[]): string {
  return execFileSync("git", ["-C", folder, ...args], { encoding: "utf-8" }).trim();
}

async function readyRepository(): Promise<{ folder: string; service: GitService }> {
  const folder = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-git-"));
  const service = new GitService({ appendLine: () => undefined });
  assert.ok(["success", "setupRequired"].includes((await service.prepareRepository(folder)).status));
  assert.equal(
    (await service.configureLocalIdentity(folder, "Test User", "test@example.com")).status,
    "success"
  );
  assert.equal((await service.prepareRepository(folder)).status, "success");
  return { folder, service };
}

describe("GitService", () => {
  it("creates an isolated repository inside a parent repository", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-parent-"));
    try {
      git(parent, "init");
      const checkout = join(parent, "checkouts");
      mkdirSync(checkout);
      const service = new GitService({ appendLine: () => undefined });

      assert.ok(["success", "setupRequired"].includes((await service.prepareRepository(checkout)).status));
      assert.equal(realpathSync((await service.repositoryRoot(checkout))!), realpathSync(checkout));
      assert.equal(await service.isManagedRepository(checkout), true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("adopts an existing exact system repository without changing its history or remotes", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-unrelated-"));
    try {
      git(folder, "init");
      git(folder, "config", "user.name", "Existing User");
      git(folder, "config", "user.email", "existing@example.com");
      writeFileSync(join(folder, "existing.txt"), "history\n");
      git(folder, "add", "existing.txt");
      git(folder, "commit", "-m", "existing history");
      git(folder, "remote", "add", "origin", "https://example.com/existing.git");
      const head = git(folder, "rev-parse", "HEAD");
      const service = new GitService({ appendLine: () => undefined });
      assert.equal((await service.prepareRepository(folder)).status, "success");
      assert.equal(git(folder, "rev-parse", "HEAD"), head);
      assert.equal(git(folder, "remote", "get-url", "origin"), "https://example.com/existing.git");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("repairs gitlink-based parent history into an existing child repository", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-repair-"));
    try {
      const service = new GitService({ appendLine: () => undefined });
      assert.ok(["success", "setupRequired"].includes((await service.prepareRepository(parent)).status));
      await service.configureLocalIdentity(parent, "Test User", "test@example.com");
      assert.equal((await service.prepareRepository(parent)).status, "success");
      const child = join(parent, "alpha.example");
      mkdirSync(child);
      git(child, "init");
      git(child, "config", "user.name", "Child User");
      git(child, "config", "user.email", "child@example.com");
      writeFileSync(join(child, "member.rpgle"), "child history\n");
      git(child, "add", "member.rpgle");
      git(child, "commit", "-m", "child history");
      git(child, "remote", "add", "origin", "https://example.com/child.git");
      const childHead = git(child, "rev-parse", "HEAD");
      const originalBranch = git(child, "branch", "--show-current");
      git(parent, "add", "alpha.example");
      git(parent, "commit", "-m", "legacy gitlink");
      git(parent, "branch", "LEGACY-ONLY");

      const inspection = await service.detectMisplacedParentRepository(parent);
      assert.ok(inspection);
      assert.equal(service.isSafeMisplacedRepository(inspection, ["alpha.example"]), true);
      const result = await service.migrateLegacyRepository(parent, [{
        system: "alpha.example",
        folder: child,
        workItems: ["workspace", "TICKET-42"],
      }]);
      assert.equal(result.status, "success");
      assert.deepEqual(
        new Set(await service.listBranches(child)),
        new Set([originalBranch, "workspace", "TICKET-42", "LEGACY-ONLY"])
      );
      assert.equal(git(child, "rev-parse", "HEAD"), childHead);
      assert.equal(git(child, "remote", "get-url", "origin"), "https://example.com/child.git");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses automated parent repair when unrelated history exists", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-unsafe-"));
    try {
      const service = new GitService({ appendLine: () => undefined });
      await service.prepareRepository(parent);
      await service.configureLocalIdentity(parent, "Test User", "test@example.com");
      await service.prepareRepository(parent);
      writeFileSync(join(parent, "notes.txt"), "do not migrate\n");
      git(parent, "add", "notes.txt");
      git(parent, "commit", "-m", "unrelated file");
      const inspection = (await service.detectMisplacedParentRepository(parent))!;
      assert.equal(service.isSafeMisplacedRepository(inspection, ["alpha.example"]), false);
      assert.equal((await service.migrateLegacyRepository(parent, [])).status, "conflict");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("commits only requested paths and leaves unrelated staged files staged", async () => {
    const { folder, service } = await readyRepository();
    try {
      const member = join(folder, "MEMBER.RPGLE");
      const unrelated = join(folder, "notes.txt");
      writeFileSync(member, "first\n");
      writeFileSync(unrelated, "staged separately\n");
      assert.equal((await service.saveCheckpoint(folder, [member], "first member")).status, "success");

      git(folder, "add", "notes.txt");
      writeFileSync(member, "second\n");
      assert.deepEqual(
        new Set(await service.changedPaths(folder)),
        new Set([member, unrelated])
      );
      assert.equal((await service.saveCheckpoint(folder, [member], "second member")).status, "success");

      assert.equal(git(folder, "diff", "--cached", "--name-only"), "notes.txt");
      assert.equal(git(folder, "show", "--format=", "--name-only", "HEAD"), "MEMBER.RPGLE");
      assert.equal(readFileSync(member, "utf-8"), "second\n");
      assert.equal((await service.saveCheckpoint(folder, [member], "duplicate")).status, "noChanges");

      rmSync(member);
      assert.equal((await service.saveCheckpoint(folder, [member], "discard member")).status, "success");
      assert.match(git(folder, "show", "--format=", "--name-status", "HEAD"), /^D\s+MEMBER\.RPGLE$/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("validates work-item names and switches clean work items", async () => {
    const { folder, service } = await readyRepository();
    try {
      assert.equal((await service.createWorkItem(folder, "bad name")).status, "invalidName");
      assert.equal((await service.createWorkItem(folder, "TICKET-123")).status, "success");
      assert.equal(await service.currentBranch(folder), "TICKET-123");
      writeFileSync(join(folder, "dirty.txt"), "not checkpointed\n");
      assert.equal((await service.switchWorkItem(folder, "workspace")).status, "dirtyWorktree");
      rmSync(join(folder, "dirty.txt"));
      assert.equal((await service.switchWorkItem(folder, "workspace")).status, "success");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
