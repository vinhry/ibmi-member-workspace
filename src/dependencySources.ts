import { PROGRAM_SOURCE_TYPES } from "./dependencyResolve";
import { RawReference, ReferenceKind, SCANNED_SOURCE_TYPES, scanReferences } from "./dependencyScan";
import type { CheckedOutMember } from "./types";

/**
 * Dependency providers: where Find Dependencies learns what a member uses. The
 * local source scan always works; the others need something that not every
 * IBM i has (SQL services, authority to DSPPGMREF, a cross-reference tool such
 * as Abstract), so each is checked on the connected system and left out when
 * it isn't available. IBM i calls are injected, keeping this module testable.
 */

export type ProviderGroup = "source" | "programReferences" | "crossReferences";

export const PROVIDER_GROUPS: readonly ProviderGroup[] = ["source", "programReferences", "crossReferences"];

export type Availability = { ok: true } | { ok: false; reason: string };

export interface ProviderContext {
  system: string;
  /** Search libraries, in order, for source members and compiled objects. */
  libraries: string[];
}

export interface ProviderResult {
  references: RawReference[];
  /** Something worth telling the user although nothing failed, e.g. no compiled object found. */
  note?: string;
}

export interface DependencyProvider {
  id: string;
  /** Shown as "found by <label>". */
  label: string;
  group: ProviderGroup;
  /** Host names the provider is limited to; empty or undefined means every system. */
  systems?: string[];
  applies(entry: CheckedOutMember): boolean;
  available(context: ProviderContext): Promise<Availability>;
  find(entry: CheckedOutMember, context: ProviderContext): Promise<ProviderResult>;
}

/** Thrown when a provider can't work on this system at all; it isn't tried again this session. */
export class ProviderUnavailableError extends Error {}

/**
 * IBM i messages meaning a provider's objects are missing or not authorized, as opposed to a
 * one-off failure: SQL0204 not found, SQL0551 not authorized, CPF9801/CPF9810 object/library not
 * found, CPF9802/CPF9820/CPF9822 not authorized.
 */
export function isUnavailableError(message: string): boolean {
  return /\b(SQL0204|SQL0551|CPF9801|CPF9802|CPF9810|CPF9820|CPF9822)\b/.test(message);
}

/** Availability per system, probed once per connection. */
export class ProviderAvailabilityCache {
  private readonly bySystem = new Map<string, Map<string, Availability>>();

  async get(system: string, providerId: string, probe: () => Promise<Availability>): Promise<Availability> {
    const known = this.known(system, providerId);
    if (known) {
      return known;
    }
    let result: Availability;
    try {
      result = await probe();
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    this.store(system).set(providerId, result);
    return result;
  }

  /** The cached result, without probing. */
  known(system: string, providerId: string): Availability | undefined {
    return this.bySystem.get(system.toUpperCase())?.get(providerId);
  }

  markUnavailable(system: string, providerId: string, reason: string): void {
    this.store(system).set(providerId, { ok: false, reason });
  }

  /** Forgets everything, e.g. when Code for IBM i connects or disconnects. */
  reset(): void {
    this.bySystem.clear();
  }

  private store(system: string): Map<string, Availability> {
    const key = system.toUpperCase();
    let store = this.bySystem.get(key);
    if (!store) {
      store = new Map();
      this.bySystem.set(key, store);
    }
    return store;
  }
}

/** The providers turned on in settings and meant for this system. */
export function selectProviders(
  providers: readonly DependencyProvider[],
  { enabled, system }: { enabled: ReadonlySet<ProviderGroup>; system: string }
): DependencyProvider[] {
  return providers.filter((provider) =>
    enabled.has(provider.group) &&
    (!provider.systems?.length || provider.systems.some((name) => name.toUpperCase() === system.toUpperCase()))
  );
}

export type ProviderOutcome =
  | { label: string; status: "ran"; count: number; note?: string }
  | { label: string; status: "unavailable"; reason: string }
  | { label: string; status: "failed"; error: string };

/** Runs every applicable, available provider; one failing never stops the others. */
export async function runProviders(
  providers: readonly DependencyProvider[],
  entry: CheckedOutMember,
  context: ProviderContext,
  cache: ProviderAvailabilityCache
): Promise<{ references: RawReference[]; outcomes: ProviderOutcome[] }> {
  const found: RawReference[] = [];
  const outcomes: ProviderOutcome[] = [];
  for (const provider of providers) {
    if (!provider.applies(entry)) {
      continue;
    }
    const availability = await cache.get(context.system, provider.id, () => provider.available(context));
    if (!availability.ok) {
      outcomes.push({ label: provider.label, status: "unavailable", reason: availability.reason });
      continue;
    }
    try {
      const result = await provider.find(entry, context);
      found.push(...result.references.map((ref) => ({ ...ref, foundBy: [provider.label] })));
      outcomes.push({ label: provider.label, status: "ran", count: result.references.length, note: result.note });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ProviderUnavailableError || isUnavailableError(message)) {
        cache.markUnavailable(context.system, provider.id, message);
        outcomes.push({ label: provider.label, status: "unavailable", reason: message });
      } else {
        outcomes.push({ label: provider.label, status: "failed", error: message });
      }
    }
  }
  return { references: mergeReferences(found), outcomes };
}

