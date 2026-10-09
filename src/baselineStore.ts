import { hashContent } from "./sync";
import { errorMessage } from "./errors";
import type { CheckedOutMember, CheckoutIndex } from "./types";

/**
 * The text of each checkout's baseline: the member as it was on the IBM i when the local copy was
 * last known to match it (checkout, re-checkout, upload). The checkout index keeps only its hash
 * (`remoteHashAtCheckout`); the text is what a three-way Merge Back uses as the common ancestor.
 * Files are content-addressed (`baselines/<sha256>`) in the workspace's extension storage, so a
 * member checked out in several work items shares one file, and unreferenced files are pruned.
 * Kept free of the `vscode` module so it can be unit tested; the files are injected.
 */

export const BASELINE_DIR = "baselines";

const HASH = /^[0-9a-f]{64}$/;
const TEMP_SUFFIX = ".tmp";

/** The files of the baseline directory; names are the hashes this module validates. */
export interface BaselineFiles {
  exists(name: string): Promise<boolean>;
  /** Rejects when the file is missing. */
  read(name: string): Promise<Uint8Array>;
  /** Creates the directory as needed. */
  write(name: string, data: Uint8Array): Promise<void>;
  /** Replaces `to` if it exists. */
  rename(from: string, to: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** The names of the files in the directory; empty when it doesn't exist. */
  list(): Promise<string[]>;
}

/** The file name of a baseline; throws unless `hash` is a hash `hashContent` made. */
export function baselineFileName(hash: string): string {
  if (!HASH.test(hash)) {
    throw new Error(`Not a baseline hash: ${JSON.stringify(hash)}`);
  }
  return hash;
}

/** The baselines any checkout in the index refers to, across systems, work items and unassigned ones. */
export function referencedBaselineHashes(index: CheckoutIndex): Set<string> {
  const hashes = new Set<string>();
  const add = (entries: CheckedOutMember[]) => {
    for (const entry of entries) {
      if (HASH.test(entry.remoteHashAtCheckout)) {
        hashes.add(entry.remoteHashAtCheckout);
      }
    }
  };
  for (const state of Object.values(index.systems)) {
    for (const entries of Object.values(state.workItems)) {
      add(entries);
    }
  }
  for (const entries of Object.values(index.unassignedWorkItems)) {
    add(entries);
  }
  return hashes;
}

export class BaselineStore {
  /** Without `files` (no workspace storage) nothing is kept, and every read says so. */
  constructor(
    private readonly files: BaselineFiles | undefined,
    private readonly log: (message: string) => void
  ) {}

  /** The baseline's text, or undefined when it isn't kept or doesn't hash to `hash` any more. */
  async read(hash: string): Promise<string | undefined> {
    if (!this.files || !HASH.test(hash)) {
      return undefined;
    }
    let text: string;
    try {
      text = Buffer.from(await this.files.read(hash)).toString("utf-8");
    } catch {
      return undefined;
    }
    if (hashContent(text) !== hash) {
      this.log(`[baseline] ${hash.substring(0, 12)} is damaged and is ignored`);
      return undefined;
    }
    return text;
  }

  /**
   * Keeps `content` as the baseline `hash`, atomically (a temporary file renamed over the name).
   * A failure is logged, never thrown: a checkout or upload must not fail over its baseline.
   * Returns whether the baseline is kept.
   */
  async write(hash: string, content: string): Promise<boolean> {
    if (!this.files) {
      return false;
    }
    try {
      const name = baselineFileName(hash);
      if (hashContent(content) !== hash) {
        throw new Error("the text doesn't hash to the baseline");
      }
      if (await this.files.exists(name)) {
        return true;
      }
      const temp = name + TEMP_SUFFIX;
      await this.files.write(temp, Buffer.from(content, "utf-8"));
      await this.files.rename(temp, name);
      return true;
    } catch (err) {
      this.log(`[baseline] Could not keep ${hash.substring(0, 12)}: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * Makes sure the baseline `hash` is kept, writing whichever of `candidates` hashes to it (the
   * live remote or local text, for checkouts made before baselines were kept). Returns whether it is.
   */
  async ensure(hash: string, candidates: readonly string[]): Promise<boolean> {
    if (!this.files || !HASH.test(hash)) {
      return false;
    }
    if (await this.files.exists(hash)) {
      return true;
    }
    const match = candidates.find((text) => hashContent(text) === hash);
    return match === undefined ? false : this.write(hash, match);
  }

  /** Deletes the baselines not in `keep`. Temporary files of writes under way are left alone. */
  async prune(keep: ReadonlySet<string>): Promise<number> {
    if (!this.files) {
      return 0;
    }
    let deleted = 0;
    for (const name of await this.files.list()) {
      if (name.endsWith(TEMP_SUFFIX) || keep.has(name)) {
        continue;
      }
      try {
        await this.files.delete(name);
        deleted++;
      } catch (err) {
        this.log(`[baseline] Could not delete ${name}: ${errorMessage(err)}`);
      }
    }
    return deleted;
  }
}
