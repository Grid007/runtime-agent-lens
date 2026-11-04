import { describe, expect, it } from "vitest";

import { DebugController, type StopReport } from "../src/application/debugController.js";
import type {
  ActiveStackItem,
  BreakpointVerification,
  DebugHost,
  FunctionBreakpointSpec,
  HostBreakpoint,
  LaunchConfigurationInfo,
  SourceBreakpointSpec,
  WorkspaceFolderInfo,
} from "../src/application/ports.js";
import { DebugState, type SessionInfo } from "../src/domain/debugState.js";
import { noopLogger } from "../src/logging.js";

/** In-memory host that simulates a debug adapter replying to DAP requests. */
class FakeHost implements DebugHost {
  readonly requests: Array<{ sessionId: string; command: string; args: unknown }> = [];
  breakpoints: HostBreakpoint[] = [];
  active: string | undefined;
  stackItem: ActiveStackItem | undefined;
  private nextBreakpointId = 1;
  startResult = true;
  configurations: LaunchConfigurationInfo[] = [];

  constructor(private readonly state: DebugState) {}

  workspaceFolders(): WorkspaceFolderInfo[] {
    return [{ name: "fixture", path: "/work/fixture" }];
  }
  async listLaunchConfigurations(): Promise<LaunchConfigurationInfo[]> {
    return this.configurations;
  }
  async startDebugging(_folder: string | undefined, nameOrConfiguration: string | Record<string, unknown>): Promise<boolean> {
    if (!this.startResult) return false;
    const name = typeof nameOrConfiguration === "string" ? nameOrConfiguration : String(nameOrConfiguration.name);
    setTimeout(() => {
      this.state.sessionStarted({ id: "new", name, type: "debugpy", configurationName: name });
      this.state.recordDapMessage("new", "adapter", { type: "event", event: "initialized" });
      this.state.recordDapMessage("new", "adapter", {
        type: "event",
        event: "output",
        body: { category: "stdout", output: "starting\n" },
      });
      this.state.recordDapMessage("new", "adapter", {
        type: "event",
        event: "stopped",
        body: { reason: "entry", threadId: 1 },
      });
    }, 5);
    return true;
  }
  async stopDebugging(sessionId?: string): Promise<void> {
    const ids = sessionId === undefined ? this.state.listSessions().map((s) => s.id) : [sessionId];
    setTimeout(() => {
      for (const id of ids) this.state.recordDapMessage(id, "adapter", { type: "event", event: "terminated" });
    }, 5);
  }
  async restartActiveSession(): Promise<void> {}
  hasSession(sessionId: string): boolean {
    return this.state.getSession(sessionId) !== undefined;
  }
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.state.getSession(sessionId);
  }
  activeSessionId(): string | undefined {
    return this.active;
  }
  activeStackItem(): ActiveStackItem | undefined {
    return this.stackItem;
  }
  async customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown> {
    this.requests.push({ sessionId, command, args });
    switch (command) {
      case "next":
      case "stepIn":
      case "stepOut":
        setTimeout(() => {
          this.state.recordDapMessage(sessionId, "adapter", { type: "event", event: "continued", body: { threadId: 1 } });
          this.state.recordDapMessage(sessionId, "adapter", {
            type: "event",
            event: "stopped",
            body: { reason: "step", threadId: 1, allThreadsStopped: true },
          });
        }, 5);
        return {};
      case "continue":
        // Never stops again: lets tests exercise the timeout path.
        this.state.recordDapMessage(sessionId, "adapter", { type: "event", event: "continued", body: { threadId: 1 } });
        return { allThreadsContinued: true };
      case "threads":
        return { threads: [{ id: 1, name: "MainThread" }] };
      case "stackTrace":
        return {
          stackFrames: [
            { id: 100, name: "average_item_price", source: { path: "/work/fixture/app.py" }, line: 13, column: 5 },
            { id: 101, name: "main", source: { path: "/work/fixture/app.py" }, line: 24, column: 9 },
          ],
          totalFrames: 2,
        };
      case "scopes":
        return {
          scopes: [
            { name: "Locals", variablesReference: 500, expensive: false },
            { name: "Globals", variablesReference: 501, expensive: true },
          ],
        };
      case "variables": {
        const request = args as { variablesReference: number; start?: number; count?: number };
        if (request.variablesReference === 500) {
          const all = [
            { name: "count", value: "0", type: "int", variablesReference: 0 },
            { name: "api_key", value: "sk-live-123", type: "str", variablesReference: 0 },
            { name: "items", value: "[]", type: "list", variablesReference: 600, indexedVariables: 0 },
            { name: "total", value: "0.0", type: "float", variablesReference: 0 },
          ];
          const start = request.start ?? 0;
          const count = request.count ?? all.length;
          return { variables: all.slice(start, start + count) };
        }
        return { variables: [] };
      }
      case "evaluate":
        return { result: "ZeroDivisionError('division by zero')", type: "ZeroDivisionError", variablesReference: 0 };
      case "setVariable": {
        const request = args as { value: string };
        return { value: request.value, type: "int" };
      }
      default:
        throw new Error(`unsupported fake request ${command}`);
    }
  }
  listBreakpoints(): HostBreakpoint[] {
    return [...this.breakpoints];
  }
  addSourceBreakpoint(spec: SourceBreakpointSpec): HostBreakpoint {
    const bp: HostBreakpoint = {
      id: `bp${this.nextBreakpointId++}`,
      kind: "source",
      enabled: true,
      file: spec.file,
      line: spec.line,
      ...(spec.condition === undefined ? {} : { condition: spec.condition }),
    };
    this.breakpoints.push(bp);
    return bp;
  }
  addFunctionBreakpoint(spec: FunctionBreakpointSpec): HostBreakpoint {
    const bp: HostBreakpoint = { id: `bp${this.nextBreakpointId++}`, kind: "function", enabled: true, functionName: spec.functionName };
    this.breakpoints.push(bp);
    return bp;
  }
  removeBreakpoints(ids: readonly string[]): number {
    const before = this.breakpoints.length;
    this.breakpoints = this.breakpoints.filter((bp) => !ids.includes(bp.id));
    return before - this.breakpoints.length;
  }
  async verifyBreakpoint(_sessionId: string, breakpointId: string): Promise<BreakpointVerification | undefined> {
    const index = this.breakpoints.findIndex((bp) => bp.id === breakpointId);
    return index === -1 ? undefined : { verified: true, dapId: index + 1 };
  }
  resolvePath(file: string): string {
    return file.startsWith("/") ? file : `/work/fixture/${file}`;
  }
  sources = new Map<string, string[]>();
  readSourceLines(file: string): readonly string[] | undefined {
    return this.sources.get(file);
  }
}

