import type { DependencyLookup } from "./commands/dependencies";
import type {
  FileDescription,
  ServiceProgramExport,
  SourceMemberMatch,
  WhereUsedRow,
} from "./codeForIBMi";
import type { SourceMemberRow } from "./dependencyResolve";
import { RawReference, scanDefinedProcedures } from "./dependencyScan";
import type { MemberInfo } from "./memberInfo";
import type { ReferenceCopyResult } from "./referenceCopies";
import { McpTool, ToolInputError } from "./bobMcpServer";
import { CheckedOutMember, formatMemberPath, isReferenceCopy } from "./types";

/**
 * The research tools Bob's agent can call: what a program uses, what uses it, and the source
 * behind both. None of them changes anything on the IBM i. The only thing written is a
 * read-only reference copy in the checkout folder (`bringReferenceCopies`), so production
 * source found along the way can be read but never edited, uploaded or merged back.
 */

export interface ResearchIo {
  connectedSystem(): string | undefined;
  entries(system: string): CheckedOutMember[];
  findEntry(system: string, library: string, sourceFile: string, member: string): CheckedOutMember | undefined;
  findMembers(members: string[], libraries: string[]): Promise<SourceMemberRow[]>;
  /** Always brings read-only reference copies; see `referenceCopies.ts`. */
  bringReferenceCopies(system: string, members: MemberInfo[]): Promise<ReferenceCopyResult[]>;
  readLocal(localPath: string): string;
  lookupDependencies(system: string, entry: CheckedOutMember): Promise<DependencyLookup>;
  searchLibraries(): string[];
  whereUsed(name: string, library: string, objectType?: string): Promise<WhereUsedRow[]>;
  searchSourceMembers(
    pattern: string,
    libraries: string[],
    options: { sourceType?: string; sourceFile?: string; text?: string; limit: number }
  ): Promise<SourceMemberMatch[]>;
  describeFile(name: string, libraries: string[]): Promise<FileDescription | undefined>;
  serviceProgramExports(
    name: string,
    libraries: string[]
  ): Promise<{ library: string; name: string; exports: ServiceProgramExport[] } | undefined>;
}

/** Reference copies brought by one call, at most; the rest are listed for a later call. */
export const MAX_REFERENCE_COPIES = 50;
/** Libraries `find_where_used` searches when none are given: DSPPGMREF reads every program. */
export const MAX_WHERE_USED_LIBRARIES = 10;
/** Lines `read_member_source` returns when no range is given. */
const DEFAULT_LINES = 3000;

const NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/;
const PATTERN = /^[A-Z0-9_$#@.*%]{1,10}$/;

function name(args: Record<string, unknown>, key: string, what: string, optional?: false): string;
function name(args: Record<string, unknown>, key: string, what: string, optional: true): string | undefined;
function name(args: Record<string, unknown>, key: string, what: string, optional = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (optional) {
      return undefined;
    }
    throw new ToolInputError(`"${key}" (${what}) is required.`);
  }
  const upper = String(value).trim().toUpperCase();
  if (!NAME.test(upper)) {
    throw new ToolInputError(`"${key}" must be an IBM i ${what} name of up to 10 characters, not ${JSON.stringify(value)}.`);
  }
  return upper;
}

function libraries(args: Record<string, unknown>, io: ResearchIo, max?: number): { libraries: string[]; capped: boolean } {
  const given = args.libraries;
  if (given === undefined || given === null) {
    const all = io.searchLibraries();
    return max && all.length > max ? { libraries: all.slice(0, max), capped: true } : { libraries: all, capped: false };
  }
  if (!Array.isArray(given) || given.length === 0) {
    throw new ToolInputError('"libraries" must be a non-empty array of library names.');
  }
  return { libraries: given.map((library: unknown) => name({ library }, "library", "library")), capped: false };
}

