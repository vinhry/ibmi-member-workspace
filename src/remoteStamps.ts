import { HASH_VERSION } from "./sync";
import type { CheckedOutMember, CheckoutStatus } from "./types";

/**
 * Quick refresh: one catalog query per source file tells which members changed on the IBM i since
 * they were last compared, so only those are downloaded. Kept free of the `vscode` module so it can
 * be unit tested.
 */

/** The member as last compared in full: its change stamp, read before the download, and its hash. */
export interface RemoteSeen {
  stamp: string;
  hash: string;
}

/**
 * A member's change stamp from its QSYS2.SYSPARTITIONSTAT row (columns CHANGED, SOURCE_UPDATED,
 * MEMBER_ROWS and MEMBER_SIZE, as `memberChangeStamps` selects them). Any change to the member's text
 * changes at least one of them.
 */
export function changeStamp(row: Readonly<Record<string, unknown>>): string {
  return [row.CHANGED, row.SOURCE_UPDATED, row.MEMBER_ROWS, row.MEMBER_SIZE]
    .map((value) => (value === null || value === undefined ? "" : String(value).trim()))
    .join("|");
}

export interface SourceFileGroup<T> {
  library: string;
  sourceFile: string;
  entries: T[];
}

/** Entries grouped by library and source file, in the order each group first appears. */
export function groupBySourceFile<T extends Pick<CheckedOutMember, "library" | "sourceFile">>(
  entries: readonly T[]
): Array<SourceFileGroup<T>> {
  const groups = new Map<string, SourceFileGroup<T>>();
  for (const entry of entries) {
    const key = `${entry.library}/${entry.sourceFile}`.toUpperCase();
    let group = groups.get(key);
    if (!group) {
      group = { library: entry.library.toUpperCase(), sourceFile: entry.sourceFile.toUpperCase(), entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

export interface RefreshPlan<T> {
  /** Compared in full; `stamp` is recorded with the result when the catalog had one. */
  download: Array<{ entry: T; stamp?: string }>;
  /** Unchanged on the IBM i since the last full comparison: `hash` is still the remote's hash. */
  unchanged: Array<{ entry: T; hash: string }>;
  /** Not in the catalog any more: deleted, renamed or moved on the IBM i. */
  missing: Array<{ entry: T }>;
}

/**
 * Which members of one source file must be downloaded, given the stamps the catalog has now, keyed
 * by member name (undefined when the query failed). A member is skipped only when its last full
 * comparison recorded the same stamp with a current baseline. A member the catalog no longer lists
 * is missing; when the catalog couldn't be read, everything is downloaded, since nothing is known.
 */
export function planRefresh<T extends Pick<CheckedOutMember, "memberName" | "remoteSeen" | "hashVersion">>(
  entries: readonly T[],
  stamps: ReadonlyMap<string, string> | undefined
): RefreshPlan<T> {
  const plan: RefreshPlan<T> = { download: [], unchanged: [], missing: [] };
  for (const entry of entries) {
    const stamp = stamps?.get(entry.memberName.toUpperCase());
    if (stamp !== undefined && entry.remoteSeen?.stamp === stamp && entry.hashVersion === HASH_VERSION) {
      plan.unchanged.push({ entry, hash: entry.remoteSeen.hash });
    } else if (stamps !== undefined && stamp === undefined) {
      plan.missing.push({ entry });
    } else {
      plan.download.push(stamp === undefined ? { entry } : { entry, stamp });
    }
  }
  return plan;
}

/** Background refresh runs at most this often. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 240;

/** The background refresh interval in milliseconds from the setting's minutes; undefined when off. */
export function refreshIntervalMs(minutes: unknown): number | undefined {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return undefined;
  }
  const clamped = Math.min(Math.max(Math.round(minutes), MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
  return clamped * 60_000;
}

/** Members that became a conflict, changed on the IBM i, or disappeared from it since `before` (statuses by id). */
export function newlyChanged(
  before: ReadonlyMap<string, CheckoutStatus>,
  after: ReadonlyArray<Pick<CheckedOutMember, "id" | "status">>
): { conflicts: string[]; remoteChanged: string[]; remoteMissing: string[] } {
  const became = (status: CheckoutStatus) =>
    after.filter((entry) => entry.status === status && before.get(entry.id) !== status).map((entry) => entry.id);
  return { conflicts: became("conflict"), remoteChanged: became("remote-changed"), remoteMissing: became("remote-missing") };
}

/**
 * The Checked Out Members view's badge: members changed on the IBM i, with or without local changes,
 * and members deleted there. Undefined when there are none.
 */
export function remoteChangeBadge(
  entries: ReadonlyArray<Pick<CheckedOutMember, "status">>
): { value: number; tooltip: string } | undefined {
  const remoteChanged = entries.filter((entry) => entry.status === "remote-changed").length;
  const conflicts = entries.filter((entry) => entry.status === "conflict").length;
  const missing = entries.filter((entry) => entry.status === "remote-missing").length;
  const value = remoteChanged + conflicts + missing;
  if (value === 0) {
    return undefined;
  }
  const parts = [
    remoteChanged > 0 && `${remoteChanged} changed on the IBM i`,
    conflicts > 0 && `${conflicts} changed on the IBM i and locally (conflict)`,
    missing > 0 && `${missing} deleted on the IBM i`,
  ].filter((part): part is string => Boolean(part));
  return { value, tooltip: parts.join(", ") };
}
