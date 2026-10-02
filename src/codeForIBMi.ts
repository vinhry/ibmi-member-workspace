import * as vscode from "vscode";
import type { CodeForIBMi, IBMiMember } from "@halcyontech/vscode-ibmi-types";
import type { SourceMemberRow } from "./dependencyResolve";
import {
  CompiledObject,
  ReferencedObject,
  SourceLocation,
  objectKey,
} from "./dependencySources";
import { commandFailureMessages } from "./changeManagement";
import { changeStamp } from "./remoteStamps";
import { SourceLayout, layoutFromColumn } from "./sourceCheck";
import { CheckedOutMember, buildLocalFileName } from "./types";
import { Snapshot, SnapshotStore } from "./whereUsedSnapshot";

type IBMi = ReturnType<CodeForIBMi["instance"]["getConnection"]>;
type IBMiContent = ReturnType<IBMi["getContent"]>;

let cachedExports: CodeForIBMi | undefined;

export function getCodeForIBMi(): CodeForIBMi | undefined {
  if (cachedExports) {
    return cachedExports;
  }

  const ext = vscode.extensions.getExtension<CodeForIBMi>(
    "halcyontechltd.code-for-ibmi"
  );
  if (!ext) {
    return undefined;
  }

  if (!ext.isActive) {
    return undefined;
  }

  cachedExports = ext.exports;
  return cachedExports;
}

export function getInstance(): CodeForIBMi["instance"] | undefined {
  return getCodeForIBMi()?.instance;
}

/** The typings declare a connection is always returned, but it is undefined while disconnected. */
export function getConnection(): IBMi | undefined {
  return getInstance()?.getConnection() as IBMi | undefined;
}

function getContent(): IBMiContent {
  const content = getConnection()?.getContent();
  if (!content) {
    throw new Error("Not connected to IBM i");
  }
  return content;
}

export function getSystemName(): string | undefined {
  return getConnection()?.currentHost;
}

/** Runs `listener` whenever Code for IBM i connects or disconnects. */
export function onConnectionChange(
  context: vscode.ExtensionContext,
  listener: () => void
): void {
  const instance = getInstance();
  if (!instance) {
    return;
  }

  try {
    instance.subscribe(context, "connected", "Refresh checked out members (connected)", listener);
    instance.subscribe(context, "disconnected", "Refresh checked out members (disconnected)", listener);
  } catch {
    // Code for i API may vary — connection events are optional
  }
}

/** URI served by Code for IBM i's `member` file system for a checked-out member. */
export function memberUri(
  entry: CheckedOutMember,
  options?: { editable?: boolean }
): vscode.Uri {
  return vscode.Uri.from({
    scheme: "member",
    path: `/${entry.library}/${entry.sourceFile}/${buildLocalFileName(entry)}`,
    query: options?.editable ? "readonly=false" : undefined,
  });
}

export async function downloadMemberContent(
  library: string,
  sourceFile: string,
  member: string
): Promise<string> {
  return getContent().downloadMemberContent(library, sourceFile, member);
}

export async function uploadMemberContent(
  library: string,
  sourceFile: string,
  member: string,
  fileContent: string
): Promise<boolean> {
  return getContent().uploadMemberContent(library, sourceFile, member, fileContent);
}

/** The user profile Code for IBM i is connected with. */
export function connectedUser(): string | undefined {
  return getConnection()?.currentUser || undefined;
}

/** Whether the current Code for IBM i connection refuses writes to the IBM i. */
export function isConnectionReadOnly(): boolean {
  return getConnection()?.getConfig().readOnlyMode === true;
}

/** Whether Code for IBM i's "Enable source dates" is on for the current connection. */
export function sourceDatesEnabled(): boolean {
  return getConnection()?.getConfig().enableSourceDates === true;
}

