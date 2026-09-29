/**
 * Bookkeeping for where-used snapshots: DSPPGMREF of every program in a library, kept in a
 * QTEMP file of Code for IBM i's SQL job (`codeForIBMi.ts` does the IBM i side). Shared with the
 * tool descriptions (`bobMcpTools.ts`); kept free of the `vscode` module so it can be unit tested.
 */

/** How long a library's snapshot answers where-used questions before it is taken again. */
export const WHERE_USED_SNAPSHOT_MINUTES = 15;

/**
 * Snapshots kept at once. A big library's snapshot can hold hundreds of thousands of rows, so
 * QTEMP must not collect one per library ever searched: the least recently used one gives up
 * its file to the next library.
 */
export const MAX_WHERE_USED_SNAPSHOTS = 10;

export interface Snapshot {
  file: string;
  takenAt: number;
}

export class SnapshotStore {
  /** In least-recently-used order: the first entry is the next to give up its file. */
  private readonly snapshots = new Map<string, Snapshot>();
  private created = 0;

  constructor(private readonly limit = MAX_WHERE_USED_SNAPSHOTS, private readonly maxAgeMs = WHERE_USED_SNAPSHOT_MINUTES * 60_000) {}

  /** The snapshot for `key` if it is still fresh; marks it as just used. */
  fresh(key: string, now: number): Snapshot | undefined {
    const snapshot = this.snapshots.get(key);
    if (!snapshot || now - snapshot.takenAt >= this.maxAgeMs) {
      return undefined;
    }
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  /**
   * The QTEMP file to take `key`'s snapshot into: its own file again, a new one while fewer than
   * the limit exist, or else the file of the least recently used snapshot, which is forgotten.
   * File names are at most 10 characters, so they are valid system names.
   */
  fileFor(key: string): string {
    const own = this.snapshots.get(key);
    if (own) {
      return own.file;
    }
    if (this.snapshots.size >= this.limit) {
      const [oldestKey, oldest] = this.snapshots.entries().next().value as [string, Snapshot];
      this.snapshots.delete(oldestKey);
      return oldest.file;
    }
    return `IMWWU${(++this.created).toString(36).toUpperCase().padStart(5, "0")}`;
  }

  record(key: string, snapshot: Snapshot): void {
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
  }

  forget(key: string): void {
    this.snapshots.delete(key);
  }

  clear(): void {
    this.snapshots.clear();
  }

  get size(): number {
    return this.snapshots.size;
  }
}
