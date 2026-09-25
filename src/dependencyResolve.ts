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
const PROGRAM_SOURCE_TYPES = new Set([
  "RPGLE", "SQLRPGLE", "RPG", "SQLRPG", "RPG38", "RPT",
  "CLLE", "CLP", "CL", "CL38",
  "CBLLE", "SQLCBLLE", "CBL", "SQLCBL",
  "C", "SQLC", "CPP", "SQLCPP",
]);

/** Source types of members that create files DDS can refer to. */
const FILE_SOURCE_TYPES = new Set(["PF", "LF", "DSPF", "PRTF", "SQL", "TABLE", "VIEW", "INDEX"]);

/** Copybooks named without a source file are looked for here first, as the RPG compiler does. */
const DEFAULT_COPY_FILE = "QRPGLESRC";

/** The libraries to search: the configured order, plus any library a reference names explicitly. */
export function librariesToSearch(refs: readonly RawReference[], libraryOrder: readonly string[]): string[] {
  const libraries = libraryOrder.map((library) => library.toUpperCase());
  for (const ref of refs) {
    if (ref.library && !libraries.includes(ref.library)) {
      libraries.push(ref.library);
    }
  }
  return libraries;
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
      return FILE_SOURCE_TYPES.has(sourceType);
    default:
      return true;
  }
}

function preferredFile(ref: RawReference, row: SourceMemberRow): number {
  return ref.kind === "copybook" && !ref.sourceFile && row.sourceFile.toUpperCase() !== DEFAULT_COPY_FILE ? 1 : 0;
}
