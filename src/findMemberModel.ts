import type { CheckedOutMember } from "./types";
import { FoundMember, MemberSearch, foundMemberInfo } from "./memberSearch";
import type { MemberInfo } from "./memberInfo";

/**
 * The rows of the Find Member panel, without the `vscode` module: what each level lists, and how a
 * found member is described. `findMemberView.ts` turns these into tree items.
 */

/** workspaceState key of Find Member's recent searches, newest first. */
export const HISTORY_KEY = "findMember.history";

/** The last search and what it found, shown until the next search or Clear Results. */
export interface FindMemberResults {
  search: MemberSearch;
  /** Where it searched, e.g. "the library list". */
  scopeLabel: string;
  /** Whether the search ran in all user libraries, so that isn't offered again. */
  everywhere: boolean;
  state: "searching" | "done" | "failed";
  found: FoundMember[];
  error?: string;
}

export type FindMemberRow =
  | { kind: "results" }
  | { kind: "found"; member: MemberInfo; found: FoundMember }
  | { kind: "suggestion"; label: string; search: MemberSearch }
  | { kind: "message"; label: string }
  | { kind: "history" }
  | { kind: "past"; search: MemberSearch };

/**
 * The rows under `element` (the top level when undefined). Nothing is shown until a search was made,
 * which leaves room for the panel's Find Member button. A search that found nothing offers to search
 * member text and all user libraries, unless it already did.
 */
export function findMemberRows(
  element: FindMemberRow | undefined,
  results: FindMemberResults | undefined,
  history: readonly MemberSearch[]
): FindMemberRow[] {
  if (!element) {
    return [
      ...(results ? [{ kind: "results" as const }] : []),
      ...(history.length > 0 ? [{ kind: "history" as const }] : []),
    ];
  }
  if (element.kind === "history") {
    return history.map((search) => ({ kind: "past", search }));
  }
  if (element.kind !== "results" || !results) {
    return [];
  }
  const { search, state, found, error, everywhere } = results;
  if (state === "searching") {
    return [{ kind: "message", label: "Searching…" }];
  }
  if (state === "failed") {
    return [{ kind: "message", label: `Search failed: ${error ?? "unknown error"}` }];
  }
  if (found.length > 0) {
    return found.map((member) => ({ kind: "found", member: foundMemberInfo(member), found: member }));
  }
  return [
    { kind: "message", label: search.byText ? "No member text contains it." : "No source member or program has this name." },
    ...(search.byText ? [] : [{ kind: "suggestion" as const, label: `Search member text for "${search.input}"`, search: { ...search, byText: true } }]),
    ...(everywhere ? [] : [{ kind: "suggestion" as const, label: "Search all user libraries", search: { ...search, scope: "everywhere" as const } }]),
  ];
}

/** A found member's description: where it is, its type, and whether it is already checked out here. */
export function foundDescription(found: FoundMember, entry: Pick<CheckedOutMember, "kind"> | undefined): string {
  const state = entry ? (entry.kind === "reference" ? "reference copy" : "checked out") : undefined;
  return [`${found.library}/${found.sourceFile}`, found.sourceType, state].filter(Boolean).join(" · ");
}

/** A found member's icon: a lock for a reference copy, a check when checked out, else a file. */
export function foundIcon(entry: Pick<CheckedOutMember, "kind"> | undefined): string {
  return entry ? (entry.kind === "reference" ? "lock" : "check") : "file-code";
}

/** The members of the Find Member results a command was run on: the selection, or the row clicked. */
export function foundMembersOf(arg: unknown, all?: unknown[]): MemberInfo[] {
  const rows = all && all.length > 1 ? all : [arg];
  return rows.flatMap((row) => {
    const found = row as Partial<Extract<FindMemberRow, { kind: "found" }>> | undefined;
    return found?.kind === "found" && found.found ? [foundMemberInfo(found.found)] : [];
  });
}
