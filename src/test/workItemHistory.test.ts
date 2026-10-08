import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import type { GitOperationResult } from "../gitService";
import { HistoryGit, WorkItemHistory, WorkItemHistoryDeps, pathIsInside } from "../workItemHistory";
import { CheckedOutMember, SystemCheckoutState, systemKey } from "../types";

const ROOT = path.resolve("/checkouts");
const SYS_ROOT = path.join(ROOT, "SYS");
const ok: GitOperationResult = { status: "success" };

function member(name: string, overrides: Partial<CheckedOutMember> = {}): CheckedOutMember {
  return {
    id: `SYS/MYLIB/QRPGLESRC/${name}`,
    system: "SYS",
    library: "MYLIB",
    sourceFile: "QRPGLESRC",
    memberName: name,
    extension: "rpgle",
    localPath: path.join(SYS_ROOT, "MYLIB", "QRPGLESRC", `${name}.RPGLE`),
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    remoteHashAtCheckout: "base",
    status: "in-sync",
    ...overrides,
  };
}

/** A fake Git that records every call; results can be scripted per method. */
function fakeGit(script: Partial<Record<keyof HistoryGit, (...args: unknown[]) => unknown>> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let branch = "workspace";
  const branches = new Set(["workspace"]);
  const defaults: Record<keyof HistoryGit, (...args: unknown[]) => unknown> = {
    gitAvailabilityProblem: async () => undefined,
    invalidateAvailability: () => undefined,
    isExactRepository: async () => false,
    prepareRepository: async () => ok,
    configureLocalIdentity: async () => ok,
    currentBranch: async () => branch,
    listBranches: async () => [...branches],
    createBranch: async (_folder, name) => {
      branches.add(String(name));
      return ok;
    },
    findCleanBase: async () => "base-commit",
    trackedInBranch: async () => [],
    switchWorkItem: async (_folder, name) => {
      branch = String(name);
      return ok;
    },
    getWorkingTreeState: async () => ok,
    changedPaths: async () => [],
    saveCheckpoint: async () => ok,
    migrateLegacyRepository: async () => ({ status: "success", restoredBranches: { SYS: ["feature"] } }),
    detectMisplacedParentRepository: async () => undefined,
    isSafeMisplacedRepository: () => true,
    archiveMisplacedRepository: async () => ({ gitBackup: "backup" }),
    inspectRepository: async () => undefined,
  };
  const git = Object.fromEntries(
    (Object.keys(defaults) as Array<keyof HistoryGit>).map((name) => [
      name,
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return (script[name] ?? defaults[name])(...args);
      },
    ])
  ) as unknown as HistoryGit;
  return { git, calls, setBranch: (name: string) => (branch = name), branches };
}

function harness(options: {
  git?: HistoryGit | undefined;
  entries?: CheckedOutMember[];
  identity?: { name: string; email: string } | undefined;
  confirmRepository?: boolean;
  trusted?: string[];
  gitIntegrationOn?: boolean;
  inBatch?: () => boolean;
} = {}) {
  const files = new Map<string, Uint8Array>();
  for (const entry of options.entries ?? []) {
    files.set(entry.localPath, Buffer.from(entry.memberName));
  }
  const state: SystemCheckoutState = {
    system: "SYS",
    directory: "SYS",
    activeWorkItem: "workspace",
    workItems: { workspace: options.entries ?? [] },
  };
  const systems: Record<string, SystemCheckoutState> = {};
  const trusted = new Set(options.trusted ?? []);
  const warnings: string[] = [];
  const logs: string[] = [];
  const readOnly: string[] = [];
  const asked = { identity: 0, repository: 0 };
  let persisted = 0;
  const deps: WorkItemHistoryDeps = {
    git: "git" in options ? options.git : fakeGit().git,
    files: {
      exists: (localPath) => files.has(localPath),
      read: async (localPath) => {
        const content = files.get(localPath);
        if (!content) {
          throw new Error(`missing ${localPath}`);
        }
        return content;
      },
      write: async (localPath, content) => {
        files.set(localPath, content);
      },
      remove: (localPath) => {
        files.delete(localPath);
      },
      setReadOnly: async (localPath, value) => {
        if (value) {
          readOnly.push(localPath);
        }
      },
    },
    ui: {
      askIdentity: async () => {
        asked.identity++;
        return "identity" in options ? options.identity : { name: "Dev", email: "dev@example.com" };
      },
      confirmRepositoryUse: async () => {
        asked.repository++;
        return options.confirmRepository ?? false;
      },
      warn: (message) => warnings.push(message),
    },
    trust: {
      isTrusted: (folder) => trusted.has(folder),
      trust: async (folder) => {
        trusted.add(folder);
      },
    },
    gitIntegrationOn: () => options.gitIntegrationOn ?? true,
    connectedSystem: () => "SYS",
    checkoutRoot: () => ROOT,
    gitRoot: (system) => path.join(ROOT, system),
    systemState: (system) => systems[systemKey(system)],
    ensureSystemState: (system) => (systems[systemKey(system)] ??= state),
    knownSystems: () => Object.values(systems),
    activeEntries: (system) => {
      const current = (systems[systemKey(system)] ??= state);
      return current.workItems[current.activeWorkItem] ??= [];
    },
    managedPaths: (system) => (systems[systemKey(system)]?.workItems[state.activeWorkItem] ?? []).map((entry) => entry.localPath),
    inBatch: options.inBatch ?? (() => false),
    persist: async () => {
      persisted++;
    },
    assertLocalPathSafe: () => undefined,
    log: (message) => logs.push(message),
  };
  const history = new WorkItemHistory(deps);
  return { history, state, files, trusted, warnings, logs, readOnly, asked, persisted: () => persisted };
}

