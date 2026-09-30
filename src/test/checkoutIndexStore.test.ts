import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_CHANGE_INTERVAL_MS,
  CheckoutIndexStore,
  CheckoutIndexStoreDeps,
  INDEX_FILE,
  IndexStorage,
} from "../checkoutIndexStore";
import type { CheckedOutMember, CheckoutIndex } from "../types";

class MemoryStorage implements IndexStorage {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  failWrites = false;
  /** Holds each write until released, to check that writes don't overlap. */
  gate: Promise<void> | undefined;

  async read(name: string): Promise<Uint8Array> {
    const text = this.files.get(name);
    if (text === undefined) {
      throw new Error(`ENOENT: ${name}`);
    }
    return Buffer.from(text, "utf-8");
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    this.writes.push(`start ${name}`);
    await this.gate;
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.files.set(name, Buffer.from(data).toString("utf-8"));
    this.writes.push(`end ${name}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.files.get(from);
    assert.ok(text !== undefined, `${from} exists`);
    this.files.delete(from);
    this.files.set(to, text);
  }

  location(name: string): string {
    return `/storage/${name}`;
  }

  saved(): CheckoutIndex {
    return JSON.parse(this.files.get(INDEX_FILE) ?? "null") as CheckoutIndex;
  }
}

interface Harness {
  store: CheckoutIndexStore;
  storage: MemoryStorage;
  changes: number;
  logs: string[];
  warnings: string[];
  errors: string[];
  timers: Array<{ callback: () => void; ms: number; cleared: boolean }>;
}

/** `null`: no folder or workspace, so no storage. */
function harness(storage: MemoryStorage | null = new MemoryStorage()): Harness {
  const h = { changes: 0, logs: [], warnings: [], errors: [], timers: [] } as unknown as Harness;
  const deps: CheckoutIndexStoreDeps = {
    storage: storage ?? undefined,
    onChange: () => h.changes++,
    log: (message) => h.logs.push(message),
    showWarning: (message) => h.warnings.push(message),
    showError: (message) => h.errors.push(message),
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      h.timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  h.store = new CheckoutIndexStore(deps);
  h.storage = storage as MemoryStorage;
  return h;
}

function member(name: string): CheckedOutMember {
  return {
    id: `SYS/MYLIB/QRPGLESRC/${name}`,
    system: "SYS",
    library: "MYLIB",
    sourceFile: "QRPGLESRC",
    memberName: name,
    extension: "rpgle",
    localPath: `/checkouts/SYS/MYLIB/QRPGLESRC/${name}.rpgle`,
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    remoteHashAtCheckout: "abc",
    hashVersion: 2,
    status: "in-sync",
  };
}

function v3Index(...names: string[]): CheckoutIndex {
  return {
    version: 3,
    systems: {
      SYS: { system: "SYS", directory: "SYS", activeWorkItem: "workspace", workItems: { workspace: names.map(member) } },
    },
    unassignedWorkItems: {},
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("CheckoutIndexStore", () => {
  it("starts empty when there is no index yet", async () => {
    const h = harness();
    await h.store.load();
    assert.deepEqual(h.store.index, { version: 3, systems: {}, unassignedWorkItems: {} });
    assert.equal(h.storage.writes.length, 0);
    assert.deepEqual(h.warnings, []);
  });

  it("starts empty and can't save without a folder or workspace", async () => {
    const h = harness(null);
    await h.store.load();
    assert.deepEqual(h.store.index.systems, {});
    await assert.rejects(h.store.save(), /Open a folder or workspace/);
  });

  it("loads a current index as it is", async () => {
    const h = harness();
    h.storage.files.set(INDEX_FILE, JSON.stringify(v3Index("PROG")));
    await h.store.load();
    assert.equal(h.store.index.systems.SYS.workItems.workspace[0].memberName, "PROG");
    assert.equal(h.storage.writes.length, 0);
  });

  it("backs up an older index and saves it as the current version", async () => {
    const h = harness();
    const v2 = { version: 2, activeWorkItem: "workspace", workItems: { workspace: [member("PROG")] } };
    h.storage.files.set(INDEX_FILE, JSON.stringify(v2));
    await h.store.load();
    assert.deepEqual(JSON.parse(h.storage.files.get("checkout-index.v2-backup.json")!), v2);
    assert.equal(h.storage.saved().version, 3);
    assert.ok(h.logs.some((line) => line.includes("/storage/checkout-index.v2-backup.json")));
  });

  it("backs up an unreadable index, starts empty, and warns", async () => {
    const h = harness();
    h.storage.files.set(INDEX_FILE, "{ not json");
    await h.store.load();
    assert.deepEqual(h.store.index.systems, {});
    const backups = [...h.storage.files.keys()].filter((name) => /^checkout-index\.corrupt-.+\.json$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(h.storage.files.get(backups[0]), "{ not json");
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /could not be read and was reset/);
    // The unreadable index is left for the user; it isn't overwritten until the next change.
    assert.equal(h.storage.files.get(INDEX_FILE), "{ not json");
  });

  it("writes through a temp file and renames it into place", async () => {
    const h = harness();
    h.store.index = v3Index("PROG");
    await h.store.save();
    assert.deepEqual(h.storage.writes, ["start checkout-index.json.tmp", "end checkout-index.json.tmp"]);
    assert.equal(h.storage.files.has("checkout-index.json.tmp"), false);
    assert.equal(h.storage.saved().systems.SYS.workItems.workspace[0].memberName, "PROG");
  });

  it("writes one save at a time, in order", async () => {
    const h = harness();
    const gate = deferred();
    h.storage.gate = gate.promise;
    h.store.index = v3Index("FIRST");
    const first = h.store.save();
    h.store.index = v3Index("SECOND");
    const second = h.store.save();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.storage.writes, ["start checkout-index.json.tmp"]);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(h.storage.writes, [
      "start checkout-index.json.tmp",
      "end checkout-index.json.tmp",
      "start checkout-index.json.tmp",
      "end checkout-index.json.tmp",
    ]);
    assert.equal(h.storage.saved().systems.SYS.workItems.workspace[0].memberName, "SECOND");
  });

  it("notifies and saves on each change outside a batch", async () => {
    const h = harness();
    await h.store.persist();
    assert.equal(h.changes, 1);
    assert.ok(h.storage.files.has(INDEX_FILE));
  });

  it("waits for the end of a batch to save, and throttles notifications", async () => {
    const h = harness();
    h.store.beginBatch();
    assert.equal(h.store.inBatch, true);
    await h.store.persist();
    await h.store.persist();
    await h.store.persist();
    assert.equal(h.storage.writes.length, 0);
    assert.equal(h.changes, 0);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, BATCH_CHANGE_INTERVAL_MS);

    h.timers[0].callback();
    assert.equal(h.changes, 1);
    await h.store.persist();
    assert.equal(h.timers.length, 2);

    await h.store.endBatch();
    assert.equal(h.store.inBatch, false);
    assert.equal(h.timers[1].cleared, true);
    assert.equal(h.changes, 2);
    assert.deepEqual(h.storage.writes, ["start checkout-index.json.tmp", "end checkout-index.json.tmp"]);
  });

  it("saves only when the outermost batch ends", async () => {
    const h = harness();
    h.store.beginBatch();
    h.store.beginBatch();
    await h.store.persist();
    const inner = h.store.endBatch();
    assert.equal(h.store.inBatch, true);
    await inner;
    assert.equal(h.storage.writes.length, 0);
    const outer = h.store.endBatch();
    // The depth drops before the save finishes.
    assert.equal(h.store.inBatch, false);
    await outer;
    assert.ok(h.storage.files.has(INDEX_FILE));
  });

  it("doesn't write when a batch changed nothing", async () => {
    const h = harness();
    h.store.beginBatch();
    await h.store.endBatch();
    assert.equal(h.storage.writes.length, 0);
    assert.equal(h.changes, 0);
  });

  it("reports a failed save at the end of a batch and saves again after the next batch", async () => {
    const h = harness();
    h.storage.failWrites = true;
    h.store.beginBatch();
    await h.store.persist();
    await h.store.endBatch();
    assert.deepEqual(h.errors, ["Could not save the checkout index: disk full"]);
    assert.ok(h.logs.includes("[index] Could not save checkout index: disk full"));
    assert.equal(h.storage.files.has(INDEX_FILE), false);

    // The failed save left the index dirty, so the next batch writes it even without a change.
    h.storage.failWrites = false;
    h.store.beginBatch();
    await h.store.endBatch();
    assert.ok(h.storage.files.has(INDEX_FILE));
  });

  it("stops a pending notification when disposed", async () => {
    const h = harness();
    h.store.beginBatch();
    await h.store.persist();
    h.store.dispose();
    assert.equal(h.timers[0].cleared, true);
  });
});
