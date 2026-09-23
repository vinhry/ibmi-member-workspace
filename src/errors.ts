/** Thrown when the user backs out of a checkout prompt; callers treat it as a no-op, not a failure. */
export class CheckoutCancelledError extends Error {
  constructor() {
    super("Checkout cancelled");
    this.name = "CheckoutCancelledError";
  }
}

/** Thrown when a checkout's local file no longer exists on disk. */
export class LocalFileMissingError extends Error {
  constructor(readonly localPath: string) {
    super(`Local file not found: ${localPath}`);
    this.name = "LocalFileMissingError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
