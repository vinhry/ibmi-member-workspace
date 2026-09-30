import type { RawReference } from "./dependencyScan";

/** A source member found on the IBM i. */
export interface SourceMemberRow {
  library: string;
  sourceFile: string;
  member: string;
  /** SEU source type, e.g. "RPGLE"; empty when not set. */
  sourceType: string;
}

export interface ResolvedReference {
  reference: RawReference;
  /** Matching source members, best first. */
  candidates: SourceMemberRow[];
}

export interface Resolution {
  resolved: ResolvedReference[];
  unresolved: RawReference[];
}

/** Source types of members that compile to programs a CALL can name. */
export const PROGRAM_SOURCE_TYPES = new Set([
  "RPGLE", "SQLRPGLE", "RPG", "SQLRPG", "RPG38", "RPT",
  "CLLE", "CLP", "CL", "CL38",
  "CBLLE", "SQLCBLLE", "CBL", "SQLCBL",
  "C", "SQLC", "CPP", "SQLCPP",
]);

/** Source types of members that create files DDS can refer to. */
const FILE_SOURCE_TYPES = new Set(["PF", "LF", "DSPF", "PRTF", "SQL", "TABLE", "VIEW", "INDEX"]);

/** Copybooks named without a source file are looked for here first, as the RPG compiler does (COBOL sets its own). */
const DEFAULT_COPY_FILE = "QRPGLESRC";

/**
 * Where dependencies are looked for: the connection's library list, the libraries in
 * `dependencies.searchLibraries`, or every user library on the system.
 */
export type SearchScopeKind = "libraryList" | "specific" | "everywhere";

export const SEARCH_SCOPE_KINDS: readonly SearchScopeKind[] = ["libraryList", "specific", "everywhere"];

export interface SearchScope {
  kind: SearchScopeKind;
  /**
   * The libraries searched, in order: the library list, or the configured libraries for
   * "specific". For "everywhere" they only rank what is found; every user library is searched.
   */
  libraries: string[];
}

export function isSearchScopeKind(value: unknown): value is SearchScopeKind {
  return (SEARCH_SCOPE_KINDS as readonly unknown[]).includes(value);
}

/**
 * The scope from the settings. Without a `dependencies.searchScope` of its own, it follows what
 * earlier versions did: the configured libraries when there are some, else the library list.
 * "specific" without libraries falls back to the library list, with a note saying so.
 */
export function searchScopeFrom(settings: {
  setting: unknown;
  searchLibraries: readonly string[];
  libraryList: readonly string[];
}): { scope: SearchScope; note?: string } {
  const configured = [...new Set(settings.searchLibraries.map((library) => library.trim().toUpperCase()).filter(Boolean))];
  const libraryList = settings.libraryList.map((library) => library.toUpperCase());
  const kind = isSearchScopeKind(settings.setting)
    ? settings.setting
    : configured.length > 0 ? "specific" : "libraryList";
  if (kind === "specific") {
    return configured.length > 0
      ? { scope: { kind, libraries: configured } }
      : {
        scope: { kind: "libraryList", libraries: libraryList },
        note: "dependencies.searchLibraries is empty, so the library list was searched instead.",
      };
  }
  return { scope: { kind, libraries: libraryList } };
}

/** How a scope is named to the user, e.g. in the list's title. */
export function describeScope(scope: SearchScope): string {
  switch (scope.kind) {
    case "everywhere":
      return "all user libraries";
    case "specific":
      return `the search libraries (${scope.libraries.join(", ")})`;
    default:
      return "the library list";
  }
}

/** A reference that named a library outside the scope, and so was looked for by name inside it. */
export interface OutsideReference {
  reference: RawReference;
  library: string;
}

/**
 * Keeps references inside the scope. In "libraryList" and "specific", a reference naming a
 * library outside it (a DSPPGMREF source location, a cross-reference row, `/COPY OTHERLIB/…`)
 * is looked for by name in the scope instead, keeping its source file. "everywhere" keeps them.
 */
