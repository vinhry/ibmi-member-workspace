import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TimedOutError, describeDuration, withDeadline } from "../deadline";

const never = () => new Promise<string>(() => undefined);
const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("withDeadline", () => {
  it("settles like the promise when it answers in time", async () => {
    assert.equal(await withDeadline(later("ok", 5), { ms: 1000, what: "x" }), "ok");
    await assert.rejects(withDeadline(Promise.reject(new Error("CPF1234")), { ms: 1000, what: "x" }), /CPF1234/);
  });

  it("gives up with a clear message when the IBM i doesn't answer", async () => {
    const error = await withDeadline(never(), { ms: 20, what: "downloading MYLIB/QRPGLESRC(ORD100)" }).catch((err: unknown) => err);
    assert.ok(error instanceof TimedOutError);
    assert.match((error as Error).message, /didn't answer within 0 seconds while downloading MYLIB\/QRPGLESRC\(ORD100\)/);
  });

  it("stops waiting at once on cancel, with the caller's error", async () => {
    const controller = new AbortController();
    const waiting = withDeadline(never(), { ms: 60_000, what: "x", signal: controller.signal, cancelled: () => new Error("stopped") });
    controller.abort();
    await assert.rejects(waiting, /stopped/);
    await assert.rejects(
      withDeadline(never(), { ms: 60_000, what: "x", signal: controller.signal, cancelled: () => new Error("already") }),
      /already/
    );
  });

  it("reports a slow wait once, and not a quick one", async () => {
    let slow = 0;
    await withDeadline(later("ok", 40), { ms: 1000, what: "x", slowMs: 10, onSlow: () => slow++ });
    assert.equal(slow, 1);
    await withDeadline(later("ok", 1), { ms: 1000, what: "x", slowMs: 30, onSlow: () => slow++ });
    await later(undefined, 50);
    assert.equal(slow, 1);
  });

  it("leaves no timer running once settled", async () => {
    // A leaked 60 s timer would keep this test file running; node:test would then time it out.
    await withDeadline(Promise.resolve(1), { ms: 60_000, what: "x", slowMs: 30_000, onSlow: () => undefined });
  });
});

describe("describeDuration", () => {
  it("says minutes for whole minutes, seconds otherwise", () => {
    assert.equal(describeDuration(120_000), "2 minutes");
    assert.equal(describeDuration(60_000), "1 minute");
    assert.equal(describeDuration(15_000), "15 seconds");
  });
});