/**
 * Combines what several providers found. The same member found twice is listed
 * once with both providers; a reference naming an exact source member absorbs
 * name-only references to the same member.
 */
export function mergeReferences(refs: readonly RawReference[]): RawReference[] {
  const merged: RawReference[] = [];
  const absorb = (target: RawReference, ref: RawReference) => {
    target.foundBy = [...new Set([...(target.foundBy ?? []), ...(ref.foundBy ?? [])])];
    if (target.line === undefined && ref.line !== undefined) {
      target.line = ref.line;
      target.text = ref.text;
    }
  };
  const isExact = (ref: RawReference) => Boolean(ref.library && ref.sourceFile);
  const sameMember = (a: RawReference, b: RawReference) => a.kind === b.kind && a.member === b.member;

  // Exact references first, so name-only ones can fold into them whatever the order.
  for (const ref of [...refs].sort((a, b) => Number(isExact(b)) - Number(isExact(a)))) {
    const existing = merged.find((other) =>
      sameMember(other, ref) &&
      (isExact(ref)
        ? other.library === ref.library && other.sourceFile === ref.sourceFile
        : (isExact(other) && !ref.library) || (!isExact(other) && other.library === ref.library))
    );
    if (existing) {
      absorb(existing, ref);
    } else {
      merged.push({ ...ref, foundBy: [...(ref.foundBy ?? [])] });
    }
  }
  // Keep the order the providers reported them in.
  return merged.sort((a, b) => refs.findIndex((ref) => sameMember(ref, a)) - refs.findIndex((ref) => sameMember(ref, b)));
}

/** One line for the picker, e.g. "Found by source scan (3), DSPPGMREF (5) · Abstract: not on this system". */
export function summarizeRun(outcomes: readonly ProviderOutcome[]): string {
  const ran = outcomes.flatMap((o) => (o.status === "ran" ? [`${o.label} (${o.count})`] : []));
  const other = outcomes.flatMap((o) =>
    o.status === "unavailable" ? [`${o.label}: not available`]
      : o.status === "failed" ? [`${o.label}: failed`]
        : o.note ? [`${o.label}: ${o.note}`] : []
  );
  return [ran.length > 0 ? `Found by ${ran.join(", ")}` : "No provider ran", ...other].join(" · ");
}

// ---------------------------------------------------------------------------
// Source scan

export function createSourceScanProvider(readText: (entry: CheckedOutMember) => string): DependencyProvider {
  return {
    id: "source",
    label: "source scan",
    group: "source",
    applies: (entry) => SCANNED_SOURCE_TYPES.has(entry.extension.toLowerCase()),
    available: async () => ({ ok: true }),
    find: async (entry) => ({ references: scanReferences(readText(entry), entry.extension) }),
  };
}

// ---------------------------------------------------------------------------
// DSPPGMREF on the compiled object

export interface CompiledObject {
  library: string;
  name: string;
  type: "*PGM" | "*SRVPGM";
}

export interface ReferencedObject {
  /** Undefined when DSPPGMREF reports *LIBL or nothing. */
  library?: string;
  name: string;
  type: "*FILE" | "*PGM" | "*SRVPGM";
  kind: ReferenceKind;
}

