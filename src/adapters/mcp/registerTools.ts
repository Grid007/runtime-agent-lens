import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolContracts, type ToolInput, type ToolName } from "../../contracts/toolContracts.js";
import type { DebugController } from "../../application/debugController.js";
import type { Result } from "../../domain/result.js";
import type { Logger } from "../../logging.js";

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

/** Sees every tool call and exactly the text the agent receives. Must never throw into the call path. */
export interface ToolObserver {
  onCall(event: { id: number; tool: string; args: unknown }): void;
  onResult(event: {
    id: number;
    tool: string;
    args: unknown;
    ok: boolean;
    ms: number;
    /** The exact text delivered to the agent (already redacted). */
    text: string;
    result: Result<unknown>;
  }): void;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
let nextCallId = 1;

const encodeResult = (result: Result<unknown>): CallToolResult => {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
    };
  }
  const value = result.value;
  let text = JSON.stringify(value) ?? "null";
  if (text.length > MAX_TEXT_BYTES) {
    text = JSON.stringify(
      {
        error: {
          code: "resource_constraint",
          message: `Result of ${text.length} bytes exceeds the ${MAX_TEXT_BYTES} byte response budget.`,
          remediation: "Request fewer items (count, levels, limit) or a smaller max_value_length.",
        },
      },
    );
    return { isError: true, content: [{ type: "text", text }] };
  }
  const structured =
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { content: [{ type: "text", text }], structuredContent: structured };
};

/** Create one McpServer bound to the shared controller (one per MCP client session). */
export const createMcpServer = (
  controller: DebugController,
  info: ServerInfo,
  log: Logger,
  observer?: ToolObserver,
): McpServer => {
  const observe = (fn: (o: ToolObserver) => void): void => {
    if (observer === undefined) return;
    try {
      fn(observer);
    } catch (cause) {
      log.warn("tool observer failed", cause);
    }
  };

  const server = new McpServer(
    { name: info.name, version: info.version },
    {
      instructions:
        "Tools drive the live VS Code debugger. Call get_debug_state first, set breakpoints, then start_debugging or wait_for_stop; execution tools block until the next stop and return frames. Read limitations in every result.",
    },
  );

  const register = <Name extends ToolName>(
    name: Name,
    handler: (input: ToolInput<Name>) => Promise<Result<unknown>>,
  ): void => {
    const contract = toolContracts[name];
    server.registerTool(
      name,
      {
        title: contract.title,
        description: contract.description,
        inputSchema: contract.input.shape,
        annotations: contract.annotations,
      },
      async (args: unknown): Promise<CallToolResult> => {
        const started = Date.now();
        const id = nextCallId++;
        observe((o) => o.onCall({ id, tool: name, args }));
        const finish = (result: Result<unknown>): CallToolResult => {
          const encoded = encodeResult(result);
          const first = encoded.content[0];
          const text = first !== undefined && first.type === "text" ? first.text : "";
          observe((o) => o.onResult({ id, tool: name, args, ok: !encoded.isError, ms: Date.now() - started, text, result }));
          return encoded;
        };
        const parsed = contract.input.safeParse(args ?? {});
        if (!parsed.success) {
          return finish({
            ok: false,
            error: { code: "invalid_input", message: parsed.error.message, details: { issues: parsed.error.issues } },
          });
        }
        try {
          const result = await handler(parsed.data as ToolInput<Name>);
          log.info(`tool ${name} ${result.ok ? "ok" : result.error.code} in ${Date.now() - started}ms`);
          return finish(result);
        } catch (cause) {
          log.error(`tool ${name} threw`, cause);
          return finish({
            ok: false,
            error: { code: "host_error", message: cause instanceof Error ? cause.message : String(cause) },
          });
        }
      },
    );
  };

  register("list_debug_configurations", (input) => controller.listConfigurations(input));
  register("start_debugging", (input) => controller.startDebugging(input));
  register("stop_debugging", (input) => controller.stopDebugging(input));
  register("restart_debugging", (input) => controller.restartDebugging(input));
  register("get_debug_state", () => controller.getDebugState());
  register("wait_for_stop", (input) => controller.waitForStop(input));
  register("continue", (input) => controller.execute("continue", input));
  register("step_over", (input) => controller.execute("next", input));
  register("step_into", (input) => controller.execute("stepIn", input));
  register("step_out", (input) => controller.execute("stepOut", input));
  register("pause", (input) => controller.pause(input));
  register("run_to_line", (input) => controller.runToLine(input));
  register("set_breakpoint", (input) => controller.setBreakpoint(input));
  register("set_function_breakpoint", (input) => controller.setFunctionBreakpoint(input));
  register("remove_breakpoint", (input) => controller.removeBreakpoint(input));
  register("clear_breakpoints", (input) => controller.clearBreakpoints(input));
  register("list_breakpoints", (input) => controller.listBreakpoints(input));
  register("set_exception_breakpoints", (input) => controller.setExceptionBreakpoints(input));
  register("get_threads", (input) => controller.getThreads(input));
  register("get_stack_trace", (input) => controller.getStackTrace(input));
  register("get_scopes", (input) => controller.getScopes(input));
  register("get_variables", (input) => controller.getVariables(input));
  register("evaluate", (input) => controller.evaluate(input));
  register("set_variable", (input) => controller.setVariable(input));
  register("get_exception_info", (input) => controller.getExceptionInfo(input));
  register("get_debug_output", (input) => controller.getDebugOutput(input));

  return server;
};