const setup = () => {
  const state = new DebugState();
  const host = new FakeHost(state);
  const controller = new DebugController(
    host,
    state,
    {
      defaultTimeoutMs: 500,
      startWaitMs: 200,
      allowMutation: true,
      redactSecrets: true,
      maxReportFrames: 10,
      maxReportOutputLines: 40,
    },
    noopLogger,
  );
  return { state, host, controller };
};

const stopSession = (state: DebugState, id: string, threadId = 1) => {
  state.sessionStarted({ id, name: id, type: "debugpy" });
  state.recordDapMessage(id, "adapter", { type: "event", event: "initialized" });
  state.recordDapMessage(id, "adapter", { type: "event", event: "stopped", body: { reason: "breakpoint", threadId, hitBreakpointIds: [1] } });
};

const expectOk = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

describe("DebugController execution", () => {
  it("step_over blocks until the next stop and returns frames", async () => {
    const { state, host, controller } = setup();
    stopSession(state, "s1");
    const report = expectOk(await controller.execute("next", {}));
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("step");
    expect(report.thread_id).toBe(1);
    expect(report.frames?.[0]?.name).toBe("average_item_price");
    expect(report.frames?.[0]?.line).toBe(13);
    expect(host.requests.map((r) => r.command)).toEqual(["next", "stackTrace"]);
  });

  it("refuses to step a running session with a remediation", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    state.recordDapMessage("s1", "adapter", { type: "event", event: "continued", body: { threadId: 1 } });
    const result = await controller.execute("next", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_stopped");
      expect(result.error.remediation).toContain("wait_for_stop");
    }
  });

  it("continue reports a timeout outcome when nothing stops in time", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const report = expectOk(await controller.execute("continue", { timeout_seconds: 0.05 }));
    expect(report.outcome).toBe("timeout");
    expect(report.limitations.join(" ")).toContain("timeout");
  });

  it("maps hit breakpoints back to the editor breakpoints", async () => {
    const { state, host, controller } = setup();
    host.addSourceBreakpoint({ file: "/work/fixture/app.py", line: 13 });
    stopSession(state, "s1");
    const report = expectOk(await controller.waitForStop({}));
    expect(report.outcome).toBe("stopped");
    expect(report.hit_breakpoints?.[0]).toMatchObject({ dap_id: 1, breakpoint_id: "bp1", line: 13 });
  });

  it("start_debugging waits for the first stop and includes output since start", async () => {
    const { controller } = setup();
    const report: StopReport = expectOk(await controller.startDebugging({ configuration_name: "mcp: python app" }));
    expect(report.outcome).toBe("stopped");
    expect(report.reason).toBe("entry");
    expect(report.session?.name).toBe("mcp: python app");
    expect(report.output.map((o) => o.text)).toEqual(["starting\n"]);
  });

  it("start_debugging rejects unknown names when configurations are known", async () => {
    const { host, controller } = setup();
    host.configurations = [{ name: "real", source: "launch.json", configuration: { name: "real" } }];
    const result = await controller.startDebugging({ configuration_name: "typo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.available).toEqual(["real"]);
  });

  it("starts mcp-launch.json entries as inline objects", async () => {
    const { host, controller } = setup();
    host.configurations = [
      { name: "agent", source: "mcp-launch.json", configuration: { name: "agent", type: "debugpy", request: "launch", program: "x.py" } },
    ];
    const spy: unknown[] = [];
    const original = host.startDebugging.bind(host);
    host.startDebugging = async (folder, target) => {
      spy.push(target);
      return original(folder, target);
    };
    expectOk(await controller.startDebugging({ configuration_name: "agent" }));
    expect(typeof spy[0]).toBe("object");
    expect((spy[0] as Record<string, unknown>).program).toBe("x.py");
  });
});

