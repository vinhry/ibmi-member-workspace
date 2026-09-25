/**
 * Finds the source members a member refers to, from its text alone: copybooks
 * (/COPY, /INCLUDE, EXEC SQL INCLUDE), called programs (CL CALL, TFRCTL) and
 * referenced files (DDS REF, REFFLD, PFILE, JFILE). Pure text in, references
 * out; resolving them to members on the IBM i is `dependencyResolve`.
 */

export type ReferenceKind = "copybook" | "program" | "file";

export interface RawReference {
  kind: ReferenceKind;
  /** Named explicitly in the source; otherwise the library list decides. */
  library?: string;
  /** Named explicitly in the source (copybooks only). */
  sourceFile?: string;
  member: string;
  /** 1-based line of the first occurrence. */
  line: number;
  /** That line, trimmed, for display. */
  text: string;
  /** Why this can never resolve to a source member, e.g. an IFS path. */
  unresolvable?: string;
}

const RPG_TYPES = new Set(["rpgle", "sqlrpgle", "rpgleinc", "rpg", "sqlrpg", "rpginc"]);
const CL_TYPES = new Set(["clle", "clp", "cl"]);
const DDS_TYPES = new Set(["pf", "lf", "dspf", "prtf"]);

/** IBM i object name characters. */
const NAME = "[A-Z0-9_$#@][A-Z0-9_$#@.]*";

/** SQL INCLUDE names that are built into the precompiler, not members. */
const SQL_BUILT_INS = new Set(["SQLCA", "SQLDA"]);

export function scanReferences(text: string, extension: string): RawReference[] {
  const type = extension.toLowerCase();
  const lines = text.split(/\r?\n/);
  const found = RPG_TYPES.has(type)
    ? scanRpg(lines)
    : CL_TYPES.has(type)
      ? scanCl(lines)
      : DDS_TYPES.has(type)
        ? scanDds(lines)
        : [];
  return dedupe(found);
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
  });
  return refs;
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
    const start = i;
    let command = clean[i];
    while (/[+-]\s*$/.test(command) && i + 1 < clean.length) {
      const next = clean[++i];
      command = /\+\s*$/.test(command)
        ? command.replace(/\+\s*$/, "") + next.trimStart()
        : command.replace(/-\s*$/, "") + next;
    }
    // Text in quotes (messages, commands built at run time) is never a call target here.
    command = command.replace(/'[^']*'/g, (quoted) => " ".repeat(quoted.length));
    const at = { line: start + 1, text: lines[start].trim() };
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
    for (const match of raw.matchAll(/\bREF\(\s*([^)\s]+)[^)]*\)/gi)) {
      file(match[1]);
    }
    // REFFLD(field [LIB/]FILE): without a file it uses the REF file, already listed.
    for (const match of raw.matchAll(/\bREFFLD\(\s*[^)\s]+\s+([^)\s]+)\s*\)/gi)) {
      file(match[1]);
    }
    for (const match of raw.matchAll(/\b(?:PFILE|JFILE)\(([^)]*)\)/gi)) {
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
