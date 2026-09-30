/**
 * Finds what a member refers to, from its text alone: copybooks (/COPY,
 * /INCLUDE, COBOL COPY, EXEC SQL INCLUDE), called programs (CL CALL, TFRCTL,
 * RPG EXTPGM prototypes), referenced files (RPG F-specs, dcl-f, EXTNAME; COBOL
 * COPY DDS; DDS REF, REFFLD, PFILE, JFILE), SQL tables and views (embedded
 * SQL), and bound procedures (RPG
 * prototypes, SQL CALL, CL CALLPRC). Pure text in, references out; resolving
 * them to members on the IBM i is `dependencyResolve`, and other providers are
 * in `dependencySources`.
 */

/** A "procedure" is never a source member of its own: it is looked for by name, not resolved. */
export type ReferenceKind = "copybook" | "program" | "file" | "table" | "procedure";

export interface RawReference {
  kind: ReferenceKind;
  /** Named explicitly; otherwise the search libraries decide. */
  library?: string;
  /** Named explicitly (copybooks, or an exact member from a provider). */
  sourceFile?: string;
  member: string;
  /** 1-based line of the first occurrence, for references found in the source text. */
  line?: number;
  /** That line trimmed, or how a provider found the reference, for display. */
  text: string;
  /** Why this can never resolve to a source member, e.g. an IFS path. */
  unresolvable?: string;
  /** For a copybook named without a source file: the file its compiler looks in first. */
  defaultSourceFile?: string;
  /** Labels of the providers that found it, e.g. ["source scan", "DSPPGMREF"]. */
  foundBy?: string[];
}

const RPG_TYPES = new Set(["rpgle", "sqlrpgle", "rpgleinc", "rpg", "sqlrpg", "rpginc"]);
const CL_TYPES = new Set(["clle", "clp", "cl"]);
const DDS_TYPES = new Set(["pf", "lf", "dspf", "prtf"]);
const COBOL_TYPES = new Set(["cblle", "sqlcblle", "cbl", "sqlcbl"]);

/** Source types (lowercase extensions) the scan understands. */
export const SCANNED_SOURCE_TYPES: ReadonlySet<string> = new Set([...RPG_TYPES, ...CL_TYPES, ...DDS_TYPES, ...COBOL_TYPES]);

/** Whether a source type is COBOL, whose copybooks are COBOL whatever their own type. */
export function isCobolType(extension: string): boolean {
  return COBOL_TYPES.has(extension.toLowerCase());
}

/** IBM i object name characters. */
const NAME = "[A-Z0-9_$#@][A-Z0-9_$#@.]*";

/** SQL INCLUDE names that are built into the precompiler, not members. */
const SQL_BUILT_INS = new Set(["SQLCA", "SQLDA"]);

export function scanReferences(text: string, extension: string): RawReference[] {
  const type = extension.toLowerCase();
  const lines = text.split(/\r?\n/);
  const found = RPG_TYPES.has(type)
    ? [...scanRpg(lines), ...scanRpgPrototypes(lines), ...scanEmbeddedSql(sqlStatements(lines))]
    : CL_TYPES.has(type)
      ? scanCl(lines)
      : DDS_TYPES.has(type)
        ? scanDds(lines)
        : COBOL_TYPES.has(type)
          ? scanCobol(lines)
          : [];
  // Each scan reports in line order; interleave them so the first occurrence is kept.
  return dedupe(found.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)));
}

/** A procedure the member itself defines (RPG dcl-proc or P-spec). */
export interface DefinedProcedure {
  name: string;
  exported: boolean;
  /** 1-based line of the procedure's start. */
  line: number;
}

/** The procedures an RPG member defines; empty for other source types. */
export function scanDefinedProcedures(text: string, extension: string): DefinedProcedure[] {
  return RPG_TYPES.has(extension.toLowerCase()) ? definedProcedures(text.split(/\r?\n/)) : [];
}

