import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_RULES_MARKER,
  MCP_SERVER_NAME,
  bobChatViews,
  bobFolderStatus,
  bobFocusInputCommand,
  bobPasteSteps,
  bobStatusSummary,
  configuredEntry,
  excludeFromGit,
  isBobProduct,
  mcpServerEntry,
  mergeMcpConfig,
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

describe("bobFolderStatus", () => {
  const withEntry = (entry: object) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } });

  it("is none without this extension's entry", () => {
    assert.equal(bobFolderStatus(undefined, true), "none");
    assert.equal(bobFolderStatus("", true), "none");
    assert.equal(bobFolderStatus("{ not json", true), "none");
    assert.equal(bobFolderStatus(JSON.stringify({ mcpServers: { other: { url: "x" } } }), true), "none");
  });

  it("tells an entry connected on this computer from one that came with the project", () => {
    assert.equal(bobFolderStatus(withEntry({ url: "http://127.0.0.1:1/mcp" }), true), "connected");
    assert.equal(bobFolderStatus(withEntry({ url: "http://127.0.0.1:1/mcp" }), false), "notConnectedHere");
  });

  it("is disabled when Bob's MCP settings turned the server off", () => {
    assert.equal(bobFolderStatus(withEntry({ url: "x", disabled: true }), true), "disabled");
    assert.equal(bobFolderStatus(withEntry({ url: "x", disabled: false }), true), "connected");
    assert.equal(bobFolderStatus(withEntry({ url: "x", disabled: true }), false), "notConnectedHere");
  });
});

describe("bobStatusSummary", () => {
  const running = { enabled: true, folders: ["connected"] as const, port: 5000, startError: undefined, system: "PUB400" };

  it("names the IBM i the running tools read", () => {
    assert.equal(bobStatusSummary(running), "Connected · PUB400");
    assert.equal(bobStatusSummary({ ...running, system: undefined }), "Connected · no IBM i");
  });

  it("says when no folder is connected on this computer", () => {
    assert.equal(bobStatusSummary({ ...running, folders: [] }), "Not connected");
    assert.equal(bobStatusSummary({ ...running, folders: ["none", "notConnectedHere"] }), "Not connected");
  });

  it("says Bob turned the server off only when it did in every connected folder", () => {
    assert.equal(bobStatusSummary({ ...running, folders: ["disabled", "none"] }), "Turned off in Bob");
    assert.equal(bobStatusSummary({ ...running, folders: ["disabled", "connected"] }), "Connected · PUB400");
  });

  it("tells a failed start from one still under way", () => {
    assert.equal(bobStatusSummary({ ...running, port: undefined, startError: "EACCES" }), "Tools not running");
    assert.equal(bobStatusSummary({ ...running, port: undefined }), "Starting…");
  });

  it("puts the setting first, then the connection", () => {
    assert.equal(bobStatusSummary({ ...running, enabled: false, startError: "EACCES" }), "Turned off");
    assert.equal(bobStatusSummary({ ...running, folders: [], startError: "EACCES" }), "Not connected");
  });
});

describe("bobChatViews", () => {
  const extension = (id: string, views: unknown) => ({ id, packageJSON: { contributes: { views } } });

  it("finds the webview views a Bob extension contributes, chat views first", () => {
    const views = bobChatViews([
      extension("ibm.bob", {
        "bob-ActivityBar": [
          { type: "webview", id: "bob.historyView", name: "History" },
          { type: "webview", id: "bob.SidebarProvider", name: "Bob" },
        ],
      }),
    ]);
    assert.deepEqual(views, ["bob.SidebarProvider", "bob.historyView"]);
  });

  it("ignores tree views and views of other extensions", () => {
    assert.deepEqual(bobChatViews([
      extension("ibm.bob", { explorer: [{ id: "bob.tree", name: "Bob files" }] }),
      extension("other.chat", { "other-bar": [{ type: "webview", id: "other.chatView", name: "Chat" }] }),
      extension("acme.bobcat", { bobcat: [{ type: "webview", id: "bobcat.view", name: "Bobcat" }] }),
    ]), []);
  });

  it("finds a Bob view in another extension's container by its name", () => {
    assert.deepEqual(bobChatViews([
      extension("ibm.agent", { "agent-bar": [{ type: "webview", id: "agent.chatPanel", name: "Bob Chat" }] }),
    ]), ["agent.chatPanel"]);
  });

  it("copes with manifests without views or with odd contributions", () => {
    assert.deepEqual(bobChatViews([
      { id: "ibm.bob", packageJSON: undefined },
      { id: "ibm.bob", packageJSON: { contributes: { views: [] } } },
      extension("ibm.bob", { bar: "not a list" }),
      extension("ibm.bob", { bar: [null, { type: "webview" }] }),
    ]), []);
  });
});

describe("bobPasteSteps", () => {
  const commands = (steps: ReturnType<typeof bobPasteSteps>) =>
    steps.flatMap((step) => ("command" in step ? [step.command] : []));

  it("runs only VS Code's own focus command on Bob's view, which never closes it", () => {
    const list = commands(bobPasteSteps("bob.SidebarProvider", 600));
    assert.deepEqual(list.filter((command) => command.startsWith("bob.")), ["bob.SidebarProvider.focus", "bob.SidebarProvider.focus"]);
    assert.deepEqual(list.filter((command) => !command.startsWith("bob.")), [
      "workbench.action.focusActiveEditorGroup",
      "editor.action.clipboardPasteAction",
    ]);
  });

  it("focuses the editor first, waits for the chat to load after opening it, and pastes last", () => {
    const steps = bobPasteSteps("bob.SidebarProvider", 1500);
    assert.deepEqual(steps.slice(0, 3), [
      { command: "workbench.action.focusActiveEditorGroup" },
      { command: "bob.SidebarProvider.focus" },
      { waitMs: 1500 },
    ]);
    assert.equal(commands(steps).at(-1), "editor.action.clipboardPasteAction");
  });

  it("focuses Bob's input box once the chat is open, then the view again, before pasting", () => {
    const steps = bobPasteSteps("bob.SidebarProvider", 600, "bob.focusInput");
    assert.deepEqual(commands(steps), [
      "workbench.action.focusActiveEditorGroup",
      "bob.SidebarProvider.focus",
      "bob.SidebarProvider.focus",
      "bob.focusInput",
      "bob.SidebarProvider.focus",
      "editor.action.clipboardPasteAction",
    ]);
    assert.deepEqual(steps.slice(0, 3), [
      { command: "workbench.action.focusActiveEditorGroup" },
      { command: "bob.SidebarProvider.focus" },
      { waitMs: 600 },
    ]);
  });
});

describe("bobFocusInputCommand", () => {
  it("picks Bob's focusInput command over its other focus commands", () => {
    assert.equal(bobFocusInputCommand(["bob.focus", "bob.SidebarProvider.focus", "bob.focusInput"]), "bob.focusInput");
    assert.equal(bobFocusInputCommand(["bob.focus", "bob.chat.focusInput"]), "bob.chat.focusInput");
  });

  it("finds none when Bob has only commands that may toggle its chat, or among other extensions", () => {
    assert.equal(bobFocusInputCommand(["bob.focus", "bob.SidebarProvider.focus"]), undefined);
    assert.equal(bobFocusInputCommand(["bobcat.focusInput", "other.focusInput"]), undefined);
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
