import { z } from "zod";

/**
 * Tool contracts: one zod input schema, description and annotations per tool.
 * Descriptions are terse and behavioural; workflow guidance lives in the
 * bundled skill (skills/vscode-debugging/SKILL.md), following REA and
 * DebugMCP. Nothing here imports vscode or the SDK.
 */

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolContract<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodObject<Shape>;
  readonly annotations: ToolAnnotations;
}

const readOnly: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const controlling: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const sessionId = z.string().optional().describe("Session id; default the stopped or active one.");
const threadId = z.number().int().optional().describe("Thread id; default the one that stopped.");
const frameId = z.number().int().optional().describe("Frame id; default the top frame.");
const timeoutSeconds = z.number().positive().optional().describe("Seconds to wait for the next stop.");
const filePath = z.string().min(1).describe("Absolute, or relative to the first workspace folder.");
const line = z.number().int().positive().describe("1-based line number.");

const define = <Shape extends z.ZodRawShape>(contract: ToolContract<Shape>): ToolContract<Shape> => contract;

export const toolContracts = {
  list_debug_configurations: define({
    title: "List debug configurations",
    description:
      "List launch configurations the agent can start by name: .vscode/mcp-launch.json entries (started as inline objects), plus launch.json, workspace and user configurations.",
    input: z.object({
      workspace_folder: z.string().optional().describe("Workspace folder path or name. Defaults to the first folder."),
    }),
    annotations: readOnly,
  }),
  start_debugging: define({
    title: "Start debugging",
    description:
      "Start a debug session by configuration name or inline configuration, then wait briefly for an initial stop. Returns outcome stopped (with frames), running, terminated or exited.",
    input: z.object({
      configuration_name: z.string().optional().describe("Name from list_debug_configurations."),
      configuration: z.record(z.string(), z.unknown()).optional().describe("Inline DebugConfiguration with at least type and request."),
      workspace_folder: z.string().optional(),
      wait_for_stop_seconds: z.number().min(0).optional().describe("How long to wait for a first stop (default from settings, 5s)."),
    }),
    annotations: controlling,
  }),
  stop_debugging: define({
    title: "Stop debugging",
    description: "Stop the selected session tree, or all sessions.",
    input: z.object({ session_id: sessionId, all: z.boolean().optional() }),
    annotations: destructive,
  }),
  restart_debugging: define({
    title: "Restart debugging",
    description: "Restart the selected session and wait briefly for an initial stop.",
    input: z.object({ session_id: sessionId, timeout_seconds: timeoutSeconds }),
    annotations: controlling,
  }),
  get_debug_state: define({
    title: "Get debug state",
    description:
      "Snapshot of live sessions, their last stop, exception filters, the selected session, active stack item, breakpoints and recent output. Cheap; call before acting.",
    input: z.object({}),
    annotations: readOnly,
  }),
  wait_for_stop: define({
    title: "Wait for stop",
    description:
      "Block until the selected session stops, exits or terminates, then return the stop report. Use after the user triggers the code path (e.g. an HTTP request).",
    input: z.object({ session_id: sessionId, timeout_seconds: timeoutSeconds }),
    annotations: readOnly,
  }),
  continue: define({
    title: "Continue",
    description: "Resume the stopped thread and wait for the next stop. Returns reason, hit breakpoints, frames and output since.",
    input: z.object({ session_id: sessionId, thread_id: threadId, timeout_seconds: timeoutSeconds }),
    annotations: controlling,
  }),
  step_over: define({
    title: "Step over",
    description: "Execute the next line without entering calls, then report the new location.",
    input: z.object({
      session_id: sessionId,
      thread_id: threadId,
      timeout_seconds: timeoutSeconds,
      granularity: z.enum(["statement", "line", "instruction"]).optional(),
    }),
    annotations: controlling,
  }),
  step_into: define({
    title: "Step into",
    description: "Step into the call on the current line, then report the new location.",
    input: z.object({
      session_id: sessionId,
      thread_id: threadId,
      timeout_seconds: timeoutSeconds,
      granularity: z.enum(["statement", "line", "instruction"]).optional(),
    }),
    annotations: controlling,
  }),
  step_out: define({
    title: "Step out",
    description: "Run until the current function returns, then report the new location.",
    input: z.object({
      session_id: sessionId,
      thread_id: threadId,
      timeout_seconds: timeoutSeconds,
      granularity: z.enum(["statement", "line", "instruction"]).optional(),
    }),
    annotations: controlling,
  }),
  pause: define({
    title: "Pause",
    description: "Interrupt a running session and report where it stopped.",
    input: z.object({ session_id: sessionId, thread_id: threadId, timeout_seconds: timeoutSeconds }),
    annotations: controlling,
  }),
  run_to_line: define({
    title: "Run to line",
    description: "Continue until the given file and line is reached (temporary breakpoint), then report.",
    input: z.object({ file: filePath, line, session_id: sessionId, thread_id: threadId, timeout_seconds: timeoutSeconds }),
    annotations: controlling,
  }),
  set_breakpoint: define({
    title: "Set breakpoint",
    description:
      "Add or replace a source breakpoint. Optional condition, hit_condition, or log_message (logpoint). Returns the breakpoint id and, when a session is live, whether the adapter verified it.",
    input: z.object({
      file: filePath,
      line,
      column: z.number().int().positive().optional(),
      condition: z.string().optional(),
      hit_condition: z.string().optional().describe("e.g. '>= 3' or '5'"),
      log_message: z.string().optional().describe("Log instead of pausing; {expr} is interpolated."),
    }),
    annotations: controlling,
  }),
  set_function_breakpoint: define({
    title: "Set function breakpoint",
    description: "Add a breakpoint on a function name (adapter support varies).",
    input: z.object({ function_name: z.string().min(1), condition: z.string().optional(), hit_condition: z.string().optional() }),
    annotations: controlling,
  }),
  remove_breakpoint: define({
    title: "Remove breakpoint",
    description: "Remove a breakpoint by id, or by file and line.",
    input: z.object({ id: z.string().optional(), file: z.string().optional(), line: z.number().int().positive().optional() }),
    annotations: controlling,
  }),
  clear_breakpoints: define({
    title: "Clear breakpoints",
    description: "Remove all breakpoints, or all in one file. Includes breakpoints the user set by hand.",
    input: z.object({ file: z.string().optional() }),
    annotations: destructive,
  }),
  list_breakpoints: define({
    title: "List breakpoints",
    description: "List source and function breakpoints with their verification state when a session is live.",
    input: z.object({ include_verification: z.boolean().optional() }),
    annotations: readOnly,
  }),
  set_exception_breakpoints: define({
    title: "Set exception breakpoints",
    description:
      "Send DAP setExceptionBreakpoints with the given filter ids (see exception_breakpoint_filters in get_debug_state). The VS Code UI does not reflect this.",
    input: z.object({ filters: z.array(z.string()), session_id: sessionId }),
    annotations: controlling,
  }),
  get_threads: define({
    title: "Get threads",
    description: "List threads of the selected session.",
    input: z.object({ session_id: sessionId }),
    annotations: readOnly,
  }),
  get_stack_trace: define({
    title: "Get stack trace",
    description: "Stack frames for a thread of a stopped session, paged with start_frame and levels.",
    input: z.object({
      session_id: sessionId,
      thread_id: threadId,
      start_frame: z.number().int().min(0).optional(),
      levels: z.number().int().positive().max(200).optional().describe("Default 20."),
    }),
    annotations: readOnly,
  }),
  get_scopes: define({
    title: "Get scopes",
    description: "Variable scopes (Locals, Globals, ...) of a frame with their variables_reference.",
    input: z.object({ session_id: sessionId, thread_id: threadId, frame_id: frameId }),
    annotations: readOnly,
  }),
  get_variables: define({
    title: "Get variables",
    description:
      "Variables of a scope or container. Without variables_reference, uses the first non-expensive scope (Locals) of the selected frame. Paged, value-length bounded, secrets redacted by name, optional nested depth up to 2.",
    input: z.object({
      session_id: sessionId,
      variables_reference: z.number().int().positive().optional(),
      thread_id: threadId,
      frame_id: frameId,
      scope: z.string().optional().describe("Scope name to use when variables_reference is omitted, e.g. 'Locals' or 'Globals'."),
      start: z.number().int().min(0).optional(),
      count: z.number().int().positive().max(200).optional().describe("Default 50."),
      depth: z.number().int().min(0).max(2).optional().describe("Expand children this deep (default 0)."),
      max_value_length: z.number().int().min(20).max(4000).optional().describe("Default 200."),
      filter: z.enum(["named", "indexed"]).optional(),
    }),
    annotations: readOnly,
  }),
  evaluate: define({
    title: "Evaluate expression",
    description:
      "Evaluate an expression in a frame. With allowMutation off, calls and assignments are refused (heuristic guard, not a sandbox). Results naming credentials or containing credential-shaped text are hidden or masked.",
    input: z.object({
      expression: z.string().min(1),
      session_id: sessionId,
      thread_id: threadId,
      frame_id: frameId,
      context: z.enum(["watch", "repl", "hover", "clipboard"]).optional(),
      max_value_length: z.number().int().min(20).max(20000).optional().describe("Default 1000."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }),
  set_variable: define({
    title: "Set variable",
    description: "Assign a new value to a variable inside the given container (variables_reference). Requires allowMutation.",
    input: z.object({ variables_reference: z.number().int().positive(), name: z.string().min(1), value: z.string(), session_id: sessionId }),
    annotations: destructive,
  }),
  get_exception_info: define({
    title: "Get exception info",
    description: "Details of the exception that stopped the thread (exceptionInfo request).",
    input: z.object({ session_id: sessionId, thread_id: threadId }),
    annotations: readOnly,
  }),
  get_debug_output: define({
    title: "Get debug output",
    description: "Output (stdout, stderr, console) of the current session from a bounded buffer; telemetry is left out. Use since_seq from a previous result to page.",
    input: z.object({
      since_seq: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(1000).optional().describe("Default 100."),
      category: z.string().optional().describe("stdout, stderr, console, important, telemetry ..."),
      session_id: sessionId,
      all_sessions: z.boolean().optional().describe("Include output of earlier sessions. Default: current session only."),
    }),
    annotations: readOnly,
  }),
} as const;

export type ToolName = keyof typeof toolContracts;
export type ToolInput<Name extends ToolName> = z.infer<(typeof toolContracts)[Name]["input"]>;

export const toolNames = Object.keys(toolContracts) as ToolName[];