/** Splits `LIB/NAME`, dropping the special values *LIBL and *CURLIB. */
function splitQualified(token: string): { library?: string; name: string } {
  const upper = token.toUpperCase();
  const slash = upper.indexOf("/");
  if (slash < 0) {
    return { name: upper };
  }
  const library = upper.slice(0, slash);
  return {
    library: library === "*LIBL" || library === "*CURLIB" ? undefined : library,
    name: upper.slice(slash + 1),
  };
}

function scanRpg(lines: string[]): RawReference[] {
  const refs: RawReference[] = [];
  const fullyFree = /^\*\*FREE\b/i.test(lines[0] ?? "");
  /** The F-spec that keyword continuation lines (blank file name) belong to. */
  let lastFixedFile: RawReference | undefined;
  lines.forEach((raw, index) => {
    // Fixed-form columns 1-5 are sequence numbers or comments; column 7 "*" is a comment line.
    if (!fullyFree && raw.charAt(6) === "*") {
      return;
    }
    const line = fullyFree ? raw : raw.slice(5);
    if (/^\s*\/\//.test(line)) {
      return;
    }
    const at = { line: index + 1, text: raw.trim() };

    const directive = /^\s*\/(COPY|INCLUDE)\s+(.+)$/i.exec(line);
    if (directive) {
      const ref = parseCopyOperand(directive[2]);
      if (ref) {
        refs.push({ ...ref, ...at });
      }
      return;
    }

    const include = /\bEXEC\s+SQL\s+INCLUDE\s+('[^']*'|"[^"]*"|[^\s;]+)/i.exec(line);
    if (include) {
      const operand = include[1];
      if (/^['"]/.test(operand)) {
        refs.push({ kind: "copybook", member: operand.slice(1, -1), unresolvable: "IFS path", ...at });
      } else if (!SQL_BUILT_INS.has(operand.toUpperCase())) {
        refs.push({ kind: "copybook", member: operand.toUpperCase(), ...at });
      }
    }

    // Fixed-form F-spec: the file name is in columns 7-16; a blank name continues the previous one.
    if (!fullyFree && /^F$/i.test(raw.charAt(5))) {
      const name = raw.slice(6, 16).trim();
      if (name) {
        // Column 22 "F" is a program-described file, which has no DDS source.
        lastFixedFile = raw.charAt(21).toUpperCase() === "F"
          ? undefined
          : { kind: "file", member: name.toUpperCase(), ...at };
        if (lastFixedFile) {
          refs.push(lastFixedFile);
        }
      }
      const extdesc = extDesc(raw);
      if (extdesc && lastFixedFile) {
        Object.assign(lastFixedFile, extdesc);
      }
    } else if (!fullyFree && raw.charAt(5).trim()) {
      lastFixedFile = undefined;
    }

    const dclF = /^\s*DCL-F\s+([A-Z0-9_$#@]+)/i.exec(line);
    if (dclF) {
      const statement = rpgStatement(lines, index, fullyFree);
      // A record length (DISK(100)) makes it program-described; LIKEFILE copies another declaration.
      if (!/\b(?:DISK|PRINTER|SEQ|SPECIAL)\s*\(\s*\d/i.test(statement) && !/\bLIKEFILE\s*\(/i.test(statement)) {
        const name = dclF[1].toUpperCase();
        refs.push({ kind: "file", member: name, ...extDesc(statement), ...at });
      }
    }

    // An externally described data structure takes its subfields from the file's record format.
    for (const extname of line.matchAll(/\bEXTNAME\(\s*'?([A-Z0-9_$#@/.*]+)'?/gi)) {
      const { library, name } = splitQualified(extname[1]);
      if (!name.startsWith("*")) {
        refs.push({ kind: "file", library, member: name, ...at });
      }
    }
  });
  return refs;
}

/** The code part of an RPG line, or undefined for a comment line. */
function rpgCode(raw: string, fullyFree: boolean): string | undefined {
  if (!fullyFree && raw.charAt(6) === "*") {
    return undefined;
  }
  const line = fullyFree ? raw : raw.slice(5);
  return /^\s*\/\//.test(line) ? undefined : line;
}

/**
 * The name in columns 7-21 of a fixed-form D- or P-spec. A long name fills columns 7-80 ending
 * in "...", and the specification itself continues on the next line with a blank name.
 */
function fixedName(raw: string, pending: string | undefined): { name: string; continues: boolean } {
  const long = raw.slice(6, 80).trim();
  if (/^\S+\.\.\.$/.test(long)) {
    return { name: `${pending ?? ""}${long.slice(0, -3)}`, continues: true };
  }
  const name = raw.slice(6, 21).trim();
  return { name: name || pending || "", continues: false };
}

function definedProcedures(lines: string[]): DefinedProcedure[] {
  const found: DefinedProcedure[] = [];
  const fullyFree = /^\*\*FREE\b/i.test(lines[0] ?? "");
  let pending: string | undefined;
  lines.forEach((raw, index) => {
    const line = rpgCode(raw, fullyFree);
    if (line === undefined) {
      return;
    }
    const free = /^\s*DCL-PROC\s+([A-Z0-9_$#@]+)/i.exec(line);
    if (free) {
      const statement = rpgStatement(lines, index, fullyFree);
      found.push({ name: free[1].toUpperCase(), exported: /\bEXPORT\b/i.test(statement), line: index + 1 });
      return;
    }
    // Fixed-form P-spec: "B" in column 24 begins a procedure; keywords start in column 44.
    if (fullyFree || !/^P$/i.test(raw.charAt(5))) {
      pending = undefined;
      return;
    }
    const { name, continues } = fixedName(raw, pending);
    pending = continues ? name : undefined;
    if (!continues && name && raw.charAt(23).toUpperCase() === "B") {
      found.push({ name: name.toUpperCase(), exported: /\bEXPORT\b/i.test(raw.slice(43)), line: index + 1 });
    }
  });
  return found;
}

/**
 * Prototypes: EXTPGM names a called program, anything else a bound procedure (EXTPROC, or the
 * prototype's own name). Prototypes of procedures the member defines itself are left out.
 */
function scanRpgPrototypes(lines: string[]): RawReference[] {
  const refs: RawReference[] = [];
  const fullyFree = /^\*\*FREE\b/i.test(lines[0] ?? "");
  const local = new Set(definedProcedures(lines).map((proc) => proc.name));
  const add = (name: string, keywords: string, at: { line: number; text: string }) => {
    const ref = prototypeTarget(name, keywords);
    if (ref && !(ref.kind === "procedure" && local.has(ref.member.toUpperCase()))) {
      refs.push({ ...ref, ...at });
    }
  };
  let pending: string | undefined;
  lines.forEach((raw, index) => {
    const line = rpgCode(raw, fullyFree);
    if (line === undefined) {
      return;
    }
    const at = { line: index + 1, text: raw.trim() };
    const free = /^\s*DCL-PR\s+([A-Z0-9_$#@]+)/i.exec(line);
    if (free) {
      add(free[1], rpgStatement(lines, index, fullyFree), at);
      return;
    }
    // Fixed-form D-spec: "PR" in columns 24-25; keywords from column 44 continue on lines with a blank name and type.
    if (fullyFree || !/^D$/i.test(raw.charAt(5))) {
      pending = undefined;
      return;
    }
    const { name, continues } = fixedName(raw, pending);
    pending = continues ? name : undefined;
    if (continues || !name || raw.slice(23, 25).toUpperCase() !== "PR") {
      return;
    }
    let keywords = raw.slice(43);
    for (let next = index + 1; next < lines.length && next < index + 20; next++) {
      const continuation = lines[next];
      if (continuation.charAt(6) === "*") {
        continue;
      }
      if (!/^D$/i.test(continuation.charAt(5)) || continuation.slice(6, 25).trim()) {
        break;
      }
      keywords += ` ${continuation.slice(43)}`;
    }
    add(name, keywords, at);
  });
  return refs;
}

/** What a prototype calls, from its EXTPGM or EXTPROC keyword. A name held in a variable is skipped. */
function prototypeTarget(name: string, keywords: string): Pick<RawReference, "kind" | "library" | "member"> | undefined {
  const extpgm = /\bEXTPGM\b\s*(?:\(\s*([^)]*?)\s*\))?/i.exec(keywords);
  if (extpgm) {
    const value = extpgm[1];
    if (!value) {
      return { kind: "program", member: name.toUpperCase() };
    }
    const quoted = /^'([^']+)'$/.exec(value);
    if (!quoted) {
      return undefined;
    }
    const { library, name: program } = splitQualified(quoted[1].trim());
    return { kind: "program", library, member: program };
  }
  const extproc = /\bEXTPROC\s*\(\s*(?:\*[A-Z]+\s*:\s*)?([^)]*?)\s*\)/i.exec(keywords);
  if (!extproc) {
    return { kind: "procedure", member: name.toUpperCase() };
  }
  const value = extproc[1];
  if (/^\*DCLCASE$/i.test(value)) {
    return { kind: "procedure", member: name };
  }
  // Procedure names are case-sensitive, so a quoted name is kept as written.
  const quoted = /^'([^']+)'$/.exec(value);
  return quoted ? { kind: "procedure", member: quoted[1].trim() } : undefined;
}

/** Embedded SQL statements: free-form EXEC SQL … ; and fixed-form C/EXEC SQL … C/END-EXEC. */
function sqlStatements(lines: string[]): Array<{ line: number; text: string; sql: string }> {
  const statements: Array<{ line: number; text: string; sql: string }> = [];
  const fullyFree = /^\*\*FREE\b/i.test(lines[0] ?? "");
  const clean = (part: string) => part.replace(/'[^']*'/g, "''").replace(/--.*$/, "");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const at = { line: i + 1, text: raw.trim() };
    if (!fullyFree && /^C$/i.test(raw.charAt(5)) && /^\/EXEC\s+SQL\b/i.test(raw.slice(6))) {
      const parts = [clean(raw.slice(6).replace(/^\/EXEC\s+SQL/i, ""))];
      for (let next = i + 1; next < lines.length && next < i + 200; next++) {
        const part = lines[next];
        if (/^C$/i.test(part.charAt(5)) && /^\/END-EXEC/i.test(part.slice(6))) {
          i = next;
          break;
        }
        if (/^C\+$/i.test(part.slice(5, 7))) {
          parts.push(clean(part.slice(7)));
        } else if (part.charAt(6) !== "*") {
          i = next - 1;
          break;
        }
      }
      statements.push({ ...at, sql: parts.join(" ") });
      continue;
    }
    const line = rpgCode(raw, fullyFree);
    const start = line === undefined ? -1 : line.search(/\bEXEC\s+SQL\b/i);
    if (line === undefined || start < 0) {
      continue;
    }
    const parts: string[] = [];
    let part = clean(line.slice(start).replace(/^EXEC\s+SQL/i, ""));
    for (let next = i; ; ) {
      const end = part.indexOf(";");
      parts.push(end < 0 ? part : part.slice(0, end));
      if (end >= 0 || next + 1 >= lines.length || next + 1 >= i + 200) {
        i = next;
        break;
      }
      const code = rpgCode(lines[++next], fullyFree);
      part = code === undefined ? "" : clean(code.replace(/\/\/.*$/, ""));
    }
    statements.push({ ...at, sql: parts.join(" ") });
  }
  return statements;
}

/** Words that can follow FROM, INTO, UPDATE or TABLE without being a table name. */
const SQL_NOT_A_NAME = new Set([
  "TABLE", "LATERAL", "FINAL", "NEW", "OLD", "UNNEST", "XMLTABLE", "JSON_TABLE", "OF", "SET", "WHERE",
  "SELECT", "VALUES", "WITH", "AS", "ON", "DESCRIPTOR", "SQL",
]);

/** Words that end a FROM list item, so they are never taken for a correlation name. */
const SQL_CLAUSE = new Set([
  "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "EXCEPTION", "GROUP", "ORDER", "HAVING",
  "FETCH", "FOR", "UNION", "EXCEPT", "INTERSECT", "WITH", "LIMIT", "OFFSET", "ON", "USING", "SET", "OPTIMIZE",
]);

/** Tokens of one SQL statement that are looked at; the rest of a longer one is ignored. */
const MAX_SQL_TOKENS = 5000;

type SqlStatement = { line: number; text: string; sql: string };

/** Tables and views embedded SQL reads or changes, and the procedures it CALLs. INCLUDE is left to each language. */
function scanEmbeddedSql(statements: SqlStatement[]): RawReference[] {
  const refs: RawReference[] = [];
  for (const { line, text, sql } of statements) {
    const upper = sql.replace(/"([^"]*)"/g, (_match, name: string) => name).toUpperCase();
    // A statement is at most 200 lines; the token cap bounds even one made of nothing but punctuation.
    const tokens: string[] = (upper.match(/[:A-Z0-9_$#@][A-Z0-9_$#@./]*|[(),]/g) ?? []).slice(0, MAX_SQL_TOKENS);
    if (tokens[0] === "INCLUDE") {
      continue;
    }
    // The next ")" at or after each position, found in one pass rather than a search per token.
    const nextClose = new Array<number>(tokens.length + 1).fill(-1);
    for (let i = tokens.length - 1; i >= 0; i--) {
      nextClose[i] = tokens[i] === ")" ? i : nextClose[i + 1];
    }
    // Common table expression names (WITH x AS (…), y (a, b) AS (…)) are local to the statement.
    const local = new Set<string>();
    tokens.forEach((token, i) => {
      if ((token === "WITH" || token === ",") && isSqlName(tokens[i + 1])) {
        const as = tokens[i + 2] === "(" ? (nextClose[i + 2] ?? -1) + 1 : i + 2;
        if (as > 0 && tokens[as] === "AS" && tokens[as + 1] === "(") {
          local.add(tokens[i + 1]);
        }
      }
    });
    const record = (token: string | undefined, kind: "table" | "procedure") => {
      if (!isSqlName(token) || SQL_NOT_A_NAME.has(token) || local.has(token)) {
        return;
      }
      const { library, name } = splitSqlName(token);
      if (library === "SESSION" || library === "QTEMP" || !name) {
        return;
      }
      refs.push({ kind, library, member: name, line, text });
    };
    tokens.forEach((token, i) => {
      if (token === "CALL") {
        record(tokens[i + 1], "procedure");
        return;
      }
      // A name followed by "(" is a table function, not a table.
      if (!["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(token) || tokens[i + 2] === "(") {
        return;
      }
      record(tokens[i + 1], "table");
      if (token !== "FROM") {
        return;
      }
      // FROM a [AS] x, b [AS] y, …
      for (let j = i + 2; j < tokens.length && j < i + 200; ) {
        if (tokens[j] === "AS") {
          j += 2;
        } else if (isSqlName(tokens[j]) && !SQL_CLAUSE.has(tokens[j])) {
          j += 1;
        }
        if (tokens[j] !== "," || tokens[j + 2] === "(") {
          break;
        }
        record(tokens[j + 1], "table");
        j += 2;
      }
    });
  }
  return refs;
}

function isSqlName(token: string | undefined): token is string {
  return token !== undefined && /^[A-Z_$#@][A-Z0-9_$#@./]*$/.test(token);
}

/** `SCHEMA.NAME` or `LIB/NAME`. */
function splitSqlName(token: string): { library?: string; name: string } {
  const separator = token.search(/[./]/);
  return separator < 0
    ? { name: token }
    : { library: token.slice(0, separator), name: token.slice(separator + 1) };
}

/** EXTDESC('LIB/FILE'): the file used at compile time instead of the declared name. */
function extDesc(text: string): { library?: string; member: string } | undefined {
  const match = /\bEXTDESC\(\s*'([^']+)'\s*\)/i.exec(text);
  if (!match) {
    return undefined;
  }
  const { library, name } = splitQualified(match[1]);
  return { library, member: name };
}

/** A free-form statement from `start` up to its ";" (keywords can continue on later lines). */
function rpgStatement(lines: string[], start: number, fullyFree: boolean): string {
  const parts: string[] = [];
  for (let i = start; i < lines.length && i < start + 20; i++) {
    const part = (fullyFree ? lines[i] : lines[i].slice(5)).replace(/\/\/.*$/, "");
    parts.push(part);
    if (part.includes(";")) {
      break;
    }
  }
  return parts.join(" ");
}

/** `[[LIB/]FILE,]MEMBER`, or an IFS path (quoted, or unquoted starting with "/" or "."). */
function parseCopyOperand(operand: string): Omit<RawReference, "line" | "text"> | undefined {
  const trimmed = operand.trim();
  const quoted = /^(['"])(.*?)\1/.exec(trimmed);
  if (quoted) {
    return { kind: "copybook", member: quoted[2], unresolvable: "IFS path" };
  }
  const token = trimmed.split(/\s+/)[0];
  if (!token) {
    return undefined;
  }
  if (/^[./]/.test(token) || (token.match(/\//g) ?? []).length > 1) {
    return { kind: "copybook", member: token, unresolvable: "IFS path" };
  }
  const comma = token.indexOf(",");
  if (comma < 0) {
    return { kind: "copybook", member: token.toUpperCase() };
  }
  const { library, name: sourceFile } = splitQualified(token.slice(0, comma));
  return { kind: "copybook", library, sourceFile, member: token.slice(comma + 1).toUpperCase() };
}

function scanCl(lines: string[]): RawReference[] {
  // Blank out comments (which can span lines) but keep line breaks for line numbers.
  const text = lines.join("\n").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const clean = text.split("\n");
  const refs: RawReference[] = [];
  for (let i = 0; i < clean.length; i++) {
    // Join continuation lines into one command: "+" skips the next line's leading blanks, "-" keeps them.
    // Only the last line is tested and trimmed: re-scanning the joined command each time would
    // make a long run of continuation lines quadratic.
    const start = i;
    const parts = [clean[i]];
    while (/[+-]\s*$/.test(parts[parts.length - 1]) && i + 1 < clean.length) {
      const last = parts.pop()!;
      const next = clean[++i];
      parts.push(
        ...(/\+\s*$/.test(last)
          ? [last.replace(/\+\s*$/, ""), next.trimStart()]
          : [last.replace(/-\s*$/, ""), next])
      );
    }
    let command = parts.join("");
    const at = { line: start + 1, text: lines[start].trim() };
    // CALLPRC names a bound procedure, usually quoted since the name is case-sensitive.
    for (const match of command.matchAll(/\bCALLPRC\s+(?:PRC\(\s*)?('[^']+'|&?[A-Z0-9_$#@]+)/gi)) {
      const name = match[1];
      if (name.startsWith("'")) {
        refs.push({ kind: "procedure", member: name.slice(1, -1), ...at });
      } else if (!name.startsWith("&")) {
        refs.push({ kind: "procedure", member: name.toUpperCase(), ...at });
      }
    }
    // Text in quotes (messages, commands built at run time) is never a call target here.
    command = command.replace(/'[^']*'/g, (quoted) => " ".repeat(quoted.length));
    // The positional form must not be a keyword such as PGM( whose value failed to parse.
    const pattern = new RegExp(
      `\\b(?:CALL|TFRCTL)\\s+(?:PGM\\(\\s*([^)\\s]+)\\s*\\)|(?![A-Z0-9_$#@./&*]*\\()([&*]?${NAME}(?:/${NAME})?))`,
      "gi"
    );
    for (const match of command.matchAll(pattern)) {
      const target = match[1] ?? match[2];
      // A program name held in a variable is only known at run time.
      if (target.startsWith("&")) {
        continue;
      }
      const { library, name } = splitQualified(target);
      if (name && !name.startsWith("&")) {
        refs.push({ kind: "program", library, member: name, ...at });
      }
    }
  }
  return refs;
}

function scanDds(lines: string[]): RawReference[] {
  const refs: RawReference[] = [];
  lines.forEach((raw, index) => {
    if (raw.charAt(6) === "*") {
      return;
    }
    const at = { line: index + 1, text: raw.trim() };
    const file = (token: string) => {
      if (token.startsWith("*")) {
        return;
      }
      const { library, name } = splitQualified(token);
      refs.push({ kind: "file", library, member: name, ...at });
    };
    // The name and the rest can't both match the same characters, which would backtrack
    // polynomially on a long line with no ")".
    for (const match of raw.matchAll(/\bREF\(\s*([^()\s]+)(?:\s[^()]*)?\)/gi)) {
      file(match[1]);
    }
    // REFFLD(field [LIB/]FILE): without a file it uses the REF file, already listed.
    for (const match of raw.matchAll(/\bREFFLD\(\s*[^)\s]+\s+([^)\s]+)\s*\)/gi)) {
      file(match[1]);
    }
    for (const match of raw.matchAll(/\b(?:PFILE|JFILE)\(([^()]*)\)/gi)) {
      match[1].split(/\s+/).filter(Boolean).forEach(file);
    }
  });
  return refs;
}

/** Copybooks named without a source file are looked for here first, as the ILE COBOL compiler does. */
const DEFAULT_COBOL_COPY_FILE = "QCBLLESRC";

/** A COBOL word or an IBM i name, possibly qualified with "/" (as in a COPY operand). */
const COBOL_OPERAND = String.raw`"[^"]*"|'[^']*'|[A-Z0-9_$#@][A-Z0-9_$#@\-/.]*`;
const COBOL_COPY = new RegExp(
  String.raw`^COPY\s+(${COBOL_OPERAND})((?:\s+(?:OF|IN)\s+(?:${COBOL_OPERAND}))*)`,
  "i"
);
const COBOL_QUALIFIER = new RegExp(String.raw`\b(?:OF|IN)\s+(${COBOL_OPERAND})`, "gi");

/** Replaces the inside of each literal with blanks, keeping every offset. */
function blankCobolLiterals(code: string): string {
  return code.replace(/"[^"]*"?|'[^']*'?/g, (literal) => literal.charAt(0) + " ".repeat(Math.max(0, literal.length - 1)));
}

/**
 * The code area (columns 8-72) of each line; undefined for a comment line ("*" or "/" in
 * column 7). A floating "*>" comment is dropped. Sequence numbers (1-6) and the identification
 * area (73-80) are never read.
 */
function cobolCode(lines: string[]): Array<string | undefined> {
  return lines.map((raw) => {
    const indicator = raw.charAt(6);
    if (indicator === "*" || indicator === "/") {
      return undefined;
    }
    const code = raw.slice(7, 72);
    const comment = blankCobolLiterals(code).indexOf("*>");
    return comment < 0 ? code : code.slice(0, comment);
  });
}

function unquote(operand: string): { name: string; quoted: boolean } {
  const quoted = /^(["'])(.*)\1$/.exec(operand);
  return quoted ? { name: quoted[2].trim(), quoted: true } : { name: operand, quoted: false };
}

function scanCobol(lines: string[]): RawReference[] {
  const code = cobolCode(lines);
  const refs: RawReference[] = [];
  /** Code from line `start` on, joined up to `limit` lines, with literals blanked in `blank`. */
  const joined = (start: number, column: number, limit: number) => {
    const parts: string[] = [];
    for (let i = start; i < code.length && i < start + limit; i++) {
      const part = code[i];
      if (part !== undefined) {
        parts.push(i === start ? part.slice(column) : part);
      }
    }
    const text = parts.join(" ");
    return { text, blank: blankCobolLiterals(text) };
  };

  for (let index = 0; index < code.length; index++) {
    const line = code[index];
    if (line === undefined) {
      continue;
    }
    const at = { line: index + 1, text: lines[index].trim() };
    const blank = blankCobolLiterals(line);

    // COPY (a data name such as WS-COPY-COUNT is not one, nor is COPY inside a literal).
    for (const match of blank.matchAll(/(?<![A-Z0-9_$#@-])COPY(?![A-Z0-9_$#@-])/gi)) {
      const statement = joined(index, match.index, 10);
      const end = statement.blank.search(/\.(\s|$)/);
      const copy = COBOL_COPY.exec(end < 0 ? statement.text : statement.text.slice(0, end));
      const ref = copy && cobolCopyTarget(copy[1], [...copy[2].matchAll(COBOL_QUALIFIER)].map((q) => q[1]));
      if (ref) {
        refs.push({ ...ref, ...at });
      }
    }

    // EXEC SQL … END-EXEC: INCLUDE is a copybook, the rest is scanned like RPG's embedded SQL.
    const exec = /\bEXEC\s+SQL\b/i.exec(blank);
    if (exec) {
      const statement = joined(index, exec.index, 200);
      const end = statement.blank.search(/\bEND-EXEC\b/i);
      const sql = (end < 0 ? statement.text : statement.text.slice(0, end))
        .replace(/^EXEC\s+SQL/i, "")
        .replace(/'[^']*'/g, "''")
        .replace(/--.*$/gm, "");
      const include = /^\s*INCLUDE\s+("[^"]*"|'[^']*'|[^\s.]+)/i.exec(sql);
      if (include) {
        const { name, quoted } = unquote(include[1]);
        if (quoted && name.includes("/")) {
          refs.push({ kind: "copybook", member: name, unresolvable: "IFS path", ...at });
        } else if (!SQL_BUILT_INS.has(name.toUpperCase())) {
          refs.push({ kind: "copybook", member: name.toUpperCase(), defaultSourceFile: DEFAULT_COBOL_COPY_FILE, ...at });
        }
      } else {
        refs.push(...scanEmbeddedSql([{ ...at, sql }]));
      }
    }
  }
  return refs;
}

/**
 * What a COPY statement names. `COPY DDS-format OF [LIB/|LIB-]FILE` (also DDSR-, DD-, DDR-) takes
 * a record format from a file, so the file is referenced. Otherwise `COPY member [OF|IN file
 * [OF|IN library]]`, where the file may also be written `LIB/FILE`, names a copybook; a quoted
 * name with a "/" is an IFS path.
 */
function cobolCopyTarget(operand: string, qualifiers: string[]): Omit<RawReference, "line" | "text"> | undefined {
  const { name, quoted } = unquote(operand);
  if (!name) {
    return undefined;
  }
  const [first, second] = qualifiers.map((q) => unquote(q).name.toUpperCase());
  if (!quoted && /^DDS?R?-/i.test(name)) {
    if (!first) {
      return undefined;
    }
    // IBM i names never hold "-", so "LIB-FILE" is a library and a file.
    const { library, name: file } = splitQualified(first.replace("-", "/"));
    return { kind: "file", library: second ?? library, member: file };
  }
  if (quoted && name.includes("/")) {
    return { kind: "copybook", member: name, unresolvable: "IFS path" };
  }
  const member = name.toUpperCase();
  if (!first) {
    return { kind: "copybook", member, defaultSourceFile: DEFAULT_COBOL_COPY_FILE };
  }
  const { library, name: sourceFile } = splitQualified(first);
  return { kind: "copybook", library: second ?? library, sourceFile, member };
}

/** Keeps the first occurrence of each reference. */
function dedupe(refs: RawReference[]): RawReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = [ref.kind, ref.library ?? "", ref.sourceFile ?? "", ref.member].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
