import * as crypto from "node:crypto";
import { errorMessage } from "./errors";
import * as http from "node:http";

/**
 * A small MCP server (Streamable HTTP, JSON responses only) for Bob's agent, run inside the
 * extension host so its tools can use the Code for IBM i connection. It implements just what
 * a tools-only server needs: initialize, ping, tools/list and tools/call. Kept free of the
 * `vscode` module so it can be unit tested.
 */

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True for tools that never write anything, not even a local reference copy. */
  readOnly: boolean;
  /** `signal` is aborted when the client stops waiting (it disconnected or timed out). */
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** A tool input the agent got wrong; reported to the agent as a tool error it can correct. */
export class ToolInputError extends Error {}

/** Tool calls running at once, at most; more are turned away so abandoned retries can't pile up. */
export const MAX_CONCURRENT_CALLS = 4;
/** Messages in one JSON-RPC batch, at most. */
const MAX_BATCH = 20;

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface ServerInfo {
  name: string;
  version: string;
  instructions: string;
}

function isRequest(message: unknown): message is JsonRpcRequest {
  const candidate = message as Partial<JsonRpcRequest> | null;
  return Boolean(candidate) && typeof candidate === "object" &&
    candidate!.jsonrpc === "2.0" && typeof candidate!.method === "string";
}

/** Handles one JSON-RPC message; undefined for a notification, which gets no response. */
export async function handleMessage(
  message: unknown,
  tools: readonly McpTool[],
  info: ServerInfo,
  signal: AbortSignal = new AbortController().signal
): Promise<JsonRpcResponse | undefined> {
  if (!isRequest(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const id = message.id;
  if (id === undefined) {
    return undefined;
  }
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message: text } });

  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            title: tool.title,
            readOnlyHint: tool.readOnly,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })),
      });
    case "tools/call": {
      const name = message.params?.name;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return fail(-32602, `Unknown tool: ${String(name)}`);
      }
      const args = message.params?.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return fail(-32602, "Tool arguments must be an object");
      }
      try {
        const result = await tool.call((args ?? {}) as Record<string, unknown>, signal);
        const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
        // Compact JSON: the text goes into the model's context, where whitespace costs tokens.
        return reply({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: structured,
        });
      } catch (err) {
        return reply({
          content: [{ type: "text", text: errorMessage(err) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

/**
 * Why a request must be refused, or undefined when it may be handled. Only local, non-browser
 * clients holding the token get through: a browser page can't send the token, and an Origin
 * header or a foreign Host (DNS rebinding) is refused outright.
 */
export function refusal(
  headers: http.IncomingHttpHeaders,
  token: string,
  port: number
): { status: number; message: string } | undefined {
  if (headers.origin !== undefined) {
    return { status: 403, message: "Browser requests are not accepted" };
  }
  const host = String(headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { status: 403, message: "Unexpected Host header" };
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(String(headers.authorization ?? ""));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { status: 401, message: "Missing or wrong token" };
  }
  return undefined;
}

const MAX_BODY = 1024 * 1024;

class RequestTooLargeError extends Error {
  constructor() {
    super("Request too large");
  }
}

export class BobMcpServer {
  private server: http.Server | undefined;
  private port = 0;
  private running = 0;

  constructor(
    private readonly tools: readonly McpTool[],
    private readonly token: string,
    private readonly info: ServerInfo,
    private readonly log: (message: string) => void
  ) {}

  /** Listens on 127.0.0.1, on `preferredPort` when it is free, otherwise on any free port. */
  async start(preferredPort: number | undefined): Promise<number> {
    const listen = (port: number) => new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.log(`[mcp] Request failed: ${errorMessage(err)}`);
          // Never leave a client waiting for an answer that won't come.
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
          } else if (!res.writableEnded) {
            res.end();
          }
        });
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(server);
      });
    });
    try {
      this.server = await listen(preferredPort ?? 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || !preferredPort) {
        throw err;
      }
      this.log(`[bob] Port ${preferredPort} is in use; using another one.`);
      this.server = await listen(0);
    }
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  /**
   * Stops listening and closes every open connection too: `close()` alone leaves keep-alive
   * connections open, and a client on one could go on using a token that was just replaced.
   */
  dispose(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      // Serialize first: a body that can't be serialized must not leave a 200 status already sent.
      const text = body === undefined ? undefined : JSON.stringify(body);
      res.writeHead(status, text === undefined ? {} : { "Content-Type": "application/json" });
      res.end(text);
    };
    const refused = refusal(req.headers, this.token, this.port);
    if (refused) {
      send(refused.status, { error: refused.message });
      return;
    }
    if ((req.url ?? "").split("?")[0] !== "/mcp") {
      send(404, { error: "Not found" });
      return;
    }
    if (req.method !== "POST") {
      // No server-to-client stream and no sessions to end.
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof RequestTooLargeError) {
        // The rest of the body is never read: answer, then close the connection instead of reusing it.
        res.setHeader("Connection", "close");
        send(413, { error: err.message });
        return;
      }
      throw err;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    if (messages.length > MAX_BATCH) {
      send(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `At most ${MAX_BATCH} messages per batch` } });
      return;
    }
    // Stop long work (e.g. DSPPGMREF over more libraries) once nobody is waiting for the answer.
    const abandoned = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        abandoned.abort();
      }
    });
    const responses: JsonRpcResponse[] = [];
    for (const item of messages) {
      const call = isRequest(item) && item.method === "tools/call" ? item : undefined;
      if (call && call.id !== undefined && this.running >= MAX_CONCURRENT_CALLS) {
        responses.push({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            content: [{ type: "text", text: `Busy with ${this.running} other requests to the IBM i; try again when they finish.` }],
            isError: true,
          },
        });
        continue;
      }
      if (call) {
        this.log(`[bob] ${String(call.params?.name).slice(0, 100)} ${logText(call.params?.arguments ?? {})}`);
        this.running++;
      }
      try {
        const response = await handleMessage(item, this.tools, this.info, abandoned.signal);
        if (response) {
          responses.push(response);
        }
      } finally {
        if (call) {
          this.running--;
        }
      }
      if (abandoned.signal.aborted) {
        this.log(`[bob] The client stopped waiting${call ? ` for ${String(call.params?.name).slice(0, 100)}` : ""}; the rest of the work was skipped.`);
        return;
      }
    }
    if (responses.length === 0) {
      send(202);
    } else {
      send(200, Array.isArray(message) ? responses : responses[0]);
    }
  }
}

/** Longest tool arguments written to the log; a request may be up to 1 MB. */
const MAX_LOGGED_ARGUMENTS = 500;

function logText(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > MAX_LOGGED_ARGUMENTS ? `${text.slice(0, MAX_LOGGED_ARGUMENTS)}… (${text.length} characters)` : text;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop keeping the body; the rest still drains so the 413 reaches the client before the
        // connection closes (a destroyed socket would only show the client a reset).
        req.off("data", onData);
        chunks.length = 0;
        reject(new RequestTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