describe("pathIsInside", () => {
  it("accepts paths strictly inside the folder only", () => {
    assert.equal(pathIsInside(SYS_ROOT, path.join(SYS_ROOT, "A", "B.RPGLE")), true);
    assert.equal(pathIsInside(SYS_ROOT, SYS_ROOT), false);
    assert.equal(pathIsInside(SYS_ROOT, path.join(SYS_ROOT, "..", "OTHER", "B.RPGLE")), false);
    assert.equal(pathIsInside(SYS_ROOT, path.join(ROOT, "SYSX", "B.RPGLE")), false);
  });
});

describe("WorkItemHistory: preparing the repository", () => {
  it("prepares a new system folder's repository, trusts it, and follows its branch", async () => {
    const fake = fakeGit({ isExactRepository: async () => true });
    fake.setBranch("feature");
    const h = harness({ git: fake.git, entries: [member("PROG")] });
    // A repository that exists before the first preparation must be confirmed; this one is created by it.
    let created = false;
    const git = fake.git as unknown as Record<string, (...args: unknown[]) => unknown>;
    const prepare = git.prepareRepository;
    git.prepareRepository = async (...args: unknown[]) => {
      created = true;
      return prepare(...args);
    };
    const isExact = git.isExactRepository;
    git.isExactRepository = async (...args: unknown[]) => created && await isExact(...args);

    assert.deepEqual(await h.history.ensureGitReady("SYS"), ok);
    assert.equal(h.asked.repository, 0);
    assert.ok(h.trusted.has(SYS_ROOT));
    // The default work item takes the branch's name, keeping its members.
    assert.equal(h.state.activeWorkItem, "feature");
    assert.deepEqual(h.state.workItems.feature.map((entry) => entry.memberName), ["PROG"]);
    assert.equal(h.state.workItems.workspace, undefined);
  });

  it("asks for an author once, and remembers a cancelled setup for the session", async () => {
    let configured = false;
    const fake = fakeGit({
      prepareRepository: async () => (configured ? ok : { status: "setupRequired" }),
      configureLocalIdentity: async () => {
        configured = true;
        return ok;
      },
    });
    const declined = harness({ git: fake.git, identity: undefined });
    assert.equal((await declined.history.ensureGitReady("SYS")).status, "setupRequired");
    assert.equal((await declined.history.ensureGitReady("SYS")).status, "setupRequired");
    assert.equal(declined.asked.identity, 1);

    const given = harness({ git: fake.git });
    assert.deepEqual(await given.history.ensureGitReady("SYS"), ok);
    assert.ok(fake.calls.some(([name, , author, email]) => name === "configureLocalIdentity" && author === "Dev" && email === "dev@example.com"));
  });

  it("uses a repository it didn't create only after the user agrees, asking once per session", async () => {
    const fake = fakeGit({ isExactRepository: async () => true });
    const refused = harness({ git: fake.git, confirmRepository: false });
    assert.equal((await refused.history.ensureGitReady("SYS")).status, "setupRequired");
    assert.equal((await refused.history.ensureGitReady("SYS")).status, "setupRequired");
    assert.equal(refused.asked.repository, 1);
    assert.equal(fake.calls.filter(([name]) => name === "prepareRepository").length, 0);

    refused.history.resetSetupState();
    assert.equal((await refused.history.ensureGitReady("SYS")).status, "setupRequired");
    assert.equal(refused.asked.repository, 2);

    const agreed = harness({ git: fakeGit({ isExactRepository: async () => true }).git, confirmRepository: true });
    assert.deepEqual(await agreed.history.ensureGitReady("SYS"), ok);
    assert.ok(agreed.trusted.has(SYS_ROOT));

    const trusted = harness({ git: fakeGit({ isExactRepository: async () => true }).git, trusted: [SYS_ROOT] });
    assert.deepEqual(await trusted.history.ensureGitReady("SYS"), ok);
    assert.equal(trusted.asked.repository, 0);
  });

  it("shares one preparation between calls at the same time, and reuses it for the whole batch", async () => {
    const fake = fakeGit();
    let batch = true;
    const h = harness({ git: fake.git, inBatch: () => batch });
    await Promise.all([h.history.ensureGitReady("SYS"), h.history.ensureGitReady("SYS")]);
    await h.history.ensureGitReady("SYS");
    assert.equal(fake.calls.filter(([name]) => name === "prepareRepository").length, 1);
    batch = false;
    h.history.endBatch();
    await h.history.ensureGitReady("SYS");
    assert.equal(fake.calls.filter(([name]) => name === "prepareRepository").length, 2);
  });

  it("says why when Local Change History is off or Git is missing, warning once", async () => {
    const off = harness({ gitIntegrationOn: false });
    assert.match((await off.history.ensureGitReady("SYS")).message ?? "", /Enable Local Change History/);
    assert.equal(await off.history.isGitEnabled(), false);

    const missing = harness({ git: fakeGit({ gitAvailabilityProblem: async () => "Git 2.20 is too old." }).git });
    assert.match((await missing.history.ensureGitReady("SYS")).message ?? "", /Git 2\.20 is too old\. Install or update Git/);
    assert.equal(await missing.history.isGitEnabled(), false);
    assert.equal(missing.warnings.length, 1);
  });
});

