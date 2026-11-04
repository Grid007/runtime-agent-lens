# VS Code Debugger MCP Server: Exploration and Design

Date: 2026-10-17
Status: implemented as v0.1.0 (see README.md); verified end to end against debugpy (fixtures/python) and js-debug (fixtures/node) on 2026-10-17
Reference studied: https://github.com/morluto/rea (cloned and read locally)

## 1. Goal

Expose the VS Code debugger you already use by hand (breakpoints, launch, step,
inspect variables, evaluate) as MCP tools so Claude Code and other agents can
drive a real debug session against the code in your editor.

## 2. What REA actually is, and what transfers

REA (`rea-agents` on npm, v6.5.0) is a reverse-engineering MCP server, not a
debugger bridge. It drives Ghidra, Hopper, IDA, GDB/MI, LLDB, Frida, CDP and
others. It never touches the VS Code debug API. So it is not a template for the
debugging mechanics, but it is an excellent template for how to build and ship
a serious local MCP server. The parts worth copying:

| REA pattern | Where in REA | Why it matters for us |
|---|---|---|
| Named tool contracts separate from the server adapter | `src/contracts/*ToolContracts.ts`, `toolContract(name)` | One zod `inputSchema` + `outputSchema` + `annotations` per tool, consumed by MCP registration, CLI, docs generation and tests. No schema drift. |
| Thin registration helpers | `src/server/registerGdbTools.ts`, `toolRegistrationOptions.ts` | Each `register*Tools` file is about 150 lines: look up contract, call the application layer, project `Result` into a tool result. |
| Tagged `Result` errors, `isError: true` + JSON diagnostic | `src/domain/result.ts`, `docs/mcp-contracts.md` | Agents get a machine-readable error code, partial observation and remediation instead of a stack trace. |
| Token-budget discipline | `AGENTS.md` "Performance" section | Smallest sufficient answer, paging, explicit `limitations` / `truncated` fields, response-size budget enforced before serialising. |
| Dependency direction: domain, then application, then adapters | `docs/architecture.mermaid` | Keeps DAP and VS Code specifics out of the tool semantics so a headless DAP backend could be added later. |
| Single bin dispatcher | `scripts/rea.mjs` | `rea mcp` runs the stdio server, anything else is one-shot CLI. Same tool contracts both ways. |
| `setup` / `doctor` commands | `src/application/SetupPlan.ts`, `SupportedClients.ts` | Idempotent, additive, with backups, dry-run and per-client config paths (Claude Code = `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json`). |
| Bundled agent skill | `.agents/skills/reverse-engineer-anything/SKILL.md` | Tools stay terse; the workflow guidance ("set a breakpoint before continuing", "read the stop reason first") lives in a skill installed into `~/.claude/skills/`. Microsoft's DebugMCP does the same with `debug-live`. |
| `AGENTS.md` with hard rules | repo root | Authority boundaries ("read-only", "never save the database") written down for contributors and agents. |
| GDB session tools as the nearest analog | `start_gdb_session`, `gdb_console`, `gdb_session_status`, `close_gdb_session` | Persistent session with explicit `session_id`, bounded recent records, lifecycle ownership. Our debug session model should look like this. |

REA uses the v2 split MCP SDK: `@modelcontextprotocol/server` 2.3.1 plus
`@modelcontextprotocol/node` for the Node Streamable HTTP transport, `zod` 4,
`pino` for logs, Vitest for tests. I recommend the same stack.

## 3. Prior art (build vs adopt)

| Project | Shape | Transport | Notes |
|---|---|---|---|
| microsoft/DebugMCP | VS Code extension hosting MCP server | Streamable HTTP `http://localhost:3001/mcp` | 17 terse tools, `debug-live` skill, secret redaction, loopback + Host/Origin validation, multi-window routing by workspace folder, test debugging through the VS Code Testing API, auto-registers with Claude Code via `claude mcp add --transport http`. MIT. Also a preview standalone `debugmcp` CLI. The strongest existing option. |
| rauschit.vscode-debugger-mcp-server | VS Code extension | streamable-http or SSE, port 10101 | Adds watch tools. Free for personal use only; commercial licence required. Not suitable for work use. |
| hwanyong/mcp-debug-tools | Extension + stdio CLI proxy | Extension HTTP on 8890, CLI over stdio | Solves multi-window discovery with a registry file plus heartbeat. Exposes MCP resources (`debug://call-stack`, `dap-log://current`). Injects a Claude skill. |
| ctagard/dap-mcp, KashunCheng/dap_mcp, markomanninen/mcp-debugpy | Standalone DAP clients, no VS Code | stdio | Spawn debugpy / delve / js-debug adapters directly. Headless, but you lose the editor UI and must re-implement launch.json semantics. |
| Digital-Defiance/mcp-debugger-server | Node only, Chrome DevTools Protocol | stdio | Not DAP; Node-specific. |