/**
 * Replaces the member through Code for IBM i's `member` file system, which
 * keeps SRCDAT for unchanged lines and dates changed lines today — the same
 * save as editing the member in Code for IBM i. Only call this while
 * {@link sourceDatesEnabled}; otherwise that save resets every date to 0 and
 * shows a modal warning.
 *
 * Code for IBM i (checked against 3.0.13) diffs against the member as it last
 * read it, cached by `uri.toString()`. Reading through the same URI first
 * refreshes that base, which could otherwise be stale from an earlier open.
 * Pass content shaped by `normalizeForMemberUpload` (LF endings, no BOM, no
 * trailing blank lines) so only lines that really changed are dated today.
 */
export async function uploadMemberContentWithDates(
  entry: CheckedOutMember,
  fileContent: string
): Promise<void> {
  const uri = memberUri(entry, { editable: true });
  await vscode.workspace.fs.readFile(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, "utf-8"));
}

/** The connection's current library followed by its library list, without duplicates. */
export function connectionLibraryList(): string[] {
  const config = getConnection()?.getConfig();
  if (!config) {
    return [];
  }
  const libraries = [config.currentLibrary, ...config.libraryList]
    .filter((library): library is string => Boolean(library))
    .map((library) => library.toUpperCase());
  return [...new Set(libraries)];
}

/** Members looked up per SQL statement, to keep the statement and its bindings small. */
const MEMBERS_PER_LOOKUP = 100;

/**
 * Libraries other than IBM's: not starting with Q or #, except QGPL and QUSR…, which hold user
 * objects. The same rule as `isIbmLibrary` in dependencyResolve.
 */
const USER_LIBRARIES_ONLY =
  "(SYSTEM_TABLE_SCHEMA NOT LIKE 'Q%' OR SYSTEM_TABLE_SCHEMA = 'QGPL' OR SYSTEM_TABLE_SCHEMA LIKE 'QUSR%') " +
  "AND SYSTEM_TABLE_SCHEMA NOT LIKE '#%'";

/**
 * Source members named `members` in any source file of `libraries`, or of every user library when
 * `libraries` is undefined (which reads the whole catalog, so it can take a while).
 * SYSPARTITIONSTAT has a null SOURCE_TYPE for members of data files.
 */
export async function findSourceMembers(
  members: string[],
  libraries: string[] | undefined
): Promise<SourceMemberRow[]> {
  const connection = getConnection();
  if (!connection) {
    throw new Error("Not connected to IBM i");
  }
  if (members.length === 0 || libraries?.length === 0) {
    return [];
  }
  const libraryFilter = libraries
    ? `AND SYSTEM_TABLE_SCHEMA IN (${libraries.map(() => "?").join(", ")}) `
    : `AND ${USER_LIBRARIES_ONLY} `;
  const rows: SourceMemberRow[] = [];
  for (let i = 0; i < members.length; i += MEMBERS_PER_LOOKUP) {
    const chunk = members.slice(i, i + MEMBERS_PER_LOOKUP);
    const result = await connection.runSQL(
      `SELECT RTRIM(SYSTEM_TABLE_SCHEMA) AS LIBRARY, RTRIM(SYSTEM_TABLE_NAME) AS SOURCE_FILE, ` +
      `RTRIM(SYSTEM_TABLE_MEMBER) AS MEMBER, COALESCE(RTRIM(CAST(SOURCE_TYPE AS VARCHAR(10))), '') AS SOURCE_TYPE ` +
      `FROM QSYS2.SYSPARTITIONSTAT WHERE SOURCE_TYPE IS NOT NULL ` +
      libraryFilter +
      `AND SYSTEM_TABLE_MEMBER IN (${chunk.map(() => "?").join(", ")})`,
      { bindings: [...(libraries ?? []), ...chunk] }
    );
    rows.push(...result.map((row) => ({
      library: String(row.LIBRARY),
      sourceFile: String(row.SOURCE_FILE),
      member: String(row.MEMBER),
      sourceType: String(row.SOURCE_TYPE ?? ""),
    })));
  }
  return rows;
}

/**
 * The change stamps (see `changeStamp`) of `members` of one source file, keyed by member name. A
 * member that doesn't exist has none.
 */
