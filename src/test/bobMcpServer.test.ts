import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BobMcpServer, MAX_CONCURRENT_CALLS, McpTool, handleMessage, refusal } from "../bobMcpServer";

const info = { name: "test", version: "1.0.0", instructions: "Read only." };

const echo: McpTool = {
  name: "echo",
  title: "Echo",
  description: "Returns its arguments.",
  inputSchema: { type: "object" },
  readOnly: true,
  call: async (args) => {
    if (args.fail) {
      throw new Error("It failed");
    }
    return { echoed: args };
  },
};

describe("handleMessage", () => {
  it("initializes with the requested protocol version when supported", async () => {
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      [echo],
      info
    ) as { result: { protocolVersion: string; capabilities: unknown; instructions: string } };
    assert.equal(response.result.protocolVersion, "2025-03-26");
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.equal(response.result.instructions, "Read only.");

    const unknown = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      [echo],
      info
    ) as { result: { protocolVersion: string } };
    assert.equal(unknown.result.protocolVersion, "2025-11-25");
  });

  it("answers nothing to notifications", async () => {
    assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, [echo], info), undefined);
  });

  it("lists tools with read-only hints", async () => {
    const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, [echo], info) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> };
    };
    assert.equal(response.result.tools[0].name, "echo");
    assert.equal(response.result.tools[0].annotations.readOnlyHint, true);
    assert.equal(response.result.tools[0].annotations.destructiveHint, false);
  });

  it("returns a tool's result as text and structured content", async () => {
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } },
      [echo],
      info
    ) as { result: { content: Array<{ text: string }>; structuredContent: unknown } };
    assert.deepEqual(response.result.structuredContent, { echoed: { a: 1 } });
    assert.deepEqual(JSON.parse(response.result.content[0].text), { echoed: { a: 1 } });
  });

  it("reports a failing tool as a tool error, not a protocol error", async () => {
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { fail: true } } },
      [echo],
      info
    ) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "It failed");
  });

  it("rejects unknown tools, bad arguments, unknown methods and malformed requests", async () => {
    const error = async (message: unknown) =>
      ((await handleMessage(message, [echo], info)) as { error: { code: number } }).error.code;
    assert.equal(await error({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upload" } }), -32602);
    assert.equal(await error({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: [] } }), -32602);
    assert.equal(await error({ jsonrpc: "2.0", id: 1, method: "resources/list" }), -32601);
    assert.equal(await error({ id: 1, method: "ping" }), -32600);
  });
});

describe("refusal", () => {
  const good = { host: "127.0.0.1:5000", authorization: "Bearer token" };

  it("accepts a local request with the token", () => {
    assert.equal(refusal(good, "token", 5000), undefined);
    assert.equal(refusal({ ...good, host: "localhost:5000" }, "token", 5000), undefined);
  });

  it("refuses a missing or wrong token", () => {
    assert.equal(refusal({ host: good.host }, "token", 5000)?.status, 401);
    assert.equal(refusal({ ...good, authorization: "Bearer other" }, "token", 5000)?.status, 401);
  });

  it("refuses browsers and foreign hosts (DNS rebinding)", () => {
    assert.equal(refusal({ ...good, origin: "https://example.com" }, "token", 5000)?.status, 403);
    assert.equal(refusal({ ...good, host: "evil.example.com:5000" }, "token", 5000)?.status, 403);
    assert.equal(refusal({ ...good, host: "127.0.0.1:5001" }, "token", 5000)?.status, 403);
  });
});