function integer(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ToolInputError(`"${key}" must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

function requireSystem(io: ResearchIo): string {
  const system = io.connectedSystem();
  if (!system) {
    throw new Error("Not connected to IBM i. Ask the user to connect with Code for IBM i, then try again.");
  }
  return system;
}

const memberSchema = {
  library: { type: "string", description: "Source library, e.g. PRODSRC." },
  sourceFile: { type: "string", description: "Source physical file, e.g. QRPGLESRC." },
  member: { type: "string", description: "Member name, e.g. ORDENT." },
};

const librariesSchema = {
  type: "array",
  items: { type: "string" },
  description: "Libraries to search, in order. Defaults to the extension's dependency search libraries (the library list unless configured).",
};

function describeEntry(entry: CheckedOutMember) {
  return {
    member: formatMemberPath(entry),
    library: entry.library,
    sourceFile: entry.sourceFile,
    memberName: entry.memberName,
    sourceType: entry.extension.toUpperCase(),
    localPath: entry.localPath,
    status: entry.status,
    readOnlyReferenceCopy: isReferenceCopy(entry),
  };
}

/**
 * The checkout of a member, bringing it as a read-only reference copy first if it isn't
 * checked out. A member checked out for change is used as it is.
 */
async function ensureLocal(
  io: ResearchIo,
  system: string,
  library: string,
  sourceFile: string,
  member: string
): Promise<{ entry: CheckedOutMember; brought: boolean }> {
  const existing = io.findEntry(system, library, sourceFile, member);
  if (existing) {
    return { entry: existing, brought: false };
  }
  const [row] = (await io.findMembers([member], [library])).filter((r) => r.sourceFile.toUpperCase() === sourceFile);
  if (!row) {
    throw new Error(`${library}/${sourceFile}(${member}) was not found on ${system}.`);
  }
  const [result] = await io.bringReferenceCopies(system, [{
    library,
    sourceFile,
    memberName: member,
    extension: (row.sourceType || "mbr").toLowerCase(),
  }]);
  const entry = io.findEntry(system, library, sourceFile, member);
  if (!entry || result?.status === "failed") {
    throw new Error(`Could not bring ${library}/${sourceFile}(${member}) as a reference copy: ${result?.error ?? "unknown error"}`);
  }
  return { entry, brought: true };
}

/** Members to bring for `members`, with their source types looked up. */
async function withSourceTypes(
  io: ResearchIo,
  members: Array<{ library: string; sourceFile: string; member: string }>
): Promise<{ found: MemberInfo[]; missing: string[] }> {
  const rows = await io.findMembers(
    [...new Set(members.map((m) => m.member))],
    [...new Set(members.map((m) => m.library))]
  );
  const found: MemberInfo[] = [];
  const missing: string[] = [];
  for (const m of members) {
    const row = rows.find((r) =>
      r.library.toUpperCase() === m.library && r.sourceFile.toUpperCase() === m.sourceFile && r.member.toUpperCase() === m.member
    );
    if (row) {
      found.push({ library: m.library, sourceFile: m.sourceFile, memberName: m.member, extension: (row.sourceType || "mbr").toLowerCase() });
    } else {
      missing.push(`${m.library}/${m.sourceFile}(${m.member})`);
    }
  }
  return { found, missing };
}

function describeReference(ref: RawReference) {
  return {
    kind: ref.kind,
    name: ref.member,
    ...(ref.library ? { library: ref.library } : {}),
    ...(ref.sourceFile ? { sourceFile: ref.sourceFile } : {}),
    ...(ref.line !== undefined ? { line: ref.line } : {}),
    text: ref.text,
    foundBy: ref.foundBy ?? [],
  };
}

export const SERVER_INSTRUCTIONS =
  "IBM i program research tools from the IBM i Member Workspace extension. Use them to find what a " +
  "program uses (copybooks, called programs, files, SQL tables, bound procedures), what uses a program or " +
  "file (find_where_used), file layouts (describe_file) and service program exports. Source members you " +
  "look at are brought into the local checkout folder as READ-ONLY REFERENCE COPIES: they may be production " +
  "source. Never edit, chmod, rename or overwrite a reference copy, and never copy one over another file. " +
  "Changes to a member go through the user's change-management process, not through these tools. " +
  "No tool here uploads to or changes the IBM i.";

export function createResearchTools(io: ResearchIo): McpTool[] {
  return [
    {
      name: "list_checkouts",
      title: "List checked-out members",
      description: "Members in the local checkout folder for the connected IBM i, with their local paths. " +
        "readOnlyReferenceCopy is true for copies brought for reading, which must not be edited.",
      inputSchema: {
        type: "object",
        properties: { referenceOnly: { type: "boolean", description: "Only list read-only reference copies." } },
        additionalProperties: false,
      },
      readOnly: true,
      call: async (args) => {
        const system = requireSystem(io);
        const entries = io.entries(system).filter((entry) => !args.referenceOnly || isReferenceCopy(entry));
        return { system, checkouts: entries.map(describeEntry) };
      },
    },
    {
      name: "read_member_source",
      title: "Read a member's source",
      description: "Returns a source member's text with line numbers counted from 1. A member that isn't checked out " +
        `is first brought as a read-only reference copy. Returns up to ${DEFAULT_LINES} lines; use startLine/endLine for more.`,
      inputSchema: {
        type: "object",
        properties: {
          ...memberSchema,
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["library", "sourceFile", "member"],
        additionalProperties: false,
      },
      readOnly: false,
      call: async (args) => {
        const system = requireSystem(io);
        const { entry, brought } = await ensureLocal(
          io, system, name(args, "library", "library"), name(args, "sourceFile", "source file"), name(args, "member", "member")
        );
        const lines = io.readLocal(entry.localPath).split(/\r?\n/);
        const startLine = integer(args, "startLine", 1, 1, Math.max(1, lines.length));
        const endLine = integer(args, "endLine", Math.min(lines.length, startLine + DEFAULT_LINES - 1), startLine, Number.MAX_SAFE_INTEGER);
        const last = Math.min(endLine, lines.length);
        return {
          ...describeEntry(entry),
          broughtAsReferenceCopy: brought,
          totalLines: lines.length,
          startLine,
          endLine: last,
          ...(last < lines.length ? { more: `Lines ${last + 1}-${lines.length} not shown; call again with startLine ${last + 1}.` } : {}),
          source: lines.slice(startLine - 1, last).join("\n"),
        };
      },
    },
    {
      name: "find_member_dependencies",
      title: "Find what a member uses",
      description: "Finds what a source member uses: copybooks, called programs, files, SQL tables and views, and bound " +
        "procedures, from its source text, DSPPGMREF of its compiled program, and any configured cross-reference tool. " +
        "Also lists the procedures the member defines. Each reference is matched to the source member it comes from; " +
        `by default those members are brought as read-only reference copies (up to ${MAX_REFERENCE_COPIES} per call) so you can read them.`,
      inputSchema: {
        type: "object",
        properties: {
          ...memberSchema,
          bringReferenceCopies: {
            type: "boolean",
            description: "Bring the source of each dependency as a read-only reference copy (default true). False only lists them.",
          },
        },
        required: ["library", "sourceFile", "member"],
        additionalProperties: false,
      },
      readOnly: false,
      call: async (args) => {
        const system = requireSystem(io);
        const { entry, brought } = await ensureLocal(
          io, system, name(args, "library", "library"), name(args, "sourceFile", "source file"), name(args, "member", "member")
        );
        const lookup = await io.lookupDependencies(system, entry);
        const resolved = lookup.resolution.resolved.map(({ reference, candidates }) => {
          const [best, ...others] = candidates;
          return {
            ...describeReference(reference),
            source: { library: best.library, sourceFile: best.sourceFile, member: best.member, sourceType: best.sourceType },
            ...(others.length > 0 ? { alsoIn: others.map((o) => `${o.library}/${o.sourceFile}(${o.member})`) } : {}),
          };
        });
        let referenceCopies: ReferenceCopyResult[] | undefined;
        let notBrought: string[] = [];
        if (args.bringReferenceCopies !== false) {
          const seen = new Set<string>();
          const members: MemberInfo[] = [];
          for (const { source } of resolved) {
            const key = `${source.library}/${source.sourceFile}(${source.member})`;
            if (!seen.has(key)) {
              seen.add(key);
              members.push({
                library: source.library,
                sourceFile: source.sourceFile,
                memberName: source.member,
                extension: (source.sourceType || "mbr").toLowerCase(),
              });
            }
          }
          notBrought = members.slice(MAX_REFERENCE_COPIES).map((m) => `${m.library}/${m.sourceFile}(${m.memberName})`);
          referenceCopies = await io.bringReferenceCopies(system, members.slice(0, MAX_REFERENCE_COPIES));
        }
        let defines: ReturnType<typeof scanDefinedProcedures> = [];
        try {
          defines = scanDefinedProcedures(io.readLocal(entry.localPath), entry.extension);
        } catch {
          // The dependencies are still worth returning.
        }
        return {
          member: describeEntry(entry),
          broughtAsReferenceCopy: brought,
          librariesSearched: lookup.libraries,
          providers: lookup.outcomes,
          uses: resolved,
          sourceNotFound: lookup.resolution.unresolved.map((ref) => ({
            ...describeReference(ref),
            reason: ref.unresolvable ?? "no source member with this name in the libraries searched",
          })),
          boundProcedures: lookup.procedures.map(describeReference),
          definesProcedures: defines,
          ...(referenceCopies ? { referenceCopies } : {}),
          ...(notBrought.length > 0
            ? { notBrought: { reason: `Only ${MAX_REFERENCE_COPIES} copies per call; use bring_reference_copies.`, members: notBrought } }
            : {}),
        };
      },
    },
    {
      name: "bring_reference_copies",
      title: "Bring members as read-only reference copies",
      description: `Brings source members into the local checkout folder as read-only reference copies (up to ${MAX_REFERENCE_COPIES}) ` +
        "and returns their local paths. Members already checked out are left as they are.",
      inputSchema: {
        type: "object",
        properties: {
          members: {
            type: "array",
            maxItems: MAX_REFERENCE_COPIES,
            items: { type: "object", properties: memberSchema, required: ["library", "sourceFile", "member"], additionalProperties: false },
          },
        },
        required: ["members"],
        additionalProperties: false,
      },
      readOnly: false,
      call: async (args) => {
        const system = requireSystem(io);
        const given = args.members;
        if (!Array.isArray(given) || given.length === 0 || given.length > MAX_REFERENCE_COPIES) {
          throw new ToolInputError(`"members" must list 1 to ${MAX_REFERENCE_COPIES} members.`);
        }
        const members = given.map((item) => {
          const m = (item ?? {}) as Record<string, unknown>;
          return { library: name(m, "library", "library"), sourceFile: name(m, "sourceFile", "source file"), member: name(m, "member", "member") };
        });
        const { found, missing } = await withSourceTypes(io, members);
        const results = await io.bringReferenceCopies(system, found);
        return { referenceCopies: [...results, ...missing.map((member) => ({ member, status: "failed", error: "not found" }))] };
      },
    },
    {
      name: "find_where_used",
      title: "Find what uses an object",
      description: "Finds the programs and service programs that refer to an object (a program, service program or file), " +
        "from DSPPGMREF of every program in the libraries searched. This reads every program in each library, so name " +
        `the libraries where the callers are; without them only the first ${MAX_WHERE_USED_LIBRARIES} search libraries are read.`,
      inputSchema: {
        type: "object",
        properties: {
          object: { type: "string", description: "Object name, e.g. ORDENT or CUSTMAST." },
          objectType: { type: "string", enum: ["*PGM", "*SRVPGM", "*FILE"], description: "Only references of this type." },
          libraries: librariesSchema,
        },
        required: ["object"],
        additionalProperties: false,
      },
      readOnly: true,
      call: async (args) => {
        requireSystem(io);
        const object = name(args, "object", "object");
        const type = args.objectType === undefined ? undefined : String(args.objectType).toUpperCase();
        if (type !== undefined && !["*PGM", "*SRVPGM", "*FILE"].includes(type)) {
          throw new ToolInputError('"objectType" must be *PGM, *SRVPGM or *FILE.');
        }
        const { libraries: searched, capped } = libraries(args, io, MAX_WHERE_USED_LIBRARIES);
        const usedBy: WhereUsedRow[] = [];
        const failed: Array<{ library: string; error: string }> = [];
        for (const library of searched) {
          try {
            usedBy.push(...await io.whereUsed(object, library, type));
          } catch (err) {
            failed.push({ library, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          object,
          librariesSearched: searched,
          ...(capped ? { note: `Only the first ${MAX_WHERE_USED_LIBRARIES} search libraries were read; pass "libraries" to read others.` } : {}),
          usedBy,
          ...(failed.length > 0 ? { librariesNotRead: failed } : {}),
        };
      },
    },
    {
      name: "search_source_members",
      title: "Search source members",
      description: "Finds source members by name pattern (* or % as wildcards), optionally by source type, source file " +
        "or member text. Returns library, source file, member, type, text and last change.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Member name or pattern, e.g. ORD* or %CUST%." },
          sourceType: { type: "string", description: "e.g. RPGLE, SQLRPGLE, CLLE, PF." },
          sourceFile: { type: "string" },
          text: { type: "string", description: "Words the member text contains." },
          libraries: librariesSchema,
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      readOnly: true,
      call: async (args) => {
        requireSystem(io);
        const pattern = String(args.pattern ?? "").trim().toUpperCase();
        if (!PATTERN.test(pattern)) {
          throw new ToolInputError('"pattern" must be a member name of up to 10 characters, with * or % as wildcards.');
        }
        const text = args.text === undefined ? undefined : String(args.text).slice(0, 50);
        const sourceType = args.sourceType === undefined ? undefined : name(args, "sourceType", "source type");
        const { libraries: searched } = libraries(args, io);
        const limit = integer(args, "limit", 100, 1, 500);
        const members = await io.searchSourceMembers(pattern, searched, {
          sourceType,
          sourceFile: name(args, "sourceFile", "source file", true),
          text,
          limit,
        });
        return { librariesSearched: searched, members, ...(members.length === limit ? { note: `Stopped at ${limit} members.` } : {}) };
      },
    },
    {
      name: "describe_file",
      title: "Describe a file or table",
      description: "Returns a physical or logical file, SQL table or view: its type, text, columns (name, type, length, " +
        "scale, text) and the logical files, views and indexes built over it.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "System name (e.g. CUSTMAST) or SQL name." },
          library: { type: "string", description: "Library; otherwise the search libraries are tried in order." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      readOnly: true,
      call: async (args) => {
        requireSystem(io);
        const raw = String(args.name ?? "").trim().toUpperCase();
        if (!/^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,127}$/.test(raw)) {
          throw new ToolInputError('"name" must be a file or table name.');
        }
        const library = name(args, "library", "library", true);
        const searched = library ? [library] : io.searchLibraries();
        const description = await io.describeFile(raw, searched);
        if (!description) {
          throw new Error(`No file or table named ${raw} in ${searched.join(", ") || "the search libraries"}.`);
        }
        return description;
      },
    },
    {
      name: "list_service_program_exports",
      title: "List service program exports",
      description: "Lists the procedures and data a service program (*SRVPGM) exports, from QSYS2.PROGRAM_EXPORT_IMPORT_INFO.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Service program name." },
          library: { type: "string", description: "Library; otherwise the search libraries are tried in order." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      readOnly: true,
      call: async (args) => {
        requireSystem(io);
        const program = name(args, "name", "service program");
        const library = name(args, "library", "library", true);
        const searched = library ? [library] : io.searchLibraries();
        const exports = await io.serviceProgramExports(program, searched);
        if (!exports) {
          throw new Error(`No service program ${program} in ${searched.join(", ") || "the search libraries"}.`);
        }
        return exports;
      },
    },
  ];
}
