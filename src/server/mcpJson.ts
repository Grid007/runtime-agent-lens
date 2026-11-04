import * as fs from "node:fs";
import * as path from "node:path";

export const SERVER_KEY = "vscode-debugger";

export interface McpJsonPlan {
  readonly file: string;
  readonly exists: boolean;
  readonly before: string | undefined;
  readonly after: string;
  readonly changed: boolean;
  readonly backupPath: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The URL Claude Code should use: env var from this window, else this window's current port. */
export const claudeServerUrl = (port: number): string =>
  `http://127.0.0.1:\${VSCODE_DEBUG_MCP_PORT:-${port}}/mcp`;

export const claudeMcpAddCommand = (port: number, scope: "user" | "project" | "local" = "user"): string =>
  `claude mcp add --transport http --scope ${scope} ${SERVER_KEY} http://127.0.0.1:${port}/mcp`;

/** Plan an additive, idempotent merge of our server entry into `<folder>/.mcp.json`. */
export const planMcpJson = (folder: string, port: number, requireToken: boolean): McpJsonPlan => {
  const file = path.join(folder, ".mcp.json");
  const exists = fs.existsSync(file);
  const before = exists ? fs.readFileSync(file, "utf8") : undefined;
  let root: Record<string, unknown> = {};
  if (before !== undefined) {
    try {
      const parsed: unknown = JSON.parse(before);
      if (isRecord(parsed)) root = parsed;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it by hand before adding the server entry.`);
    }
  }
  const servers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  const entry: Record<string, unknown> = { type: "http", url: claudeServerUrl(port) };
  if (requireToken) entry.headers = { Authorization: "Bearer ${VSCODE_DEBUG_MCP_TOKEN}" };
  servers[SERVER_KEY] = entry;
  const after = `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
  const changed = before !== after;
  const backupPath = exists && changed ? `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}` : undefined;
  return { file, exists, before, after, changed, backupPath };
};

export const applyMcpJson = (plan: McpJsonPlan): void => {
  if (!plan.changed) return;
  if (plan.backupPath !== undefined && plan.before !== undefined) fs.writeFileSync(plan.backupPath, plan.before);
  fs.writeFileSync(plan.file, plan.after);
};
