import * as vscode from "vscode";
import type { CodeForIBMi, IBMiMember } from "@halcyontech/vscode-ibmi-types";
import type { SourceMemberRow } from "./dependencyResolve";
import {
  CompiledObject,
  ReferencedObject,
  SourceLocation,
  objectKey,
} from "./dependencySources";
import { CheckedOutMember, buildLocalFileName } from "./types";

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
 * Source members named `members` in any source file of `libraries`.
 * SYSPARTITIONSTAT has a null SOURCE_TYPE for members of data files.
 */
export async function findSourceMembers(
  members: string[],
  libraries: string[]
): Promise<SourceMemberRow[]> {
  const connection = getConnection();
  if (!connection) {
    throw new Error("Not connected to IBM i");
  }
  if (members.length === 0 || libraries.length === 0) {
    return [];
  }
  const rows: SourceMemberRow[] = [];
  for (let i = 0; i < members.length; i += MEMBERS_PER_LOOKUP) {
    const chunk = members.slice(i, i + MEMBERS_PER_LOOKUP);
    const result = await connection.runSQL(
      `SELECT RTRIM(SYSTEM_TABLE_SCHEMA) AS LIBRARY, RTRIM(SYSTEM_TABLE_NAME) AS SOURCE_FILE, ` +
      `RTRIM(SYSTEM_TABLE_MEMBER) AS MEMBER, COALESCE(RTRIM(CAST(SOURCE_TYPE AS VARCHAR(10))), '') AS SOURCE_TYPE ` +
      `FROM QSYS2.SYSPARTITIONSTAT WHERE SOURCE_TYPE IS NOT NULL ` +
      `AND SYSTEM_TABLE_SCHEMA IN (${libraries.map(() => "?").join(", ")}) ` +
      `AND SYSTEM_TABLE_MEMBER IN (${chunk.map(() => "?").join(", ")})`,
      { bindings: [...libraries, ...chunk] }
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

function requireConnection(): IBMi {
  const connection = getConnection();
  if (!connection) {
    throw new Error("Not connected to IBM i");
  }
  return connection;
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

/** Runs DSPPGMREF into a QTEMP outfile of the SQL job and returns its rows. */
export async function programReferences(object: CompiledObject): Promise<Array<Record<string, unknown>>> {
  if (!OBJECT_NAME.test(object.library) || !OBJECT_NAME.test(object.name)) {
    throw new Error(`Not a valid object name: ${object.library}/${object.name}`);
  }
  const connection = requireConnection();
  await connection.runSQL(
    `@QSYS/DSPPGMREF PGM(${object.library}/${object.name}) OUTPUT(*OUTFILE) OBJTYPE(${object.type}) ` +
    "OUTFILE(QTEMP/IMWPGMREF) OUTMBR(*FIRST *REPLACE)"
  );
  return connection.runSQL("SELECT WHFNAM, WHLNAM, WHOTYP FROM QTEMP.IMWPGMREF");
}

/** The source member each object was created from, when the object records one. */
export async function objectSources(objects: ReferencedObject[]): Promise<Map<string, SourceLocation>> {
  const connection = requireConnection();
  const sources = new Map<string, SourceLocation>();
  for (const object of objects) {
    if (!object.library) {
      continue;
    }
    try {
      const [row] = await connection.runSQL(
        "SELECT SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER FROM TABLE(QSYS2.OBJECT_STATISTICS(?, ?, OBJECT_NAME => ?)) X",
        { bindings: [object.library, object.type, object.name] }
      );
      if (row?.SOURCE_LIBRARY && row.SOURCE_FILE && row.SOURCE_MEMBER) {
        sources.set(objectKey(object), {
          library: String(row.SOURCE_LIBRARY).trim(),
          sourceFile: String(row.SOURCE_FILE).trim(),
          member: String(row.SOURCE_MEMBER).trim(),
        });
      }
    } catch {
      // No source information: the reference is matched by name instead.
    }
  }
  return sources;
}

/** Runs a user-defined cross-reference SELECT. */
export async function runCrossReferenceQuery(sql: string, bindings: string[]): Promise<Array<Record<string, unknown>>> {
  return requireConnection().runSQL(sql, { bindings });
}

export async function listSourceFileMembers(
  library: string,
  sourceFile: string
): Promise<IBMiMember[]> {
  return getContent().getMemberList({ library, sourceFile });
}
