import type { SessionInfo } from "../domain/debugState.js";

export interface HostBreakpoint {
  readonly id: string;
  readonly kind: "source" | "function" | "other";
  readonly enabled: boolean;
  readonly condition?: string;
  readonly hitCondition?: string;
  readonly logMessage?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly functionName?: string;
}

export interface SourceBreakpointSpec {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly condition?: string;
  readonly hitCondition?: string;
  readonly logMessage?: string;
  readonly enabled?: boolean;
}

export interface FunctionBreakpointSpec {
  readonly functionName: string;
  readonly condition?: string;
  readonly hitCondition?: string;
  readonly enabled?: boolean;
}

export interface BreakpointVerification {
  readonly dapId?: number;
  readonly verified: boolean;
  readonly message?: string;
  readonly line?: number;
}

export type LaunchConfigurationSource = "mcp-launch.json" | "launch.json" | "workspace" | "user";

export interface LaunchConfigurationInfo {
  readonly name: string;
  readonly type?: string;
  readonly request?: string;
  readonly source: LaunchConfigurationSource;
  readonly folder?: string;
  readonly hidden?: boolean;
  readonly configuration: Record<string, unknown>;
}

export interface WorkspaceFolderInfo {
  readonly name: string;
  readonly path: string;
}

export interface ActiveStackItem {
  readonly sessionId: string;
  readonly threadId: number;
  readonly frameId?: number;
}

/**
 * Everything the controller needs from the editor. The VS Code adapter
 * implements it; tests use an in-memory fake. Keeping this narrow is what
 * makes a future headless DAP backend possible.
 */
export interface DebugHost {
  workspaceFolders(): WorkspaceFolderInfo[];
  listLaunchConfigurations(folderPath?: string): Promise<LaunchConfigurationInfo[]>;
  startDebugging(folderPath: string | undefined, nameOrConfiguration: string | Record<string, unknown>): Promise<boolean>;
  stopDebugging(sessionId?: string): Promise<void>;
  restartActiveSession(): Promise<void>;
  hasSession(sessionId: string): boolean;
  sessionInfo(sessionId: string): SessionInfo | undefined;
  activeSessionId(): string | undefined;
  activeStackItem(): ActiveStackItem | undefined;
  customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown>;
  listBreakpoints(): HostBreakpoint[];
  addSourceBreakpoint(spec: SourceBreakpointSpec): HostBreakpoint;
  addFunctionBreakpoint(spec: FunctionBreakpointSpec): HostBreakpoint;
  removeBreakpoints(ids: readonly string[]): number;
  verifyBreakpoint(sessionId: string, breakpointId: string): Promise<BreakpointVerification | undefined>;
  /** Resolve a possibly workspace-relative path to an absolute one. */
  resolvePath(file: string): string;
  /** Lines of a text file on disk, or undefined when it cannot be read (missing, binary, very large). */
  readSourceLines(file: string): readonly string[] | undefined;
}
