import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { createMcpServer } from "./adapters/mcp/registerTools.js";
import { AgentActivity } from "./adapters/vscode/agentActivity.js";
import { VscodeDebugHost } from "./adapters/vscode/vscodeDebugHost.js";
import { DebugController } from "./application/debugController.js";
import { DebugState } from "./domain/debugState.js";
import { formatLogData, type Logger } from "./logging.js";
import { McpHttpServer } from "./server/httpServer.js";
import { applyMcpJson, claudeMcpAddCommand, planMcpJson, SERVER_KEY } from "./server/mcpJson.js";
import { InstanceRegistry } from "./server/registry.js";

const SERVER_NAME = "vscode-debugger-mcp";

interface Runtime {
  readonly state: DebugState;
  readonly host: VscodeDebugHost;
  readonly controller: DebugController;
  readonly http: McpHttpServer;
  readonly registry: InstanceRegistry;
  readonly token: string | undefined;
  readonly pruneTimer: NodeJS.Timeout;
}

let runtime: Runtime | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let log: Logger;
let activity: AgentActivity | undefined;
const definitionsChanged = new vscode.EventEmitter<void>();

const createLogger = (channel: vscode.OutputChannel): Logger => {
  const write = (level: string, message: string, data?: unknown): void => {
    channel.appendLine(`${new Date().toISOString()} [${level}] ${message}${formatLogData(data)}`);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
};

const settings = () => {
  const cfg = vscode.workspace.getConfiguration("vscodeDebuggerMcp");
  return {
    autoStart: cfg.get<boolean>("autoStart", true),
    port: cfg.get<number>("port", 0),
    requireToken: cfg.get<boolean>("requireToken", false),
    allowMutation: cfg.get<boolean>("allowMutation", true),
    redactSecrets: cfg.get<boolean>("redactSecrets", true),
    defaultTimeoutSeconds: cfg.get<number>("defaultTimeoutSeconds", 60),
    startWaitSeconds: cfg.get<number>("startWaitSeconds", 5),
    maxOutputEntries: cfg.get<number>("maxOutputEntries", 2000),
  };
};

const activitySettings = () => {
  const cfg = vscode.workspace.getConfiguration("vscodeDebuggerMcp");
  return {
    autoReveal: cfg.get<boolean>("activity.autoReveal", true),
    echoToDebugConsole: cfg.get<boolean>("activity.echoToDebugConsole", true),
    maxRawChars: Math.max(200, cfg.get<number>("activity.maxRawChars", 3000)),
  };
};

const extensionVersion = (context: vscode.ExtensionContext): string => {
  const pkg = context.extension.packageJSON as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
};

const workspaceName = (): string =>
  vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "VS Code window";

const workspaceFolderPaths = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

async function startRuntime(context: vscode.ExtensionContext, portOverride?: number): Promise<void> {
  if (runtime !== undefined) return;
  const s = settings();
  const version = extensionVersion(context);
  const state = new DebugState({ maxOutputEntries: s.maxOutputEntries });
  const host = new VscodeDebugHost(state, log);
  const controller = new DebugController(
    host,
    state,
    {
      defaultTimeoutMs: s.defaultTimeoutSeconds * 1000,
      startWaitMs: s.startWaitSeconds * 1000,
      allowMutation: s.allowMutation,
      redactSecrets: s.redactSecrets,
      maxReportFrames: 10,
      maxReportOutputLines: 40,
    },
    log,
  );
  const token = s.requireToken ? randomBytes(24).toString("hex") : undefined;
  const http = new McpHttpServer({
    port: portOverride ?? s.port,
    token,
    log,
    createMcpServer: () => createMcpServer(controller, { name: SERVER_NAME, version }, log, activity),
    healthInfo: () => ({
      version,
      workspace: workspaceName(),
      workspace_folders: workspaceFolderPaths(),
      debug_sessions: state.listSessions().length,
    }),
  });
  try {
    await http.start();
  } catch (cause) {
    host.dispose();
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && portOverride === undefined) {
      const choice = await vscode.window.showErrorMessage(
        `Debugger MCP: port ${s.port} is in use.`,
        "Use a free port for this window",
        "Open settings",
      );
      if (choice === "Use a free port for this window") {
        await startRuntime(context, 0);
        return;
      }
      if (choice === "Open settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "vscodeDebuggerMcp.port");
      }
      return;
    }
    log.error("Failed to start MCP server", cause);
    void vscode.window.showErrorMessage(`Debugger MCP failed to start: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  }
  controller.setServerInfoProvider(() => ({
    name: SERVER_NAME,
    version,
    url: http.url,
    port: http.port,
    mcp_clients: http.clientSessionCount,
    token_required: token !== undefined,
  }));

  const env = context.environmentVariableCollection;
  env.description = "VS Code Debugger MCP endpoint for this window";
  env.replace("VSCODE_DEBUG_MCP_PORT", String(http.port));
  env.replace("VSCODE_DEBUG_MCP_URL", http.url);
  if (token !== undefined) env.replace("VSCODE_DEBUG_MCP_TOKEN", token);
  else env.delete("VSCODE_DEBUG_MCP_TOKEN");

  const registry = new InstanceRegistry(() => ({
    pid: process.pid,
    port: http.port,
    url: http.url,
    name: workspaceName(),
    workspaceFolders: workspaceFolderPaths(),
  }));
  registry.start();

  const pruneTimer = setInterval(() => state.pruneTerminated(10 * 60_000), 60_000);
  pruneTimer.unref?.();

  runtime = { state, host, controller, http, registry, token, pruneTimer };
  updateStatusBar();
  definitionsChanged.fire();
  log.info(`Ready. Port ${http.port}; new integrated terminals get VSCODE_DEBUG_MCP_PORT=${http.port}.`);
}

async function stopRuntime(): Promise<void> {
  const current = runtime;
  runtime = undefined;
  if (current === undefined) return;
  clearInterval(current.pruneTimer);
  current.registry.stop();
  await current.http.stop();
  current.host.dispose();
  updateStatusBar();
  definitionsChanged.fire();
}

function updateStatusBar(): void {
  if (statusBar === undefined) return;
  if (runtime === undefined) {
    statusBar.text = "$(debug-disconnect) MCP off";
    statusBar.tooltip = "VS Code Debugger MCP server is not running. Click for options.";
  } else {
    statusBar.text = `$(debug-alt) MCP :${runtime.http.port}`;
    statusBar.tooltip = `VS Code Debugger MCP\n${runtime.http.url}\nClick for options.`;
  }
  statusBar.show();
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Open a folder first.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: "Which workspace folder's .mcp.json should get the server entry?" },
  );
  return picked?.folder;
}

async function writeMcpJsonCommand(): Promise<void> {
  if (runtime === undefined) {
    void vscode.window.showWarningMessage("Start the Debugger MCP server first.");
    return;
  }
  const folder = await pickFolder();
  if (folder === undefined) return;
  let plan;
  try {
    plan = planMcpJson(folder.uri.fsPath, runtime.http.port, runtime.token !== undefined);
  } catch (cause) {
    void vscode.window.showErrorMessage(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  if (!plan.changed) {
    void vscode.window.showInformationMessage(`.mcp.json already has the '${SERVER_KEY}' entry.`);
    return;
  }
  const detail = [
    `File: ${plan.file}`,
    plan.exists ? `Backup: ${plan.backupPath ?? "(none)"}` : "A new file will be created.",
    "",
    "Entry:",
    JSON.stringify(JSON.parse(plan.after).mcpServers[SERVER_KEY], null, 2),
  ].join("\n");
  const choice = await vscode.window.showInformationMessage(
    `Add '${SERVER_KEY}' to .mcp.json?`,
    { modal: true, detail },
    "Write",
  );
  if (choice !== "Write") return;
  applyMcpJson(plan);
  log.info(`Wrote ${plan.file}`);
  void vscode.window.showInformationMessage(
    "Added. Start Claude Code from a new integrated terminal in this window so it inherits VSCODE_DEBUG_MCP_PORT.",
  );
}

async function revealRedactedCommand(): Promise<void> {
  if (runtime === undefined) {
    void vscode.window.showWarningMessage("Start the Debugger MCP server first.");
    return;
  }
  const controller = runtime.controller;
  const items = controller.listRedactions();
  if (items.length === 0) {
    void vscode.window.showInformationMessage("Nothing has been hidden from the agent in this window yet.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    items.map((r) => ({
      label: r.label,
      description: r.tool === "evaluate" ? "evaluate" : "variable",
      detail: new Date(r.at).toLocaleTimeString("en-GB", { hour12: false }),
      id: r.id,
    })),
    { placeHolder: "Value hidden from the agent. Only you will see it." },
  );
  if (picked === undefined) return;
  const result = await controller.revealRedaction(picked.id);
  if (!result.ok) {
    void vscode.window.showWarningMessage(result.error.message);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Hidden from the agent: ${result.value.label}`,
    { modal: true, detail: result.value.value },
    "Copy value",
  );
  if (choice === "Copy value") await vscode.env.clipboard.writeText(result.value.value);
}

async function installSkillCommand(context: vscode.ExtensionContext): Promise<void> {
  const source = context.asAbsolutePath(path.join("skills", "vscode-debugging", "SKILL.md"));
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const destinationDir = path.join(configDir, "skills", "vscode-debugging");
  const destination = path.join(destinationDir, "SKILL.md");
  try {
    const content = fs.readFileSync(source, "utf8");
    fs.mkdirSync(destinationDir, { recursive: true });
    if (fs.existsSync(destination) && fs.readFileSync(destination, "utf8") !== content) {
      fs.copyFileSync(destination, `${destination}.bak`);
    }
    fs.writeFileSync(destination, content);
    void vscode.window.showInformationMessage(`Installed skill to ${destination}`);
  } catch (cause) {
    void vscode.window.showErrorMessage(`Skill install failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function showStatusCommand(context: vscode.ExtensionContext): Promise<void> {
  const running = runtime !== undefined;
  const items: Array<vscode.QuickPickItem & { action: () => Promise<void> }> = [];
  if (running && runtime !== undefined) {
    const url = runtime.http.url;
    items.push({
      label: `$(link) ${url}`,
      description: `${runtime.http.clientSessionCount} MCP client(s), ${runtime.state.listSessions().length} debug session(s)`,
      detail: "Copy URL",
      action: async () => {
        await vscode.env.clipboard.writeText(url);
      },
    });
    items.push({
      label: "$(terminal) Copy 'claude mcp add' command",
      detail: claudeMcpAddCommand(runtime.http.port),
      action: async () => {
        await vscode.commands.executeCommand("vscodeDebuggerMcp.copyClaudeCommand");
      },
    });
    items.push({
      label: "$(json) Add server to workspace .mcp.json",
      detail: "Claude Code picks it up from the project; uses VSCODE_DEBUG_MCP_PORT with this port as fallback.",
      action: async () => {
        await vscode.commands.executeCommand("vscodeDebuggerMcp.writeMcpJson");
      },
    });
  }
  items.push({
    label: "$(book) Install debugging skill for Claude Code",
    detail: "Copies skills/vscode-debugging/SKILL.md into ~/.claude/skills/",
    action: () => installSkillCommand(context),
  });
  items.push({
    label: running ? "$(debug-restart) Restart server" : "$(debug-start) Start server",
    action: async () => {
      await vscode.commands.executeCommand("vscodeDebuggerMcp.restartServer");
    },
  });
  items.push({
    label: "$(eye) Show agent activity",
    detail: "Every tool call and the exact result the agent received",
    action: async () => {
      activity?.show();
    },
  });
  items.push({
    label: "$(output) Show log",
    action: async () => {
      output?.show(true);
    },
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: running ? "VS Code Debugger MCP is running" : "VS Code Debugger MCP is stopped",
  });
  if (picked !== undefined) await picked.action();
}

function registerCopilotProvider(context: vscode.ExtensionContext): void {
  const lm = (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: unknown } }).lm;
  if (lm === undefined || typeof lm.registerMcpServerDefinitionProvider !== "function") return;
  try {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider("vscodeDebuggerMcp.provider", {
        onDidChangeMcpServerDefinitions: definitionsChanged.event,
        provideMcpServerDefinitions: () => {
          if (runtime === undefined) return [];
          const headers: Record<string, string> = {};
          if (runtime.token !== undefined) headers.Authorization = `Bearer ${runtime.token}`;
          return [
            new vscode.McpHttpServerDefinition(
              "VS Code Debugger MCP",
              vscode.Uri.parse(runtime.http.url),
              headers,
              extensionVersion(context),
            ),
          ];
        },
      }),
    );
  } catch (cause) {
    log.warn("Could not register MCP server definition provider", cause);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("VS Code Debugger MCP");
  log = createLogger(output);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "vscodeDebuggerMcp.showStatus";
  activity = new AgentActivity(activitySettings);
  context.subscriptions.push(output, statusBar, definitionsChanged, activity);

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeDebuggerMcp.showStatus", () => showStatusCommand(context)),
    vscode.commands.registerCommand("vscodeDebuggerMcp.restartServer", async () => {
      await stopRuntime();
      await startRuntime(context);
    }),
    vscode.commands.registerCommand("vscodeDebuggerMcp.showActivity", () => activity?.show()),
    vscode.commands.registerCommand("vscodeDebuggerMcp.revealRedacted", revealRedactedCommand),
    vscode.commands.registerCommand("vscodeDebuggerMcp.writeMcpJson", writeMcpJsonCommand),
    vscode.commands.registerCommand("vscodeDebuggerMcp.copyClaudeCommand", async () => {
      if (runtime === undefined) {
        void vscode.window.showWarningMessage("Start the Debugger MCP server first.");
        return;
      }
      const command = claudeMcpAddCommand(runtime.http.port);
      await vscode.env.clipboard.writeText(command);
      void vscode.window.showInformationMessage(`Copied: ${command}`);
    }),
    vscode.commands.registerCommand("vscodeDebuggerMcp.installClaudeSkill", () => installSkillCommand(context)),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const serverSettings = ["autoStart", "port", "requireToken", "allowMutation", "redactSecrets", "defaultTimeoutSeconds", "startWaitSeconds", "maxOutputEntries"];
      // Display-only settings (activity.*) are read per call and must not restart the server or move its port.
      if (!serverSettings.some((key) => event.affectsConfiguration(`vscodeDebuggerMcp.${key}`))) return;
      if (runtime === undefined) return;
      log.info("Settings changed; restarting MCP server");
      await stopRuntime();
      await startRuntime(context);
    }),
  );

  registerCopilotProvider(context);
  updateStatusBar();
  if (settings().autoStart) await startRuntime(context);
}

export async function deactivate(): Promise<void> {
  await stopRuntime();
}
