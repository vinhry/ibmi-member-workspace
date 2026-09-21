/** Thrown when the user backs out of a checkout prompt; callers treat it as a no-op, not a failure. */
export class CheckoutCancelledError extends Error {
  constructor() {
    super("Checkout cancelled");
    this.name = "CheckoutCancelledError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