export interface SourceLocation {
  library: string;
  sourceFile: string;
  member: string;
}

export interface ProgramReferencesIo {
  /** Whether the IBM i SQL services this provider relies on work on this system. */
  sqlServicesAvailable(): Promise<boolean>;
  findCompiledObject(name: string, libraries: string[]): Promise<CompiledObject | undefined>;
  /** Rows of the DSPPGMREF outfile (QADSPPGM). */
  programReferences(object: CompiledObject): Promise<Array<Record<string, unknown>>>;
  /** The source member each object was created from, keyed by `objectKey`. */
  objectSources(objects: ReferencedObject[]): Promise<Map<string, SourceLocation>>;
}

export function objectKey(object: { library?: string; name: string; type: string }): string {
  return `${object.library ?? ""}/${object.name}/${object.type}`;
}

const OBJECT_KINDS: Record<string, ReferenceKind> = { "*FILE": "file", "*PGM": "program", "*SRVPGM": "program" };

/** DSPPGMREF outfile rows to the files and programs used; data areas, message files and the like are dropped. */
export function pgmRefRowsToObjects(rows: ReadonlyArray<Record<string, unknown>>): ReferencedObject[] {
  const objects = new Map<string, ReferencedObject>();
  for (const row of rows) {
    const name = String(row.WHFNAM ?? "").trim().toUpperCase();
    const type = String(row.WHOTYP ?? "").trim().toUpperCase();
    const library = String(row.WHLNAM ?? "").trim().toUpperCase();
    const kind = OBJECT_KINDS[type];
    if (!name || !kind || name.startsWith("*") || name.startsWith("&")) {
      continue;
    }
    const object: ReferencedObject = {
      library: library && !library.startsWith("*") ? library : undefined,
      name,
      type: type as ReferencedObject["type"],
      kind,
    };
    objects.set(objectKey(object), object);
  }
  return [...objects.values()];
}