export async function memberChangeStamps(
  library: string,
  sourceFile: string,
  members: readonly string[]
): Promise<Map<string, string>> {
  const connection = requireConnection();
  const stamps = new Map<string, string>();
  for (let i = 0; i < members.length; i += MEMBERS_PER_LOOKUP) {
    const chunk = members.slice(i, i + MEMBERS_PER_LOOKUP).map((member) => member.toUpperCase());
    const rows = await connection.runSQL(
      "SELECT RTRIM(SYSTEM_TABLE_MEMBER) AS MEMBER, VARCHAR(LAST_CHANGE_TIMESTAMP) AS CHANGED, " +
      "VARCHAR(LAST_SOURCE_UPDATE_TIMESTAMP) AS SOURCE_UPDATED, NUMBER_ROWS AS MEMBER_ROWS, DATA_SIZE AS MEMBER_SIZE " +
      "FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? " +
      `AND SYSTEM_TABLE_MEMBER IN (${chunk.map(() => "?").join(", ")})`,
      { bindings: [library.toUpperCase(), sourceFile.toUpperCase(), ...chunk] }
    );
    for (const row of rows) {
      stamps.set(String(row.MEMBER).toUpperCase(), changeStamp(row));
    }
  }
  return stamps;
}

function requireConnection(): IBMi {
  const connection = getConnection();
  if (!connection) {
    throw new Error("Not connected to IBM i");
  }
  return connection;
}

/**
 * Runs a CL command in the connection's ILE environment (its library list applies). Throws with
 * all its messages (the cause first, see `commandFailureMessages`) when the command fails.
 */
export async function runClCommand(command: string): Promise<void> {
  const connection = requireConnection();
  // The IBM i's clock, to read only the job log messages this command adds.
  const [started] = await connection.runSQL("VALUES VARCHAR(CURRENT TIMESTAMP)").catch(() => []);
  const since = started ? String(Object.values(started)[0] ?? "") : "";
  const result = await connection.runCommand({ command, environment: "ile" });
  if (result.code !== 0) {
    const messages = commandFailureMessages(
      [await jobLogSince(since), result.stderr, result.stdout].filter(Boolean).join("\n")
    );
    throw new Error(messages.join(" ") || `The command ended with code ${result.code}.`);
  }
}

/**
 * Diagnostic and error messages in the SQL job's log since `since`. A command run in that job (as
 * through QCMDEXC) leaves its cause there, e.g. Rocket LMI's CMSnnnn messages before its generic
 * CMS9913. Empty when the job log can't be read.
 */
async function jobLogSince(since: string): Promise<string> {
  if (!since) {
    return "";
  }
  try {
    const rows = await requireConnection().runSQL(
      "SELECT MESSAGE_ID, MESSAGE_TEXT FROM TABLE(QSYS2.JOBLOG_INFO('*')) X " +
      "WHERE MESSAGE_TIMESTAMP >= TIMESTAMP(?) AND MESSAGE_ID IS NOT NULL " +
      "AND (SEVERITY >= 20 OR MESSAGE_ID LIKE 'CMS%') ORDER BY ORDINAL_POSITION",
      { bindings: [since] }
    );
    return rows.map((row) => `${String(row.MESSAGE_ID).trim()}: ${String(row.MESSAGE_TEXT ?? "").trim()}`).join("\n");
  } catch {
    return "";
  }
}

