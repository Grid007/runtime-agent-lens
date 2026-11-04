import type {
  DebugHost,
  HostBreakpoint,
  LaunchConfigurationInfo,
} from "./ports.js";
import type { DebugState, SessionRecord, StateEvent, OutputEntry } from "../domain/debugState.js";
import { fail, failFromUnknown, ok, type Result } from "../domain/result.js";
import { findSideEffect } from "../domain/expressionGuard.js";
import { expressionMentionsSecret, REDACTED, redactSourceLine, redactValuePatterns, redactVariable } from "../domain/redaction.js";
import { shapeVariable, truncateText, type DapVariable, type VariableView } from "../domain/variables.js";
import type { Logger } from "../logging.js";

export interface ControllerOptions {
  defaultTimeoutMs: number;
  startWaitMs: number;
  allowMutation: boolean;
  redactSecrets: boolean;
  maxReportFrames: number;
  maxReportOutputLines: number;
}

export interface SessionSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  parent_id?: string;
  configuration_name?: string;
  workspace_folder?: string;
  last_stop?: {
    reason: string;
    thread_id?: number;
    description?: string;
    text?: string;
    at: string;
  };
  exit_code?: number;
  exception_breakpoint_filters?: Array<{ filter: string; label: string; default?: boolean; description?: string }>;
}

/** A value hidden from the agent: where to find it again, never the value itself. */
export interface RedactionRef {
  id: number;
  at: number;
  tool: "get_variables" | "evaluate";
  label: string;
  sessionId: string;
  reference?: number;
  name?: string;
  frameId?: number;
  expression?: string;
}

export interface FrameView {
  frame_id: number;
  name: string;
  file?: string;
  line?: number;
  column?: number;
  source_line?: string;
  presentation_hint?: string;
}

export interface OutputLine {
  seq: number;
  category: string;
  text: string;
}

export interface StopReport {
  outcome: "stopped" | "terminated" | "exited" | "timeout" | "running";
  session?: SessionSummary;
  reason?: string;
  description?: string;
  text?: string;
  thread_id?: number;
  all_threads_stopped?: boolean;
  hit_breakpoints?: Array<{ dap_id: number; breakpoint_id?: string; file?: string; line?: number }>;
  exception?: unknown;
  frames?: FrameView[];
  exit_code?: number;
  output: OutputLine[];
  output_truncated: boolean;
  elapsed_ms: number;
  limitations: string[];
}

export interface BreakpointView {
  id: string;
  kind: string;
  enabled: boolean;
  file?: string;
  line?: number;
  column?: number;
  function_name?: string;
  condition?: string;
  hit_condition?: string;
  log_message?: string;
  verified?: boolean;
  verification_message?: string;
  adapter_line?: number;
  dap_id?: number;
}

interface DapStackFrame {
  id: number;
  name: string;
  source?: { path?: string; name?: string; sourceReference?: number };
  line?: number;
  column?: number;
  presentationHint?: string;
}

interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: string;
}

interface DapThread {
  id: number;
  name: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toIso = (ms: number): string => new Date(ms).toISOString();

/** Brief is what stop reports carry: enough to identify the session, none of the setup detail. */
const summarizeSession = (record: SessionRecord, brief = false): SessionSummary => {
  const exited = record.exitCode !== undefined && record.status === "running";
  const summary: SessionSummary = {
    id: record.id,
    name: record.name,
    type: record.type,
    status: exited ? "exited" : record.status,
  };
  if (brief) {
    if (record.exitCode !== undefined) summary.exit_code = record.exitCode;
    return summary;
  }
  if (record.parentId !== undefined) summary.parent_id = record.parentId;
  if (record.configurationName !== undefined) summary.configuration_name = record.configurationName;
  if (record.workspaceFolder !== undefined) summary.workspace_folder = record.workspaceFolder;
  if (record.lastStop !== undefined) {
    summary.last_stop = {
      reason: record.lastStop.reason,
      thread_id: record.lastStop.threadId,
      description: record.lastStop.description,
      text: record.lastStop.text,
      at: toIso(record.lastStop.at),
    };
  }
  if (record.exitCode !== undefined) summary.exit_code = record.exitCode;
  const filters = record.capabilities?.exceptionBreakpointFilters;
  if (filters !== undefined && filters.length > 0) {
    summary.exception_breakpoint_filters = filters.map((f) => ({
      filter: f.filter,
      label: f.label,
      ...(f.default === undefined ? {} : { default: f.default }),
      ...(f.description === undefined ? {} : { description: f.description }),
    }));
  }
  return summary;
};

const toFrameView = (frame: DapStackFrame): FrameView => {
  const view: FrameView = { frame_id: frame.id, name: frame.name };
  const file = frame.source?.path ?? frame.source?.name;
  if (file !== undefined) view.file = file;
  if (frame.line !== undefined) view.line = frame.line;
  if (frame.column !== undefined) view.column = frame.column;
  if (frame.presentationHint !== undefined) view.presentation_hint = frame.presentationHint;
  return view;
};

const toBreakpointView = (bp: HostBreakpoint): BreakpointView => {
  const view: BreakpointView = { id: bp.id, kind: bp.kind, enabled: bp.enabled };
  if (bp.file !== undefined) view.file = bp.file;
  if (bp.line !== undefined) view.line = bp.line;
  if (bp.column !== undefined) view.column = bp.column;
  if (bp.functionName !== undefined) view.function_name = bp.functionName;
  if (bp.condition !== undefined) view.condition = bp.condition;
  if (bp.hitCondition !== undefined) view.hit_condition = bp.hitCondition;
  if (bp.logMessage !== undefined) view.log_message = bp.logMessage;
  return view;
};

const sameFile = (a: string, b: string): boolean => {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
};

export class DebugController {
  private serverInfoProvider: () => Record<string, unknown> = () => ({});
  private readonly redactions: RedactionRef[] = [];
  private nextRedactionId = 1;

  constructor(
    private readonly host: DebugHost,
    private readonly state: DebugState,
    private readonly options: ControllerOptions,
    private readonly log: Logger,
  ) {}

  setServerInfoProvider(provider: () => Record<string, unknown>): void {
    this.serverInfoProvider = provider;
  }

  // ---------------------------------------------------------------- sessions

