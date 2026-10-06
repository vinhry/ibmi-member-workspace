/**
 * Find Member: a member or program name typed by the user, turned into a search, and the members
 * found put in order. Kept free of the `vscode` module so it can be unit tested.
 */

export interface FoundMember {
  library: string;
  sourceFile: string;
  member: string;
  sourceType: string;
  text?: string;
  lastChanged?: string;
  /** Why it was offered when its name doesn't match, e.g. "source of program PRODOBJ/ORD100". */
  via?: string;
}

/** Why `input` can't be searched for, or undefined when it can: an IBM i name, with `*` for any characters. */
export function memberPatternProblem(input: string): string | undefined {
  const value = input.trim();
  if (!/^[A-Z0-9_$#@.*]{1,10}$/i.test(value) || !/[^*]/.test(value)) {
    return "Enter a member or program name, up to 10 characters, with * for any characters (for example ORD* or *ENT).";
  }
  return undefined;
}

/** The search pattern for `input`: trimmed and uppercase. */
export function memberPattern(input: string): string {
  return input.trim().toUpperCase();
}

export function isWildcard(pattern: string): boolean {
  return pattern.includes("*");
}

/**
 * The escape character of the `LIKE … ESCAPE` clauses in `codeForIBMi.ts`; `likeMemberPattern` and
 * `likeText` escape with it. Not a name character, and plain in SQL, JSON and a shell, whichever way
 * Code for IBM i sends the statement.
 */
export const LIKE_ESCAPE = "+";

/**
 * A member pattern as a `LIKE` value: `*` and `%` match any characters, and `_` (valid in IBM i
 * names) is kept literal rather than matching any one character, so ORD_HDR doesn't find ORD$HDR.
 */
export function likeMemberPattern(pattern: string): string {
  return pattern.replace(/[+_]/g, (char) => `${LIKE_ESCAPE}${char}`).replace(/\*/g, "%");
}

/** Text to look for anywhere in a value, as a `LIKE` value: every character literal. */
export function likeText(text: string): string {
  return `%${text.replace(/[+%_]/g, (char) => `${LIKE_ESCAPE}${char}`)}%`;
}

/**
 * The members found, each once, in the order to offer them: the exact name first, then by the
 * search libraries' order (others after them), then by name.
 */
export function orderFound(
  found: readonly FoundMember[],
  { pattern, libraries }: { pattern: string; libraries: readonly string[] }
): FoundMember[] {
  const unique = new Map<string, FoundMember>();
  for (const member of found) {
    const key = `${member.library}/${member.sourceFile}(${member.member})`.toUpperCase();
    if (!unique.has(key)) {
      unique.set(key, member);
    }
  }
  const exact = (member: FoundMember) => (member.member.toUpperCase() === pattern.toUpperCase() ? 0 : 1);
  const rank = (member: FoundMember) => {
    const index = libraries.findIndex((library) => library.toUpperCase() === member.library.toUpperCase());
    return index === -1 ? libraries.length : index;
  };
  return [...unique.values()].sort((a, b) =>
    exact(a) - exact(b) ||
    rank(a) - rank(b) ||
    a.member.localeCompare(b.member) ||
    a.library.localeCompare(b.library) ||
    a.sourceFile.localeCompare(b.sourceFile)
  );
}

/** One Find Member search, as kept in its history. `scope` is the scope chosen for it, if not the setting's. */
export interface MemberSearch {
  input: string;
  byText: boolean;
  scope?: "libraryList" | "specific" | "everywhere";
}

/** Searches kept in Find Member's history. */
export const MAX_HISTORY = 20;

export function sameSearch(a: MemberSearch, b: MemberSearch): boolean {
  return memberPattern(a.input) === memberPattern(b.input) && a.byText === b.byText && a.scope === b.scope;
}

/** The history with `search` first: a search made again moves to the top instead of being listed twice. */
export function addToHistory(history: readonly MemberSearch[], search: MemberSearch, max = MAX_HISTORY): MemberSearch[] {
  const entry: MemberSearch = { input: memberPattern(search.input), byText: search.byText, ...(search.scope ? { scope: search.scope } : {}) };
  return [entry, ...history.filter((past) => !sameSearch(past, entry))].slice(0, max);
}

/** What a search looks for, for labels: the pattern, or the text searched for. */
export function describeSearch(search: MemberSearch): string {
  return search.byText ? `text "${memberPattern(search.input)}"` : memberPattern(search.input);
}

/** A found member as a checkout takes it; the source type is the local file extension. */
export function foundMemberInfo(found: FoundMember): { library: string; sourceFile: string; memberName: string; extension: string } {
  return {
    library: found.library,
    sourceFile: found.sourceFile,
    memberName: found.member,
    extension: found.sourceType.toLowerCase() || "mbr",
  };
}
