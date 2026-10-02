/**
 * A time limit and a cancel for waits on the IBM i. Code for IBM i rejects a pending request only
 * when the connection closes, so a request that never answers would otherwise hold a checkout (and
 * everything waiting behind it) until the user disconnects. Kept free of the `vscode` module so it
 * can be unit tested.
 */

/** Thrown when the IBM i didn't answer in time. The request itself may still finish later; its result is ignored. */
export class TimedOutError extends Error {
  constructor(readonly what: string, readonly ms: number) {
    super(
      `The IBM i didn't answer within ${describeDuration(ms)} while ${what}. ` +
      "Code for IBM i's connection may be busy or stuck: try again, or reconnect if it keeps happening."
    );
    this.name = "TimedOutError";
  }
}

export function describeDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

export interface DeadlineOptions {
  ms: number;
  /** What is being waited for, for the message, e.g. "downloading MYLIB/QRPGLESRC(ORD100)". */
  what: string;
  /** Stops waiting at once when aborted. */
  signal?: AbortSignal;
  /** The error a cancel rejects with. */
  cancelled?: () => Error;
  /** Called once if the wait is still going after `slowMs`, e.g. to log it. */
  onSlow?: () => void;
  slowMs?: number;
}

/**
 * Settles like `promise`, unless `ms` passes first (rejects with {@link TimedOutError}) or `signal`
 * aborts (rejects with `cancelled()`). Timers and listeners are always cleared.
 */
export function withDeadline<T>(promise: Promise<T>, options: DeadlineOptions): Promise<T> {
  const { ms, what, signal, cancelled = () => new Error("Cancelled"), onSlow, slowMs } = options;
  if (signal?.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(slowTimer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    const timer = setTimeout(() => finish(() => reject(new TimedOutError(what, ms))), ms);
    const slowTimer = onSlow && slowMs !== undefined && slowMs < ms
      ? setTimeout(() => !settled && onSlow(), slowMs)
      : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err))
    );
  });
}
