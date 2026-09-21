export interface CheckedOutMember {
  id: string;
  system: string;
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
  localPath: string;
  checkedOutAt: string;
  lastCheckedAt?: string;
  remoteHashAtCheckout: string;
  status: CheckoutStatus;
}

export type CheckoutStatus =
  | "checked-out"
  | "merged"
  | "modified"
  | "remote-changed"
  | "conflict"
  | "in-sync";

export interface CheckoutIndex {
  version: number;
  entries: CheckedOutMember[];
}

export interface RefreshTally {
  inSync: number;
  modified: number;
  remoteChanged: number;
  conflict: number;
  errors: number;
}

export function emptyTally(): RefreshTally {
  return { inSync: 0, modified: 0, remoteChanged: 0, conflict: 0, errors: 0 };
}

/** Parses the persisted checkout index, throwing if it is not valid JSON or lacks an `entries` array. */
export function parseCheckoutIndex(json: string): CheckoutIndex {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as CheckoutIndex).entries)
  ) {
    throw new Error("Checkout index is missing its entries list");
  }
  const index = parsed as CheckoutIndex;
  return { version: typeof index.version === "number" ? index.version : 1, entries: index.entries };
}

export function buildCheckoutId(
  system: string,
  library: string,
  sourceFile: string,
  memberName: string
): string {
  return `${system}_${library}_${sourceFile}_${memberName}`.toUpperCase();
}

export function buildLocalFileName(entry: CheckedOutMember): string {
  return `${entry.memberName}.${entry.extension}`.toUpperCase();
}

export function sanitizeSystemName(system: string): string {
  return system.replace(/[\\/:*?"<>|]/g, "_");
}

export function formatMemberPath(entry: CheckedOutMember): string {
  return `${entry.library}/${entry.sourceFile}(${entry.memberName})`;
}

export type TreeItemType =
  | { kind: "sourceFile"; system: string; library: string; sourceFile: string }
  | { kind: "member"; entry: CheckedOutMember };