describe("WorkItemHistory: checkpoints", () => {
  it("saves a checkpoint in the system's repository, and refuses paths of another one", async () => {
    const fake = fakeGit();
    const h = harness({ git: fake.git });
    const inside = member("PROG").localPath;
    assert.deepEqual(await h.history.saveCheckpoint("SYS", [inside], "upload: PROG"), ok);
    assert.ok(fake.calls.some(([name, folder, paths, message, prepare]) =>
      name === "saveCheckpoint" && folder === SYS_ROOT && (paths as string[])[0] === inside && message === "upload: PROG" && prepare === false
    ));
    const elsewhere = path.join(ROOT, "OTHER", "X.RPGLE");
    assert.equal((await h.history.saveCheckpoint("SYS", [elsewhere], "x")).status, "failure");
  });

  it("saves no batch checkpoint for no paths, and logs a failed one without stopping", async () => {
    const fake = fakeGit({ saveCheckpoint: async () => ({ status: "failure", message: "Disk full", details: "ENOSPC" }) });
    const h = harness({ git: fake.git });
    await h.history.saveBatchCheckpoint("SYS", [], "nothing");
    assert.equal(fake.calls.filter(([name]) => name === "saveCheckpoint").length, 0);
    await h.history.saveBatchCheckpoint("SYS", [member("PROG").localPath], "checkout: 1 member");
    await h.history.saveBatchCheckpoint("SYS", [member("PROG").localPath], "checkout: 1 member");
    assert.deepEqual(h.logs.filter((line) => line.startsWith("[git]")), ["[git] Disk full: ENOSPC", "[git] Disk full: ENOSPC"]);
    assert.equal(h.warnings.length, 1);
  });

  it("treats a checkpoint with nothing new as no failure", () => {
    const h = harness();
    h.history.logGitFailure({ status: "noChanges" });
    assert.deepEqual(h.logs, []);
    assert.deepEqual(h.warnings, []);
  });
});

