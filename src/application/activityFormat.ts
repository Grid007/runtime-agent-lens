import type { Result } from "../domain/result.js";

type Rec = Record<string, unknown>;

export interface ActivityDescription {
  /** Human-readable lines describing what the agent received. */
  readonly summary: readonly string[];
  /** One line echoed to the Debug Console, for calls that drive or change the session. */
  readonly consoleLine?: string;
}

const EXECUTION_TOOLS = new Set([
  "start_debugging",
  "restart_debugging",
  "stop_debugging",
  "continue",
  "step_over",
  "step_into",
  "step_out",
  "pause",
  "run_to_line",
  "wait_for_stop",
]);
const BREAKPOINT_TOOLS = new Set([
  "set_breakpoint",
  "set_function_breakpoint",
  "remove_breakpoint",
  "clear_breakpoints",
  "set_exception_breakpoints",
]);

const asRec = (v: unknown): Rec | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined);
const asList = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(asRec).filter((r): r is Rec => r !== undefined) : []);
const asText = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export const short = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export const shortArgs = (args: unknown, max = 120): string => {
  const record = asRec(args);
  if (record === undefined || Object.keys(record).length === 0) return "";
  return short(JSON.stringify(record), max);
};

const frameText = (frame: Rec): string =>
  `${asText(frame.name) ?? "?"} ${baseName(asText(frame.file) ?? "?")}:${asText(frame.line) ?? "?"}`;

const describeVariables = (value: Rec): ActivityDescription => {
  const variables = asList(value.variables);
  const scope = asText(value.scope);
  const width = Math.min(24, Math.max(4, ...variables.map((v) => (asText(v.name) ?? "").length)));
  const hidden: string[] = [];
  const lines = variables.map((v) => {
    const name = asText(v.name) ?? "?";
    if (v.redacted === true) {
      hidden.push(name);
      return `${name.padEnd(width)} = [REDACTED]   (hidden from the agent by name; the VS Code panel still shows the real value)`;
    }
    const type = asText(v.type);
    return `${name.padEnd(width)} = ${short(asText(v.value) ?? "", 100)}${type === undefined ? "" : `   : ${type}`}`;
  });
  const heading = `${scope ?? "variables"} (${variables.length}${value.has_more === true ? "+" : ""})`;
  return {
    summary: [heading, ...lines.map((l) => `  ${l}`)],
    consoleLine: hidden.length > 0 ? `get_variables: ${hidden.length} value(s) hidden from the agent (${hidden.join(", ")})` : undefined,
  };
};

const describeSetVariable = (value: Rec): ActivityDescription => {
  const name = asText(value.name) ?? "?";
  const before = asText(value.previous_value) ?? "?";
  const after = asText(value.value) ?? "?";
  const beforeType = asText(value.previous_type);
  const afterType = asText(value.type);
  const typeNote = beforeType !== undefined && afterType !== undefined && beforeType !== afterType ? `  (${beforeType} → ${afterType})` : "";
  return {
    summary: [
      `${name}: ${before} → ${after}${typeNote}`,
      "The debuggee has the new value. The Variables panel is cached by VS Code and updates on the next step or stop.",
    ],
    consoleLine: `set_variable ${name}: ${short(before, 40)} → ${short(after, 40)}  (Variables panel updates on the next step)`,
  };
};

const describeEvaluate = (value: Rec): ActivityDescription => {
  const expression = asText(value.expression) ?? "?";
  const result = asText(value.result) ?? "";
  const context = asText(value.context) ?? "watch";
  return {
    summary: [`${expression} = ${short(result, 160)}   [${context}]`],
    consoleLine: `evaluate (${context}) ${short(expression, 60)} → ${short(result, 60)}`,
  };
};

const describeExecution = (tool: string, value: Rec): ActivityDescription => {
  const outcome = asText(value.outcome) ?? "?";
  const frames = asList(value.frames);
  const hits = asList(value.hit_breakpoints);
  const reason = asText(value.reason);
  const lines = [`outcome: ${outcome}${reason === undefined ? "" : ` (${reason})`}`];
  if (frames[0] !== undefined) lines.push(`at: ${frameText(frames[0])}`);
  if (hits.length > 0) {
    lines.push(`breakpoints hit: ${hits.map((h) => `${baseName(asText(h.file) ?? "?")}:${asText(h.line) ?? "?"}`).join(", ")}`);
  }
  if (value.exit_code !== undefined) lines.push(`exit code: ${asText(value.exit_code)}`);
  const output = asList(value.output);
  if (output.length > 0) lines.push(`program output: ${output.length} line(s)`);
  let consoleLine = `${tool} → ${outcome}`;
  if (frames[0] !== undefined) consoleLine += ` at ${frameText(frames[0])}`;
  else if (value.exit_code !== undefined) consoleLine += ` (exit ${asText(value.exit_code)})`;
  return { summary: lines, consoleLine };
};

const describeStack = (value: Rec): ActivityDescription => {
  const frames = asList(value.frames);
  return { summary: frames.map((f, i) => `${i === 0 ? "▶" : " "} #${i} ${frameText(f)}`) };
};

const describeBreakpoint = (tool: string, args: unknown, value: Rec): ActivityDescription => {
  const file = asText(value.file);
  const removed = asText(value.removed);
  let detail: string;
  if (removed !== undefined) detail = `removed ${removed}, remaining ${asText(value.remaining) ?? "?"}`;
  else if (file !== undefined) detail = `${baseName(file)}:${asText(value.line) ?? "?"}`;
  else detail = shortArgs(args, 80);
  return { summary: [detail], consoleLine: `${tool} ${detail}` };
};

/** Describe a tool result the way a person debugging would want to read it. Never throws. */
export const describeResult = (tool: string, args: unknown, result: Result<unknown>): ActivityDescription => {
  if (!result.ok) {
    const lines = [`${result.error.code}: ${result.error.message}`];
    if (result.error.remediation !== undefined) lines.push(`remediation: ${result.error.remediation}`);
    return { summary: lines, consoleLine: `${tool} failed: ${result.error.code}` };
  }
  const value = asRec(result.value);
  if (value === undefined) return { summary: [] };
  try {
    switch (tool) {
      case "get_variables":
        return describeVariables(value);
      case "set_variable":
        return describeSetVariable(value);
      case "evaluate":
        return describeEvaluate(value);
      case "get_stack_trace":
        return describeStack(value);
      default:
        if (EXECUTION_TOOLS.has(tool)) return describeExecution(tool, value);
        if (BREAKPOINT_TOOLS.has(tool)) return describeBreakpoint(tool, args, value);
        return { summary: [] };
    }
  } catch {
    return { summary: [] };
  }
};