/** A system object name, safe to put in a CL command. */
const OBJECT_NAME = /^[A-Z0-9_$#@][A-Z0-9_$#@.]{0,9}$/;

/** Whether QSYS2.OBJECT_STATISTICS (with named arguments) works on this IBM i. */
export async function sqlServicesAvailable(): Promise<boolean> {
  try {
    await requireConnection().runSQL(
      "SELECT OBJNAME FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB', OBJECT_NAME => 'QSYS2')) X"
    );
    return true;
  } catch {
    return false;
  }
}

export async function libraryExists(library: string): Promise<boolean> {
  const rows = await requireConnection().runSQL(
    "SELECT 1 AS FOUND FROM QSYS2.SYSSCHEMAS WHERE SYSTEM_SCHEMA_NAME = ? OR SCHEMA_NAME = ? FETCH FIRST 1 ROW ONLY",
    { bindings: [library, library] }
  );
  return rows.length > 0;
}

/**
 * The line length and CCSID of a source file's SRCDTA column. Undefined for a file without one, which
 * isn't a source physical file.
 */
export async function sourceFileLayout(library: string, sourceFile: string): Promise<SourceLayout | undefined> {
  const [row] = await requireConnection().runSQL(
    "SELECT LENGTH, CCSID FROM QSYS2.SYSCOLUMNS " +
    "WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? AND SYSTEM_COLUMN_NAME = 'SRCDTA'",
    { bindings: [library.toUpperCase(), sourceFile.toUpperCase()] }
  );
  return row ? layoutFromColumn(row.LENGTH, row.CCSID) : undefined;
}

/** The first *PGM or *SRVPGM named `name` in `libraries`, in order. Libraries that can't be read are skipped. */
export async function findCompiledObject(name: string, libraries: string[]): Promise<CompiledObject | undefined> {
  const connection = requireConnection();
  for (const library of libraries) {
    try {
      const [row] = await connection.runSQL(
        "SELECT OBJLIB, OBJNAME, OBJTYPE FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*PGM *SRVPGM', OBJECT_NAME => ?)) X",
        { bindings: [library, name] }
      );
      if (row) {
        return {
          library: String(row.OBJLIB).trim(),
          name: String(row.OBJNAME).trim(),
          type: String(row.OBJTYPE).trim() === "*SRVPGM" ? "*SRVPGM" : "*PGM",
        };
      }
    } catch {
      // A library that doesn't exist or isn't authorized just holds no object.
    }
  }
  return undefined;
}

/**
 * Commands that write a QTEMP outfile and then read it run one at a time. Find Dependencies and
 * Bob's tools can run together, and one's `*REPLACE` must not land between the other's write
 * and read.
 */
let outfileQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` after every command queued before it. A caller whose `signal` aborts stops waiting at
 * once, and its `fn` is skipped when its turn comes, so one hung command doesn't also hold up
 * requests nobody is waiting for any more.
 */
function exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const turn = () => (signal?.aborted ? Promise.reject(new OperationCancelledError()) : fn());
  const run = outfileQueue.then(turn, turn);
  outfileQueue = run.catch(() => undefined);
  if (!signal) {
    return run;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new OperationCancelledError());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Runs DSPPGMREF into a QTEMP outfile of the SQL job and returns its rows. */
export async function programReferences(object: CompiledObject): Promise<Array<Record<string, unknown>>> {
  if (!OBJECT_NAME.test(object.library) || !OBJECT_NAME.test(object.name)) {
    throw new Error(`Not a valid object name: ${object.library}/${object.name}`);
  }
  const type = object.type === "*SRVPGM" ? "*SRVPGM" : "*PGM";
  return exclusive(async () => {
    const connection = requireConnection();
    await connection.runSQL(
      `@QSYS/DSPPGMREF PGM(${object.library}/${object.name}) OUTPUT(*OUTFILE) OBJTYPE(${type}) ` +
      "OUTFILE(QTEMP/IMWPGMREF) OUTMBR(*FIRST *REPLACE)"
    );
    return connection.runSQL("SELECT WHFNAM, WHLNAM, WHOTYP FROM QTEMP.IMWPGMREF");
  });
}

/** Objects asked about per statement in `objectSources`. */
const OBJECTS_PER_SOURCE_LOOKUP = 25;

/**
 * The source member each object was created from, when the object records one. Objects are asked
 * about in groups, one statement per group; a group whose statement fails (for example, one
 * library is missing or not authorized) is asked about one object at a time.
 */
export async function objectSources(objects: ReferencedObject[]): Promise<Map<string, SourceLocation>> {
  const connection = requireConnection();
  const sources = new Map<string, SourceLocation>();
  const select = (index: number) =>
    `SELECT ${index} AS IDX, SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER ` +
    "FROM TABLE(QSYS2.OBJECT_STATISTICS(?, ?, OBJECT_NAME => ?)) X";
  const keep = (object: ReferencedObject, row: Record<string, unknown> | undefined) => {
    if (row?.SOURCE_LIBRARY && row.SOURCE_FILE && row.SOURCE_MEMBER && !sources.has(objectKey(object))) {
      sources.set(objectKey(object), {
        library: String(row.SOURCE_LIBRARY).trim(),
        sourceFile: String(row.SOURCE_FILE).trim(),
        member: String(row.SOURCE_MEMBER).trim(),
      });
    }
  };
  const withLibrary = objects.filter((object) => object.library);
  for (let start = 0; start < withLibrary.length; start += OBJECTS_PER_SOURCE_LOOKUP) {
    const group = withLibrary.slice(start, start + OBJECTS_PER_SOURCE_LOOKUP);
    try {
      const rows = await connection.runSQL(
        group.map((_object, index) => select(index)).join(" UNION ALL "),
        { bindings: group.flatMap((object) => [object.library!, object.type, object.name]) }
      );
      for (const row of rows) {
        const object = group[Number(row.IDX)];
        if (object) {
          keep(object, row);
        }
      }
      continue;
    } catch {
      // Asked one at a time below, so one bad object doesn't cost the others their source.
    }
    for (const object of group) {
      try {
        const [row] = await connection.runSQL(select(0), { bindings: [object.library!, object.type, object.name] });
        keep(object, row);
      } catch {
        // No source information: the reference is matched by name instead.
      }
    }
  }
  return sources;
}

/** Runs a user-defined cross-reference SELECT. */
export async function runCrossReferenceQuery(sql: string, bindings: string[]): Promise<Array<Record<string, unknown>>> {
  return requireConnection().runSQL(sql, { bindings });
}

/** Checks that `name` is a system object name, safe to put in a CL command. */
function objectName(name: string, what: string): string {
  const upper = name.trim().toUpperCase();
  if (!OBJECT_NAME.test(upper)) {
    throw new Error(`Not a valid ${what} name: ${name}`);
  }
  return upper;
}

export interface SourceMemberMatch extends SourceMemberRow {
  text: string;
  lastChanged: string;
}

/**
 * Source members whose name matches `pattern` ("*" and "%" are wildcards) in `libraries`,
 * optionally only of one source type or with text containing `text`.
 */
export async function searchSourceMembers(
  pattern: string,
  libraries: string[] | undefined,
  options: { sourceType?: string; sourceFile?: string; text?: string; limit: number }
): Promise<SourceMemberMatch[]> {
  if (libraries?.length === 0) {
    return [];
  }
  // Without libraries, every user library is read, which can take a while.
  const libraryFilter = libraries
    ? `AND SYSTEM_TABLE_SCHEMA IN (${libraries.map(() => "?").join(", ")}) `
    : `AND ${USER_LIBRARIES_ONLY} `;
  const bindings = [...(libraries ?? []), pattern.trim().toUpperCase().replace(/\*/g, "%")];
  let filters = "";
  if (options.sourceType) {
    filters += " AND UPPER(SOURCE_TYPE) = ?";
    bindings.push(options.sourceType.trim().toUpperCase());
  }
  if (options.sourceFile) {
    filters += " AND SYSTEM_TABLE_NAME = ?";
    bindings.push(options.sourceFile.trim().toUpperCase());
  }
  if (options.text) {
    filters += " AND UPPER(PARTITION_TEXT) LIKE ?";
    bindings.push(`%${options.text.trim().toUpperCase()}%`);
  }
  const rows = await requireConnection().runSQL(
    "SELECT RTRIM(SYSTEM_TABLE_SCHEMA) AS LIBRARY, RTRIM(SYSTEM_TABLE_NAME) AS SOURCE_FILE, " +
    "RTRIM(SYSTEM_TABLE_MEMBER) AS MEMBER, COALESCE(RTRIM(CAST(SOURCE_TYPE AS VARCHAR(10))), '') AS SOURCE_TYPE, " +
    "COALESCE(RTRIM(CAST(PARTITION_TEXT AS VARCHAR(50))), '') AS TEXT, " +
    "COALESCE(VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '') AS LAST_CHANGED " +
    "FROM QSYS2.SYSPARTITIONSTAT WHERE SOURCE_TYPE IS NOT NULL " +
    libraryFilter +
    `AND SYSTEM_TABLE_MEMBER LIKE ?${filters} ` +
    `ORDER BY SYSTEM_TABLE_MEMBER, SYSTEM_TABLE_SCHEMA FETCH FIRST ${Math.max(1, Math.floor(options.limit))} ROWS ONLY`,
    { bindings }
  );
  return rows.map((row) => ({
    library: String(row.LIBRARY),
    sourceFile: String(row.SOURCE_FILE),
    member: String(row.MEMBER),
    sourceType: String(row.SOURCE_TYPE ?? ""),
    text: String(row.TEXT ?? ""),
    lastChanged: String(row.LAST_CHANGED ?? ""),
  }));
}

export interface WhereUsedRow {
  library: string;
  program: string;
  text: string;
  /** The library the program names for the object, or "*LIBL". */
  objectLibrary: string;
  objectType: string;
  /** For files: how the program uses it (DSPPGMREF's usage code, e.g. 1 input, 2 output, 4 update). */
  usage?: string;
}

/**
 * DSPPGMREF of every program in a library, kept in a QTEMP file of the SQL job. Reading a whole
 * library is the slow part of a where-used search, so each library is read once and then asked
 * about any number of objects. QTEMP ends with the job, so snapshots are dropped when Code for
 * IBM i connects or disconnects, and only the most recently used ones are kept (`whereUsedSnapshot.ts`).
 */
const snapshots = new SnapshotStore();

/** Forgets every where-used snapshot, e.g. when the connection changes. */
export function resetWhereUsedSnapshots(): void {
  snapshots.clear();
}

export class OperationCancelledError extends Error {
  constructor() {
    super("Cancelled: the request was abandoned.");
    this.name = "OperationCancelledError";
  }
}

/**
 * Programs and service programs in `library` that refer to object `name`, from DSPPGMREF of
 * every program in the library. The first search in a library reads all of its programs, which
 * can take a while; later ones reuse that snapshot for a while (`WHERE_USED_SNAPSHOT_MINUTES`)
 * unless `refresh` asks for a new one.
 */
export async function whereUsed(
  name: string,
  library: string,
  objectType?: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {}
): Promise<{ rows: WhereUsedRow[]; snapshotTakenAt: string; reusedSnapshot: boolean }> {
  const lib = objectName(library, "library");
  const object = objectName(name, "object");
  const bindings = [object];
  let typeFilter = "";
  if (objectType) {
    // DSPPGMREF writes names and types in uppercase, so plain comparisons can use the index.
    typeFilter = " AND WHOTYP = ?";
    bindings.push(objectType.trim().toUpperCase());
  }
  return exclusive(async () => {
    const connection = requireConnection();
    const key = `${(getSystemName() ?? "").toUpperCase()}|${lib}`;
    const take = async (): Promise<Snapshot> => {
      const file = snapshots.fileFor(key);
      await connection.runSQL(
        `@QSYS/DSPPGMREF PGM(${lib}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*PGM *SRVPGM) ` +
        `OUTFILE(QTEMP/${file}) OUTMBR(*FIRST *REPLACE)`
      );
      try {
        await connection.runSQL(`CREATE INDEX QTEMP.${file}_I ON QTEMP.${file} (WHFNAM)`);
      } catch {
        // Already there (the file is reused) or not allowed: the query works without it.
      }
      const snapshot = { file, takenAt: Date.now() };
      snapshots.record(key, snapshot);
      return snapshot;
    };
    const read = (file: string) => connection.runSQL(
      `SELECT WHLIB, WHPNAM, WHTEXT, WHLNAM, WHOTYP, WHFUSG FROM QTEMP.${file} WHERE WHFNAM = ?${typeFilter}`,
      { bindings }
    );
    const reused = options.refresh ? undefined : snapshots.fresh(key, Date.now());
    let snapshot = reused ?? await take();
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await read(snapshot.file);
    } catch (err) {
      if (!reused) {
        throw err;
      }
      // The job may have ended (and QTEMP with it) without a disconnect event: take it again.
      snapshots.forget(key);
      snapshot = await take();
      rows = await read(snapshot.file);
    }
    return {
      rows: toWhereUsedRows(rows),
      snapshotTakenAt: new Date(snapshot.takenAt).toISOString(),
      reusedSnapshot: snapshot === reused,
    };
  }, options.signal);
}

function toWhereUsedRows(rows: ReadonlyArray<Record<string, unknown>>): WhereUsedRow[] {
  const found = new Map<string, WhereUsedRow>();
  for (const row of rows) {
    const usage = String(row.WHFUSG ?? "").trim();
    const entry: WhereUsedRow = {
      library: String(row.WHLIB ?? "").trim(),
      program: String(row.WHPNAM ?? "").trim(),
      text: String(row.WHTEXT ?? "").trim(),
      objectLibrary: String(row.WHLNAM ?? "").trim() || "*LIBL",
      objectType: String(row.WHOTYP ?? "").trim(),
      ...(usage && usage !== "0" ? { usage } : {}),
    };
    found.set(`${entry.library}/${entry.program}/${entry.objectType}`, entry);
  }
  return [...found.values()];
}

export interface FileDescription {
  library: string;
  systemName: string;
  sqlName: string;
  /** SYSTABLES TABLE_TYPE: T table, P physical file, L logical file, V view, A alias, M materialized query table. */
  type: string;
  text: string;
  columns: Array<{
    name: string;
    systemName: string;
    type: string;
    length: number;
    scale?: number;
    nullable: boolean;
    text: string;
  }>;
  /** Logical files, views and indexes built over the file (DSPDBR); absent when that could not be read. */
  dependents?: Array<{ library: string; name: string; type: string }>;
  notes: string[];
}

/** A file, table or view: its columns and what depends on it. The first match in `libraries` wins. */
export async function describeFile(name: string, libraries: string[]): Promise<FileDescription | undefined> {
  const connection = requireConnection();
  const upper = name.trim().toUpperCase();
  if (libraries.length === 0) {
    return undefined;
  }
  const tables = await connection.runSQL(
    "SELECT RTRIM(SYSTEM_TABLE_SCHEMA) AS LIBRARY, RTRIM(SYSTEM_TABLE_NAME) AS SYSTEM_NAME, TABLE_NAME, " +
    "TABLE_TYPE, COALESCE(TABLE_TEXT, '') AS TEXT FROM QSYS2.SYSTABLES " +
    `WHERE SYSTEM_TABLE_SCHEMA IN (${libraries.map(() => "?").join(", ")}) ` +
    "AND (SYSTEM_TABLE_NAME = ? OR TABLE_NAME = ?) AND FILE_TYPE = 'D'",
    { bindings: [...libraries, upper, upper] }
  );
  const order = libraries.map((library) => library.toUpperCase());
  const [table] = tables.sort((a, b) =>
    order.indexOf(String(a.LIBRARY).toUpperCase()) - order.indexOf(String(b.LIBRARY).toUpperCase())
  );
  if (!table) {
    return undefined;
  }
  const library = String(table.LIBRARY);
  const systemName = String(table.SYSTEM_NAME);
  const columns = await connection.runSQL(
    "SELECT COLUMN_NAME, RTRIM(SYSTEM_COLUMN_NAME) AS SYSTEM_COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, " +
    "IS_NULLABLE, COALESCE(COLUMN_TEXT, '') AS TEXT FROM QSYS2.SYSCOLUMNS " +
    "WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    { bindings: [library, systemName] }
  );
  const description: FileDescription = {
    library,
    systemName,
    sqlName: String(table.TABLE_NAME ?? "").trim(),
    type: String(table.TABLE_TYPE ?? "").trim(),
    text: String(table.TEXT ?? "").trim(),
    columns: columns.map((column) => {
      const scale = column.NUMERIC_SCALE;
      return {
        name: String(column.COLUMN_NAME ?? "").trim(),
        systemName: String(column.SYSTEM_COLUMN_NAME ?? "").trim(),
        type: String(column.DATA_TYPE ?? "").trim(),
        length: Number(column.LENGTH ?? 0),
        ...(scale !== null && scale !== undefined ? { scale: Number(scale) } : {}),
        nullable: String(column.IS_NULLABLE ?? "").trim() === "Y",
        text: String(column.TEXT ?? "").trim(),
      };
    }),
    notes: [],
  };
  try {
    const file = `${objectName(library, "library")}/${objectName(systemName, "file")}`;
    const rows = await exclusive(async () => {
      await connection.runSQL(
        `@QSYS/DSPDBR FILE(${file}) OUTPUT(*OUTFILE) OUTFILE(QTEMP/IMWDBR) OUTMBR(*FIRST *REPLACE)`
      );
      // Column names vary a little between releases, so they are looked up rather than selected by name.
      return connection.runSQL("SELECT * FROM QTEMP.IMWDBR");
    });
    const column = (row: Record<string, unknown>, ...names: string[]) => {
      const key = Object.keys(row).find((candidate) => names.includes(candidate.toUpperCase()));
      return key === undefined ? "" : String(row[key] ?? "").trim();
    };
    if (rows.length > 0 && !Object.keys(rows[0]).some((key) => key.toUpperCase() === "WHREFI")) {
      description.notes.push(`Dependent files could not be read: unexpected DSPDBR columns ${Object.keys(rows[0]).join(", ")}`);
    }
    description.dependents = rows.flatMap((row) => {
      const dependent = column(row, "WHREFI");
      return dependent
        ? [{ library: column(row, "WHRELI"), name: dependent, type: column(row, "WHTYPE") }]
        : [];
    });
  } catch (err) {
    description.notes.push(`Dependent files could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return description;
}