  async listConfigurations(input: { workspace_folder?: string }): Promise<Result<unknown>> {
    try {
      const configurations = await this.host.listLaunchConfigurations(input.workspace_folder);
      return ok({
        workspace_folders: this.host.workspaceFolders(),
        configurations: configurations.map((c) => ({
          name: c.name,
          type: c.type,
          request: c.request,
          source: c.source,
          folder: c.folder,
          hidden: c.hidden ?? false,
        })),
        limitations: [
          "Configurations from .vscode/mcp-launch.json are started as inline objects; the others are started by name through VS Code.",
        ],
      });
    } catch (cause) {
      return failFromUnknown("host_error", cause);
    }
  }

  async startDebugging(input: {
    configuration_name?: string;
    configuration?: Record<string, unknown>;
    workspace_folder?: string;
    wait_for_stop_seconds?: number;
  }): Promise<Result<StopReport>> {
    if (input.configuration_name === undefined && input.configuration === undefined) {
      return fail("invalid_input", "Provide configuration_name or an inline configuration.", {
        remediation: "Call list_debug_configurations to see the names available in this workspace.",
      });
    }
    let target: string | Record<string, unknown>;
    let configurations: LaunchConfigurationInfo[] = [];
    try {
      configurations = await this.host.listLaunchConfigurations(input.workspace_folder);
    } catch (cause) {
      this.log.warn("Could not list launch configurations", cause);
    }
    if (input.configuration !== undefined) {
      const inline = input.configuration;
      if (typeof inline.type !== "string" || typeof inline.request !== "string") {
        return fail("invalid_input", "An inline configuration needs string 'type' and 'request' fields.");
      }
      target = { name: "MCP inline launch", ...inline };
    } else {
      const name = input.configuration_name as string;
      const fromMcpFile = configurations.find((c) => c.source === "mcp-launch.json" && c.name === name);
      const fromVsCode = configurations.find((c) => c.source !== "mcp-launch.json" && c.name === name);
      if (fromMcpFile !== undefined) {
        target = { ...fromMcpFile.configuration, name };
      } else if (fromVsCode !== undefined || configurations.length === 0) {
        target = name;
      } else {
        return fail("not_found", `No launch configuration named '${name}'.`, {
          details: { available: configurations.map((c) => c.name) },
          remediation: "Use one of the available names or pass an inline configuration.",
        });
      }
    }
    const startSeq = this.state.currentSeq();
    const startedAt = Date.now();
    let started: boolean;
    try {
      started = await this.host.startDebugging(input.workspace_folder, target);
    } catch (cause) {
      return failFromUnknown("host_error", cause, { target: typeof target === "string" ? target : target.name });
    }
    if (!started) {
      return fail("host_error", "VS Code declined to start the debug session.", {
        details: { target: typeof target === "string" ? target : target.name },
        remediation:
          "Check the configuration's type is provided by an installed debugger extension, and look at any preLaunchTask output in the terminal or the Debug Console.",
      });
    }
    const waitMs = input.wait_for_stop_seconds === undefined ? this.options.startWaitMs : input.wait_for_stop_seconds * 1000;
    const event = await this.waitForEvent({ afterSeq: startSeq, timeoutMs: waitMs });
    const report = await this.buildStopReport(event, startSeq, startedAt, []);
    if (report.outcome === "timeout") {
      report.outcome = "running";
      const started = this.state.listSessions().filter((s) => s.startedAt >= startedAt);
      if (started.length > 0) report.session = summarizeSession(started[started.length - 1] as SessionRecord, true);
      report.limitations.push(
        `No stop within ${Math.round(waitMs / 1000)}s. The program is running; set breakpoints and call wait_for_stop, or pause.`,
      );
    }
    return ok(report);
  }

  async stopDebugging(input: { session_id?: string; all?: boolean }): Promise<Result<unknown>> {
    const startSeq = this.state.currentSeq();
    const live = this.state.listSessions();
    if (live.length === 0) return fail("no_session", "No live debug session.");
    try {
      if (input.all) {
        await this.host.stopDebugging(undefined);
      } else {
        const session = this.resolveSession(input.session_id);
        if (!session.ok) return session;
        // Stop the root of the tree so parent and children all end.
        const root = this.rootOf(session.value);
        await this.host.stopDebugging(root.id);
      }
    } catch (cause) {
      return failFromUnknown("host_error", cause);
    }
    await this.waitForEvent({ afterSeq: startSeq, timeoutMs: 10_000, kinds: ["terminated"] });
    return ok({
      stopped: true,
      remaining_sessions: this.state.listSessions().map((s) => summarizeSession(s, true)),
    });
  }

  async restartDebugging(input: { session_id?: string; timeout_seconds?: number }): Promise<Result<StopReport>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    const startSeq = this.state.currentSeq();
    const startedAt = Date.now();
    const limitations: string[] = [];
    try {
      if (session.value.capabilities?.supportsRestartRequest) {
        await this.host.customRequest(session.value.id, "restart", {});
      } else {
        await this.host.restartActiveSession();
        limitations.push("Adapter has no restart request; VS Code's restart command was used on the active session.");
      }
    } catch (cause) {
      return failFromUnknown("host_error", cause);
    }
    const event = await this.waitForEvent({
      afterSeq: startSeq,
      timeoutMs: input.timeout_seconds === undefined ? this.options.startWaitMs : input.timeout_seconds * 1000,
    });
    const report = await this.buildStopReport(event, startSeq, startedAt, limitations);
    if (report.outcome === "timeout") report.outcome = "running";
    return ok(report);
  }

  async getDebugState(): Promise<Result<unknown>> {
    const sessions = this.state.listSessions();
    const selected = this.resolveSession(undefined);
    const active = this.host.activeStackItem();
    const breakpoints = this.host.listBreakpoints();
    const tail = this.scopedOutput(undefined, undefined, false).entries.slice(-20);
    return ok({
      server: this.serverInfoProvider(),
      workspace_folders: this.host.workspaceFolders(),
      sessions: sessions.map((s) => summarizeSession(s)),
      selected_session_id: selected.ok ? selected.value.id : undefined,
      active_stack_item: active,
      breakpoints: {
        count: breakpoints.length,
        items: breakpoints.slice(0, 50).map(toBreakpointView),
      },
      output_tail: tail.map(toOutputLine),
      last_event_seq: this.state.currentSeq(),
      mutation_allowed: this.options.allowMutation,
      limitations: sessions.length === 0 ? ["No live debug session. Use start_debugging or start one in VS Code."] : [],
    });
  }

