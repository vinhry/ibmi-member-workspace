/**
 * Running several waits on the IBM i at once, with a limit. Kept free of the `vscode` module so it
 * can be unit tested.
 */

/**
 * How many members are downloaded at once by a batch checkout or a batch of reference copies. Code
 * for IBM i opens a channel per download on the one SSH connection; four keeps well under the
 * server's usual limit of ten sessions while making a big source file several times quicker.
 */
export const DOWNLOAD_CONCURRENCY = 4;

export interface MapWithLimitOptions {
  /** Once aborted, nothing more starts; the items not started are rejected with `cancelled()`. */
  signal?: AbortSignal;
  cancelled?: () => Error;
  /** Called as each item settles, in completion order, for example to report progress. */
  onSettled?: (index: number, result: PromiseSettledResult<unknown>) => void;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, like `Promise.allSettled` with a limit:
 * the results are in the items' order, and one failure never stops the others.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: MapWithLimitOptions = {}
): Promise<Array<PromiseSettledResult<R>>> {
  const { signal, cancelled = () => new Error("Cancelled"), onSettled } = options;
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      let result: PromiseSettledResult<R>;
      if (signal?.aborted) {
        result = { status: "rejected", reason: cancelled() };
      } else {
        try {
          result = { status: "fulfilled", value: await fn(items[index], index) };
        } catch (reason) {
          result = { status: "rejected", reason };
        }
      }
      results[index] = result;
      onSettled?.(index, result);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
