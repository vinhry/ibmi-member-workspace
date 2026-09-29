import * as path from "node:path";

/**
 * Ready-made prompts for Bob's chat, offered from the "Bob, Investigate" right-click menu.
 * They ask Bob to use the research tools (`bobMcpTools.ts`) and never to change a file.
 * Kept free of the `vscode` module so it can be unit tested.
 */

export type BobPromptKind = "relationships" | "explain";

export interface PromptMember {
  library: string;
  sourceFile: string;
  member: string;
  /** The local copy, when the member is checked out. */
  localPath?: string;
  /** True for a read-only reference copy. */
  readOnly?: boolean;
}

/** Members one prompt names at most; more make a prompt too long to review. */
export const MAX_PROMPT_MEMBERS = 25;

const READ_ONLY_RULE =
  "These may be production sources: don't edit, rename or overwrite any file. Reference copies are read-only.";

/**
 * `@/path` for a file inside one of `workspaceRoots`, which makes Bob include the file's text;
 * undefined for a file outside them (the tools read it instead). Mentions always use "/".
 */
export function mentionFor(localPath: string, workspaceRoots: readonly string[], pathApi = path): string | undefined {
  for (const root of workspaceRoots) {
    const relative = pathApi.relative(root, localPath);
    if (relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative)) {
      return `@/${relative.split(pathApi.sep).join("/")}`;
    }
  }
  return undefined;
}

export function buildBobPrompt(
  kind: BobPromptKind,
  members: readonly PromptMember[],
  workspaceRoots: readonly string[],
  pathApi = path
): { text: string; skipped: string[] } {
  const seen = new Set<string>();
  const unique: PromptMember[] = [];
  for (const m of members) {
    const key = `${m.library}/${m.sourceFile}(${m.member})`.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(m);
    }
  }
  const listed = unique.slice(0, MAX_PROMPT_MEMBERS);
  const skipped = unique.slice(MAX_PROMPT_MEMBERS).map((m) => `${m.library}/${m.sourceFile}(${m.member})`.toUpperCase());
  const lines = listed.map((m) => {
    const name = `${m.library}/${m.sourceFile}(${m.member})`.toUpperCase();
    const mention = m.localPath ? mentionFor(m.localPath, workspaceRoots, pathApi) : undefined;
    return `- ${name}${mention ? ` ${mention}` : ""}${m.readOnly ? " (read-only reference copy)" : ""}`;
  });
  const one = listed.length === 1;
  const these = one ? "this IBM i member" : `these ${listed.length} IBM i members`;

  const text = kind === "relationships"
    ? [
      `Using the ibmi-member-workspace tools, analyze the relationships of ${these}:`,
      ...lines,
      "",
      `For ${one ? "it" : "each one"}:`,
      "1. Use find_member_dependencies to list what it uses: copybooks, called programs, files, SQL tables and views, and bound procedures, with the source member of each.",
      "2. Use find_where_used to find which programs and service programs call it, or use it if it is a file.",
      `3. Summarize with a table of what it uses, a tree of its callers${one ? "" : ", and how the selected members relate to each other"}.`,
      "",
      READ_ONLY_RULE,
    ].join("\n")
    : [
      `Explain what ${these} ${one ? "does" : "do"}:`,
      ...lines,
      "",
      "Read the source with read_member_source, and its copybooks through find_member_dependencies when you need them. " +
        `For ${one ? "the member" : "each member"}, explain:`,
      "1. Its purpose, in plain language.",
      "2. Its inputs and outputs: parameters, files, SQL tables, screens and reports.",
      "3. The main processing steps.",
      "4. The business rules it applies.",
      "5. How it handles errors.",
      "",
      READ_ONLY_RULE,
    ].join("\n");
  return { text, skipped };
}