describe("DebugController selection", () => {
  it("prefers the stopped child session over the active parent (js-debug)", async () => {
    const { state, host, controller } = setup();
    state.sessionStarted({ id: "parent", name: "node", type: "pwa-node" });
    state.recordDapMessage("parent", "adapter", { type: "event", event: "initialized" });
    state.sessionStarted({ id: "child", name: "node [1]", type: "pwa-node", parentId: "parent" });
    state.recordDapMessage("child", "adapter", { type: "event", event: "initialized" });
    state.recordDapMessage("child", "adapter", { type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 3 } });
    host.active = "parent";
    const selected = controller.resolveSession(undefined);
    expect(selected.ok && selected.value.id).toBe("child");
    const threads = expectOk(await controller.getThreads({}));
    expect((threads as { session: { id: string } }).session.id).toBe("child");
  });

  it("reports no_session with a remediation when nothing is live", async () => {
    const { controller } = setup();
    const result = await controller.getStackTrace({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_session");
  });

  it("wait_for_stop returns immediately when already stopped", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const started = Date.now();
    const report = expectOk(await controller.waitForStop({ timeout_seconds: 5 }));
    expect(report.outcome).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe("DebugController inspection", () => {
  it("get_variables defaults to Locals, redacts secrets and pages", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const page = expectOk(await controller.getVariables({ count: 2 })) as {
      scope: string;
      has_more: boolean;
      variables: Array<{ name: string; value: string; redacted?: boolean }>;
      limitations: string[];
    };
    expect(page.scope).toBe("Locals");
    expect(page.has_more).toBe(true);
    expect(page.variables.map((v) => v.name)).toEqual(["count", "api_key"]);
    expect(page.variables[1]?.value).toBe("[REDACTED]");
    expect(page.variables[1]?.redacted).toBe(true);
    expect(page.limitations[0]).toContain("Globals");
  });

  it("evaluate honours the mutation setting", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const ok = expectOk(await controller.evaluate({ expression: "count", context: "watch" })) as { result: string };
    expect(ok.result).toContain("ZeroDivisionError");
    const strict = new DebugController(
      new FakeHost(state),
      state,
      { defaultTimeoutMs: 100, startWaitMs: 100, allowMutation: false, redactSecrets: true, maxReportFrames: 5, maxReportOutputLines: 5 },
      noopLogger,
    );
    const denied = await strict.evaluate({ expression: "count = 1", context: "repl" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    const defaulted = expectOk(await strict.evaluate({ expression: "count" })) as { context: string };
    expect(defaulted.context).toBe("watch");
  });

  it("set_breakpoint replaces an existing breakpoint on the same line and reports verification", async () => {
    const { state, host, controller } = setup();
    stopSession(state, "s1");
    expectOk(await controller.setBreakpoint({ file: "app.py", line: 13 }));
    const second = expectOk(await controller.setBreakpoint({ file: "app.py", line: 13, condition: "count == 0" }));
    expect(host.breakpoints).toHaveLength(1);
    expect(second.condition).toBe("count == 0");
    expect(second.verified).toBe(true);
    expect(second.file).toBe("/work/fixture/app.py");
  });

  it("stop_debugging ends the session tree", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const result = expectOk(await controller.stopDebugging({})) as { stopped: boolean; remaining_sessions: unknown[] };
    expect(result.stopped).toBe(true);
    expect(result.remaining_sessions).toHaveLength(0);
    expect(state.getSession("s1")?.status).toBe("terminated");
  });
});

describe("DebugController set_variable", () => {
  it("returns the previous value, redacting secret-looking names, and notes the cached panel", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const changed = expectOk(await controller.setVariable({ variables_reference: 500, name: "total", value: "26" })) as Record<string, unknown>;
    expect(changed.previous_value).toBe("0.0");
    expect(changed.previous_type).toBe("float");
    expect(changed.value).toBe("26");
    expect(String((changed.limitations as string[])[0])).toContain("Variables panel");

    const secret = expectOk(await controller.setVariable({ variables_reference: 500, name: "api_key", value: "x" })) as Record<string, unknown>;
    expect(secret.previous_value).toBe("[REDACTED]");
  });

  it("notes when the previous value could not be read", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const changed = expectOk(await controller.setVariable({ variables_reference: 999, name: "ghost", value: "1" })) as Record<string, unknown>;
    expect(changed.previous_value).toBeUndefined();
    expect((changed.limitations as string[]).join(" ")).toContain("previous value could not be read");
  });
});

describe("DebugController evaluate redaction", () => {
  it("hides the result and children when the expression names a secret", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const hidden = expectOk(await controller.evaluate({ expression: "api_key", context: "watch" })) as Record<string, unknown>;
    expect(hidden.result).toBe("[REDACTED]");
    expect(hidden.redacted).toBe(true);
    expect(hidden.variables_reference).toBe(0);

    const partial = expectOk(await controller.evaluate({ expression: "api_key[:3]", context: "watch" })) as Record<string, unknown>;
    expect(partial.result).toBe("[REDACTED]");
  });

  it("returns ordinary expressions untouched", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const plain = expectOk(await controller.evaluate({ expression: "total / count", context: "watch" })) as Record<string, unknown>;
    expect(plain.result).toContain("ZeroDivisionError");
    expect(plain.redacted).toBeUndefined();
  });

  it("does not redact when redactSecrets is off", async () => {
    const state = new DebugState();
    const host = new FakeHost(state);
    const controller = new DebugController(
      host,
      state,
      { defaultTimeoutMs: 500, startWaitMs: 200, allowMutation: true, redactSecrets: false, maxReportFrames: 10, maxReportOutputLines: 40 },
      noopLogger,
    );
    stopSession(state, "s1");
    const raw = expectOk(await controller.evaluate({ expression: "api_key", context: "watch" })) as Record<string, unknown>;
    expect(raw.result).not.toBe("[REDACTED]");
  });
});