function post(port: number, body: string, headers: http.OutgoingHttpHeaders): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("BobMcpServer", () => {
  it("serves tools over HTTP on 127.0.0.1 only to requests with the token", async (t) => {
    const server = new BobMcpServer([echo], "token", info, () => undefined);
    const port = await server.start(undefined);
    t.after(() => server.dispose());

    const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { x: "y" } } });
    const ok = await post(port, call, { Authorization: "Bearer token" });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).result.structuredContent, { echoed: { x: "y" } });

    assert.equal((await post(port, call, {})).status, 401);
    assert.equal((await post(port, call, { Authorization: "Bearer token", Origin: "http://localhost" })).status, 403);

    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal((await post(port, notification, { Authorization: "Bearer token" })).status, 202);
    assert.equal((await post(port, "{ nope", { Authorization: "Bearer token" })).status, 400);
  });

  it("answers a body over the limit with 413 and closes the connection", async (t) => {
    const server = new BobMcpServer([echo], "token", info, () => undefined);
    const port = await server.start(undefined);
    t.after(() => server.dispose());

    const huge = `{"pad":"${"x".repeat(1024 * 1024 + 1)}"}`;
    const response = await post(port, huge, { Authorization: "Bearer token" });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).error, "Request too large");
    // The server still answers afterwards.
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal((await post(port, ping, { Authorization: "Bearer token" })).status, 200);
  });

  it(`runs at most ${MAX_CONCURRENT_CALLS} tool calls at once`, async (t) => {
    const release: Array<() => void> = [];
    const slow: McpTool = { ...echo, name: "slow", call: () => new Promise((resolve) => release.push(() => resolve({ done: true }))) };
    const server = new BobMcpServer([slow], "token", info, () => undefined);
    const port = await server.start(undefined);
    t.after(() => server.dispose());
    const call = (id: number) =>
      post(port, JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "slow" } }), { Authorization: "Bearer token" });

    const running = Array.from({ length: MAX_CONCURRENT_CALLS }, (_, i) => call(i));
    while (release.length < MAX_CONCURRENT_CALLS) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const refused = JSON.parse((await call(99)).body);
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /Busy/);

    release.forEach((done) => done());
    for (const response of await Promise.all(running)) {
      assert.deepEqual(JSON.parse(response.body).result.structuredContent, { done: true });
    }
  });

  it("tells a tool when the client stops waiting", async (t) => {
    let aborted: Promise<void> | undefined;
    const waiting: McpTool = {
      ...echo,
      name: "waiting",
      call: (_args, signal) => {
        aborted = new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
        return new Promise(() => undefined);
      },
    };
    const server = new BobMcpServer([waiting], "token", info, () => undefined);
    const port = await server.start(undefined);
    t.after(() => server.dispose());
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    });
    req.on("error", () => undefined);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "waiting" } }));
    while (!aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    req.destroy();
    await aborted;
  });

  it("closes open keep-alive connections when disposed, so an old token can't go on working", async () => {
    const server = new BobMcpServer([echo], "token", info, () => undefined);
    const port = await server.start(undefined);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const request = () => new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/mcp", method: "POST", agent, headers: { Authorization: "Bearer token" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end(ping);
    });
    try {
      assert.equal(await request(), 200);
      server.dispose();
      await assert.rejects(request());
    } finally {
      agent.destroy();
      server.dispose();
    }
  });

  it("answers 500 instead of leaving the client waiting when handling fails", async (t) => {
    let serialized = 0;
    // Serializes once for the text content, then fails when the response is written.
    const brittle: McpTool = {
      ...echo,
      name: "brittle",
      call: async () => ({
        toJSON: () => {
          if (++serialized > 1) {
            throw new Error("cannot serialize");
          }
          return { ok: true };
        },
      }),
    };
    const server = new BobMcpServer([brittle], "token", info, () => undefined);
    const port = await server.start(undefined);
    t.after(() => server.dispose());
    const response = await post(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brittle" } }),
      { Authorization: "Bearer token" }
    );
    assert.equal(response.status, 500);
  });

  it("refuses oversized batches", async (t) => {
    const server = new BobMcpServer([echo], "token", info, () => undefined);
    const port = await server.start(undefined);
    t.after(() => server.dispose());
    const batch = JSON.stringify(Array.from({ length: 21 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" })));
    assert.equal((await post(port, batch, { Authorization: "Bearer token" })).status, 400);
  });

  it("logs a shortened copy of large tool arguments", async (t) => {
    const logged: string[] = [];
    const server = new BobMcpServer([echo], "token", info, (message) => logged.push(message));
    const port = await server.start(undefined);
    t.after(() => server.dispose());
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { x: "y".repeat(100_000) } } });
    assert.equal((await post(port, call, { Authorization: "Bearer token" })).status, 200);
    const line = logged.find((message) => message.startsWith("[bob] echo "));
    assert.ok(line && line.length < 1000, `logged ${line?.length} characters`);
    assert.match(line, /\(100008 characters\)$/);
  });

  it("uses another port when the saved one is taken", async (t) => {
    const first = new BobMcpServer([echo], "token", info, () => undefined);
    const port = await first.start(undefined);
    t.after(() => first.dispose());
    const second = new BobMcpServer([echo], "token", info, () => undefined);
    const other = await second.start(port);
    t.after(() => second.dispose());
    assert.notEqual(other, port);
  });
});