export function scopeReferences(
  refs: readonly RawReference[],
  scope: SearchScope
): { references: RawReference[]; outside: OutsideReference[] } {
  if (scope.kind === "everywhere") {
    return { references: [...refs], outside: [] };
  }
  const inScope = new Set(scope.libraries.map((library) => library.toUpperCase()));
  const outside: OutsideReference[] = [];
  const references = refs.map((ref) => {
    if (!ref.library || inScope.has(ref.library.toUpperCase())) {
      return ref;
    }
    outside.push({ reference: ref, library: ref.library });
    const inside = { ...ref };
    delete inside.library;
    return inside;
  });
  return { references, outside };
}

/**
 * The libraries to search: exactly the scope's libraries, or undefined for every user library.
 * Libraries named by references are never added; `scopeReferences` keeps references in scope.
 */
export function librariesToSearch(scope: SearchScope): string[] | undefined {
  return scope.kind === "everywhere" ? undefined : scope.libraries.map((library) => library.toUpperCase());
}

/**
 * IBM's libraries, which "everywhere" leaves out: names starting with Q or #, except QGPL and
 * QUSR…, which hold user objects. Keep in step with the SQL in `findSourceMembers`.
 */
export function isIbmLibrary(library: string): boolean {
  const name = library.toUpperCase();
  if (name === "QGPL" || name.startsWith("QUSR")) {
    return false;
  }
  return name.startsWith("Q") || name.startsWith("#");
}

/**
 * Matches scanned references to source members found on the IBM i. An explicit
 * library or source file must match exactly; otherwise members are ranked by
 * the library order. A reference with no matching member is unresolved, not an
 * error.
 */
export function resolveReferences(
  refs: readonly RawReference[],
  rows: readonly SourceMemberRow[],
  libraryOrder: readonly string[]
): Resolution {
  const order = libraryOrder.map((library) => library.toUpperCase());
  const rank = (library: string) => {
    const index = order.indexOf(library.toUpperCase());
    return index < 0 ? order.length : index;
  };
  const resolution: Resolution = { resolved: [], unresolved: [] };

  for (const ref of refs) {
    if (ref.unresolvable) {
      resolution.unresolved.push(ref);
      continue;
    }
    const candidates = rows
      .filter((row) =>
        row.member.toUpperCase() === ref.member &&
        (!ref.library || row.library.toUpperCase() === ref.library) &&
        (!ref.sourceFile || row.sourceFile.toUpperCase() === ref.sourceFile) &&
        typeMatches(ref, row.sourceType.toUpperCase())
      )
      .sort((a, b) =>
        rank(a.library) - rank(b.library) ||
        // Libraries outside the order (found searching everywhere) come after it, alphabetically.
        (rank(a.library) === order.length ? a.library.localeCompare(b.library) : 0) ||
        preferredFile(ref, a) - preferredFile(ref, b) ||
        a.sourceFile.localeCompare(b.sourceFile)
      );
    if (candidates.length === 0) {
      resolution.unresolved.push(ref);
    } else {
      resolution.resolved.push({ reference: ref, candidates });
    }
  }
  return resolution;
}

function typeMatches(ref: RawReference, sourceType: string): boolean {
  switch (ref.kind) {
    case "program":
      return PROGRAM_SOURCE_TYPES.has(sourceType);
    case "file":
    case "table":
      return FILE_SOURCE_TYPES.has(sourceType);
    case "procedure":
      // A procedure lives inside a module's source, never in a member named after it.
      return false;
    default:
      return true;
  }
}

function preferredFile(ref: RawReference, row: SourceMemberRow): number {
  const preferred = ref.defaultSourceFile ?? DEFAULT_COPY_FILE;
  return ref.kind === "copybook" && !ref.sourceFile && row.sourceFile.toUpperCase() !== preferred.toUpperCase() ? 1 : 0;
}
