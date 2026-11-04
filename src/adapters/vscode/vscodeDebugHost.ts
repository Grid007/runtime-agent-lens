import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  ActiveStackItem,
  BreakpointVerification,
  DebugHost,
  FunctionBreakpointSpec,
  HostBreakpoint,
  LaunchConfigurationInfo,
  SourceBreakpointSpec,
  WorkspaceFolderInfo,
} from "../../application/ports.js";
import type { DebugState, SessionInfo } from "../../domain/debugState.js";
import type { Logger } from "../../logging.js";
import { listLaunchConfigurations } from "./launchConfigurations.js";

const toSessionInfo = (session: vscode.DebugSession): SessionInfo => ({
  id: session.id,
  name: session.name,
  type: session.type,
  ...(session.parentSession === undefined ? {} : { parentId: session.parentSession.id }),
  ...(typeof session.configuration.name === "string" ? { configurationName: session.configuration.name } : {}),
  ...(session.workspaceFolder === undefined ? {} : { workspaceFolder: session.workspaceFolder.uri.fsPath }),
});

const toHostBreakpoint = (bp: vscode.Breakpoint): HostBreakpoint => {
  const base = {
    id: bp.id,
    enabled: bp.enabled,
    ...(bp.condition === undefined ? {} : { condition: bp.condition }),
    ...(bp.hitCondition === undefined ? {} : { hitCondition: bp.hitCondition }),
    ...(bp.logMessage === undefined ? {} : { logMessage: bp.logMessage }),
  };
  if (bp instanceof vscode.SourceBreakpoint) {
    return {
      ...base,
      kind: "source",
      file: bp.location.uri.fsPath,
      line: bp.location.range.start.line + 1,
      column: bp.location.range.start.character + 1,
    };
  }
  if (bp instanceof vscode.FunctionBreakpoint) {
    return { ...base, kind: "function", functionName: bp.functionName };
  }
  return { ...base, kind: "other" };
};

