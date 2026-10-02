import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_ALLOW_RULE,
  RULES_BODY,
  agentsStatusSummary,
  availableAgents,
  claudeAddCommand,
  claudeEntryMatches,
  claudePromptQuery,
  claudeServerEntry,
  codexEntryMatches,
  codexEntryState,
  codexServerLines,
  mentionFor,
  mergeClaudeLocalSettings,
  mergeClaudeMcpConfig,
  mergeCodexConfig,
  rulesText,
} from "../agentConfig";
import { GENERATED_RULES_MARKER, MCP_SERVER_NAME, shouldRewriteRules } from "../agentFiles";

describe("availableAgents", () => {
  it("offers each agent whose extension is installed, ignoring case", () => {
    assert.deepEqual(availableAgents(["Anthropic.claude-code", "openai.chatgpt", "GitHub.copilot-chat"], true), ["claude", "codex", "copilot"]);
    assert.deepEqual(availableAgents(["ms-python.python"], true), []);
  });

  it("offers Copilot only where VS Code lets extensions offer MCP servers", () => {
    assert.deepEqual(availableAgents(["github.copilot-chat", "anthropic.claude-code"], false), ["claude"]);
  });
});

describe("rulesText", () => {
  it("gives every agent Bob's rules, with frontmatter for Copilot's instructions file", () => {
    assert.equal(rulesText("claude"), `${GENERATED_RULES_MARKER}\n${RULES_BODY}`);
    assert.equal(rulesText("copilot"), `---\napplyTo: "**"\n---\n${GENERATED_RULES_MARKER}\n${RULES_BODY}`);
  });

  it("is recognized as written by this extension, so a later version can update it", () => {
    for (const agent of ["claude", "copilot"] as const) {
      const older = rulesText(agent).replace("never upload", "never, ever upload");
      assert.equal(shouldRewriteRules(older, rulesText(agent), []), true, agent);
    }
  });
});

describe("Claude Code", () => {
  const entry = claudeServerEntry(4100, "secret");

  it("adds an HTTP server with the token to .mcp.json, and tells whether it's current", () => {
    const text = mergeClaudeMcpConfig('{"mcpServers":{"github":{"type":"http","url":"https://x"}}}', entry);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.mcpServers[MCP_SERVER_NAME], {
      type: "http",
      url: "http://127.0.0.1:4100/mcp",
      headers: { Authorization: "Bearer secret" },
    });
    assert.ok(parsed.mcpServers.github);
    assert.equal(claudeEntryMatches(text, 4100, "secret"), true);
    assert.equal(claudeEntryMatches(text, 4101, "secret"), false);
    assert.equal(claudeEntryMatches(text, 4100, "other"), false);
  });

  it("drops anything a cloned project put in this extension's entry", () => {
    const existing = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "sh", args: ["-c", "evil"] } } });
    assert.deepEqual(JSON.parse(mergeClaudeMcpConfig(existing, entry)).mcpServers[MCP_SERVER_NAME], entry);
  });

  it("approves the server and its tools in the local settings, keeping the user's own", () => {
    const existing = JSON.stringify({ model: "x", permissions: { allow: ["Bash(npm test)"], deny: ["Read(.env)"] } });
    const connected = JSON.parse(mergeClaudeLocalSettings(existing, true));
    assert.deepEqual(connected, {
      model: "x",
      permissions: { allow: ["Bash(npm test)", CLAUDE_ALLOW_RULE], deny: ["Read(.env)"] },
      enabledMcpjsonServers: [MCP_SERVER_NAME],
    });
    assert.equal(CLAUDE_ALLOW_RULE, "mcp__ibmi-member-workspace");
    // Connecting twice adds nothing twice.
    assert.deepEqual(JSON.parse(mergeClaudeLocalSettings(JSON.stringify(connected), true)), connected);
  });

  it("creates the local settings, and takes only its own entries out again", () => {
    const created = mergeClaudeLocalSettings(undefined, true);
    assert.deepEqual(JSON.parse(created), { permissions: { allow: [CLAUDE_ALLOW_RULE] }, enabledMcpjsonServers: [MCP_SERVER_NAME] });
    const removed = JSON.parse(mergeClaudeLocalSettings(JSON.stringify({
      permissions: { allow: ["Bash(ls)", CLAUDE_ALLOW_RULE] },
      enabledMcpjsonServers: ["github", MCP_SERVER_NAME],
    }), false));
    assert.deepEqual(removed, { permissions: { allow: ["Bash(ls)"] }, enabledMcpjsonServers: ["github"] });
    assert.deepEqual(JSON.parse(mergeClaudeLocalSettings("{}", false)), {});
  });

  it("refuses settings it can't change instead of replacing them", () => {
    assert.throws(() => mergeClaudeLocalSettings("[]", true), /does not hold a JSON object/);
    assert.throws(() => mergeClaudeLocalSettings('{"permissions":{"allow":"all"}}', true), /can't change/);
    assert.throws(() => mergeClaudeLocalSettings('{"permissions":[]}', true), /"permissions"/);
  });

  it("offers a local-scope command when .mcp.json is committed", () => {
    assert.equal(
      claudeAddCommand(4100, "secret"),
      'claude mcp add --transport http --scope local ibmi-member-workspace http://127.0.0.1:4100/mcp --header "Authorization: Bearer secret"'
    );
  });

  it("form-encodes the prompt so Claude Code's URLSearchParams reads it back exactly", () => {
    const prompt = "Explain A&B + C = 100%?\n- MYLIB/QRPGLESRC(PROG) @checkout/PROG.RPGLE #1";
    assert.equal(new URLSearchParams(claudePromptQuery(prompt)).get("prompt"), prompt);
  });
});

