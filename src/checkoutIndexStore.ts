/**
 * Loads and saves the checkout index (`checkout-index.json` in the workspace's
 * extension storage). Writes are atomic and one at a time; during a batch they
 * wait for its end. File access and messages are injected, so this has no
 * `vscode` dependency.
 */
import { errorMessage } from "./errors";
import { CheckoutIndex, parseCheckoutIndex } from "./types";

export const INDEX_FILE = "checkout-index.json";
const INDEX_TEMP_FILE = "checkout-index.json.tmp";

/** How often listeners hear about changes while a batch is running; see `persist`. */
export const BATCH_CHANGE_INTERVAL_MS = 250;

/** Files in the index's folder, by name. */
export interface IndexStorage {
  read(name: string): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  /** Replaces `to` if it exists. */
  rename(from: string, to: string): Promise<void>;
  /** The file's path, for messages. */
  location(name: string): string;
}

export interface CheckoutIndexStoreDeps {
  /** Undefined without a folder or workspace: nothing is loaded and saving fails. */
  storage: IndexStorage | undefined;
  /** The index changed; listeners redraw. */
  onChange(): void;
  log(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export function emptyIndex(): CheckoutIndex {
  return { version: 3, systems: {}, unassignedWorkItems: {} };
}

export class CheckoutIndexStore {
  index: CheckoutIndex = emptyIndex();

  private batchDepth = 0;
  private dirty = false;
  /** A change made during the running batch that listeners haven't been told about yet. */
  private changeTimer: unknown;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: CheckoutIndexStoreDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get inBatch(): boolean {
    return this.batchDepth > 0;
  }

  /**
   * Reads the index. A missing index starts empty. An older version is backed up and saved
   * as the current one; an unreadable index is backed up, reset, and reported.
   */
  async load(): Promise<void> {
    const storage = this.deps.storage;
    if (!storage) {
      this.index = emptyIndex();
      return;
    }

    let data: Uint8Array;
    try {
      data = await storage.read(INDEX_FILE);
    } catch {
      // no index yet
      this.index = emptyIndex();
      return;
    }

    try {
      const json = Buffer.from(data).toString("utf-8");
      const storedVersion = (JSON.parse(json) as { version?: number }).version ?? 1;
      this.index = parseCheckoutIndex(json);
      if (storedVersion !== 3) {
        const backup = `checkout-index.v${storedVersion}-backup.json`;
        try {
          await storage.write(backup, data);
          await this.save();
          this.deps.log(`[index] Migrated checkout index to work-item storage; backup: ${storage.location(backup)}`);
        } catch (migrationError) {
          this.deps.log(`[index] Could not save checkout-index migration backup: ${errorMessage(migrationError)}`);
        }
      }
    } catch (err) {
      this.index = emptyIndex();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `checkout-index.corrupt-${stamp}.json`;
      try {
        await storage.write(backup, data);
      } catch (backupErr) {
        this.deps.log(`[index] Could not back up unreadable index: ${errorMessage(backupErr)}`);
      }
      this.deps.log(
        `[index] ${storage.location(INDEX_FILE)} is unreadable (${errorMessage(err)}); backed up to ${storage.location(backup)}`
      );
      this.deps.showWarning(
        `The IBM i checkout index could not be read and was reset. A backup was saved to ${storage.location(backup)}.`
      );
    }
  }

  /**
   * Notifies listeners and saves the index. While a batch is running, the save waits for its end
   * and listeners are told at most every {@link BATCH_CHANGE_INTERVAL_MS}: each notification redraws
   * the views and asks Git for the work item, so one per member would start thousands of Git
   * processes for a large checkout.
   */
  async persist(): Promise<void> {
    if (this.batchDepth > 0) {
      this.dirty = true;
      this.changeTimer ??= this.setTimer(() => {
        this.changeTimer = undefined;
        this.deps.onChange();
      }, BATCH_CHANGE_INTERVAL_MS);
      return;
    }
    this.deps.onChange();
    await this.save();
  }

  /** Writes the index atomically (temp file + rename), one write at a time. */
  save(): Promise<void> {
    this.dirty = false;
    const storage = this.deps.storage;
    if (!storage) {
      return Promise.reject(new Error("Open a folder or workspace before saving checkouts."));
    }
    const data = Buffer.from(JSON.stringify(this.index, null, 2), "utf-8");
    const write = async () => {
      await storage.write(INDEX_TEMP_FILE, data);
      await storage.rename(INDEX_TEMP_FILE, INDEX_FILE);
    };
    const result = this.saveQueue.then(write);
    result.catch(() => {
      this.dirty = true;
    });
    this.saveQueue = result.catch(() => undefined);
    return result;
  }

  beginBatch(): void {
    this.batchDepth++;
  }

  /**
   * Ends a batch. The depth drops before this returns its promise, so callers can check
   * {@link inBatch} right away. When the outermost batch ends, pending listeners are told and
   * unsaved changes are written; a failed write is reported, not thrown.
   */
  endBatch(): Promise<void> {
    this.batchDepth--;
    if (this.batchDepth > 0) {
      return Promise.resolve();
    }
    if (this.changeTimer !== undefined) {
      this.clearTimer(this.changeTimer);
      this.changeTimer = undefined;
      this.deps.onChange();
    }
    if (!this.dirty) {
      return Promise.resolve();
    }
    return this.save().catch((err: unknown) => {
      this.deps.log(`[index] Could not save checkout index: ${errorMessage(err)}`);
      this.deps.showError(`Could not save the checkout index: ${errorMessage(err)}`);
    });
  }

  dispose(): void {
    if (this.changeTimer !== undefined) {
      this.clearTimer(this.changeTimer);
      this.changeTimer = undefined;
    }
  }
}