Conclusion: the problem is solved in principle and DebugMCP proves the
extension-hosted design works with Claude Code. Building our own is still
justified if you want: (a) MIT code you control and can run at work,
(b) REA-grade contracts, error algebra and token budgets, (c) a clean solution
for the multi-window and auto-discovery problems, and (d) a learning vehicle.
A pragmatic path is to install DebugMCP today to confirm the workflow, then
build ours with the design below. Where DebugMCP already made a good call
(tool names, redaction, timeouts), copy it.

## 4. Architecture options

### Option A: VS Code extension hosts the MCP server (recommended core)

```
Claude Code ---MCP Streamable HTTP---> extension host process
                                         |- McpServer (tool contracts)
                                         |- DebugSessionController
                                         |    |- vscode.debug.startDebugging / stopDebugging
                                         |    |- session.customRequest(<DAP command>)
                                         |    `- vscode.debug.addBreakpoints / removeBreakpoints
                                         `- DapTracker (registerDebugAdapterTrackerFactory('*'))
                                              observes stopped / continued / output / terminated
```

Pros: full access to `vscode.debug`; works with every debugger extension you
have installed (debugpy today, js-debug built in); the editor UI stays in sync
so you can watch what the agent does; launch.json is reused as-is.
Cons: needs a TCP port; one server per VS Code window; HTTP rather than stdio.

### Option B: Option A plus a stdio shim

A tiny `vscode-debugger-mcp` npm bin that Claude Code launches over stdio and
that forwards to the window's HTTP endpoint. Needed only for clients that
cannot speak Streamable HTTP. Claude Code can, so this is optional.

### Option C: Standalone DAP MCP server (no VS Code)

Spawn DAP adapters directly, like `dap-mcp`. Useful for CI or headless agents,
but it is a second product. Keep the domain layer free of VS Code types so this
can be added later as another adapter, exactly as REA keeps engine protocols
out of its application layer.

Recommendation: A, with the domain/application split so C stays possible.

## 5. Solving the multi-window and discovery problem

Correction after reading DebugMCP's source: it already handles multiple
windows. The first window binds port 3001; every window also runs a private
control server and registers `{pid, controlPort, controlToken, workspaceFolders}`
in `~/.debugmcp/`. The port owner routes each `start_debugging` call to the
window whose workspace folder contains `fileFullPath`
(`src/routingDebuggingHandler.ts`, `src/utils/workspaceRegistry.ts`). So the
differentiator below is not "multi-window works" but "no fixed port and no
routing hop": each window is addressed directly by the Claude Code instance
running inside it.

You already have the Claude Code VS Code extension (anthropic.claude-code
2.1.301), so Claude Code usually runs in the integrated terminal of the window
you are debugging in. VS Code lets an
extension inject environment variables into every integrated terminal of its
own window:

```ts
context.environmentVariableCollection.replace('VSCODE_DEBUG_MCP_PORT', String(port));
```

Then the project `.mcp.json` can reference it with Claude Code's variable
expansion and no fixed port is ever needed:

```json
{
  "mcpServers": {
    "vscode-debugger": {
      "type": "http",
      "url": "http://127.0.0.1:${VSCODE_DEBUG_MCP_PORT:-3001}/mcp"
    }
  }
}
```

Each window binds a free loopback port, writes a registry entry under
`~/.vscode-debugger-mcp/instances.json` (pid, port, workspace folders,
heartbeat), and the stdio shim or a `doctor` command can list and pick
instances for clients launched outside VS Code. Verify during the spike that
Claude Code expands `${VAR:-default}` in `url` (it is documented for `.mcp.json`
fields; confirm against your installed 2.1.302).

Claude Code does not consume `vscode.lm.registerMcpServerDefinitionProvider`
(that API feeds Copilot Chat). We can still register through it so Copilot
picks the server up for free, but Claude Code needs `.mcp.json` or:

```
claude mcp add --transport http --scope user vscode-debugger http://127.0.0.1:<port>/mcp
```

## 6. Mapping tools to the VS Code debug API

Everything an agent needs is reachable from the public API, no proposed APIs
(verified against `vscode.d.ts` on main and `@types/vscode@1.140.0`):

