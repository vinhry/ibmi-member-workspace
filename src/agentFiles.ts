import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Files this extension writes into workspace folders for AI agents (IBM Bob, Claude Code, Codex,
 * GitHub Copilot): MCP server entries, rules files, and the Git exclude that keeps a token out of
 * commits. Nothing is read or written through a link. Kept free of the `vscode` module so it can be
 * unit tested.
 */

/** The name of this extension's MCP server in every agent's configuration. */
export const MCP_SERVER_NAME = "ibmi-member-workspace";

/** Claude Code's project MCP configuration, relative to a workspace folder. */
export const CLAUDE_MCP_FILE = ".mcp.json";
/** Codex's project configuration, relative to a workspace folder. */
export const CODEX_CONFIG_FILE = ".codex/config.toml";

/** The path of a workspace-relative file (written with "/") under `root`. */
export function fileBelow(root: string, file: string): string {
  return path.join(root, ...file.split("/"));
}

/**
 * A JSON MCP configuration (`mcpServers`, as Bob's `.bob/mcp.json` and Claude Code's `.mcp.json`
 * hold it) with this extension's entry set, or removed with `entry` undefined, keeping every other
 * server and setting in the file. Of an existing entry, only the keys in `userOptions` (the user's
 * own choices, such as "disabled") are kept: a "command" or "type" in an entry that came with a
 * cloned project must not survive Connect.
 */
export function mergeJsonMcpServers(
  existing: string | undefined,
  entry: Readonly<Record<string, unknown>> | undefined,
  { file, userOptions }: { file: string; userOptions: ReadonlySet<string> }
): string {
  let config: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} does not hold a JSON object.`);
    }
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`"mcpServers" in ${file} is not an object.`);
  }
  const merged: Record<string, unknown> = { ...(servers as Record<string, unknown> | undefined) };
  if (entry) {
    const previous = merged[MCP_SERVER_NAME];
    const kept = previous && typeof previous === "object" && !Array.isArray(previous)
      ? Object.fromEntries(Object.entries(previous).filter(([key]) => userOptions.has(key)))
      : {};
    merged[MCP_SERVER_NAME] = { ...kept, ...entry };
  } else {
    delete merged[MCP_SERVER_NAME];
  }
  return `${JSON.stringify({ ...config, mcpServers: merged }, null, 2)}\n`;
}

/** This extension's entry in a JSON MCP configuration's text, if any. */
export function jsonMcpEntry(text: string | undefined): Record<string, unknown> | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    const entry = parsed?.mcpServers?.[MCP_SERVER_NAME];
    return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A line of every rules file this extension writes; while it is there, the file is kept up to date. */
export const GENERATED_RULES_MARKER = "<!-- Written by IBM i Member Workspace; delete this line to keep your own edits. -->";

/**
 * Whether the rules file holding `existing` should be replaced by `current`: it was written by this
 * extension (it starts with the marker, right after YAML frontmatter if it has some, or is exactly a
 * text an earlier version wrote) and is out of date. A missing file or one the user edited is left alone.
 */
export function shouldRewriteRules(existing: string | undefined, current: string, previous: readonly string[]): boolean {
  if (existing === undefined) {
    return false;
  }
  const text = existing.replace(/\r\n/g, "\n");
  if (text === current) {
    return false;
  }
  return startsWithMarker(text) || previous.includes(text);
}

function startsWithMarker(text: string): boolean {
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 3);
    if (end === -1) {
      return false;
    }
    body = text.slice(end + "\n---\n".length);
  }
  return body.startsWith(`${GENERATED_RULES_MARKER}\n`);
}

/** Throws when `target` or a folder between `root` and it is a link, so a write can't land elsewhere. */
function assertNoLinks(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${target} is outside ${root}.`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`${current} is a link; not writing through it.`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

/** Reads a file below `root` without following links; undefined when it doesn't exist. */
export function readFileBelow(root: string, target: string): string | undefined {
  assertNoLinks(root, target);
  try {
    return fs.readFileSync(target, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Writes a file below `root` through a new temporary file and a rename, which replaces a link
 * rather than following it; folders on the way are checked not to be links.
 */
export function writeFileBelow(root: string, target: string, content: string, mode = 0o600): void {
  assertNoLinks(root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertNoLinks(root, target);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: "utf-8", flag: "wx", mode });
  try {
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * - "excluded": the file is listed in the repository's `.git/info/exclude`.
 * - "noRepository": the folder isn't in a Git repository.
 * - "notExcluded": the folder is in a repository whose exclude file isn't ours to edit
 *   (a worktree or submodule, whose `.git` is a file, or a link).
 */
export type ExcludeResult = "excluded" | "noRepository" | "notExcluded";

/** `text` as a literal gitignore pattern: wildcards and trailing blanks escaped. */
function literalPattern(text: string): string {
  return text.replace(/[\\*?[]/g, "\\$&").replace(/ +$/, (blanks) => blanks.replace(/ /g, "\\ "));
}

/**
 * Adds `file` (relative to `folder`, e.g. ".bob/mcp.json") to `.git/info/exclude` of the repository
 * holding `folder`, which may be `folder` itself or a folder above it, so a file holding a token isn't
 * committed. `.gitignore` is left alone: it is shared with everyone else.
 */
export function excludeFromGit(folder: string, file: string): ExcludeResult {
  let root = path.resolve(folder);
  let stat: fs.Stats | undefined;
  for (;;) {
    try {
      stat = fs.lstatSync(path.join(root, ".git"));
      break;
    } catch {
      const parent = path.dirname(root);
      if (parent === root) {
        return "noRepository";
      }
      root = parent;
    }
  }
  if (!stat.isDirectory()) {
    // A worktree or submodule (.git file) or a link: not ours to edit.
    return "notExcluded";
  }
  const relative = path.relative(root, path.join(path.resolve(folder), file)).split(path.sep).join("/");
  const pattern = `/${literalPattern(relative)}`;
  const exclude = path.join(root, ".git", "info", "exclude");
  const current = readFileBelow(root, exclude) ?? "";
  if (current.split(/\r?\n/).some((line) => line === pattern || line.trim() === pattern)) {
    return "excluded";
  }
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  writeFileBelow(root, exclude, `${current}${separator}${pattern}\n`, 0o644);
  return "excluded";
}
