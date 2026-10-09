import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RefreshStep, runRefreshSteps } from "../refreshRun";
import type { RemoteStatus } from "../sync";

function step(label: string, outcome: RemoteStatus | Error, gate?: Promise<void>): RefreshStep {
  return {
    label,
    detail: `LIB/FILE(${label})`,
    run: async () => {
      await gate;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
  };
}

describe("runRefreshSteps", () => {
  it("tallies every status and counts failures as errors, reporting each step as it settles", async () => {
    const progress: string[] = [];
    const errors: string[] = [];
    const tally = await runRefreshSteps(
      [step("A", "in-sync"), step("B", "modified"), step("C", "remote-changed"), step("D", "conflict"), step("E", "remote-missing"), step("F", new Error("busy"))],
      {
        concurrency: 2,
        onProgress: (message, increment) => progress.push(`${message} ${Math.round(increment)}`),
        onError: (failed, error) => errors.push(`${failed.detail}: ${(error as Error).message}`),
      }
    );
    assert.deepEqual(tally, { inSync: 1, modified: 1, remoteChanged: 1, conflict: 1, remoteMissing: 1, errors: 1 });
    assert.deepEqual(errors, ["LIB/FILE(F): busy"]);
    assert.equal(progress.length, 6);
    assert.ok(progress.includes("F (6/6) 17"));
  });

  it("runs a few steps at once, no more than asked", async () => {
    let inFlight = 0;
    let most = 0;
    const steps: RefreshStep[] = ["A", "B", "C", "D", "E"].map((label) => ({
      label,
      detail: label,
      run: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return "in-sync";
      },
    }));
    const tally = await runRefreshSteps(steps, { concurrency: 3 });
    assert.equal(tally.inSync, 5);
    assert.equal(most, 3);
  });

  it("starts nothing more once cancelled, and doesn't count the steps left out", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const steps: RefreshStep[] = ["A", "B", "C"].map((label) => ({
      label,
      detail: label,
      run: async () => {
        started.push(label);
        controller.abort();
        return "modified";
      },
    }));
    const tally = await runRefreshSteps(steps, { concurrency: 1, signal: controller.signal });
    assert.deepEqual(started, ["A"]);
    assert.deepEqual(tally, { inSync: 0, modified: 1, remoteChanged: 0, conflict: 0, remoteMissing: 0, errors: 0 });
  });
});
