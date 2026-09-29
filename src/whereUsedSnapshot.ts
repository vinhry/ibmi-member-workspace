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
  /**
   * Files created but holding no recorded snapshot: one being taken, or one whose take failed.
   * They are reused before a new file is made, so failures never add files beyond the limit.
   */
  private readonly spare: string[] = [];
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
   * The QTEMP file to take `key`'s snapshot into: its own file again, a spare one, a new one while
   * fewer than the limit exist, or else the file of the least recently used snapshot, which is
   * forgotten. `key`'s own snapshot is forgotten too until {@link record}: the take replaces the
   * file's contents, and a take that fails partway must not leave it looking fresh.
   * File names are at most 10 characters, so they are valid system names.
   */
  fileFor(key: string): string {
    const own = this.snapshots.get(key);
    if (own) {
      this.snapshots.delete(key);
      this.spare.unshift(own.file);
      return own.file;
    }
    if (this.spare.length > 0) {
      return this.spare[0];
    }
    if (this.snapshots.size >= this.limit) {
      const [oldestKey, oldest] = this.snapshots.entries().next().value as [string, Snapshot];
      this.snapshots.delete(oldestKey);
      this.spare.push(oldest.file);
      return oldest.file;
    }
    const file = `IMWWU${(++this.created).toString(36).toUpperCase().padStart(5, "0")}`;
    this.spare.push(file);
    return file;
  }

  record(key: string, snapshot: Snapshot): void {
    const spare = this.spare.indexOf(snapshot.file);
    if (spare >= 0) {
      this.spare.splice(spare, 1);
    }
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
  }

  forget(key: string): void {
    const snapshot = this.snapshots.get(key);
    if (snapshot) {
      this.snapshots.delete(key);
      this.spare.push(snapshot.file);
    }
  }

  clear(): void {
    this.snapshots.clear();
    this.spare.length = 0;
  }

  get size(): number {
    return this.snapshots.size;
  }

  /** QTEMP files in use: recorded snapshots and spare files. */
  get files(): number {
    return this.snapshots.size + this.spare.length;
  }
}