describe("WorkItemHistory: work items", () => {
  it("activates a work item, dropping members whose files are gone and protecting reference copies", async () => {
    const kept = member("KEPT");
    const reference = member("REF", { kind: "reference" });
    const gone = member("GONE");
    const h = harness({ entries: [kept, reference] });
    h.state.workItems.feature = [kept, reference, gone];
    await h.history.activateWorkItem("SYS", "feature");
    assert.equal(h.state.activeWorkItem, "feature");
    assert.deepEqual(h.state.workItems.feature.map((entry) => entry.memberName), ["KEPT", "REF"]);
    assert.deepEqual(h.readOnly, [reference.localPath]);
    assert.ok(h.persisted() > 0);
  });

  it("starts a work item as a copy of the current members, or empty", async () => {
    const h = harness({ entries: [member("PROG")] });
    await h.history.startWorkItem("SYS", "copy", "copy");
    assert.equal(h.state.activeWorkItem, "copy");
    assert.equal(h.state.workItems.copy.length, 1);
    assert.equal(h.state.workItems.workspace.length, 1);
    await h.history.startWorkItem("SYS", "empty", "empty");
    assert.deepEqual(h.state.workItems.empty, []);
  });

  it("asks which work item a checkout belongs to on the default one, then once per session", async () => {
    const fake = fakeGit();
    const h = harness({ git: fake.git });
    assert.equal(await h.history.needsWorkItemChoice("SYS"), true);
    fake.setBranch("feature");
    h.state.activeWorkItem = "feature";
    assert.equal(await h.history.needsWorkItemChoice("SYS"), true);
    h.history.confirmWorkItem("SYS");
    assert.equal(await h.history.needsWorkItemChoice("SYS"), false);
  });

  it("refuses an entry the active work item no longer holds", async () => {
    const h = harness({ entries: [member("PROG")] });
    await h.history.assertEntryInActiveWorkItem(h.state.workItems.workspace[0]);
    await assert.rejects(h.history.assertEntryInActiveWorkItem(member("PROG")), /The active work item changed/);
    const off = harness({ gitIntegrationOn: false });
    await off.history.assertEntryInActiveWorkItem(member("PROG"));
  });
});

describe("WorkItemHistory: moving members", () => {
  it("commits the members on the new work item before removing them from the current one", async () => {
    const fake = fakeGit();
    const prog = member("PROG");
    const h = harness({ git: fake.git, entries: [prog] });
    const result = await h.history.moveEntries("SYS", [prog], "feature", true);
    assert.deepEqual(result, { status: "success" });
    const order = fake.calls
      .filter(([name]) => name === "createBranch" || name === "switchWorkItem" || name === "saveCheckpoint")
      .map(([name, , second, third]) => (name === "saveCheckpoint" ? `${name} ${String(third)}` : `${name} ${String(second)}`));
    assert.deepEqual(order, [
      "createBranch feature",
      "switchWorkItem feature",
      "saveCheckpoint move: MYLIB/QRPGLESRC(PROG) from workspace",
      "switchWorkItem workspace",
      "saveCheckpoint move: MYLIB/QRPGLESRC(PROG) to feature",
    ]);
    assert.deepEqual(h.state.workItems.workspace, []);
    assert.deepEqual(h.state.workItems.feature.map((entry) => entry.memberName), ["PROG"]);
    assert.equal(h.files.has(prog.localPath), false);
    assert.equal(h.state.activeWorkItem, "workspace");
  });

  it("goes back and leaves the current work item alone when the commit on the target fails", async () => {
    let checkpoints = 0;
    const fake = fakeGit({
      saveCheckpoint: async () => (++checkpoints === 1 ? { status: "failure", message: "hook failed" } : ok),
    });
    const prog = member("PROG");
    const h = harness({ git: fake.git, entries: [prog] });
    const result = await h.history.moveEntries("SYS", [prog], "feature", true);
    assert.equal(result.status, "failure");
    assert.match(result.message ?? "", /Nothing was changed in “workspace”/);
    assert.deepEqual(h.state.workItems.workspace.map((entry) => entry.memberName), ["PROG"]);
    assert.ok(fake.calls.some(([name, , branch, allowDirty]) => name === "switchWorkItem" && branch === "workspace" && allowDirty === true));
  });

  it("refuses to move into a work item that has the member, or that doesn't exist", async () => {
    const prog = member("PROG");
    const fake = fakeGit();
    fake.branches.add("feature");
    const h = harness({ git: fake.git, entries: [prog] });
    h.state.workItems.feature = [member("PROG")];
    assert.equal((await h.history.moveEntries("SYS", [prog], "feature", false)).status, "conflict");
    assert.equal((await h.history.moveEntries("SYS", [prog], "nope", false)).status, "failure");
    assert.equal((await h.history.moveEntries("SYS", [prog], "feature", true)).status, "conflict");
    assert.equal((await h.history.moveEntries("SYS", [prog], "workspace", false)).status, "noChanges");
    assert.deepEqual(h.state.workItems.workspace.map((entry) => entry.memberName), ["PROG"]);
  });
});

describe("WorkItemHistory: legacy layout", () => {
  it("restores the branches a migration found as work items", async () => {
    const h = harness({ trusted: [SYS_ROOT] });
    h.history.confirmWorkItem("SYS");
    const result = await h.history.migrateLegacyRepository();
    assert.equal(result.status, "success");
    assert.deepEqual(h.state.workItems.feature, []);
  });

  it("needs a checkout folder and Git for the repairs", async () => {
    const h = harness({ git: undefined });
    assert.equal((await h.history.migrateLegacyRepository()).status, "setupRequired");
    await assert.rejects(h.history.archiveMisplacedRepository(), /Choose a checkout folder first/);
  });
});