const strictSetup = () => {
  const state = new DebugState();
  const host = new FakeHost(state);
  const controller = new DebugController(
    host,
    state,
    { defaultTimeoutMs: 500, startWaitMs: 200, allowMutation: false, redactSecrets: true, maxReportFrames: 10, maxReportOutputLines: 40 },
    noopLogger,
  );
  return { state, host, controller };
};

describe("DebugController benchmark fixes", () => {
  it("refuses calls and assignments in watch context when mutation is off", async () => {
    const { state, controller } = strictSetup();
    stopSession(state, "s1");
    for (const expression of ["big_list.clear()", "x = 1", "os.remove(p)"]) {
      const denied = await controller.evaluate({ expression, context: "watch" });
      expect(denied.ok, expression).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    }
    const allowed = await controller.evaluate({ expression: "len(items) > 0", context: "watch" });
    expect(allowed.ok).toBe(true);
  });

  it("masks credential-shaped text in an evaluate result and hints at repr for elided nesting", async () => {
    const { state, host, controller } = setup();
    stopSession(state, "s1");
    const original = host.customRequest.bind(host);
    host.customRequest = async (sessionId: string, command: string, args?: unknown) =>
      command === "evaluate"
        ? { result: "{'auth': 'Bearer abcdef1234567890xyz', 'rows': [[...], [...]]}", variablesReference: 9 }
        : original(sessionId, command, args);
    const value = expectOk(await controller.evaluate({ expression: "headers", context: "watch" })) as Record<string, unknown>;
    expect(String(value.result)).not.toContain("abcdef1234567890xyz");
    expect(value.redacted).toBe(true);
    expect(value.variables_reference).toBe(0);
    expect((value.limitations as string[]).join(" ")).toContain("Credential-shaped");
    expect((value.limitations as string[]).join(" ")).toContain("repr(x)");
  });

  it("stop reports are brief: no exception filters, no column, and the source line is included", async () => {
    const { state, host, controller } = setup();
    host.sources.set("/work/fixture/app.py", Array.from({ length: 30 }, (_, i) => (i === 12 ? "    return total / count" : `line ${i + 1}`)));
    stopSession(state, "s1");
    state.getSession("s1")!.capabilities = { exceptionBreakpointFilters: [{ filter: "raised", label: "Raised" }] };
    const report = expectOk(await controller.execute("next", {}));
    expect(JSON.stringify(report)).not.toContain("exception_breakpoint_filters");
    expect(report.frames?.[0]).toMatchObject({ name: "average_item_price", line: 13, source_line: "return total / count" });
    expect(report.frames?.[0]?.column).toBeUndefined();
    expect(report.session?.last_stop).toBeUndefined();

    const full = expectOk(await controller.getDebugState()) as { sessions: Array<Record<string, unknown>> };
    expect(full.sessions[0]?.exception_breakpoint_filters).toBeDefined();
  });

  it("redacts a credential literal in the source line shown at a stop", async () => {
    const { state, host, controller } = setup();
    host.sources.set("/work/fixture/app.py", Array.from({ length: 30 }, (_, i) => (i === 12 ? 'api_key = "demo-not-a-real-key"' : "x")));
    stopSession(state, "s1");
    const report = expectOk(await controller.execute("next", {}));
    expect(report.frames?.[0]?.source_line).toBe("api_key = [REDACTED]");
  });

  it("reports an exited session as exited, not running", async () => {
    const { state, controller } = setup();
    state.sessionStarted({ id: "s1", name: "s1", type: "debugpy" });
    state.recordDapMessage("s1", "adapter", { type: "event", event: "initialized" });
    state.recordDapMessage("s1", "adapter", { type: "event", event: "exited", body: { exitCode: 0 } });
    const full = expectOk(await controller.getDebugState()) as { sessions: Array<{ status: string }> };
    expect(full.sessions[0]?.status).toBe("exited");
  });

  it("rejects a breakpoint past the end of a readable file", async () => {
    const { host, controller } = setup();
    host.sources.set("/work/fixture/app.py", Array.from({ length: 43 }, () => "x"));
    const past = await controller.setBreakpoint({ file: "app.py", line: 9999 });
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.error.code).toBe("invalid_input");
      expect(past.error.message).toContain("43 lines");
    }
    expect((await controller.setBreakpoint({ file: "app.py", line: 43 })).ok).toBe(true);
  });

  it("get_debug_output defaults to the current session and skips telemetry", async () => {
    const { state, controller } = setup();
    state.sessionStarted({ id: "old", name: "old", type: "debugpy" });
    state.recordDapMessage("old", "adapter", { type: "event", event: "output", body: { category: "stdout", output: "from the old run" } });
    state.sessionTerminated("old");
    state.sessionStarted({ id: "new", name: "new", type: "debugpy" });
    state.recordDapMessage("new", "adapter", { type: "event", event: "output", body: { category: "stdout", output: "from the new run" } });
    state.recordDapMessage("new", "adapter", { type: "event", event: "output", body: { category: "telemetry", output: "ptvsd" } });

    const current = expectOk(await controller.getDebugOutput({})) as { entries: Array<{ text: string }>; limitations: string[] };
    expect(current.entries.map((e) => e.text)).toEqual(["from the new run"]);
    expect(current.limitations.join(" ")).toContain("all_sessions");

    const all = expectOk(await controller.getDebugOutput({ all_sessions: true })) as { entries: Array<{ text: string }> };
    expect(all.entries.map((e) => e.text)).toEqual(["from the old run", "from the new run"]);
  });
});

