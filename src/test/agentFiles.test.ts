import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_RULES_MARKER,
  MCP_SERVER_NAME,
  excludeFromGit,
  jsonMcpEntry,
  mergeJsonMcpServers,
  readFileBelow,
  shouldRewriteRules,
  writeFileBelow,
} from "../agentFiles";

function tempFolder(t: { after: (fn: () => void) => void }): string {
  const folder = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-agent-files-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** Creates a link, or skips the test where links need Developer Mode (Windows). */
function linkOrSkip(t: { skip: (message: string) => void }, target: string, link: string, type: "file" | "dir"): boolean {
  try {
    symlinkSync(target, link, type === "dir" ? "junction" : "file");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating links needs Developer Mode on Windows");
      return false;
    }
    throw err;
  }
}

describe("shouldRewriteRules", () => {
  const current = `${GENERATED_RULES_MARKER}\n# Rules\n- new\n`;
  const previous = ["# Rules\n- old\n"];

  it("leaves a missing or current file alone", () => {
    assert.equal(shouldRewriteRules(undefined, current, previous), false);
    assert.equal(shouldRewriteRules(current, current, previous), false);
    assert.equal(shouldRewriteRules(current.replace(/\n/g, "\r\n"), current, previous), false);
  });

  it("updates a file it wrote: with the marker, or exactly an earlier text", () => {
    assert.equal(shouldRewriteRules(`${GENERATED_RULES_MARKER}\n# Rules\n- old\n`, current, previous), true);
    assert.equal(shouldRewriteRules("# Rules\r\n- old\r\n", current, previous), true);
  });

  it("leaves a file the user edited alone", () => {
    assert.equal(shouldRewriteRules("# Rules\n- old\n- mine\n", current, previous), false);
    assert.equal(shouldRewriteRules(`# Mine\n${GENERATED_RULES_MARKER}\n`, current, previous), false);
  });
});

describe("writeFileBelow", () => {
  it("creates folders and replaces the file", (t) => {
    const root = tempFolder(t);
    const target = join(root, ".bob", "mcp.json");
    writeFileBelow(root, target, "one");
    writeFileBelow(root, target, "two");
    assert.equal(readFileSync(target, "utf-8"), "two");
    assert.equal(readFileBelow(root, target), "two");
    if (process.platform !== "win32") {
      assert.equal(statSync(target).mode & 0o777, 0o600);
    }
  });

  it("never writes through a linked folder", (t) => {
    const root = tempFolder(t);
    const outside = tempFolder(t);
    if (!linkOrSkip(t, outside, join(root, ".bob"), "dir")) {
      return;
    }
    assert.throws(() => writeFileBelow(root, join(root, ".bob", "mcp.json"), "x"), /link/);
    assert.equal(existsSync(join(outside, "mcp.json")), false);
  });

  it("never reads or writes through a linked file", (t) => {
    const root = tempFolder(t);
    const outside = join(tempFolder(t), "target.json");
    writeFileSync(outside, "{}");
    mkdirSync(join(root, ".bob"));
    if (!linkOrSkip(t, outside, join(root, ".bob", "mcp.json"), "file")) {
      return;
    }
    assert.throws(() => readFileBelow(root, join(root, ".bob", "mcp.json")), /link/);
    assert.throws(() => writeFileBelow(root, join(root, ".bob", "mcp.json"), "x"), /link/);
    assert.equal(readFileSync(outside, "utf-8"), "{}");
  });

  it("refuses a path outside the root", (t) => {
    const root = tempFolder(t);
    assert.throws(() => writeFileBelow(root, join(root, "..", "elsewhere.json"), "x"), /outside/);
  });
});

