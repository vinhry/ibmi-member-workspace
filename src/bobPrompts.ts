import * as path from "node:path";

/**
 * Ready-made prompts for an agent's chat, offered from the "Bob, Investigate" right-click menu in
 * IBM Bob and "Investigate with AI" in VS Code. They ask the agent to use the research tools
 * (`bobMcpTools.ts`) and never to change a file. Kept free of the `vscode` module so it can be unit tested.
 */

export type BobPromptKind = "relationships" | "explain" | "deepDive";

export interface PromptMember {
  library: string;
  sourceFile: string;
  member: string;
  /** The local copy, when the member is checked out. */
  localPath?: string;
  /** True for a read-only reference copy. */
  readOnly?: boolean;
  /** The member's source type (e.g. RPGLE, PF), so Bob can tell programs from files. */
  sourceType?: string;
}

/** Members one prompt names at most; more make a prompt too long to review. */
export const MAX_PROMPT_MEMBERS = 25;

const READ_ONLY_RULE =
  "These may be production sources: don't edit, rename or overwrite any file. Reference copies are read-only.";

/** Folder, relative to the workspace, that deep-dive documents are written to. */
export const DEEP_DIVE_FOLDER = "docs";

/** The deep-dive document's name for one member, `DEEP_DIVE_<MEMBER>.md`, valid on every file system. */
export function deepDiveFileName(member: string): string {
  return `DEEP_DIVE_${member.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}.md`;
}

/**
 * The path of a file inside one of `workspaceRoots`, relative to it and with "/"; undefined for a
 * file outside them (the tools read it instead).
 */
export function workspaceRelativePath(localPath: string, workspaceRoots: readonly string[], pathApi = path): string | undefined {
  for (const root of workspaceRoots) {
    const relative = pathApi.relative(root, localPath);
    if (relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative)) {
      return relative.split(pathApi.sep).join("/");
    }
  }
  return undefined;
}

/**
 * `@/path` for a file inside one of `workspaceRoots`, which makes Bob include the file's text;
 * undefined for a file outside them (the tools read it instead). Mentions always use "/".
 */
export function mentionFor(localPath: string, workspaceRoots: readonly string[], pathApi = path): string | undefined {
  const relative = workspaceRelativePath(localPath, workspaceRoots, pathApi);
  return relative === undefined ? undefined : `@/${relative}`;
}

export function buildBobPrompt(
  kind: BobPromptKind,
  members: readonly PromptMember[],
  workspaceRoots: readonly string[],
  pathApi = path
): { text: string; skipped: string[] } {
  return buildInvestigatePrompt(kind, members, workspaceRoots, { pathApi });
}

/**
 * The prompt for `kind`. `mention` names a checked-out file inside the workspace, given its
 * workspace-relative path, the way the agent reads it (Bob's `@/path` when not given).
 */
export function buildInvestigatePrompt(
  kind: BobPromptKind,
  members: readonly PromptMember[],
  workspaceRoots: readonly string[],
  { mention = (relative: string) => `@/${relative}`, pathApi = path }: { mention?: (relative: string) => string; pathApi?: typeof path } = {}
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
    const relative = m.localPath ? workspaceRelativePath(m.localPath, workspaceRoots, pathApi) : undefined;
    const named = relative === undefined ? undefined : mention(relative);
    const type = m.sourceType ? ` [${m.sourceType.toUpperCase()}]` : "";
    return `- ${name}${type}${named ? ` ${named}` : ""}${m.readOnly ? " (read-only reference copy)" : ""}`;
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
    : kind === "explain"
      ? [
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
      ].join("\n")
      : deepDivePrompt(these, one, lines, listed);
  return { text, skipped };
}

function deepDivePrompt(these: string, one: boolean, lines: string[], listed: readonly PromptMember[]): string {
  const file = one
    ? `${DEEP_DIVE_FOLDER}/${deepDiveFileName(listed[0].member)}`
    : `${DEEP_DIVE_FOLDER}/DEEP_DIVE_<PURPOSE>.md, where <PURPOSE> is 2 to 4 words in UPPER_SNAKE_CASE for what these ` +
      "members do together (for example DEEP_DIVE_ORDER_ENTRY.md; only A-Z, 0-9 and _, at most 40 characters)";
  return [
    `Give a new developer a deep-dive walkthrough of ${these}, written by developers who have since left:`,
    ...lines,
    "",
    "Use the ibmi-member-workspace tools: read_member_source for the source, find_member_dependencies for what it uses " +
      "(read its copybooks when you need them), find_where_used for its callers or the programs that use a file, " +
      "describe_file for file and table layouts, and list_service_program_exports for service programs.",
    "",
    `For ${one ? "a program" : "each program"}, cover:`,
    "1. Its purpose, and where it fits: a tree of its callers and what it calls.",
    "2. Its inputs and outputs: parameters, files and SQL tables (with key fields, and whether each is read, updated or written), screens, reports and data areas.",
    "3. A walkthrough of the main logic in order, with line numbers, including subroutines and procedures.",
    "4. The business rules it applies, in plain language, with line references.",
    "5. How it handles errors, and its edge cases.",
    "6. The non-obvious parts: indicators, the RPG cycle, magic or hard-coded values, dead code and legacy patterns.",
    "7. Change risks: which callers and files to retest after a change.",
    "",
    `For ${one ? "a file" : "each file"} (PF, LF, DSPF, PRTF, SQL table or view), cover:`,
    "1. What it holds or shows.",
    "2. Its fields and keys, and the logical files, views and indexes built over it.",
    "3. Which programs read, update or write it, and what each one does with it.",
    "4. What the fields mean and which values they take, as the programs use them.",
    "5. Change risks: level checks and the programs to recompile after a change.",
    "",
    "End with a glossary of the business terms and abbreviations used, and a suggested order for reading the source.",
    "",
    `Write the result as a Markdown document to ${file}, in the workspace folder. Create the ${DEEP_DIVE_FOLDER} folder if it ` +
      "doesn't exist. If the file already exists, add _2, _3 and so on to the name instead of overwriting it. " +
      "When done, tell me the file's path.",
    "",
    `These may be production sources: creating that one Markdown file in ${DEEP_DIVE_FOLDER}/ is the only change allowed. ` +
      "Don't edit, rename or overwrite any other file. Reference copies are read-only.",
  ].join("\n");
}
