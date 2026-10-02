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