  async waitForStop(input: { session_id?: string; timeout_seconds?: number }): Promise<Result<StopReport>> {
    const startSeq = this.state.currentSeq();
    const startedAt = Date.now();
    let sessionId: string | undefined;
    if (input.session_id !== undefined) {
      const session = this.resolveSession(input.session_id);
      if (!session.ok) return session;
      sessionId = session.value.id;
    }
    const alreadyStopped = sessionId === undefined ? this.state.lastStoppedSession() : this.state.getSession(sessionId);
    if (alreadyStopped?.status === "stopped" && alreadyStopped.lastStop !== undefined) {
      const report = await this.describeStopped(alreadyStopped, startSeq, startedAt, [
        "Session was already stopped when wait_for_stop was called.",
      ]);
      return ok(report);
    }
    if (this.state.listSessions().length === 0) {
      return fail("no_session", "No live debug session to wait on.", {
        remediation: "Start one with start_debugging or in VS Code first.",
      });
    }
    const event = await this.waitForEvent({
      sessionId,
      afterSeq: startSeq,
      timeoutMs: this.timeoutMs(input.timeout_seconds),
    });
    return ok(await this.buildStopReport(event, startSeq, startedAt, []));
  }

  // --------------------------------------------------------------- execution

  async execute(
    command: "continue" | "next" | "stepIn" | "stepOut",
    input: { session_id?: string; thread_id?: number; timeout_seconds?: number; granularity?: string },
  ): Promise<Result<StopReport>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.status !== "stopped") {
      return fail("not_stopped", `Session '${session.value.name}' is ${session.value.status}; ${command} needs a stopped session.`, {
        remediation: "Use wait_for_stop to wait for a breakpoint, or pause to interrupt it.",
      });
    }
    const thread = await this.resolveThread(session.value, input.thread_id);
    if (!thread.ok) return thread;
    const startSeq = this.state.currentSeq();
    const startedAt = Date.now();
    const args: Record<string, unknown> = { threadId: thread.value };
    if (command !== "continue" && input.granularity !== undefined) args.granularity = input.granularity;
    try {
      await this.host.customRequest(session.value.id, command, args);
    } catch (cause) {
      return failFromUnknown("dap_error", cause, { command, thread_id: thread.value });
    }
    const event = await this.waitForEvent({
      sessionId: session.value.id,
      afterSeq: startSeq,
      timeoutMs: this.timeoutMs(input.timeout_seconds),
    });
    return ok(await this.buildStopReport(event, startSeq, startedAt, []));
  }

  async pause(input: { session_id?: string; thread_id?: number; timeout_seconds?: number }): Promise<Result<StopReport>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.status === "stopped") {
      return ok(await this.describeStopped(session.value, this.state.currentSeq(), Date.now(), ["Session was already stopped."]));
    }
    if (session.value.status === "terminated") return fail("no_session", "Session has terminated.");
    let threadId = input.thread_id ?? session.value.threadIds[0];
    if (threadId === undefined) {
      const threads = await this.dap<{ threads?: DapThread[] }>(session.value.id, "threads", {});
      if (!threads.ok) return threads;
      threadId = threads.value.threads?.[0]?.id;
    }
    if (threadId === undefined) return fail("dap_error", "No thread available to pause.");
    const startSeq = this.state.currentSeq();
    const startedAt = Date.now();
    try {
      await this.host.customRequest(session.value.id, "pause", { threadId });
    } catch (cause) {
      return failFromUnknown("dap_error", cause, { command: "pause", thread_id: threadId });
    }
    const event = await this.waitForEvent({
      sessionId: session.value.id,
      afterSeq: startSeq,
      timeoutMs: Math.min(this.timeoutMs(input.timeout_seconds), 15_000),
    });
    return ok(await this.buildStopReport(event, startSeq, startedAt, []));
  }

  async runToLine(input: {
    file: string;
    line: number;
    session_id?: string;
    thread_id?: number;
    timeout_seconds?: number;
  }): Promise<Result<StopReport>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.status !== "stopped") {
      return fail("not_stopped", "run_to_line needs a stopped session.");
    }
    const file = this.host.resolvePath(input.file);
    const existing = this.host
      .listBreakpoints()
      .find((bp) => bp.kind === "source" && bp.file !== undefined && sameFile(bp.file, file) && bp.line === input.line);
    const temporary = existing === undefined ? this.host.addSourceBreakpoint({ file, line: input.line }) : undefined;
    try {
      const result = await this.execute("continue", {
        session_id: session.value.id,
        thread_id: input.thread_id,
        timeout_seconds: input.timeout_seconds,
      });
      if (result.ok && temporary !== undefined) {
        result.value.limitations.push(`Temporary breakpoint at ${file}:${input.line} was removed after the run.`);
      }
      return result;
    } finally {
      if (temporary !== undefined) this.host.removeBreakpoints([temporary.id]);
    }
  }

  // ------------------------------------------------------------- breakpoints

  async setBreakpoint(input: {
    file: string;
    line: number;
    column?: number;
    condition?: string;
    hit_condition?: string;
    log_message?: string;
  }): Promise<Result<BreakpointView>> {
    const file = this.host.resolvePath(input.file);
    const sourceLines = this.host.readSourceLines(file);
    if (sourceLines !== undefined && input.line > sourceLines.length) {
      return fail("invalid_input", `Line ${input.line} is past the end of ${file.split(/[\\/]/).pop()} (${sourceLines.length} lines).`, {
        remediation: `Choose a line from 1 to ${sourceLines.length}.`,
      });
    }
    const duplicates = this.host
      .listBreakpoints()
      .filter((bp) => bp.kind === "source" && bp.file !== undefined && sameFile(bp.file, file) && bp.line === input.line);
    if (duplicates.length > 0) this.host.removeBreakpoints(duplicates.map((bp) => bp.id));
    let created: HostBreakpoint;
    try {
      created = this.host.addSourceBreakpoint({
        file,
        line: input.line,
        column: input.column,
        condition: input.condition,
        hitCondition: input.hit_condition,
        logMessage: input.log_message,
      });
    } catch (cause) {
      return failFromUnknown("host_error", cause, { file, line: input.line });
    }
    const view = toBreakpointView(created);
    await this.attachVerification(view);
    return ok(view);
  }

  async setFunctionBreakpoint(input: {
    function_name: string;
    condition?: string;
    hit_condition?: string;
  }): Promise<Result<BreakpointView>> {
    try {
      const created = this.host.addFunctionBreakpoint({
        functionName: input.function_name,
        condition: input.condition,
        hitCondition: input.hit_condition,
      });
      const view = toBreakpointView(created);
      await this.attachVerification(view);
      return ok(view);
    } catch (cause) {
      return failFromUnknown("host_error", cause);
    }
  }

  async removeBreakpoint(input: { id?: string; file?: string; line?: number }): Promise<Result<unknown>> {
    const all = this.host.listBreakpoints();
    let targets: HostBreakpoint[];
    if (input.id !== undefined) {
      targets = all.filter((bp) => bp.id === input.id);
    } else if (input.file !== undefined && input.line !== undefined) {
      const file = this.host.resolvePath(input.file);
      targets = all.filter((bp) => bp.file !== undefined && sameFile(bp.file, file) && bp.line === input.line);
    } else {
      return fail("invalid_input", "Provide id, or file and line.");
    }
    if (targets.length === 0) return fail("not_found", "No matching breakpoint.");
    const removed = this.host.removeBreakpoints(targets.map((bp) => bp.id));
    return ok({ removed, remaining: this.host.listBreakpoints().length });
  }

  async clearBreakpoints(input: { file?: string }): Promise<Result<unknown>> {
    const all = this.host.listBreakpoints();
    const targets =
      input.file === undefined
        ? all
        : all.filter((bp) => bp.file !== undefined && sameFile(bp.file, this.host.resolvePath(input.file as string)));
    const removed = this.host.removeBreakpoints(targets.map((bp) => bp.id));
    return ok({ removed, remaining: this.host.listBreakpoints().length });
  }

  async listBreakpoints(input: { include_verification?: boolean }): Promise<Result<unknown>> {
    const views = this.host.listBreakpoints().map(toBreakpointView);
    const limitations: string[] = [];
    if (input.include_verification !== false) {
      const session = this.resolveSession(undefined);
      if (session.ok) {
        for (const view of views.slice(0, 50)) await this.attachVerification(view, session.value.id);
        if (views.length > 50) limitations.push("Verification state fetched for the first 50 breakpoints only.");
      } else {
        limitations.push("No live session, so verification state is unavailable.");
      }
    }
    limitations.push("Exception breakpoints are not listed; VS Code exposes no API for them.");
    return ok({ breakpoints: views, limitations });
  }

  async setExceptionBreakpoints(input: { filters: string[]; session_id?: string }): Promise<Result<unknown>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    const available = session.value.capabilities?.exceptionBreakpointFilters?.map((f) => f.filter) ?? [];
    const unknown = input.filters.filter((f) => available.length > 0 && !available.includes(f));
    if (unknown.length > 0) {
      return fail("invalid_input", `Unknown exception filters: ${unknown.join(", ")}`, {
        details: { available },
      });
    }
    const result = await this.dap<unknown>(session.value.id, "setExceptionBreakpoints", { filters: input.filters });
    if (!result.ok) return result;
    return ok({
      applied: input.filters,
      available,
      limitations: [
        "The Breakpoints view checkboxes will not reflect this change, and VS Code resends its own exception settings when any breakpoint changes or the session restarts.",
      ],
    });
  }

  // -------------------------------------------------------------- inspection

  async getThreads(input: { session_id?: string }): Promise<Result<unknown>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    const threads = await this.dap<{ threads?: DapThread[] }>(session.value.id, "threads", {});
    if (!threads.ok) return threads;
    return ok({
      session: summarizeSession(session.value, true),
      threads: threads.value.threads ?? [],
      stopped_thread_id: session.value.lastStop?.threadId,
    });
  }

  async getStackTrace(input: {
    session_id?: string;
    thread_id?: number;
    start_frame?: number;
    levels?: number;
  }): Promise<Result<unknown>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.status !== "stopped") {
      return fail("not_stopped", "Stack traces are only available while the session is stopped.");
    }
    const thread = await this.resolveThread(session.value, input.thread_id);
    if (!thread.ok) return thread;
    const levels = input.levels ?? 20;
    const result = await this.dap<{ stackFrames?: DapStackFrame[]; totalFrames?: number }>(session.value.id, "stackTrace", {
      threadId: thread.value,
      startFrame: input.start_frame ?? 0,
      levels,
    });
    if (!result.ok) return result;
    const frames = (result.value.stackFrames ?? []).map(toFrameView);
    if ((input.start_frame ?? 0) === 0) this.attachSourceLine(frames);
    return ok({
      session_id: session.value.id,
      thread_id: thread.value,
      frames,
      total_frames: result.value.totalFrames,
      truncated: result.value.totalFrames !== undefined && (input.start_frame ?? 0) + frames.length < result.value.totalFrames,
    });
  }

  async getScopes(input: { session_id?: string; thread_id?: number; frame_id?: number }): Promise<Result<unknown>> {
    const located = await this.resolveFrame(input);
    if (!located.ok) return located;
    const scopes = await this.dap<{ scopes?: DapScope[] }>(located.value.session.id, "scopes", { frameId: located.value.frameId });
    if (!scopes.ok) return scopes;
    return ok({
      session_id: located.value.session.id,
      thread_id: located.value.threadId,
      frame_id: located.value.frameId,
      scopes: (scopes.value.scopes ?? []).map((s) => ({
        name: s.name,
        variables_reference: s.variablesReference,
        expensive: s.expensive ?? false,
        named_variables: s.namedVariables,
        indexed_variables: s.indexedVariables,
        presentation_hint: s.presentationHint,
      })),
    });
  }

  async getVariables(input: {
    session_id?: string;
    variables_reference?: number;
    thread_id?: number;
    frame_id?: number;
    scope?: string;
    start?: number;
    count?: number;
    depth?: number;
    max_value_length?: number;
    filter?: "named" | "indexed";
  }): Promise<Result<unknown>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.status !== "stopped") {
      return fail("not_stopped", "Variables are only available while the session is stopped.");
    }
    const limitations: string[] = [];
    let reference = input.variables_reference;
    let scopeName: string | undefined;
    if (reference === undefined) {
      const located = await this.resolveFrame({ session_id: session.value.id, thread_id: input.thread_id, frame_id: input.frame_id });
      if (!located.ok) return located;
      const scopes = await this.dap<{ scopes?: DapScope[] }>(session.value.id, "scopes", { frameId: located.value.frameId });
      if (!scopes.ok) return scopes;
      const all = scopes.value.scopes ?? [];
      const wanted = input.scope?.toLowerCase();
      const chosen =
        wanted === undefined
          ? (all.find((s) => !s.expensive) ?? all[0])
          : all.find((s) => s.name.toLowerCase() === wanted || s.presentationHint?.toLowerCase() === wanted);
      if (chosen === undefined) {
        return fail("not_found", `No scope matching '${input.scope ?? "<default>"}'.`, {
          details: { available: all.map((s) => s.name) },
        });
      }
      reference = chosen.variablesReference;
      scopeName = chosen.name;
      if (wanted === undefined && all.length > 1) {
        limitations.push(`Showing scope '${chosen.name}'; other scopes: ${all.filter((s) => s !== chosen).map((s) => s.name).join(", ")}.`);
      }
    }
    const count = Math.min(Math.max(input.count ?? 50, 1), 200);
    const depth = Math.min(Math.max(input.depth ?? 0, 0), 2);
    const maxValueLength = Math.min(Math.max(input.max_value_length ?? 200, 20), 4000);
    const page = await this.fetchVariables(session.value.id, reference, {
      start: input.start ?? 0,
      count,
      depth,
      maxValueLength,
      filter: input.filter,
    });
    if (!page.ok) return page;
    if (page.value.variables.some((v) => hasElision(v.value))) limitations.push(ELISION_HINT);
    return ok({
      session_id: session.value.id,
      scope: scopeName,
      variables_reference: reference,
      start: input.start ?? 0,
      count: page.value.variables.length,
      has_more: page.value.hasMore,
      variables: page.value.variables,
      limitations,
    });
  }

  async evaluate(input: {
    expression: string;
    session_id?: string;
    thread_id?: number;
    frame_id?: number;
    context?: "watch" | "repl" | "hover" | "clipboard";
    max_value_length?: number;
  }): Promise<Result<unknown>> {
    const context = input.context ?? (this.options.allowMutation ? "repl" : "watch");
    if (!this.options.allowMutation && context === "repl") {
      return fail("forbidden", "Mutation is disabled; evaluate only with context 'watch' or 'hover'.", {
        remediation: "Enable vscodeDebuggerMcp.allowMutation to run side-effecting expressions.",
      });
    }
    if (!this.options.allowMutation) {
      const effect = findSideEffect(input.expression);
      if (effect !== undefined) {
        return fail("forbidden", `Mutation is disabled and the expression contains ${effect}.`, {
          remediation:
            "With mutation off only names, attributes, subscripts, arithmetic and len/repr/str/type/int/float/bool/abs/min/max/sum/round/isinstance are evaluated. Use get_variables to read containers, or enable vscodeDebuggerMcp.allowMutation.",
        });
      }
    }
    const located = await this.resolveFrame(input);
    if (!located.ok) return located;
    const result = await this.dap<{
      result: string;
      type?: string;
      variablesReference: number;
      namedVariables?: number;
      indexedVariables?: number;
      presentationHint?: { kind?: string };
    }>(located.value.session.id, "evaluate", {
      expression: input.expression,
      frameId: located.value.frameId,
      context,
    });
    if (!result.ok) return result;
    const maxValueLength = Math.min(Math.max(input.max_value_length ?? 1000, 20), 20_000);
    const named = this.options.redactSecrets && expressionMentionsSecret(input.expression);
    const rawText = result.value.result ?? "";
    const masked = this.options.redactSecrets && !named ? redactValuePatterns(rawText) : { value: rawText, redacted: false };
    const hidden = named || masked.redacted;
    const bounded = named ? { text: REDACTED, truncated: false } : truncateText(masked.value, maxValueLength);
    const limitations: string[] = [];
    if (hidden) {
      this.noteRedaction({
        tool: "evaluate",
        sessionId: located.value.session.id,
        label: input.expression,
        frameId: located.value.frameId,
        expression: input.expression,
      });
    }
    if (named) {
      limitations.push(
        "Result hidden: the expression names a credential-looking identifier (matched by name only). Disable vscodeDebuggerMcp.redactSecrets to see values.",
      );
    } else {
      if (masked.redacted) limitations.push("Credential-shaped text in the result was masked.");
      if (hasElision(bounded.text)) limitations.push(ELISION_HINT);
    }
    return ok({
      session_id: located.value.session.id,
      frame_id: located.value.frameId,
      expression: input.expression,
      context,
      result: bounded.text,
      truncated: bounded.truncated,
      type: result.value.type,
      // A hidden result must not be browsable through its children either.
      variables_reference: hidden ? 0 : result.value.variablesReference,
      child_count: hidden ? undefined : (result.value.namedVariables ?? 0) + (result.value.indexedVariables ?? 0) || undefined,
      ...(hidden ? { redacted: true } : {}),
      limitations,
    });
  }

  async setVariable(input: {
    variables_reference: number;
    name: string;
    value: string;
    session_id?: string;
  }): Promise<Result<unknown>> {
    if (!this.options.allowMutation) {
      return fail("forbidden", "Mutation is disabled by vscodeDebuggerMcp.allowMutation.");
    }
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.capabilities?.supportsSetVariable === false) {
      return fail("unsupported", "This debug adapter does not support setVariable.");
    }
    const limitations: string[] = [
      "The VS Code Variables panel caches scopes per frame and keeps showing the old value until the next step or stop; the debuggee already has the new value.",
    ];
    const before = await this.dap<{ variables?: DapVariable[] }>(session.value.id, "variables", {
      variablesReference: input.variables_reference,
    });
    const previous = before.ok ? before.value.variables?.find((v) => v.name === input.name) : undefined;
    const result = await this.dap<{ value: string; type?: string; variablesReference?: number }>(session.value.id, "setVariable", {
      variablesReference: input.variables_reference,
      name: input.name,
      value: input.value,
    });
    if (!result.ok) return result;
    const redact = this.options.redactSecrets ? redactVariable : (_name: string, value: string) => ({ value, redacted: false });
    const previousView = previous === undefined ? undefined : redact(input.name, previous.value);
    if (previous === undefined) limitations.push("The previous value could not be read before the change.");
    return ok({
      name: input.name,
      value: result.value.value,
      type: result.value.type,
      previous_value: previousView?.value,
      previous_type: previous?.type,
      limitations,
    });
  }

  async getExceptionInfo(input: { session_id?: string; thread_id?: number }): Promise<Result<unknown>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.capabilities?.supportsExceptionInfoRequest === false) {
      return fail("unsupported", "This debug adapter does not support exceptionInfo.", {
        details: { last_stop: session.value.lastStop },
      });
    }
    const thread = await this.resolveThread(session.value, input.thread_id);
    if (!thread.ok) return thread;
    const info = await this.dap<unknown>(session.value.id, "exceptionInfo", { threadId: thread.value });
    if (!info.ok) return info;
    return ok({ session_id: session.value.id, thread_id: thread.value, exception: info.value, last_stop: session.value.lastStop });
  }

  async getDebugOutput(input: {
    since_seq?: number;
    limit?: number;
    category?: string;
    session_id?: string;
    all_sessions?: boolean;
  }): Promise<Result<unknown>> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const scoped = this.scopedOutput(input.session_id, input.since_seq, input.all_sessions === true, input.category);
    let entries: OutputEntry[] = scoped.entries;
    const truncated = entries.length > limit;
    const page = truncated ? entries.slice(-limit) : entries;
    const oldest = this.state.output.oldestSeq();
    const limitations: string[] = [];
    if (scoped.otherSessions > 0) {
      limitations.push(`Showing output of the current session only; ${scoped.otherSessions} entries from other sessions were left out (pass all_sessions to include them).`);
    }
    if (truncated) limitations.push(`Returned the latest ${limit} of ${entries.length} matching entries.`);
    if (input.since_seq !== undefined && oldest !== undefined && input.since_seq < oldest - 1) {
      limitations.push("Some entries before since_seq were discarded from the bounded buffer.");
    }
    return ok({
      entries: page.map(toOutputLine),
      last_seq: this.state.currentSeq(),
      limitations,
    });
  }

  // ----------------------------------------------------------------- helpers

  private timeoutMs(seconds: number | undefined): number {
    return seconds === undefined ? this.options.defaultTimeoutMs : Math.max(0.05, seconds) * 1000;
  }

  private rootOf(session: SessionRecord): SessionRecord {
    let current = session;
    const seen = new Set<string>();
    while (current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.state.getSession(current.parentId);
      if (parent === undefined || parent.status === "terminated") break;
      current = parent;
    }
    return current;
  }

  /** Pick the session a tool should act on when the agent did not say. */
  resolveSession(sessionId: string | undefined): Result<SessionRecord> {
    if (sessionId !== undefined) {
      const record = this.state.getSession(sessionId);
      if (record === undefined || record.status === "terminated") {
        return fail("not_found", `No live session with id '${sessionId}'.`, {
          details: { live_sessions: this.state.listSessions().map((s) => ({ id: s.id, name: s.name, status: s.status })) },
        });
      }
      return ok(record);
    }
    const stopped = this.state.lastStoppedSession();
    if (stopped !== undefined) return ok(stopped);
    const activeId = this.host.activeSessionId();
    if (activeId !== undefined) {
      const active = this.state.getSession(activeId);
      if (active !== undefined && active.status !== "terminated") {
        const stoppedChild = this.state.children(active.id).find((c) => c.status === "stopped");
        return ok(stoppedChild ?? active);
      }
    }
    const leaves = this.state.leafSessions();
    if (leaves.length === 1) return ok(leaves[0] as SessionRecord);
    if (leaves.length > 1) {
      return fail("invalid_input", "Several live sessions; pass session_id.", {
        details: { live_sessions: leaves.map((s) => ({ id: s.id, name: s.name, status: s.status })) },
      });
    }
    return fail("no_session", "No live debug session.", {
      remediation: "Call start_debugging with a configuration name, or start debugging in VS Code.",
    });
  }

  private async resolveThread(session: SessionRecord, threadId: number | undefined): Promise<Result<number>> {
    if (threadId !== undefined) return ok(threadId);
    if (session.lastStop?.threadId !== undefined) return ok(session.lastStop.threadId);
    const active = this.host.activeStackItem();
    if (active !== undefined && active.sessionId === session.id) return ok(active.threadId);
    const threads = await this.dap<{ threads?: DapThread[] }>(session.id, "threads", {});
    if (!threads.ok) return threads;
    const first = threads.value.threads?.[0];
    if (first === undefined) return fail("dap_error", "The adapter reported no threads.");
    return ok(first.id);
  }

  private async resolveFrame(input: {
    session_id?: string;
    thread_id?: number;
    frame_id?: number;
  }): Promise<Result<{ session: SessionRecord; threadId: number; frameId: number }>> {
    const session = this.resolveSession(input.session_id);
    if (!session.ok) return session;
    if (session.value.status !== "stopped") {
      return fail("not_stopped", "Frame-scoped requests need a stopped session.", {
        remediation: "Use wait_for_stop or pause first.",
      });
    }
    const thread = await this.resolveThread(session.value, input.thread_id);
    if (!thread.ok) return thread;
    if (input.frame_id !== undefined) return ok({ session: session.value, threadId: thread.value, frameId: input.frame_id });
    const active = this.host.activeStackItem();
    if (active?.frameId !== undefined && active.sessionId === session.value.id && active.threadId === thread.value) {
      return ok({ session: session.value, threadId: thread.value, frameId: active.frameId });
    }
    const top = await this.dap<{ stackFrames?: DapStackFrame[] }>(session.value.id, "stackTrace", {
      threadId: thread.value,
      startFrame: 0,
      levels: 1,
    });
    if (!top.ok) return top;
    const frame = top.value.stackFrames?.[0];
    if (frame === undefined) return fail("dap_error", "No stack frame available for the selected thread.");
    return ok({ session: session.value, threadId: thread.value, frameId: frame.id });
  }

  private async dap<T>(sessionId: string, command: string, args: unknown): Promise<Result<T>> {
    try {
      const response = await this.host.customRequest(sessionId, command, args);
      return ok((response ?? {}) as T);
    } catch (cause) {
      return failFromUnknown("dap_error", cause, { command, session_id: sessionId });
    }
  }

  private async attachVerification(view: BreakpointView, sessionId?: string): Promise<void> {
    const id = sessionId ?? (() => {
      const session = this.resolveSession(undefined);
      return session.ok ? session.value.id : undefined;
    })();
    if (id === undefined) return;
    try {
      const verification = await this.host.verifyBreakpoint(id, view.id);
      if (verification === undefined) return;
      view.verified = verification.verified;
      if (verification.message !== undefined) view.verification_message = verification.message;
      if (verification.line !== undefined && verification.line !== view.line) view.adapter_line = verification.line;
      if (verification.dapId !== undefined) view.dap_id = verification.dapId;
    } catch (cause) {
      this.log.debug("Breakpoint verification failed", cause);
    }
  }

  private async fetchVariables(
    sessionId: string,
    reference: number,
    options: { start: number; count: number; depth: number; maxValueLength: number; filter?: "named" | "indexed" },
  ): Promise<Result<{ variables: VariableView[]; hasMore: boolean }>> {
    const args: Record<string, unknown> = { variablesReference: reference, start: options.start, count: options.count + 1 };
    if (options.filter !== undefined) args.filter = options.filter;
    const result = await this.dap<{ variables?: DapVariable[] }>(sessionId, "variables", args);
    if (!result.ok) return result;
    const raw = result.value.variables ?? [];
    const hasMore = raw.length > options.count;
    const page = hasMore ? raw.slice(0, options.count) : raw;
    const redact = this.options.redactSecrets ? redactVariable : (_name: string, value: string) => ({ value, redacted: false });
    const views: VariableView[] = [];
    for (const variable of page) {
      const view = shapeVariable(variable, { maxValueLength: options.maxValueLength, redact });
      if (view.redacted) {
        this.noteRedaction({ tool: "get_variables", sessionId, label: variable.name, reference, name: variable.name });
      }
      if (options.depth > 0 && variable.variablesReference > 0 && !view.redacted) {
        const children = await this.fetchVariables(sessionId, variable.variablesReference, {
          start: 0,
          count: Math.min(options.count, 25),
          depth: options.depth - 1,
          maxValueLength: options.maxValueLength,
        });
        if (children.ok) {
          view.children = children.value.variables;
          if (children.value.hasMore) view.children_truncated = true;
        }
      }
      views.push(view);
    }
    return ok({ variables: views, hasMore });
  }

  private waitForEvent(filter: {
    sessionId?: string;
    afterSeq: number;
    timeoutMs: number;
    kinds?: StateEvent["kind"][];
  }): Promise<StateEvent | undefined> {
    const kinds = filter.kinds ?? ["stopped", "terminated", "exited"];
    const matches = (event: StateEvent): boolean =>
      kinds.includes(event.kind) &&
      event.seq > filter.afterSeq &&
      (filter.sessionId === undefined || this.state.isSameOrDescendant(event.sessionId, filter.sessionId));
    const already = this.state.events.since(filter.afterSeq).find(matches);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve) => {
      let unsubscribe: () => void = () => undefined;
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(undefined);
      }, filter.timeoutMs);
      unsubscribe = this.state.subscribe((event) => {
        if (!matches(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  private async buildStopReport(
    event: StateEvent | undefined,
    startSeq: number,
    startedAt: number,
    limitations: string[],
  ): Promise<StopReport> {
    if (event === undefined) {
      return {
        outcome: "timeout",
        ...this.outputSince(startSeq),
        elapsed_ms: Date.now() - startedAt,
        limitations: [...limitations, "No stop, exit or termination arrived before the timeout."],
      };
    }
    const session = this.state.getSession(event.sessionId);
    if (event.kind === "stopped" && session !== undefined) {
      return this.describeStopped(session, startSeq, startedAt, limitations);
    }
    const report: StopReport = {
      outcome: event.kind === "exited" ? "exited" : "terminated",
      ...this.outputSince(startSeq),
      elapsed_ms: Date.now() - startedAt,
      limitations,
    };
    if (session !== undefined) {
      report.session = summarizeSession(session, true);
      if (session.exitCode !== undefined) report.exit_code = session.exitCode;
    }
    return report;
  }

  private async describeStopped(
    session: SessionRecord,
    startSeq: number,
    startedAt: number,
    limitations: string[],
  ): Promise<StopReport> {
    const stop = session.lastStop;
    const report: StopReport = {
      outcome: "stopped",
      session: summarizeSession(session, true),
      ...this.outputSince(startSeq),
      elapsed_ms: Date.now() - startedAt,
      limitations: [...limitations],
    };
    if (stop === undefined) return report;
    report.reason = stop.reason;
    if (stop.description !== undefined) report.description = stop.description;
    if (stop.text !== undefined) report.text = stop.text;
    if (stop.threadId !== undefined) report.thread_id = stop.threadId;
    if (stop.allThreadsStopped !== undefined) report.all_threads_stopped = stop.allThreadsStopped;
    const threadId = stop.threadId ?? session.threadIds[0];
    if (threadId !== undefined) {
      const frames = await this.dap<{ stackFrames?: DapStackFrame[]; totalFrames?: number }>(session.id, "stackTrace", {
        threadId,
        startFrame: 0,
        levels: this.options.maxReportFrames,
      });
      if (frames.ok) {
        report.frames = (frames.value.stackFrames ?? []).map(toFrameView);
        for (const frame of report.frames) delete frame.column;
        this.attachSourceLine(report.frames);
        const total = frames.value.totalFrames;
        if (total !== undefined && total > report.frames.length) {
          report.limitations.push(`Showing ${report.frames.length} of ${total} frames; use get_stack_trace for more.`);
        }
      } else {
        report.limitations.push(`Stack trace unavailable: ${frames.error.message}`);
      }
      if (stop.reason === "exception" && session.capabilities?.supportsExceptionInfoRequest !== false) {
        const info = await this.dap<unknown>(session.id, "exceptionInfo", { threadId });
        if (info.ok) report.exception = info.value;
      }
    } else {
      report.limitations.push("Stopped event carried no threadId; call get_threads then get_stack_trace.");
    }
    if (stop.hitBreakpointIds !== undefined && stop.hitBreakpointIds.length > 0) {
      report.hit_breakpoints = await this.mapHitBreakpoints(session.id, stop.hitBreakpointIds);
    } else if (stop.reason === "breakpoint") {
      // Some adapters (debugpy) omit hitBreakpointIds; infer from the top frame.
      const top = report.frames?.[0];
      if (top?.file !== undefined && top.line !== undefined) {
        const matches = this.host
          .listBreakpoints()
          .filter((bp) => bp.kind === "source" && bp.file !== undefined && sameFile(bp.file, top.file as string) && bp.line === top.line);
        if (matches.length > 0) {
          report.hit_breakpoints = matches.map((bp) => ({ dap_id: -1, breakpoint_id: bp.id, file: bp.file, line: bp.line }));
          report.limitations.push("hit_breakpoints inferred from the top frame location; the adapter sent no hitBreakpointIds.");
        }
      }
    }
    return report;
  }

  private async mapHitBreakpoints(
    sessionId: string,
    dapIds: readonly number[],
  ): Promise<Array<{ dap_id: number; breakpoint_id?: string; file?: string; line?: number }>> {
    const byDapId = new Map<number, HostBreakpoint>();
    const candidates = this.host.listBreakpoints().filter((bp) => bp.kind !== "other").slice(0, 50);
    for (const bp of candidates) {
      try {
        const verification = await this.host.verifyBreakpoint(sessionId, bp.id);
        if (verification?.dapId !== undefined) byDapId.set(verification.dapId, bp);
      } catch {
        // Mapping is best effort.
      }
    }
    return dapIds.map((dapId) => {
      const bp = byDapId.get(dapId);
      return bp === undefined
        ? { dap_id: dapId }
        : { dap_id: dapId, breakpoint_id: bp.id, file: bp.file, line: bp.line };
    });
  }

  // ------------------------------------------------- reveal (user only, not a tool)

  private noteRedaction(ref: Omit<RedactionRef, "id" | "at">): void {
    const key = (r: Omit<RedactionRef, "id" | "at">): string =>
      `${r.sessionId}|${r.tool}|${r.reference ?? ""}|${r.name ?? ""}|${r.frameId ?? ""}|${r.expression ?? ""}`;
    const existing = this.redactions.findIndex((r) => key(r) === key(ref));
    if (existing !== -1) this.redactions.splice(existing, 1);
    this.redactions.push({ ...ref, id: this.nextRedactionId++, at: Date.now() });
    if (this.redactions.length > 50) this.redactions.splice(0, this.redactions.length - 50);
  }

  /** What was hidden from the agent recently, newest first. Names and locations only, never values. */
  listRedactions(): readonly RedactionRef[] {
    return [...this.redactions].reverse();
  }

  /**
   * Fetch the real value of something hidden from the agent, for the person at the keyboard. Deliberately not
   * exposed as an MCP tool: an agent able to call it would make redaction meaningless.
   */
  async revealRedaction(id: number): Promise<Result<{ label: string; value: string }>> {
    const ref = this.redactions.find((r) => r.id === id);
    if (ref === undefined) return fail("not_found", "That redaction is no longer tracked.");
    const session = this.state.getSession(ref.sessionId);
    if (session === undefined || session.status === "terminated") {
      return fail("no_session", "The session that produced this value has ended.");
    }
    if (ref.tool === "get_variables" && ref.reference !== undefined && ref.name !== undefined) {
      const result = await this.dap<{ variables?: DapVariable[] }>(ref.sessionId, "variables", { variablesReference: ref.reference });
      if (!result.ok) return result;
      const found = result.value.variables?.find((v) => v.name === ref.name);
      if (found === undefined) {
        return fail("not_found", `'${ref.name}' is no longer in that scope; the program has moved on.`);
      }
      return ok({ label: ref.label, value: found.value });
    }
    if (ref.tool === "evaluate" && ref.expression !== undefined) {
      const effect = findSideEffect(ref.expression);
      if (effect !== undefined) {
        return fail("forbidden", `Not re-evaluated: the expression contains ${effect}, and revealing must not run it again.`);
      }
      const result = await this.dap<{ result?: string }>(ref.sessionId, "evaluate", {
        expression: ref.expression,
        frameId: ref.frameId,
        context: "watch",
      });
      if (!result.ok) return result;
      return ok({ label: ref.label, value: result.value.result ?? "" });
    }
    return fail("unsupported", "This redaction cannot be revealed.");
  }

  /** Source text of the top frame, so a step answer says what line it landed on. */
  private attachSourceLine(frames: FrameView[]): void {
    const top = frames[0];
    if (top?.file === undefined || top.line === undefined) return;
    const text = this.host.readSourceLines(top.file)?.[top.line - 1];
    if (text === undefined) return;
    const shown = this.options.redactSecrets ? redactSourceLine(text.trim()) : text.trim();
    top.source_line = truncateText(shown, 200).text;
  }

  private currentSessionId(): string | undefined {
    const selected = this.resolveSession(undefined);
    if (selected.ok) return selected.value.id;
    const all = this.state.listSessions({ includeTerminated: true });
    return all.sort((a, b) => b.startedAt - a.startedAt)[0]?.id;
  }

  /** Output without telemetry, limited to the current session tree unless told otherwise. */
  private scopedOutput(
    sessionId: string | undefined,
    sinceSeq: number | undefined,
    allSessions: boolean,
    category?: string,
  ): { entries: OutputEntry[]; otherSessions: number } {
    let entries: OutputEntry[] = sinceSeq === undefined ? [...this.state.output.all()] : this.state.output.since(sinceSeq);
    entries = category === undefined ? entries.filter((e) => e.category !== "telemetry") : entries.filter((e) => e.category === category);
    if (sessionId !== undefined) return { entries: entries.filter((e) => e.sessionId === sessionId), otherSessions: 0 };
    if (allSessions) return { entries, otherSessions: 0 };
    const current = this.currentSessionId();
    const root = current === undefined ? undefined : this.state.getSession(current);
    if (root === undefined) return { entries, otherSessions: 0 };
    const rootId = this.rootOf(root).id;
    const mine = entries.filter((e) => e.sessionId === undefined || this.state.isSameOrDescendant(e.sessionId, rootId));
    return { entries: mine, otherSessions: entries.length - mine.length };
  }

  private outputSince(seq: number): { output: OutputLine[]; output_truncated: boolean } {
    const entries = this.state.output.since(seq).filter((entry) => entry.category !== "telemetry");
    const limit = this.options.maxReportOutputLines;
    const truncated = entries.length > limit;
    return {
      output: (truncated ? entries.slice(-limit) : entries).map(toOutputLine),
      output_truncated: truncated,
    };
  }
}

const hasElision = (text: string): boolean => /\[\.\.\.\]|\{\.\.\.\}|\(\.\.\.\)/.test(text);

const ELISION_HINT =
  "Some adapters (debugpy) show values nested more than two levels deep as [...]. Evaluate repr(x) to read one, or page get_variables with its variables_reference.";

const toOutputLine = (entry: OutputEntry): OutputLine => ({
  seq: entry.seq,
  category: entry.category,
  text: entry.text,
});

export const isPlainObject = isRecord;
