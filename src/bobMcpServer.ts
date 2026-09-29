import * as crypto from "node:crypto";
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
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** A tool input the agent got wrong; reported to the agent as a tool error it can correct. */
export class ToolInputError extends Error {}

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
  info: ServerInfo
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
        const result = await tool.call((args ?? {}) as Record<string, unknown>);
        const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: structured,
        });
      } catch (err) {
        return reply({
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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

export class BobMcpServer {
  private server: http.Server | undefined;
  private port = 0;

  constructor(
    private readonly tools: readonly McpTool[],
    private readonly token: string,
    private readonly info: ServerInfo,
    private readonly log: (message: string) => void
  ) {}

  /** Listens on 127.0.0.1, on `preferredPort` when it is free, otherwise on any free port. */
  async start(preferredPort: number | undefined): Promise<number> {
    const listen = (port: number) => new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
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

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
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
      send(413, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const responses: JsonRpcResponse[] = [];
    for (const item of messages) {
      if (isRequest(item) && item.method === "tools/call") {
        this.log(`[bob] ${String(item.params?.name)} ${JSON.stringify(item.params?.arguments ?? {})}`);
      }
      const response = await handleMessage(item, this.tools, this.info);
      if (response) {
        responses.push(response);
      }
    }
    if (responses.length === 0) {
      send(202);
    } else {
      send(200, Array.isArray(message) ? responses : responses[0]);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