describe("DebugController reveal (user only)", () => {
  it("tracks what was hidden without storing values, and reveals a variable on request", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    const listed = expectOk(await controller.getVariables({})) as { variables: Array<{ name: string; value: string }> };
    expect(listed.variables.find((v) => v.name === "api_key")?.value).toBe("[REDACTED]");

    const tracked = controller.listRedactions();
    expect(tracked.map((r) => r.label)).toEqual(["api_key"]);
    expect(JSON.stringify(tracked)).not.toContain("sk-live-123");

    const first = tracked[0];
    const revealed = expectOk(await controller.revealRedaction(first!.id));
    expect(revealed).toEqual({ label: "api_key", value: "sk-live-123" });
  });

  it("reveals an evaluate result, but never re-runs an expression with side effects", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    await controller.evaluate({ expression: "api_key", context: "watch" });
    await controller.evaluate({ expression: "secret_store.pop()", context: "repl" });
    const [popped, plain] = controller.listRedactions();
    const refused = await controller.revealRedaction(popped!.id);
    expect(refused.ok).toBe(false);
    expect(expectOk(await controller.revealRedaction(plain!.id)).value).toContain("ZeroDivisionError");
  });

  it("fails cleanly once the session has ended", async () => {
    const { state, controller } = setup();
    stopSession(state, "s1");
    await controller.getVariables({});
    const id = controller.listRedactions()[0]!.id;
    state.sessionTerminated("s1");
    const gone = await controller.revealRedaction(id);
    expect(gone.ok).toBe(false);
  });

  it("is not reachable from any MCP tool", async () => {
    const { toolNames } = await import("../src/contracts/toolContracts.js");
    expect(toolNames.filter((n) => /reveal|unredact|redact/i.test(n))).toEqual([]);
  });
});