| Need | VS Code API |
|---|---|
| Start a session from launch.json or an inline config | `vscode.debug.startDebugging(folder, nameOrConfig)` |
| Stop / restart | `vscode.debug.stopDebugging(session)`; restart via `customRequest('restart')` or stop+start |
| Breakpoints (line, condition, hit count, logpoint, function) | `vscode.debug.addBreakpoints([new SourceBreakpoint(location, enabled, condition, hitCondition, logMessage)])`, `FunctionBreakpoint`, `removeBreakpoints`, `vscode.debug.breakpoints` |
| Verified breakpoint state from the adapter | `session.getDebugProtocolBreakpoint(bp)` |
| Execution control | `session.customRequest('continue' / 'next' / 'stepIn' / 'stepOut' / 'pause', { threadId })` |
| Inspection | `customRequest('threads')`, `('stackTrace', {threadId, startFrame, levels})`, `('scopes', {frameId})`, `('variables', {variablesReference, start, count})`, `('evaluate', {expression, frameId, context})`, `('setVariable', ...)`, `('exceptionInfo', {threadId})` |
| Which frame the user or agent is focused on | `vscode.debug.activeStackItem` (`DebugStackFrame { session, threadId, frameId }` or `DebugThread`) and `onDidChangeActiveStackItem` |
| Observe DAP events (stopped, continued, output, terminated, breakpoint) | `vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: s => ({ onDidSendMessage, onWillReceiveMessage, onExit }) })` |
| Session lifecycle | `onDidStartDebugSession`, `onDidTerminateDebugSession`, `onDidChangeActiveDebugSession` |
| Debug console text | tracker `output` events; `vscode.debug.activeDebugConsole` is append-only |

Design points that decide whether the agent experience is good:

1. Blocking execution tools. `continue`, `step_*`, `start_debugging` and
   `pause` must wait for the next `stopped`, `terminated` or `exited` event
   (with a configurable timeout, DebugMCP uses 180 s) and return the stop
   reason, `hitBreakpointIds`, exception text, and the top N frames in the
   same response. Without this the agent polls and burns tokens.
2. Session selection. js-debug spawns child sessions; the active session may be
   a parent with no threads. Track all sessions via the tracker, prefer the
   leaf session that last emitted `stopped`, and let tools accept an optional
   `session_id`.
3. Thread selection. Default to the thread from the last `stopped` event, then
   `activeStackItem`, then the first thread from `threads`.
4. Bounded, paged variable output. Cap depth, children per node and string
   length; return `variablesReference` so the agent can drill in; always
   include `truncated` and `limitations` like REA does.
5. Redaction. Mask values whose names look like secrets (DebugMCP does this),
   with a setting to disable.
6. Breakpoint identity. Return VS Code's breakpoint `id` plus file/line plus the
   adapter's `verified` flag so the agent knows when a breakpoint will never hit.

## 7. Proposed tool catalog (terse, REA-style contracts)

Session: `list_debug_configurations`, `start_debugging`, `stop_debugging`,
`restart_debugging`, `get_debug_state` (sessions, active thread/frame, last stop
reason, recent output).

Breakpoints: `set_breakpoint` (line, condition, hitCondition, logMessage),
`set_function_breakpoint`, `remove_breakpoint`, `clear_breakpoints`,
`list_breakpoints`.

Execution (all block until next stop): `continue`, `step_over`, `step_into`,
`step_out`, `pause`, `run_to_line` (temporary breakpoint + continue).

Inspection: `get_threads`, `get_stack_trace`, `get_scopes`, `get_variables`
(paged), `evaluate` (`context: watch | repl | hover`), `set_variable`,
`get_exception_info`, `get_debug_output` (ring buffer, since cursor).

Resources (read-only MCP resources, cheap to re-read): `debug://state`,
`debug://breakpoints`, `debug://output`, `debug://dap-log` (bounded).

Each contract is a `z.strictObject` input, an output schema, `annotations`
(`readOnlyHint` for inspection, `destructiveHint` for `evaluate` with side
effects, `set_variable`, `stop_debugging`), one or two examples, and a
`limitations` array in every result.

## 8. Security and authority

- Bind `127.0.0.1` and `::1` only; use `localhostHostValidation()` and
  `localhostOriginValidation()` from `@modelcontextprotocol/node` to defeat DNS
  rebinding. No auth token is strictly needed on loopback, but a per-window
  random bearer token in the `.mcp.json` headers is cheap and worth adding.
- `evaluate` and `set_variable` run arbitrary code in the debuggee. Expose a
  setting `vscodeDebuggerMcp.allowMutation` (default true for your own use,
  documented as such) and mark the tools `destructiveHint`.
- Only `launch.json` configurations or explicit inline configs can be started;
  the tool never guesses a debugger type without telling the agent.
- Redact credential-like variable values by default.
- Log every tool call to an output channel so you can audit what the agent did.

## 9. What is installed locally today