/** Implements the DebugHost port on top of the public vscode.debug API. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export class VscodeDebugHost implements DebugHost, vscode.Disposable {
  private readonly sessions = new Map<string, vscode.DebugSession>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sourceCache = new Map<string, { mtimeMs: number; lines: readonly string[] }>();

  constructor(
    private readonly state: DebugState,
    private readonly log: Logger,
  ) {
    const track = (session: vscode.DebugSession): void => {
      this.sessions.set(session.id, session);
      this.state.sessionStarted(toSessionInfo(session));
    };
    if (vscode.debug.activeDebugSession !== undefined) track(vscode.debug.activeDebugSession);
    this.disposables.push(
      vscode.debug.onDidStartDebugSession(track),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.state.sessionTerminated(session.id);
        this.sessions.delete(session.id);
      }),
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session): vscode.DebugAdapterTracker => {
          track(session);
          return {
            onWillStartSession: () => track(session),
            onWillReceiveMessage: (message) => this.state.recordDapMessage(session.id, "client", message),
            onDidSendMessage: (message) => this.state.recordDapMessage(session.id, "adapter", message),
            onExit: (code, signal) => this.state.adapterExited(session.id, code, signal),
            onError: (error) => this.log.warn(`Debug adapter error in ${session.name}`, error),
          };
        },
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  workspaceFolders(): WorkspaceFolderInfo[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
  }

  private findFolder(folderPath: string | undefined): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folderPath === undefined) return folders[0];
    const normalized = path.resolve(folderPath).toLowerCase();
    return (
      folders.find((f) => f.uri.fsPath.toLowerCase() === normalized) ??
      folders.find((f) => f.name.toLowerCase() === folderPath.toLowerCase()) ??
      folders[0]
    );
  }

  listLaunchConfigurations(folderPath?: string): Promise<LaunchConfigurationInfo[]> {
    return listLaunchConfigurations(this.findFolder(folderPath), this.log);
  }

  async startDebugging(folderPath: string | undefined, nameOrConfiguration: string | Record<string, unknown>): Promise<boolean> {
    const folder = this.findFolder(folderPath);
    const target =
      typeof nameOrConfiguration === "string" ? nameOrConfiguration : (nameOrConfiguration as vscode.DebugConfiguration);
    return vscode.debug.startDebugging(folder, target);
  }

  async stopDebugging(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      await vscode.debug.stopDebugging();
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
    await vscode.debug.stopDebugging(session);
  }

  async restartActiveSession(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.debug.restart");
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : toSessionInfo(session);
  }

  activeSessionId(): string | undefined {
    return vscode.debug.activeDebugSession?.id;
  }

  activeStackItem(): ActiveStackItem | undefined {
    const item = vscode.debug.activeStackItem;
    if (item === undefined) return undefined;
    if (item instanceof vscode.DebugStackFrame) {
      return { sessionId: item.session.id, threadId: item.threadId, frameId: item.frameId };
    }
    return { sessionId: item.session.id, threadId: item.threadId };
  }

  async customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown or ended session ${sessionId}`);
    return session.customRequest(command, args);
  }

  listBreakpoints(): HostBreakpoint[] {
    return vscode.debug.breakpoints.map(toHostBreakpoint);
  }

  addSourceBreakpoint(spec: SourceBreakpointSpec): HostBreakpoint {
    const location = new vscode.Location(
      vscode.Uri.file(spec.file),
      new vscode.Position(Math.max(0, spec.line - 1), Math.max(0, (spec.column ?? 1) - 1)),
    );
    const breakpoint = new vscode.SourceBreakpoint(location, spec.enabled ?? true, spec.condition, spec.hitCondition, spec.logMessage);
    vscode.debug.addBreakpoints([breakpoint]);
    return toHostBreakpoint(breakpoint);
  }

  addFunctionBreakpoint(spec: FunctionBreakpointSpec): HostBreakpoint {
    const breakpoint = new vscode.FunctionBreakpoint(spec.functionName, spec.enabled ?? true, spec.condition, spec.hitCondition);
    vscode.debug.addBreakpoints([breakpoint]);
    return toHostBreakpoint(breakpoint);
  }

  removeBreakpoints(ids: readonly string[]): number {
    const wanted = new Set(ids);
    const targets = vscode.debug.breakpoints.filter((bp) => wanted.has(bp.id));
    if (targets.length > 0) vscode.debug.removeBreakpoints(targets);
    return targets.length;
  }

  async verifyBreakpoint(sessionId: string, breakpointId: string): Promise<BreakpointVerification | undefined> {
    const session = this.sessions.get(sessionId);
    const breakpoint = vscode.debug.breakpoints.find((bp) => bp.id === breakpointId);
    if (session === undefined || breakpoint === undefined) return undefined;
    const protocolBreakpoint = (await session.getDebugProtocolBreakpoint(breakpoint)) as
      | { id?: number; verified?: boolean; message?: string; line?: number }
      | undefined;
    if (protocolBreakpoint === undefined) return undefined;
    return {
      verified: protocolBreakpoint.verified === true,
      ...(protocolBreakpoint.id === undefined ? {} : { dapId: protocolBreakpoint.id }),
      ...(protocolBreakpoint.message === undefined ? {} : { message: protocolBreakpoint.message }),
      ...(protocolBreakpoint.line === undefined ? {} : { line: protocolBreakpoint.line }),
    };
  }

  resolvePath(file: string): string {
    if (path.isAbsolute(file)) return path.normalize(file);
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const candidate = path.join(folder.uri.fsPath, file);
      if (fs.existsSync(candidate)) return candidate;
    }
    const first = folders[0];
    return first === undefined ? path.resolve(file) : path.join(first.uri.fsPath, file);
  }

  readSourceLines(file: string): readonly string[] | undefined {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return undefined;
      const cached = this.sourceCache.get(file);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.lines;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("\u0000")) return undefined;
      const lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      if (this.sourceCache.size >= 32) this.sourceCache.clear();
      this.sourceCache.set(file, { mtimeMs: stat.mtimeMs, lines });
      return lines;
    } catch {
      return undefined;
    }
  }
}
