import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_RULES_MARKER,
  MCP_SERVER_NAME,
  configuredEntry,
  excludeFromGit,
  isBobProduct,
  mcpServerEntry,
  mergeMcpConfig,
  pickBobFocusCommand,
  readFileBelow,
  refreshedAlwaysAllow,
  shouldRewriteRules,
  writeFileBelow,
} from "../bobIde";

function tempFolder(t: { after: (fn: () => void) => void }): string {
  const folder = mkdtempSync(join(tmpdir(), "ibmi-member-workspace-bob-"));
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

describe("isBobProduct", () => {
  it("recognizes IBM Bob and nothing else", () => {
    assert.equal(isBobProduct("IBM Bob", "bob"), true);
    assert.equal(isBobProduct("Bob", "vscode"), true);
    assert.equal(isBobProduct("Bob - Insiders", "bob-insiders"), true);
    assert.equal(isBobProduct("Something", "ibm-bob"), true);
    assert.equal(isBobProduct("Visual Studio Code", "vscode"), false);
    assert.equal(isBobProduct("Visual Studio Code - Insiders", "vscode-insiders"), false);
    assert.equal(isBobProduct("Cursor", "cursor"), false);
    assert.equal(isBobProduct("VSCodium", "vscodium"), false);
    assert.equal(isBobProduct("Bobcat Editor", "bobcat"), false);
  });
});

describe("mergeMcpConfig", () => {
  const entry = mcpServerEntry(4321, "secret", ["list_checkouts"]);

  it("creates the file when there is none", () => {
    assert.deepEqual(JSON.parse(mergeMcpConfig(undefined, entry)), {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          url: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: "Bearer secret" },
          alwaysAllow: ["list_checkouts"],
        },
      },
    });
  });

  it("keeps other servers, other settings, and the user's own options for the entry", () => {
    const existing = JSON.stringify({
      other: true,
      mcpServers: {
        instana: { command: "npx", args: ["instana-mcp"] },
        [MCP_SERVER_NAME]: { url: "http://127.0.0.1:1/mcp", disabled: true, timeout: 300 },
      },
    });
    const merged = JSON.parse(mergeMcpConfig(existing, entry));
    assert.equal(merged.other, true);
    assert.deepEqual(merged.mcpServers.instana, { command: "npx", args: ["instana-mcp"] });
    assert.equal(merged.mcpServers[MCP_SERVER_NAME].disabled, true);
    assert.equal(merged.mcpServers[MCP_SERVER_NAME].timeout, 300);
    assert.equal(merged.mcpServers[MCP_SERVER_NAME].url, "http://127.0.0.1:4321/mcp");
  });

  it("drops anything else a cloned project put in this extension's entry", () => {
    const existing = JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "stdio", command: "sh", args: ["-c", "evil"], env: { A: "1" }, disabled: false },
      },
    });
    assert.deepEqual(JSON.parse(mergeMcpConfig(existing, entry)).mcpServers[MCP_SERVER_NAME], { disabled: false, ...entry });
  });

  it("removes only this extension's entry", () => {
    const existing = mergeMcpConfig(JSON.stringify({ mcpServers: { instana: { url: "x" } } }), entry);
    assert.deepEqual(JSON.parse(mergeMcpConfig(existing, undefined)), { mcpServers: { instana: { url: "x" } } });
  });

  it("refuses a file it can't merge instead of replacing it", () => {
    assert.throws(() => mergeMcpConfig("[]", entry), /JSON object/);
    assert.throws(() => mergeMcpConfig(JSON.stringify({ mcpServers: [] }), entry), /not an object/);
    assert.throws(() => mergeMcpConfig("{ not json", entry));
  });

  it("finds the configured entry", () => {
    assert.equal(configuredEntry(undefined), undefined);
    assert.equal(configuredEntry("{ broken"), undefined);
    assert.equal(configuredEntry(mergeMcpConfig(undefined, entry))?.url, "http://127.0.0.1:4321/mcp");
  });
});

describe("refreshedAlwaysAllow", () => {
  const tools = ["list_checkouts", "read_member_source", "find_where_used"];

  it("keeps tools the user took out of alwaysAllow out", () => {
    assert.deepEqual(refreshedAlwaysAllow(["list_checkouts"], tools, tools), ["list_checkouts"]);
    assert.deepEqual(refreshedAlwaysAllow(undefined, tools, tools), []);
  });

  it("adds only tools a new version brought, and drops tools that are gone", () => {
    assert.deepEqual(
      refreshedAlwaysAllow(["list_checkouts", "old_tool"], tools, ["list_checkouts", "read_member_source"]),
      ["list_checkouts", "find_where_used"]
    );
  });

  it("adds nothing when the previous tools are unknown", () => {
    assert.deepEqual(refreshedAlwaysAllow(["read_member_source"], tools, undefined), ["read_member_source"]);
  });
});

describe("pickBobFocusCommand", () => {
  it("prefers the chat input, then bob.focus, then another Bob view", () => {
    assert.equal(pickBobFocusCommand(["bob.focus", "bob.chatView.focusInput", "bob.other.focus"]), "bob.chatView.focusInput");
    assert.equal(pickBobFocusCommand(["bob.other.focus", "bob.focus"]), "bob.focus");
    assert.equal(pickBobFocusCommand(["editor.focus", "bob.other.focus"]), "bob.other.focus");
  });

  it("ignores commands of other extensions", () => {
    assert.equal(pickBobFocusCommand(["bobcat.focus", "foo.bob.focus", "bobcat.focusInput"]), undefined);
    assert.equal(pickBobFocusCommand([]), undefined);
  });
});

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