| Item | Version | Relevance |
|---|---|---|
| VS Code | 1.140.0 | `@types/vscode@1.140.0` is published; all APIs above are stable in it. |
| Node / npm | 22.13.1 / 10.9.2 | Fine for the extension host bundle (esbuild) and the SDK. |
| Claude Code CLI + VS Code extension | 2.1.302 / 2.1.301 | Target client; no local MCP servers configured yet in `~/.claude.json`. |
| ms-python.debugpy | 2026.6.0 | First test language: Python. |
| js-debug (built in) | bundled | Second test language: Node/TypeScript. Exercises the child-session case. |
| ms-dotnettools.vscode-dotnet-runtime | 3.2.0 | Runtime only; no C# debugger extension installed. |

No Java, Go, C++ or C# debuggers are present, so the first milestones should
target Python and Node fixtures.

## 10. Proposed repository layout

```
vscode-debugger-mcp/
  package.json              VS Code extension manifest + npm bin for the shim
  AGENTS.md                 authority rules, token-budget rules (REA style)
  docs/architecture.mermaid
  docs/mcp-contracts.md     generated tool catalog
  src/
    extension.ts            activate(): start server, trackers, env injection, registry
    contracts/              zod tool contracts, no vscode imports
    domain/                 DebugState, StopEvent, Result/error algebra, redaction, paging
    application/            DebugSessionController, WaitForStop, BreakpointService, SetupPlan
    adapters/vscode/        thin wrappers over vscode.debug and DAP customRequest
    adapters/mcp/           registerSessionTools.ts, registerBreakpointTools.ts, ...
    server/                 McpServer composition, Streamable HTTP on node:http
    cli/                    shim (stdio -> http), setup, doctor
  skills/vscode-debugging/SKILL.md   workflow guidance installed to ~/.claude/skills
  tests/                    vitest unit tests + @vscode/test-electron integration with
                            fixtures/python and fixtures/node
```

## 11. Phased plan

Phase 0, spike (about a day): extension with `start_debugging`, `set_breakpoint`,
`continue`, `get_stack_trace`, `get_variables`, `evaluate` over Streamable HTTP
on a fixed port; register in Claude Code with `claude mcp add --transport http`;
debug a Python fixture end to end. Proves the blocking-until-stop model and
the js-debug child-session behaviour.

Phase 1, full catalog: all tools in section 7, DAP tracker state machine,
paging and redaction, `limitations` everywhere, MCP resources.

Phase 2, distribution: dynamic port plus `environmentVariableCollection`,
instance registry, `.mcp.json` writer with backup and dry-run, `doctor`,
bundled skill, optional `registerMcpServerDefinitionProvider` for Copilot.

Phase 3, hardening: integration tests on Python and Node fixtures, response
budget enforcement, vsce packaging, `docs/mcp-contracts.md` generation,
CHANGELOG, CI.

## 12. Open questions to settle in the spike

1. Does Claude Code 2.1.302 expand `${VAR:-default}` inside the `url` field of
   `.mcp.json`? If not, fall back to the stdio shim or a fixed port.
2. Does `customRequest('next')` keep the VS Code call-stack UI focused on the
   new frame, or do we also need to drive `activeStackItem`? DebugMCP's
   behaviour suggests it works, but confirm.
3. Streamable HTTP session handling in the v2 SDK: one long-lived
   `McpServer` per window with a stateful transport, or stateless per request?
   Stateful is needed for resources and notifications.
4. How much of a stopped-state snapshot to return by default (frames, locals
   depth) before it stops being "the smallest sufficient answer".

## 13. Sources

- REA repository: https://github.com/morluto/rea
- VS Code API reference: https://code.visualstudio.com/api/references/vscode-api
- VS Code MCP extension guide: https://code.visualstudio.com/api/extension-guides/ai/mcp
- Debug Adapter Protocol: https://microsoft.github.io/debug-adapter-protocol/specification
- Microsoft DebugMCP: https://github.com/microsoft/DebugMCP
- VS Code Debugger MCP Server (Rausch IT): https://marketplace.visualstudio.com/items?itemName=rauschit.vscode-debugger-mcp-server
- mcp-debug-tools: https://github.com/hwanyong/mcp-debug-tools
- dap-mcp: https://github.com/ctagard/dap-mcp
- dap_mcp: https://github.com/KashunCheng/dap_mcp
- mcp-debugpy: https://github.com/markomanninen/mcp-debugpy
- mcp-debugger-server: https://github.com/Digital-Defiance/mcp-debugger-server
- MCP TypeScript SDK v2 Node adapters: https://www.npmjs.com/package/@modelcontextprotocol/node