export interface ServiceProgramExport {
  symbol: string;
  usage: string;
}

/** The procedures and data a service program exports; the first match in `libraries` wins. */
export async function serviceProgramExports(
  name: string,
  libraries: string[]
): Promise<{ library: string; name: string; exports: ServiceProgramExport[] } | undefined> {
  const program = objectName(name, "service program");
  if (libraries.length === 0) {
    return undefined;
  }
  const rows = await requireConnection().runSQL(
    "SELECT PROGRAM_LIBRARY, PROGRAM_NAME, CAST(SYMBOL_NAME AS VARCHAR(1024)) AS SYMBOL, SYMBOL_USAGE " +
    "FROM QSYS2.PROGRAM_EXPORT_IMPORT_INFO WHERE OBJECT_TYPE = '*SRVPGM' AND PROGRAM_NAME = ? " +
    `AND PROGRAM_LIBRARY IN (${libraries.map(() => "?").join(", ")})`,
    { bindings: [program, ...libraries] }
  );
  const order = libraries.map((library) => library.toUpperCase());
  const byLibrary = new Map<string, ServiceProgramExport[]>();
  for (const row of rows) {
    const library = String(row.PROGRAM_LIBRARY ?? "").trim().toUpperCase();
    const list = byLibrary.get(library) ?? [];
    list.push({ symbol: String(row.SYMBOL ?? "").trim(), usage: String(row.SYMBOL_USAGE ?? "").trim() });
    byLibrary.set(library, list);
  }
  const library = order.find((candidate) => byLibrary.has(candidate));
  return library ? { library, name: program, exports: byLibrary.get(library)! } : undefined;
}

export async function listSourceFileMembers(
  library: string,
  sourceFile: string
): Promise<IBMiMember[]> {
  return getContent().getMemberList({ library, sourceFile });
}
