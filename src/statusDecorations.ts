import type { CheckedOutMember } from "./types";

/**
 * How a checked-out file shows its status in the Explorer and on editor tabs. Kept free of the
 * `vscode` module so it can be unit tested.
 */
export interface StatusDecoration {
  /** One or two characters. Arrows, not Git's letters: with Local Change History, Git decorates the same files. */
  badge: string;
  tooltip: string;
  /** A theme color id for the file name, if any. */
  colorId?: string;
}

/** The decoration for a checkout; undefined for one in sync with the IBM i. */
export function decorationFor(entry: Pick<CheckedOutMember, "status" | "kind">): StatusDecoration | undefined {
  if (entry.kind === "reference") {
    return {
      badge: "RO",
      tooltip: entry.status === "remote-changed" || entry.status === "conflict"
        ? "IBM i: read-only reference copy, changed on the IBM i. Refresh offers to update it."
        : entry.status === "remote-missing"
          ? "IBM i: read-only reference copy of a member that no longer exists on the IBM i."
          : "IBM i: read-only reference copy",
    };
  }
  switch (entry.status) {
    case "remote-missing":
      return {
        badge: "✕",
        tooltip: "IBM i: the member no longer exists on the IBM i. Your local copy is kept.",
        colorId: "gitDecoration.deletedResourceForeground",
      };
    case "modified":
      return {
        badge: "↑",
        tooltip: "IBM i: local changes not yet uploaded",
        colorId: "gitDecoration.modifiedResourceForeground",
      };
    case "remote-changed":
      return {
        badge: "↓",
        tooltip: "IBM i: changed on the IBM i since checkout. Your local copy has no changes.",
        colorId: "charts.blue",
      };
    case "conflict":
      return {
        badge: "!",
        tooltip: "IBM i: changed both locally and on the IBM i. Review it with Merge Back.",
        colorId: "gitDecoration.conflictingResourceForeground",
      };
    default:
      return undefined;
  }
}
