import * as fs from "node:fs";
import * as path from "node:path";

/**
 * IBM Bob IDE support. Bob's agent reaches outside tools only through MCP servers listed in
 * `.bob/mcp.json`, so the research tools are offered only when the extension runs in Bob:
 * VS Code has no Bob agent to use them. Kept free of the `vscode` module so it can be unit tested.
 */

/** Whether the host product is IBM Bob, from `vscode.env.appName` and `vscode.env.uriScheme`. */
export function isBobProduct(appName: string, uriScheme: string): boolean {
  return /\bbob\b/i.test(appName) || /^(?:ibm-?)?bob(?:-|$)/i.test(uriScheme);
}

/**
 * The command that best focuses Bob's chat: one that focuses its input box, then `bob.focus`, then
 * any other Bob view's focus command. Bob documents none of them, so they are found by name.
 */
export function pickBobFocusCommand(commands: readonly string[]): string | undefined {
  return commands.find((command) => /^bob\b.*\.focusInput$/i.test(command)) ??
    commands.find((command) => command.toLowerCase() === "bob.focus") ??
    commands.find((command) => /^bob\b.*\.focus$/i.test(command));
}

/** Bob commands that may focus its chat, listed in the log so the right one can be told apart. */
export function bobFocusCandidates(commands: readonly string[]): string[] {
  return commands.filter((command) => /^bob\b.*(focus|chat|input)/i.test(command));
}

/** The name of this extension's entry under `mcpServers`. */
export const MCP_SERVER_NAME = "ibmi-member-workspace";

export interface McpServerEntry {
  url: string;
  headers: Record<string, string>;
  alwaysAllow: string[];
}

export function mcpServerEntry(port: number, token: string, tools: readonly string[]): McpServerEntry {
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    alwaysAllow: [...tools],
  };
}

/**
 * The tools a refreshed entry lets Bob run without asking. Tools the user took out of `alwaysAllow`
 * stay out; only tools new since `offeredBefore` (the tools the previous start offered) are added.
 * Without `offeredBefore`, none are added. Tools that no longer exist are dropped.
 */
export function refreshedAlwaysAllow(
  existing: unknown,
  tools: readonly string[],
  offeredBefore: readonly string[] | undefined
): string[] {
  const kept = Array.isArray(existing) ? existing.filter((tool): tool is string => typeof tool === "string") : [];
  return tools.filter((tool) => kept.includes(tool) || (offeredBefore !== undefined && !offeredBefore.includes(tool)));
}

/** Options of this extension's `.bob/mcp.json` entry that belong to the user and are kept. */
const USER_OPTIONS: ReadonlySet<string> = new Set(["disabled", "timeout", "disabledTools"]);

/**
 * `.bob/mcp.json` text with this extension's entry set (or removed, with `entry` undefined),
 * keeping every other server and setting in the file.
 */
export function mergeMcpConfig(existing: string | undefined, entry: McpServerEntry | undefined): string {
  let config: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(".bob/mcp.json does not hold a JSON object.");
    }
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error('"mcpServers" in .bob/mcp.json is not an object.');
  }
  const merged: Record<string, unknown> = { ...(servers as Record<string, unknown> | undefined) };
  if (entry) {
    // Keep the user's own choices for the entry (e.g. "disabled"); everything else is ours. A
    // "command" or "type" in an entry that came with a cloned project must not survive Connect.
    const previous = merged[MCP_SERVER_NAME];
    const kept = previous && typeof previous === "object" && !Array.isArray(previous)
      ? Object.fromEntries(Object.entries(previous).filter(([key]) => USER_OPTIONS.has(key)))
      : {};
    merged[MCP_SERVER_NAME] = { ...kept, ...entry };
  } else {
    delete merged[MCP_SERVER_NAME];
  }
  return `${JSON.stringify({ ...config, mcpServers: merged }, null, 2)}\n`;
}

/** This extension's entry in `.bob/mcp.json` text, if any. */
export function configuredEntry(text: string | undefined): { url?: unknown; headers?: unknown; alwaysAllow?: unknown } | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    const entry = parsed?.mcpServers?.[MCP_SERVER_NAME];
    return entry && typeof entry === "object" ? (entry as { url?: unknown; headers?: unknown; alwaysAllow?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

/** First line of the Bob rules file this extension writes; while it is there, the file is kept up to date. */
export const GENERATED_RULES_MARKER = "<!-- Written by IBM i Member Workspace; delete this line to keep your own edits. -->";

/**
 * Whether the rules file holding `existing` should be replaced by `current`: it was written by this
 * extension (it starts with the marker, or is exactly a text an earlier version wrote) and is out of
 * date. A missing file or one the user edited is left alone.
 */
export function shouldRewriteRules(existing: string | undefined, current: string, previous: readonly string[]): boolean {
  if (existing === undefined) {
    return false;
  }
  const text = existing.replace(/\r\n/g, "\n");
  if (text === current) {
    return false;
  }
  return text.startsWith(`${GENERATED_RULES_MARKER}\n`) || previous.includes(text);
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
