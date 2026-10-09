import { mapWithLimit } from "./concurrency";
import type { RemoteStatus } from "./sync";
import type { RefreshTally } from "./types";

/**
 * Runs a refresh's per-member steps a few at a time and tallies what they found. Kept free of the
 * `vscode` module so it can be unit tested; the steps themselves (download, compare, persist) are
 * the checkout service's.
 */

export interface RefreshStep {
  /** Shown in the progress, e.g. the member name. */
  label: string;
  /** Named in an error, e.g. LIBRARY/FILE(MEMBER). */
  detail: string;
  run(): Promise<RemoteStatus>;
}

export interface RefreshRunOptions {
  /** How many steps run at once. */
  concurrency: number;
  /** Once aborted, no further step starts; steps under way finish and are counted. */
  signal?: AbortSignal;
  /** As each step settles: a message naming it and how many are done, and the share of the whole it was. */
  onProgress?(message: string, increment: number): void;
  onError?(step: RefreshStep, error: unknown): void;
}

export function emptyRefreshTally(): RefreshTally {
  return { inSync: 0, modified: 0, remoteChanged: 0, conflict: 0, remoteMissing: 0, errors: 0 };
}

class RefreshCancelledError extends Error {
  constructor() {
    super("Refresh cancelled");
    this.name = "RefreshCancelledError";
  }
}

/** Counts a step's result; a step that didn't run because of a cancel is not counted. */
export async function runRefreshSteps(steps: readonly RefreshStep[], options: RefreshRunOptions): Promise<RefreshTally> {
  const tally = emptyRefreshTally();
  let done = 0;
  await mapWithLimit(steps, options.concurrency, (step) => step.run(), {
    signal: options.signal,
    cancelled: () => new RefreshCancelledError(),
    onSettled: (index, result) => {
      const step = steps[index];
      if (result.status === "fulfilled") {
        switch (result.value as RemoteStatus) {
          case "in-sync":
            tally.inSync++;
            break;
          case "modified":
            tally.modified++;
            break;
          case "remote-changed":
            tally.remoteChanged++;
            break;
          case "conflict":
            tally.conflict++;
            break;
          case "remote-missing":
            tally.remoteMissing++;
            break;
        }
      } else if (result.reason instanceof RefreshCancelledError) {
        return;
      } else {
        tally.errors++;
        options.onError?.(step, result.reason);
      }
      done++;
      options.onProgress?.(`${step.label} (${done}/${steps.length})`, 100 / steps.length);
    },
  });
  return tally;
}