export function createProgramReferencesProvider(io: ProgramReferencesIo): DependencyProvider {
  return {
    id: "programReferences",
    label: "DSPPGMREF",
    group: "programReferences",
    applies: (entry) => PROGRAM_SOURCE_TYPES.has(entry.extension.toUpperCase()),
    available: async () =>
      (await io.sqlServicesAvailable()) ? { ok: true } : { ok: false, reason: "IBM i SQL services not available" },
    find: async (entry, context) => {
      const object = await io.findCompiledObject(entry.memberName, context.libraries);
      if (!object) {
        return {
          references: [],
          note: `no compiled program ${entry.memberName} in ${context.libraries.join(", ") || "the search libraries"}`,
        };
      }
      const objects = pgmRefRowsToObjects(await io.programReferences(object));
      const sources = await io.objectSources(objects.filter((o) => o.library));
      const text = `DSPPGMREF of ${object.library}/${object.name}`;
      return {
        references: objects.map((o): RawReference => {
          const source = sources.get(objectKey(o));
          // The object library is never the source library: objects and source usually live apart.
          return source
            ? { kind: o.kind, library: source.library, sourceFile: source.sourceFile, member: source.member, text }
            : { kind: o.kind, member: o.name, text };
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// User-defined cross-reference queries (Abstract, Pathfinder, MDXREF, ...)

export interface CrossReferenceConfig {
  name: string;
  query: string;
  systems?: string[];
  requiresLibrary?: string;
}

/** Valid entries of the `dependencies.crossReferences` setting, plus why others were skipped. */
export function parseCrossReferenceConfigs(value: unknown): { configs: CrossReferenceConfig[]; problems: string[] } {
  const configs: CrossReferenceConfig[] = [];
  const problems: string[] = [];
  for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
    const candidate = item as Partial<CrossReferenceConfig> | null;
    if (!candidate || typeof candidate.name !== "string" || !candidate.name.trim() ||
        typeof candidate.query !== "string" || !candidate.query.trim()) {
      problems.push(`Entry ${index + 1} needs a "name" and a "query".`);
      continue;
    }
    configs.push({
      name: candidate.name.trim(),
      query: candidate.query,
      systems: Array.isArray(candidate.systems) ? candidate.systems.filter((s): s is string => typeof s === "string") : undefined,
      requiresLibrary: typeof candidate.requiresLibrary === "string" && candidate.requiresLibrary.trim()
        ? candidate.requiresLibrary.trim().toUpperCase()
        : undefined,
    });
  }
  return { configs, problems };
}

const PLACEHOLDER = /\{(library|sourceFile|member|object)\}/g;

/** Turns `{library}`-style placeholders into parameter markers; only a single SELECT is accepted. */
export function crossReferenceStatement(
  query: string,
  entry: Pick<CheckedOutMember, "library" | "sourceFile" | "memberName">
): { sql: string; bindings: string[] } {
  const statement = query.trim().replace(/;\s*$/, "");
  if (!/^(SELECT|WITH)\b/i.test(statement)) {
    throw new Error("The query must be a SELECT (or WITH … SELECT) statement.");
  }
  if (statement.includes(";")) {
    throw new Error("The query must be a single statement.");
  }
  const values: Record<string, string> = {
    library: entry.library,
    sourceFile: entry.sourceFile,
    member: entry.memberName,
    object: entry.memberName,
  };
  const bindings: string[] = [];
  const sql = statement.replace(PLACEHOLDER, (_match, name: string) => {
    bindings.push(values[name]);
    return "?";
  });
  return { sql, bindings };
}

/** Maps the KIND column; object types and common tool wording are accepted. */
export function crossReferenceKind(value: unknown): ReferenceKind | undefined {
  const kind = String(value ?? "").trim().toUpperCase().replace(/^[*/]/, "");
  if (["COPYBOOK", "COPY", "INCLUDE"].includes(kind)) {
    return "copybook";
  }
  if (["PROGRAM", "PGM", "SRVPGM", "SERVICE PROGRAM"].includes(kind)) {
    return "program";
  }
  if (["FILE", "TABLE", "VIEW", "PF", "LF", "DSPF", "PRTF"].includes(kind)) {
    return "file";
  }
  return undefined;
}

/** Rows of a cross-reference query to references; column names are matched case-insensitively. */
export function xrefRowsToReferences(
  rows: ReadonlyArray<Record<string, unknown>>,
  label: string
): { references: RawReference[]; dropped: number } {
  const references: RawReference[] = [];
  let dropped = 0;
  for (const row of rows) {
    const column = (name: string) => {
      const key = Object.keys(row).find((candidate) => candidate.toUpperCase() === name);
      const value = key === undefined ? undefined : row[key];
      return value === null || value === undefined ? "" : String(value).trim();
    };
    const member = (column("MEMBER") || column("OBJECT")).toUpperCase();
    const kind = crossReferenceKind(column("KIND"));
    if (!member || !kind) {
      dropped++;
      continue;
    }
    const library = column("LIBRARY").toUpperCase() || undefined;
    const sourceFile = column("SOURCE_FILE").toUpperCase() || undefined;
    const line = Number(column("LINE"));
    references.push({
      kind,
      library,
      sourceFile: library ? sourceFile : undefined,
      member,
      line: Number.isInteger(line) && line > 0 ? line : undefined,
      text: column("TEXT") || label,
    });
  }
  return { references, dropped };
}

export interface CrossReferenceIo {
  libraryExists(library: string): Promise<boolean>;
  runQuery(sql: string, bindings: string[]): Promise<Array<Record<string, unknown>>>;
  log(message: string): void;
}

export function createCrossReferenceProvider(config: CrossReferenceConfig, io: CrossReferenceIo): DependencyProvider {
  return {
    id: `xref:${config.name}`,
    label: config.name,
    group: "crossReferences",
    systems: config.systems,
    applies: () => true,
    available: async () => {
      if (config.requiresLibrary && !(await io.libraryExists(config.requiresLibrary))) {
        return { ok: false, reason: `library ${config.requiresLibrary} is not on this system` };
      }
      return { ok: true };
    },
    find: async (entry) => {
      const { sql, bindings } = crossReferenceStatement(config.query, entry);
      const { references, dropped } = xrefRowsToReferences(await io.runQuery(sql, bindings), config.name);
      if (dropped > 0) {
        io.log(`[dependencies] ${config.name}: skipped ${dropped} row(s) without a MEMBER/OBJECT or a known KIND`);
      }
      return { references };
    },
  };
}
