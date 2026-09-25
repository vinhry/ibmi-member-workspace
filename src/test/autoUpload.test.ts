import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_UPLOAD_BUSY_RETRY_MS,
  AUTO_UPLOAD_DEBOUNCE_MS,
  AutoUploadDeps,
  AutoUploadMode,
  AutoUploadScheduler,
  hasLocalEditsToUpload,
} from "../autoUpload";
import type { CheckedOutMember, CheckoutStatus } from "../types";

const PATH = "/checkouts/SYS/MYLIB/QRPGLESRC/PROG.RPGLE";

function member(status: CheckoutStatus = "modified", id = "PROG"): CheckedOutMember {
  return {
    id,
    system: "SYS",
    library: "MYLIB",
    sourceFile: "QRPGLESRC",
    memberName: id,
    extension: "rpgle",
    localPath: PATH,
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    remoteHashAtCheckout: "abc",
    status,
  };
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A scheduler with fake timers and controllable dependencies. */
function harness(
  options: Omit<Partial<AutoUploadDeps>, "mode"> & { initialMode?: AutoUploadMode; entry?: CheckedOutMember } = {}
) {
  const { initialMode, entry: initialEntry, ...overrides } = options;
  let mode: AutoUploadMode = initialMode ?? "silent";
  let entry: CheckedOutMember | undefined = initialEntry ?? member();
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextTimer = 1;
  const uploads: CheckedOutMember[] = [];
  const logs: string[] = [];
  let busy = false;

  const scheduler = new AutoUploadScheduler({
    mode: () => mode,
    findEntry: () => entry,
    skipReason: () => undefined,
    isBusy: () => busy,
    confirm: async () => "upload",
    setMode: async (value) => {
      mode = value;
    },
    upload: async (value) => {
      uploads.push(value);
    },
    log: (message) => logs.push(message),
    setTimer: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    ...overrides,
  });

  return {
    scheduler,
    uploads,
    logs,
    timers,
    setEntry: (value: CheckedOutMember | undefined) => (entry = value),
    setBusy: (value: boolean) => (busy = value),
    getMode: () => mode,
    /** Fires every pending timer, then lets the uploads they start progress. */
    async fireTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { callback } of pending) {
        callback();
      }
      await settle();
    },
  };
}

describe("hasLocalEditsToUpload", () => {
  it("uploads only checkouts with local edits", () => {
    assert.equal(hasLocalEditsToUpload("modified"), true);
    assert.equal(hasLocalEditsToUpload("conflict"), true);
    for (const status of ["in-sync", "merged", "checked-out", "remote-changed"] as const) {
      assert.equal(hasLocalEditsToUpload(status), false, status);
    }
  });
});

describe("AutoUploadScheduler", () => {
  it("does nothing while the setting is off", async () => {
    const h = harness({ initialMode: "off" });
    h.scheduler.schedule(PATH);
    assert.equal(h.timers.size, 0);
  });

  it("coalesces a burst of saves into one upload", async () => {
    const h = harness();
    h.scheduler.schedule(PATH);
    h.scheduler.schedule(PATH);
    h.scheduler.schedule(PATH);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, AUTO_UPLOAD_DEBOUNCE_MS);
    await h.fireTimers();
    assert.equal(h.uploads.length, 1);
  });

  it("skips a save without local edits, so no IBM i call is made", async () => {
    for (const status of ["in-sync", "merged", "checked-out", "remote-changed"] as const) {
      const h = harness({ entry: member(status) });
      h.scheduler.schedule(PATH);
      await h.fireTimers();
      assert.equal(h.uploads.length, 0, status);
    }
  });

  it("skips and logs when the checkout can't be uploaded now", async () => {
    const h = harness({ skipReason: () => "not connected to the IBM i" });
    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.equal(h.uploads.length, 0);
    assert.match(h.logs.join("\n"), /not connected to the IBM i/);
  });

  it("resolves the checkout when the upload runs, not when the file was saved", async () => {
    const h = harness();
    h.scheduler.schedule(PATH);
    const moved = member("modified", "MOVED");
    h.setEntry(moved);
    await h.fireTimers();
    assert.deepEqual(h.uploads, [moved]);

    h.setEntry(undefined);
    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.equal(h.uploads.length, 1);
  });

  it("waits for another operation to finish instead of dropping the upload", async () => {
    const h = harness();
    h.setBusy(true);
    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.equal(h.uploads.length, 0);
    assert.equal([...h.timers.values()][0].ms, AUTO_UPLOAD_BUSY_RETRY_MS);

    h.setBusy(false);
    await h.fireTimers();
    assert.equal(h.uploads.length, 1);
  });

  it("uploads again after a save made during an upload, never two at once", async () => {
    const first = deferred<void>();
    const uploads: string[] = [];
    const h = harness({
      upload: async () => {
        uploads.push("start");
        if (uploads.length === 1) {
          await first.promise;
        }
        uploads.push("end");
      },
    });
    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.deepEqual(uploads, ["start"]);

    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.deepEqual(uploads, ["start"], "no second upload while the first runs");

    first.resolve();
    await settle();
    assert.deepEqual(uploads, ["start", "end"]);
    assert.equal(h.timers.size, 1, "the later save is uploaded next");
    await h.fireTimers();
    assert.deepEqual(uploads, ["start", "end", "start", "end"]);
  });

  it("recovers after an upload error", async () => {
    let attempts = 0;
    const h = harness({
      upload: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("connection lost");
        }
      },
    });
    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.match(h.logs.join("\n"), /connection lost/);
    h.scheduler.schedule(PATH);
    await h.fireTimers();
    assert.equal(attempts, 2);
  });

  describe("ask mode", () => {
    it("does not upload when the user declines", async () => {
      const h = harness({ initialMode: "ask", confirm: async () => undefined });
      h.scheduler.schedule(PATH);
      await h.fireTimers();
      assert.equal(h.uploads.length, 0);
    });

    it("switches to silent when the user chooses Always Upload", async () => {
      const h = harness({ initialMode: "ask", confirm: async () => "always" });
      h.scheduler.schedule(PATH);
      await h.fireTimers();
      assert.equal(h.getMode(), "silent");
      assert.equal(h.uploads.length, 1);
    });

    it("shows one prompt per file and uploads the latest save once", async () => {
      const answer = deferred<"upload" | "always" | undefined>();
      let prompts = 0;
      const h = harness({
        initialMode: "ask",
        confirm: () => {
          prompts++;
          return answer.promise;
        },
      });
      h.scheduler.schedule(PATH);
      await h.fireTimers();
      h.scheduler.schedule(PATH);
      await h.fireTimers();
      assert.equal(prompts, 1);

      answer.resolve("upload");
      await settle();
      assert.equal(h.uploads.length, 1);
      assert.equal(h.timers.size, 0, "the save made while asking is already included");
    });
  });
});
