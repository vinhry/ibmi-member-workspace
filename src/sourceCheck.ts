/**
 * Finds text in a local copy that its source member can't hold: lines longer than the source
 * file's records, and characters the member's CCSID has no code for. The IBM i cuts off the first
 * and replaces the second when the member is uploaded. Kept free of the `vscode` module so it can
 * be unit tested.
 */

/** A source file's SRCDTA column: how many characters of source a record holds, and its CCSID. */
export interface SourceLayout {
  /** The record length less the sequence number and date (for example 80 for RCDLEN(92)). */
  dataLength: number;
  /** Undefined when the IBM i didn't report one; characters are then not checked. */
  ccsid?: number;
}

/**
 * Lines and columns are 0-based and count UTF-16 code units of the text as given, as editor
 * positions do. Lengths count characters, as the IBM i stores one per byte in a single-byte CCSID.
 */
export type SourceProblem =
  | {
    kind: "long-line";
    line: number;
    /** Characters on the line, without trailing blanks. */
    length: number;
    /** Where the characters that don't fit start, and where the line's text ends. */
    column: number;
    end: number;
  }
  | {
    kind: "character";
    line: number;
    column: number;
    end: number;
    char: string;
    /** Plain text to use instead, when there is an obvious one. */
    replacement?: string;
  };

/**
 * A layout from the LENGTH and CCSID that QSYS2.SYSCOLUMNS gives for SRCDTA, or undefined when the
 * length isn't a usable number. A CCSID of 0 or none is left out.
 */
export function layoutFromColumn(length: unknown, ccsid: unknown): SourceLayout | undefined {
  const dataLength = Number(length);
  if (!Number.isInteger(dataLength) || dataLength <= 0) {
    return undefined;
  }
  const code = Number(ccsid);
  return Number.isInteger(code) && code > 0 ? { dataLength, ccsid: code } : { dataLength };
}

/** Single-byte EBCDIC CCSIDs whose characters are exactly those of Latin-1 (U+0000 to U+00FF). */
const LATIN1_CCSIDS: ReadonlySet<number> = new Set([37, 273, 277, 278, 280, 284, 285, 297, 500, 871, 1047]);

/** The euro versions of {@link LATIN1_CCSIDS} (1140 is 37 with €, and so on): € takes the place of ¤. */
const EURO_CCSIDS: ReadonlySet<number> = new Set([1140, 1141, 1142, 1143, 1144, 1145, 1146, 1147, 1148, 1149]);

/**
 * Whether `ccsid` can store the character `codePoint`. Only the Latin-1 EBCDIC CCSIDs are known;
 * any other CCSID (Unicode, DBCS, 65535) is assumed to store everything.
 */
export function storableIn(codePoint: number, ccsid: number | undefined): boolean {
  if (ccsid === undefined) {
    return true;
  }
  if (LATIN1_CCSIDS.has(ccsid)) {
    return codePoint <= 0xff;
  }
  if (EURO_CCSIDS.has(ccsid)) {
    return codePoint === 0x20ac || (codePoint <= 0xff && codePoint !== 0xa4);
  }
  return true;
}

/** Whether characters are checked for `ccsid` at all. */
export function checksCharacters(ccsid: number | undefined): boolean {
  return ccsid !== undefined && (LATIN1_CCSIDS.has(ccsid) || EURO_CCSIDS.has(ccsid));
}

/** Typographic characters, often added by word processors and AI tools, and their plain-text spelling. */
const ASCII_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["\u2018", "'"], ["\u2019", "'"], ["\u201A", "'"], ["\u201B", "'"], ["\u2032", "'"],
  ["\u201C", "\""], ["\u201D", "\""], ["\u201E", "\""], ["\u201F", "\""], ["\u2033", "\""],
  ["\u2010", "-"], ["\u2011", "-"], ["\u2012", "-"], ["\u2013", "-"], ["\u2014", "-"], ["\u2015", "-"], ["\u2212", "-"],
  ["\u2026", "..."],
  ["\u2022", "*"],
  ["\u2190", "<-"], ["\u2192", "->"], ["\u21D2", "=>"],
  ["\u2264", "<="], ["\u2265", ">="], ["\u2260", "<>"],
  ["\u2002", " "], ["\u2003", " "], ["\u2004", " "], ["\u2005", " "], ["\u2006", " "], ["\u2007", " "],
  ["\u2008", " "], ["\u2009", " "], ["\u200A", " "], ["\u202F", " "], ["\u205F", " "], ["\u3000", " "],
  ["\u200B", ""], ["\u200C", ""], ["\u200D", ""], ["\u2060", ""], ["\uFEFF", ""],
]);

/** The plain-text spelling of a typographic character, or undefined when there isn't an obvious one. */
export function asciiReplacement(char: string): string | undefined {
  return ASCII_REPLACEMENTS.get(char);
}

/**
 * Every problem in `content`, line by line. The text is read as upload sends it (see
 * `normalizeForMemberUpload`): a leading BOM, CRLF line ends, trailing blanks and trailing blank
 * lines don't count. Positions refer to `content` itself.
 */
export function sourceProblems(content: string, layout: SourceLayout): SourceProblem[] {
  const problems: SourceProblem[] = [];
  const checkCharacters = checksCharacters(layout.ccsid);
  const lines = content.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const start = line === 0 && lines[0].startsWith("\uFEFF") ? 1 : 0;
    const text = lines[line].replace(/[ \t]+$/, "");
    let length = 0;
    let cutColumn: number | undefined;
    for (let column = start; column < text.length;) {
      const codePoint = text.codePointAt(column)!;
      const char = String.fromCodePoint(codePoint);
      if (length === layout.dataLength) {
        cutColumn = column;
      }
      length++;
      if (checkCharacters && !storableIn(codePoint, layout.ccsid)) {
        const replacement = asciiReplacement(char);
        problems.push({
          kind: "character",
          line,
          column,
          end: column + char.length,
          char,
          ...(replacement !== undefined ? { replacement } : {}),
        });
      }
      column += char.length;
    }
    if (cutColumn !== undefined) {
      problems.push({ kind: "long-line", line, length, column: cutColumn, end: text.length });
    }
  }
  return problems.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** `U+201C` for "“". */
export function codePointLabel(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** One problem in words, for the editor and the output panel. */
export function describeProblem(problem: SourceProblem, layout: SourceLayout): string {
  if (problem.kind === "long-line") {
    return `This line is ${problem.length} characters, but the source file holds ${layout.dataLength}. ` +
      "The rest is cut off when the member is uploaded.";
  }
  const instead = problem.replacement === undefined
    ? ""
    : problem.replacement === ""
      ? " Remove it."
      : ` Use ${JSON.stringify(problem.replacement)} instead.`;
  return `"${problem.char}" (${codePointLabel(problem.char)}) can't be stored in CCSID ${layout.ccsid} ` +
    `and is replaced when the member is uploaded.${instead}`;
}

/** The problems summed up in one sentence, for example before an upload. */
export function summarizeProblems(problems: readonly SourceProblem[], layout: SourceLayout): string {
  const longLines = problems.filter((problem) => problem.kind === "long-line").length;
  const characters = problems.filter((problem) => problem.kind === "character").length;
  const parts = [
    longLines > 0 &&
      `${longLines} ${longLines === 1 ? "line is" : "lines are"} longer than the ${layout.dataLength} characters the source file holds`,
    characters > 0 &&
      `${characters} ${characters === 1 ? "character" : "characters"} can't be stored in CCSID ${layout.ccsid}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(", and ");
}