describe("mergeCodexConfig", () => {
  const lines = codexServerLines(4100, "secret");
  const table = [
    "[mcp_servers.ibmi-member-workspace]",
    'url = "http://127.0.0.1:4100/mcp"',
    'http_headers = { "Authorization" = "Bearer secret" }',
    'default_tools_approval_mode = "approve"',
  ];

  it("writes the server table, approving its read-only tools", () => {
    assert.deepEqual(lines, table);
    assert.equal(mergeCodexConfig(undefined, lines), `${table.join("\n")}\n`);
  });

  it("appends to a file with other settings and servers, leaving them as they are", () => {
    const existing = 'model = "gpt-5"\n\n[mcp_servers.github]\nurl = "https://x"\n';
    assert.equal(mergeCodexConfig(existing, lines), `model = "gpt-5"\n\n[mcp_servers.github]\nurl = "https://x"\n\n${table.join("\n")}\n`);
  });

  it("replaces its own table and subtables, keeping the user's own settings for it", () => {
    const existing = [
      "[mcp_servers.ibmi-member-workspace]",
      'url = "http://127.0.0.1:9999/mcp"',
      "enabled = false",
      "tool_timeout_sec = 120",
      'command = "evil"',
      "",
      "[mcp_servers.ibmi-member-workspace.tools.find_where_used]",
      'approval_mode = "prompt"',
      "",
      "[profiles.fast]",
      'model = "x"',
      "",
    ].join("\n");
    assert.equal(
      mergeCodexConfig(existing, lines),
      `[profiles.fast]\nmodel = "x"\n\n${[...table, "enabled = false", "tool_timeout_sec = 120"].join("\n")}\n`
    );
  });

  it("finds its table under a quoted name", () => {
    const existing = '[mcp_servers."ibmi-member-workspace"]\nurl = "old"\n';
    assert.equal(mergeCodexConfig(existing, lines), `${table.join("\n")}\n`);
  });

  it("doesn't take a line inside a multi-line string for a table header", () => {
    const existing = 'notes = """\n[mcp_servers.ibmi-member-workspace]\n"""\nmodel = "x"\n';
    assert.equal(mergeCodexConfig(existing, undefined), existing);
    assert.equal(codexEntryState(existing), "none");
  });

  it("keeps CRLF line ends", () => {
    assert.equal(mergeCodexConfig('model = "x"\r\n', lines), `model = "x"\r\n\r\n${table.join("\r\n")}\r\n`);
  });

  it("removes its table, and leaves a file it wasn't in unchanged", () => {
    const existing = `model = "x"\n\n${table.join("\n")}\n`;
    assert.equal(mergeCodexConfig(existing, undefined), 'model = "x"\n');
    assert.equal(mergeCodexConfig(`${table.join("\n")}\n`, undefined), "");
  });

  it("refuses a server it can't update safely: an inline table or dotted keys", () => {
    assert.throws(() => mergeCodexConfig('[mcp_servers]\nibmi-member-workspace = { url = "x" }\n', lines), /can't update/);
    assert.throws(() => mergeCodexConfig('mcp_servers.ibmi-member-workspace.url = "x"\n', lines), /can't update/);
  });
});

describe("codexEntryState and codexEntryMatches", () => {
  it("tells a missing, enabled and turned-off server apart", () => {
    const table = codexServerLines(4100, "secret").join("\n");
    assert.equal(codexEntryState(undefined), "none");
    assert.equal(codexEntryState('model = "x"\n'), "none");
    assert.equal(codexEntryState(`${table}\n`), "enabled");
    assert.equal(codexEntryState(`${table}\nenabled = false\n`), "disabled");
    assert.equal(codexEntryMatches(`${table}\n`, 4100, "secret"), true);
    assert.equal(codexEntryMatches(`${table}\n`, 4100, "new"), false);
    assert.equal(codexEntryMatches(undefined, 4100, "secret"), false);
  });
});

describe("mentionFor", () => {
  it("names a checked-out file the way each agent reads it", () => {
    assert.equal(mentionFor("claude", "checkout/PUB400/MYLIB/QRPGLESRC/PROG.RPGLE"), "@checkout/PUB400/MYLIB/QRPGLESRC/PROG.RPGLE");
    assert.equal(mentionFor("copilot", "checkout/PROG.RPGLE"), "#file:checkout/PROG.RPGLE");
    assert.equal(mentionFor("codex", "checkout/PROG.RPGLE"), "checkout/PROG.RPGLE");
  });
});

describe("agentsStatusSummary", () => {
  const base = { enabled: true, connected: ["copilot", "claude"] as const, port: 4100, startError: undefined, system: "PUB400" };

  it("names the connected agents, in a fixed order, and the IBM i", () => {
    assert.equal(agentsStatusSummary({ ...base, connected: [...base.connected] }), "Claude Code, GitHub Copilot · PUB400");
  });

  it("puts the setting first, then the connections, then the server", () => {
    assert.equal(agentsStatusSummary({ ...base, connected: [...base.connected], enabled: false }), "Turned off");
    assert.equal(agentsStatusSummary({ ...base, connected: [] }), "Not connected");
    assert.equal(agentsStatusSummary({ ...base, connected: ["codex"], startError: "port in use" }), "Tools not running");
    assert.equal(agentsStatusSummary({ ...base, connected: ["codex"], port: undefined }), "Starting…");
    assert.equal(agentsStatusSummary({ ...base, connected: ["codex"], system: undefined }), "Codex · no IBM i");
  });
});
