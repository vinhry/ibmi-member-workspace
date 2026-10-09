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
import { TimedOutError, withDeadline } from "./deadline";
import { errorMessage } from "./errors";
import { LIKE_ESCAPE, likeMemberPattern, likeText } from "./memberSearch";
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

/** The connection, undefined while disconnected. */
export function getConnection(): IBMi | undefined {
  return getInstance()?.getConnection();
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
/** How long a CL command such as a change-management checkout may run before the extension stops waiting. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;

export async function runClCommand(command: string): Promise<void> {
  const connection = requireConnection();
  // The IBM i's clock, to read only the job log messages this command adds.
  const [started] = await connection.runSQL("VALUES VARCHAR(CURRENT TIMESTAMP)").catch(() => []);
  const since = started ? String(Object.values(started)[0] ?? "") : "";
  let result: Awaited<ReturnType<typeof connection.runCommand>>;
  try {
    result = await withDeadline(connection.runCommand({ command, environment: "ile" }), {
      ms: COMMAND_TIMEOUT_MS,
      what: `running ${command.split(/\s/)[0]}`,
    });
  } catch (err) {
    if (err instanceof TimedOutError) {
      throw new Error(
        `${err.message} The command may be waiting for a reply on the IBM i: look for its job in MSGW status (WRKACTJOB), ` +
        "answer or end it, then reconnect.",
        { cause: err }
      );
    }
    throw err;
  }
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
  const row = await firstObjectRow("OBJLIB, OBJNAME, OBJTYPE", libraries, "*PGM *SRVPGM", name);
  return row
    ? {
      library: String(row.OBJLIB).trim(),
      name: String(row.OBJNAME).trim(),
      type: String(row.OBJTYPE).trim() === "*SRVPGM" ? "*SRVPGM" : "*PGM",
    }
    : undefined;
}

/** Libraries asked about per statement in `firstObjectRow`. */
const LIBRARIES_PER_PROBE = 25;

/**
 * The OBJECT_STATISTICS row of the first library in `libraries` that holds object `name` of a type
 * in `typeList`, with the given columns. Libraries are asked about in groups, one statement per
 * group; a group whose statement fails (a library that doesn't exist or isn't authorized fails the
 * whole statement) is asked about one library at a time.
 */
async function firstObjectRow(
  columns: string,
  libraries: string[],
  typeList: string,
  name: string
): Promise<Record<string, unknown> | undefined> {
  const connection = requireConnection();
  const select = (index: number) =>
    `SELECT ${index} AS IDX, ${columns} FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '${typeList}', OBJECT_NAME => ?)) X`;
  for (let start = 0; start < libraries.length; start += LIBRARIES_PER_PROBE) {
    const group = libraries.slice(start, start + LIBRARIES_PER_PROBE);
    let rows: Array<Record<string, unknown>> | undefined;
    try {
      rows = await connection.runSQL(
        group.map((_library, index) => select(index)).join(" UNION ALL "),
        { bindings: group.flatMap((library) => [library, name]) }
      );
    } catch {
      rows = undefined;
    }
    if (rows) {
      const first = rows.sort((a, b) => Number(a.IDX) - Number(b.IDX))[0];
      if (first) {
        return first;
      }
      continue;
    }
    for (const library of group) {
      try {
        const [row] = await connection.runSQL(select(0), { bindings: [library, name] });
        if (row) {
          return row;
        }
      } catch {
        // A library that doesn't exist or isn't authorized just holds no object.
      }
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
  const bindings = [...(libraries ?? []), likeMemberPattern(pattern.trim().toUpperCase())];
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
    filters += ` AND UPPER(PARTITION_TEXT) LIKE ? ESCAPE '${LIKE_ESCAPE}'`;
    bindings.push(likeText(options.text.trim().toUpperCase()));
  }
  const rows = await requireConnection().runSQL(
    "SELECT RTRIM(SYSTEM_TABLE_SCHEMA) AS LIBRARY, RTRIM(SYSTEM_TABLE_NAME) AS SOURCE_FILE, " +
    "RTRIM(SYSTEM_TABLE_MEMBER) AS MEMBER, COALESCE(RTRIM(CAST(SOURCE_TYPE AS VARCHAR(10))), '') AS SOURCE_TYPE, " +
    "COALESCE(RTRIM(CAST(PARTITION_TEXT AS VARCHAR(50))), '') AS TEXT, " +
    "COALESCE(VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '') AS LAST_CHANGED " +
    "FROM QSYS2.SYSPARTITIONSTAT WHERE SOURCE_TYPE IS NOT NULL " +
    libraryFilter +
    `AND SYSTEM_TABLE_MEMBER LIKE ? ESCAPE '${LIKE_ESCAPE}'${filters} ` +
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
/** The SYSTABLES row of a file, table or view named `name` (system or SQL name); the first match in `libraries` wins. */
async function findTable(
  name: string,
  libraries: string[]
): Promise<{ library: string; systemName: string; sqlName: string; type: string; text: string } | undefined> {
  const upper = name.trim().toUpperCase();
  if (libraries.length === 0) {
    return undefined;
  }
  const tables = await requireConnection().runSQL(
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
  return table
    ? {
      library: String(table.LIBRARY),
      systemName: String(table.SYSTEM_NAME),
      sqlName: String(table.TABLE_NAME ?? "").trim(),
      type: String(table.TABLE_TYPE ?? "").trim(),
      text: String(table.TEXT ?? "").trim(),
    }
    : undefined;
}

export async function describeFile(name: string, libraries: string[]): Promise<FileDescription | undefined> {
  const connection = requireConnection();
  const table = await findTable(name, libraries);
  if (!table) {
    return undefined;
  }
  const { library, systemName } = table;
  const columns = await connection.runSQL(
    "SELECT COLUMN_NAME, RTRIM(SYSTEM_COLUMN_NAME) AS SYSTEM_COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, " +
    "IS_NULLABLE, COALESCE(COLUMN_TEXT, '') AS TEXT FROM QSYS2.SYSCOLUMNS " +
    "WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    { bindings: [library, systemName] }
  );
  const description: FileDescription = {
    library,
    systemName,
    sqlName: table.sqlName,
    type: table.type,
    text: table.text,
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
    description.notes.push(`Dependent files could not be read: ${errorMessage(err)}`);
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

/** A value of a row by any of several column names (they vary a little between releases), trimmed; undefined when absent or null. */
function columnValue(row: Record<string, unknown>, ...names: string[]): string | undefined {
  const key = Object.keys(row).find((candidate) => names.includes(candidate.toUpperCase()));
  const value = key === undefined ? undefined : row[key];
  return value === undefined || value === null ? undefined : String(value).trim();
}

/** The named columns of a row that are present and not null, as text. */
function pickColumns(row: Record<string, unknown>, mapping: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, names] of Object.entries(mapping)) {
    const value = columnValue(row, ...names);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export interface ObjectDescription {
  library: string;
  name: string;
  /** *PGM or *SRVPGM. */
  type: string;
  /** From OBJECT_STATISTICS: attribute (RPGLE, CLLE…), text, owner, timestamps, source. */
  object: Record<string, string>;
  /** From QSYS2.PROGRAM_INFO: ILE or OPM, activation group, adopted authority, entry module, counts…; absent when it couldn't be read. */
  program?: Record<string, string>;
  /** From QSYS2.BOUND_MODULE_INFO; absent when it couldn't be read. */
  modules?: Array<Record<string, string>>;
  /** From QSYS2.BOUND_SRVPGM_INFO; absent when it couldn't be read. */
  boundServicePrograms?: Array<Record<string, string>>;
  notes: string[];
}

/**
 * A program or service program: what OBJECT_STATISTICS, PROGRAM_INFO, BOUND_MODULE_INFO and
 * BOUND_SRVPGM_INFO say about it. The first match in `libraries` wins; each view beyond the first is
 * optional (older releases lack some), so a failure there is a note, not an error.
 */
export async function describeObject(
  name: string,
  libraries: string[],
  types: string[] = ["*PGM", "*SRVPGM"]
): Promise<ObjectDescription | undefined> {
  const connection = requireConnection();
  const object = objectName(name, "object");
  const typeList = types.map((type) => objectType(type)).join(" ");
  const found = await firstObjectRow(
    "OBJLIB, OBJNAME, OBJTYPE, OBJATTRIBUTE, OBJTEXT, OBJOWNER, OBJCREATED, CHANGE_TIMESTAMP, " +
    "LAST_USED_TIMESTAMP, DAYS_USED_COUNT, SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER, SOURCE_TIMESTAMP",
    libraries.map((library) => objectName(library, "library")),
    typeList,
    object
  );
  if (!found) {
    return undefined;
  }
  const library = columnValue(found, "OBJLIB") ?? "";
  const type = columnValue(found, "OBJTYPE") ?? "";
  const description: ObjectDescription = {
    library,
    name: columnValue(found, "OBJNAME") ?? object,
    type,
    object: pickColumns(found, {
      attribute: ["OBJATTRIBUTE"],
      text: ["OBJTEXT"],
      owner: ["OBJOWNER"],
      created: ["OBJCREATED"],
      changed: ["CHANGE_TIMESTAMP"],
      lastUsed: ["LAST_USED_TIMESTAMP"],
      daysUsed: ["DAYS_USED_COUNT"],
      sourceLibrary: ["SOURCE_LIBRARY"],
      sourceFile: ["SOURCE_FILE"],
      sourceMember: ["SOURCE_MEMBER"],
      sourceChanged: ["SOURCE_TIMESTAMP"],
    }),
    notes: [],
  };
  const where = "WHERE PROGRAM_LIBRARY = ? AND PROGRAM_NAME = ? AND OBJECT_TYPE = ?";
  const bindings = [library, description.name, type];
  try {
    const [row] = await connection.runSQL(`SELECT * FROM QSYS2.PROGRAM_INFO ${where}`, { bindings });
    if (row) {
      description.program = pickColumns(row, {
        programType: ["PROGRAM_TYPE"],
        attribute: ["PROGRAM_ATTRIBUTE"],
        text: ["TEXT_DESCRIPTION"],
        owner: ["PROGRAM_OWNER"],
        userProfile: ["USER_PROFILE"],
        useAdoptedAuthority: ["USE_ADOPTED_AUTHORITY"],
        activationGroup: ["ACTIVATION_GROUP"],
        entryModule: ["PROGRAM_ENTRY_PROCEDURE_MODULE"],
        entryModuleLibrary: ["PROGRAM_ENTRY_PROCEDURE_MODULE_LIBRARY"],
        moduleCount: ["MODULES"],
        serviceProgramCount: ["SERVICE_PROGRAMS"],
        sourceLibrary: ["SOURCE_FILE_LIBRARY"],
        sourceFile: ["SOURCE_FILE"],
        sourceMember: ["SOURCE_FILE_MEMBER"],
        sourceChanged: ["SOURCE_FILE_CHANGE_TIMESTAMP"],
        targetRelease: ["TARGET_RELEASE"],
        releaseCreatedOn: ["RELEASE_CREATED_ON"],
        observable: ["OBSERVABLE"],
        sqlStatementCount: ["SQL_STATEMENT_COUNT"],
        created: ["CREATE_TIMESTAMP"],
      });
    }
  } catch (err) {
    description.notes.push(`PROGRAM_INFO could not be read: ${errorMessage(err)}`);
  }
  try {
    const rows = await connection.runSQL(`SELECT * FROM QSYS2.BOUND_MODULE_INFO ${where}`, { bindings });
    description.modules = rows.map((row) => pickColumns(row, {
      library: ["BOUND_MODULE_LIBRARY"],
      name: ["BOUND_MODULE"],
      attribute: ["MODULE_ATTRIBUTE"],
      sourceLibrary: ["SOURCE_FILE_LIBRARY"],
      sourceFile: ["SOURCE_FILE"],
      sourceMember: ["SOURCE_FILE_MEMBER"],
      sourceChanged: ["SOURCE_CHANGE_TIMESTAMP", "SOURCE_FILE_CHANGE_TIMESTAMP"],
      created: ["MODULE_CREATE_TIMESTAMP", "CREATE_TIMESTAMP"],
    }));
  } catch (err) {
    description.notes.push(`BOUND_MODULE_INFO could not be read: ${errorMessage(err)}`);
  }
  try {
    const rows = await connection.runSQL(`SELECT * FROM QSYS2.BOUND_SRVPGM_INFO ${where}`, { bindings });
    description.boundServicePrograms = rows.map((row) => pickColumns(row, {
      library: ["BOUND_SERVICE_PROGRAM_LIBRARY"],
      name: ["BOUND_SERVICE_PROGRAM"],
      signature: ["BOUND_SERVICE_PROGRAM_SIGNATURE"],
    }));
  } catch (err) {
    description.notes.push(`BOUND_SRVPGM_INFO could not be read: ${errorMessage(err)}`);
  }
  return description;
}

/** An object type such as *PGM, safe to put in SQL text. */
function objectType(type: string): string {
  const upper = type.trim().toUpperCase();
  if (!/^\*[A-Z]{1,9}$/.test(upper)) {
    throw new Error(`Not a valid object type: ${type}`);
  }
  return upper;
}

export interface JobLogMessage {
  position: number;
  id: string;
  type: string;
  severity: number;
  sent: string;
  fromProgram: string;
  text: string;
  help: string;
}

/** A qualified job name: number/user/name. */
const JOB_NAME = /^\d{6}\/[A-Z0-9_$#@]{1,10}\/[A-Z0-9_$#@]{1,10}$/;

/**
 * The most recent messages of a job's log, oldest first: the SQL job's (`*`), which is also the
 * one CL commands run in, or any job named number/user/name.
 */
export async function jobLogMessages(
  options: { job?: string; maxMessages: number; minSeverity: number }
): Promise<{ job: string; messages: JobLogMessage[] }> {
  const job = (options.job ?? "*").trim().toUpperCase();
  if (job !== "*" && !JOB_NAME.test(job)) {
    throw new Error(`Not a job name: ${options.job}. Use number/user/name, for example 123456/QUSER/QZDASOINIT, or * for this connection's job.`);
  }
  const limit = Math.max(1, Math.floor(options.maxMessages));
  const rows = await requireConnection().runSQL(
    "SELECT ORDINAL_POSITION, MESSAGE_ID, MESSAGE_TYPE, SEVERITY, VARCHAR(MESSAGE_TIMESTAMP) AS SENT, FROM_PROGRAM, " +
    `MESSAGE_TEXT, MESSAGE_SECOND_LEVEL_TEXT FROM TABLE(QSYS2.JOBLOG_INFO('${job}')) X ` +
    `WHERE SEVERITY >= ? ORDER BY ORDINAL_POSITION DESC FETCH FIRST ${limit} ROWS ONLY`,
    { bindings: [Math.max(0, Math.floor(options.minSeverity))] }
  );
  const messages = rows.map((row): JobLogMessage => ({
    position: Number(row.ORDINAL_POSITION ?? 0),
    id: columnValue(row, "MESSAGE_ID") ?? "",
    type: columnValue(row, "MESSAGE_TYPE") ?? "",
    severity: Number(row.SEVERITY ?? 0),
    sent: columnValue(row, "SENT") ?? "",
    fromProgram: columnValue(row, "FROM_PROGRAM") ?? "",
    text: columnValue(row, "MESSAGE_TEXT") ?? "",
    help: columnValue(row, "MESSAGE_SECOND_LEVEL_TEXT") ?? "",
  })).reverse();
  return { job, messages };
}

export interface FileSample {
  library: string;
  systemName: string;
  sqlName: string;
  member?: string;
  columns: string[];
  /** Each row's values as text, in `columns` order; null is null. */
  rows: Array<Array<string | null>>;
  notes: string[];
}

/** Characters of one value a sample returns at most. */
const SAMPLE_VALUE_LENGTH = 200;

/**
 * The first rows of a file, table or view, as text. The first match in `libraries` wins. A `member`
 * other than the first is read through an alias in QTEMP, which the outfile commands also use.
 */
export async function sampleFileRows(
  name: string,
  libraries: string[],
  options: { member?: string; maxRows: number }
): Promise<FileSample | undefined> {
  const connection = requireConnection();
  const table = await findTable(name, libraries);
  if (!table) {
    return undefined;
  }
  const library = objectName(table.library, "library");
  const file = objectName(table.systemName, "file");
  const member = options.member === undefined ? undefined : objectName(options.member, "member");
  const limit = Math.max(1, Math.floor(options.maxRows));
  const select = (from: string) => connection.runSQL(`SELECT * FROM ${from} FETCH FIRST ${limit} ROWS ONLY`);
  const rows = member === undefined
    ? await select(`"${library}"."${file}"`)
    : await exclusive(async () => {
      await connection.runSQL(`CREATE OR REPLACE ALIAS QTEMP.IMWSAMPLE FOR "${library}"."${file}"("${member}")`);
      try {
        return await select("QTEMP.IMWSAMPLE");
      } finally {
        await connection.runSQL("DROP ALIAS QTEMP.IMWSAMPLE").catch(() => undefined);
      }
    });
  const notes: string[] = [];
  let columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  if (columns.length === 0) {
    const described = await connection.runSQL(
      "SELECT COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      { bindings: [library, file] }
    );
    columns = described.map((row) => String(row.COLUMN_NAME ?? "").trim());
    notes.push("The file has no rows.");
  }
  let truncated = 0;
  const values = rows.map((row) => columns.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value);
    if (text.length > SAMPLE_VALUE_LENGTH) {
      truncated++;
      return `${text.slice(0, SAMPLE_VALUE_LENGTH)}…`;
    }
    return text;
  }));
  if (truncated > 0) {
    notes.push(`${truncated} value(s) longer than ${SAMPLE_VALUE_LENGTH} characters were cut short.`);
  }
  return { library, systemName: file, sqlName: table.sqlName, ...(member ? { member } : {}), columns, rows: values, notes };
}

export async function listSourceFileMembers(
  library: string,
  sourceFile: string
): Promise<IBMiMember[]> {
  return getContent().getMemberList({ library, sourceFile });
}

/** Runs a statement the SQL guard (`sqlGuard.ts`) already checked and wrapped. */
export function runReadOnlyQuery(sql: string): Promise<Array<Record<string, unknown>>> {
  return requireConnection().runSQL(sql);
}

export interface SpooledFileInfo {
  /** number/user/name */
  job: string;
  name: string;
  number: number;
  user: string;
  userData: string;
  status: string;
  created: string;
  pages: number;
  outputQueue: string;
}

/** Spooled files one call lists at most. */
export const MAX_SPOOLED_FILES = 50;

/**
 * Spooled files, newest first: of a job, or else of a user (the connected one when none is named),
 * optionally only those named `name` (a compile listing is named after its program).
 */
export async function listSpooledFiles(
  options: { name?: string; user?: string; job?: string; limit: number }
): Promise<SpooledFileInfo[]> {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (options.name) {
    conditions.push("SPOOLED_FILE_NAME = ?");
    bindings.push(objectName(options.name, "spooled file"));
  }
  if (options.job) {
    conditions.push("JOB_NAME = ?");
    bindings.push(jobName(options.job));
  } else if (options.user) {
    conditions.push("USER_NAME = ?");
    bindings.push(objectName(options.user, "user"));
  } else {
    conditions.push("USER_NAME = USER");
  }
  const limit = Math.min(MAX_SPOOLED_FILES, Math.max(1, Math.floor(options.limit)));
  const rows = await requireConnection().runSQL(
    "SELECT JOB_NAME, SPOOLED_FILE_NAME, FILE_NUMBER, USER_NAME, USER_DATA, STATUS, VARCHAR(CREATE_TIMESTAMP) AS CREATED, " +
    "TOTAL_PAGES, OUTPUT_QUEUE_LIBRARY_NAME, OUTPUT_QUEUE_NAME FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC " +
    `WHERE ${conditions.join(" AND ")} ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${limit} ROWS ONLY`,
    { bindings }
  );
  return rows.map((row) => ({
    job: columnValue(row, "JOB_NAME") ?? "",
    name: columnValue(row, "SPOOLED_FILE_NAME") ?? "",
    number: Number(row.FILE_NUMBER ?? 0),
    user: columnValue(row, "USER_NAME") ?? "",
    userData: columnValue(row, "USER_DATA") ?? "",
    status: columnValue(row, "STATUS") ?? "",
    created: columnValue(row, "CREATED") ?? "",
    pages: Number(row.TOTAL_PAGES ?? 0),
    outputQueue: `${columnValue(row, "OUTPUT_QUEUE_LIBRARY_NAME") ?? ""}/${columnValue(row, "OUTPUT_QUEUE_NAME") ?? ""}`,
  }));
}

/** The lines `startLine` to `endLine` (counted from 1) of a spooled file, trailing blanks removed. */
export async function readSpooledFile(
  file: { job: string; name: string; number: number },
  range: { startLine: number; endLine: number }
): Promise<{ lines: string[]; totalLines: number }> {
  const job = jobName(file.job);
  const name = objectName(file.name, "spooled file");
  const number = Math.floor(file.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Not a spooled file number: ${file.number}`);
  }
  // The names are validated above, so they can be written into the statement; the table function
  // copies the whole spooled file, so it is read once and cut here.
  const rows = await requireConnection().runSQL(
    "SELECT ORDINAL_POSITION, SPOOLED_DATA FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(" +
    `JOB_NAME => '${job}', SPOOLED_FILE_NAME => '${name}', SPOOLED_FILE_NUMBER => ${number})) X ORDER BY ORDINAL_POSITION`
  );
  const all = rows.map((row) => String(row.SPOOLED_DATA ?? "").replace(/\s+$/, ""));
  const start = Math.max(1, Math.floor(range.startLine));
  const end = Math.max(start, Math.floor(range.endLine));
  return { lines: all.slice(start - 1, end), totalLines: all.length };
}

/** A qualified job name as number/user/name, upper-cased. */
function jobName(job: string): string {
  const upper = job.trim().toUpperCase();
  if (!JOB_NAME.test(upper)) {
    throw new Error(`Not a job name: ${job}. Use number/user/name, for example 123456/QUSER/QZDASOINIT.`);
  }
  return upper;
}