describe("excludeFromGit", () => {
  it("adds the file to .git/info/exclude once, leaving .gitignore alone", (t) => {
    const root = tempFolder(t);
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "# existing");
    assert.equal(excludeFromGit(root, ".bob/mcp.json"), "excluded");
    assert.equal(excludeFromGit(root, ".bob/mcp.json"), "excluded");
    assert.equal(readFileSync(join(root, ".git", "info", "exclude"), "utf-8"), "# existing\n/.bob/mcp.json\n");
    assert.equal(existsSync(join(root, ".gitignore")), false);
  });

  it("excludes the file of a folder below the top of the repository", (t) => {
    const root = tempFolder(t);
    mkdirSync(join(root, ".git"));
    const folder = join(root, "apps", "ord[1]");
    mkdirSync(folder, { recursive: true });
    assert.equal(excludeFromGit(folder, ".bob/mcp.json"), "excluded");
    assert.equal(readFileSync(join(root, ".git", "info", "exclude"), "utf-8"), "/apps/ord\\[1]/.bob/mcp.json\n");
  });

  it("reports a folder outside any repository", (t) => {
    const root = tempFolder(t);
    assert.equal(excludeFromGit(root, ".bob/mcp.json"), "noRepository");
  });

  it("leaves a worktree or submodule alone, but says the file isn't excluded", (t) => {
    const root = tempFolder(t);
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere");
    mkdirSync(join(root, "sub"));
    assert.equal(excludeFromGit(root, ".bob/mcp.json"), "notExcluded");
    assert.equal(excludeFromGit(join(root, "sub"), ".bob/mcp.json"), "notExcluded");
  });
});

describe("shouldRewriteRules after frontmatter", () => {
  const body = `${GENERATED_RULES_MARKER}\n# Rules\n- new\n`;
  const current = `---\napplyTo: "**"\n---\n${body}`;

  it("updates a file it wrote with the marker right after the frontmatter", () => {
    assert.equal(shouldRewriteRules(`---\napplyTo: "**"\n---\n${GENERATED_RULES_MARKER}\n# Rules\n- old\n`, current, []), true);
  });

  it("leaves a file alone whose frontmatter doesn't close or whose marker the user removed", () => {
    assert.equal(shouldRewriteRules(`---\napplyTo: "**"\n${GENERATED_RULES_MARKER}\n# Rules\n`, current, []), false);
    assert.equal(shouldRewriteRules(`---\napplyTo: "**"\n---\n# Rules\n- mine\n`, current, []), false);
  });
});

describe("mergeJsonMcpServers", () => {
  const options = { file: ".mcp.json", userOptions: new Set<string>() };
  const entry = { type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer t" } };

  it("adds the entry, keeping other servers and settings", () => {
    const merged = JSON.parse(mergeJsonMcpServers('{"other":1,"mcpServers":{"github":{"type":"http"}}}', entry, options));
    assert.deepEqual(merged, { other: 1, mcpServers: { github: { type: "http" }, [MCP_SERVER_NAME]: entry } });
  });

  it("keeps only the user's own options of an existing entry", () => {
    const existing = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "evil", disabled: true } } });
    assert.deepEqual(JSON.parse(mergeJsonMcpServers(existing, entry, options)).mcpServers[MCP_SERVER_NAME], entry);
    const keeping = { file: ".bob/mcp.json", userOptions: new Set(["disabled"]) };
    assert.deepEqual(JSON.parse(mergeJsonMcpServers(existing, entry, keeping)).mcpServers[MCP_SERVER_NAME], { disabled: true, ...entry });
  });

  it("names the file it can't merge", () => {
    assert.throws(() => mergeJsonMcpServers("[]", entry, options), /\.mcp\.json does not hold a JSON object/);
    assert.throws(() => mergeJsonMcpServers('{"mcpServers":[]}', entry, options), /"mcpServers" in \.mcp\.json is not an object/);
  });

  it("removes only this extension's entry", () => {
    const existing = JSON.stringify({ mcpServers: { github: {}, [MCP_SERVER_NAME]: entry } });
    assert.deepEqual(JSON.parse(mergeJsonMcpServers(existing, undefined, options)), { mcpServers: { github: {} } });
  });
});

describe("jsonMcpEntry", () => {
  it("finds this extension's entry, and nothing in a file without one or that doesn't parse", () => {
    assert.deepEqual(jsonMcpEntry(JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: "u" } } })), { url: "u" });
    assert.equal(jsonMcpEntry('{"mcpServers":{}}'), undefined);
    assert.equal(jsonMcpEntry("{"), undefined);
    assert.equal(jsonMcpEntry(undefined), undefined);
  });
});
