/**
 * Finds what a member refers to, from its text alone: copybooks (/COPY,
 * /INCLUDE, EXEC SQL INCLUDE), called programs (CL CALL, TFRCTL, RPG EXTPGM
 * prototypes), referenced files (RPG F-specs, dcl-f, EXTNAME; DDS REF, REFFLD,
 * PFILE, JFILE), SQL tables and views (embedded SQL), and bound procedures (RPG
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
  /** Labels of the providers that found it, e.g. ["source scan", "DSPPGMREF"]. */
  foundBy?: string[];
}

const RPG_TYPES = new Set(["rpgle", "sqlrpgle", "rpgleinc", "rpg", "sqlrpg", "rpginc"]);
const CL_TYPES = new Set(["clle", "clp", "cl"]);
const DDS_TYPES = new Set(["pf", "lf", "dspf", "prtf"]);

/** Source types (lowercase extensions) the scan understands. */
export const SCANNED_SOURCE_TYPES: ReadonlySet<string> = new Set([...RPG_TYPES, ...CL_TYPES, ...DDS_TYPES]);

/** IBM i object name characters. */
const NAME = "[A-Z0-9_$#@][A-Z0-9_$#@.]*";

/** SQL INCLUDE names that are built into the precompiler, not members. */
const SQL_BUILT_INS = new Set(["SQLCA", "SQLDA"]);

export function scanReferences(text: string, extension: string): RawReference[] {
  const type = extension.toLowerCase();
  const lines = text.split(/\r?\n/);
  const found = RPG_TYPES.has(type)
    ? [...scanRpg(lines), ...scanRpgPrototypes(lines), ...scanEmbeddedSql(lines, type)]
    : CL_TYPES.has(type)
      ? scanCl(lines)
      : DDS_TYPES.has(type)
        ? scanDds(lines)
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

/** Tables and views embedded SQL reads or changes, and the procedures it CALLs. */
function scanEmbeddedSql(lines: string[], type: string): RawReference[] {
  if (!RPG_TYPES.has(type)) {
    return [];
  }
  const refs: RawReference[] = [];
  for (const { line, text, sql } of sqlStatements(lines)) {
    const upper = sql.replace(/"([^"]*)"/g, (_match, name: string) => name).toUpperCase();
    const tokens: string[] = upper.match(/[:A-Z0-9_$#@][A-Z0-9_$#@./]*|[(),]/g) ?? [];
    if (tokens[0] === "INCLUDE") {
      continue;
    }
    // Common table expression names (WITH x AS (…), y (a, b) AS (…)) are local to the statement.
    const local = new Set<string>();
    tokens.forEach((token, i) => {
      if ((token === "WITH" || token === ",") && isSqlName(tokens[i + 1])) {
        const as = tokens[i + 2] === "(" ? tokens.indexOf(")", i + 2) + 1 : i + 2;
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
