import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOWNLOAD_CONCURRENCY, mapWithLimit } from "../concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("mapWithLimit", () => {
  it("runs at most `limit` at once", async () => {
    const pending: Array<ReturnType<typeof deferred<number>>> = [];
    let inFlight = 0;
    let most = 0;
    const run = mapWithLimit([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const d = deferred<number>();
      pending.push(d);
      const value = await d.promise;
      inFlight--;
      return value * item;
    });
    await tick();
    assert.equal(pending.length, 2);
    while (pending.length > 0) {
      pending.shift()!.resolve(10);
      await tick();
    }
    const results = await run;
    assert.equal(most, 2);
    assert.deepEqual(results.map((r) => r.status === "fulfilled" && r.value), [10, 20, 30, 40, 50]);
  });

  it("returns results in the items' order whatever the completion order", async () => {
    const results = await mapWithLimit(["slow", "fast"], 2, (item) =>
      new Promise<string>((resolve) => setTimeout(() => resolve(item.toUpperCase()), item === "slow" ? 20 : 1))
    );
    assert.deepEqual(results, [
      { status: "fulfilled", value: "SLOW" },
      { status: "fulfilled", value: "FAST" },
    ]);
  });

  it("reports each item as it settles, and a rejection doesn't stop the others", async () => {
    const settled: number[] = [];
    const results = await mapWithLimit([1, 2, 3], 1, async (item) => {
      if (item === 2) {
        throw new Error("boom");
      }
      return item;
    }, { onSettled: (index) => settled.push(index) });
    assert.deepEqual(settled, [0, 1, 2]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal((results[1] as PromiseRejectedResult).reason.message, "boom");
  });

  it("starts nothing more after an abort, reporting the rest as cancelled", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    class Cancelled extends Error {}
    const results = await mapWithLimit([1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      if (item === 2) {
        controller.abort();
      }
      return item;
    }, { signal: controller.signal, cancelled: () => new Cancelled() });
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "rejected", "rejected"]);
    assert.ok((results[2] as PromiseRejectedResult).reason instanceof Cancelled);
  });

  it("is sequential with a limit of 1, and resolves an empty list", async () => {
    const order: string[] = [];
    await mapWithLimit(["a", "b"], 1, async (item) => {
      order.push(`start ${item}`);
      await tick();
      order.push(`end ${item}`);
    });
    assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
    assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
  });

  it("downloads a few members at once, not a flood", () => {
    assert.ok(DOWNLOAD_CONCURRENCY >= 2 && DOWNLOAD_CONCURRENCY <= 8);
  });
});
