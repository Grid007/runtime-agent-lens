import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "../logging.js";

export interface HttpServerOptions {
  readonly port: number;
  readonly token?: string;
  readonly createMcpServer: () => McpServer;
  readonly healthInfo: () => Record<string, unknown>;
  readonly log: Logger;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const hostnameOf = (hostHeader: string | undefined): string | undefined => {
  if (hostHeader === undefined) return undefined;
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
};

const originIsLoopback = (origin: string | undefined): boolean => {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`);
  } catch {
    return false;
  }
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Loopback-only Streamable HTTP front door. One McpServer + transport per MCP
 * client session, all sharing the single DebugController behind createMcpServer.
 */
export class McpHttpServer {
  private server: Server | undefined;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private boundPort = 0;

  constructor(private readonly options: HttpServerOptions) {}

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/mcp`;
  }

  get clientSessionCount(): number {
    return this.transports.size;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((cause: unknown) => {
        this.options.log.error("Unhandled HTTP error", cause);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    this.options.log.info(`MCP server listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      try {
        await transport.close();
      } catch {
        // best effort
      }
    }
    this.transports.clear();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.options.log.info("MCP server stopped");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostname = hostnameOf(req.headers.host);
    if (hostname === undefined || !LOOPBACK_HOSTS.has(hostname)) {
      sendJson(res, 403, { error: "Host header must be a loopback address" });
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      sendJson(res, 403, { error: "Origin not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, url: this.url, mcp_clients: this.transports.size, ...this.options.healthInfo() });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (this.options.token !== undefined) {
      const header = req.headers.authorization;
      if (header !== `Bearer ${this.options.token}`) {
        sendJson(res, 401, { error: "missing or invalid bearer token" });
        return;
      }
    }
    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    let body: unknown;
    if (req.method === "POST") {
      const text = await readBody(req);
      try {
        body = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        return;
      }
    }
    if (sessionId !== undefined) {
      const transport = this.transports.get(sessionId);
      if (transport === undefined) {
        sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Unknown MCP session" }, id: null });
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.transports.set(id, transport);
          this.options.log.info(`MCP client session ${id} connected`);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id !== undefined && this.transports.get(id) === transport) {
          this.transports.delete(id);
          this.options.log.info(`MCP client session ${id} closed`);
        }
      };
      const mcpServer = this.options.createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad request: expected an initialize request or an mcp-session-id header" },
      id: null,
    });
  }
}
