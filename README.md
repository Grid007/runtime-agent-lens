# VS Code Debugger MCP

A VS Code extension that hosts a Model Context Protocol server and gives AI
agents (Claude Code, Copilot, Cursor and any Streamable HTTP MCP client) the
VS Code debugger you already use: breakpoints, launch configurations,
stepping, call stacks, variables and expression evaluation, on the same live
session you see in the editor.

## How it works

```
Claude Code  --MCP over HTTP (loopback)-->  this extension (in the VS Code window)
                                              |- vscode.debug.startDebugging / breakpoints
                                              |- session.customRequest(<DAP>)  (step, stack, variables)
                                              `- DebugAdapterTracker            (stopped / output / terminated)
```

Every window runs its own server on a free loopback port and injects
`VSCODE_DEBUG_MCP_PORT` and `VSCODE_DEBUG_MCP_URL` into its integrated
terminals, so a Claude Code started from that terminal talks to that window.

## Install

```bash
npm install
npm run package          # produces vscode-debugger-mcp-<version>.vsix
code --install-extension vscode-debugger-mcp-0.1.0.vsix
```

Reload the window. The status bar shows `MCP :<port>`; click it for options.

## Connect Claude Code

Option 1, per project (recommended): run the command
**Debugger MCP: Add Server to Workspace .mcp.json**. It writes

```json
{
  "mcpServers": {
    "vscode-debugger": {
      "type": "http",
      "url": "http://127.0.0.1:${VSCODE_DEBUG_MCP_PORT:-54321}/mcp"
    }
  }
}
```

Start Claude Code from a new integrated terminal in that window.

Option 2, per user: **Debugger MCP: Copy 'claude mcp add' Command**, then
paste it in a terminal. This pins the current port; set
`vscodeDebuggerMcp.port` to a fixed value if you use this route.

Then install the workflow skill with **Debugger MCP: Install Debugging Skill
for Claude Code**.

## Watching what the agent does

Breakpoints, stepping, continue and stops go through VS Code itself, so the gutter, Call Stack and editor follow in real time.
What never shows up in the UI is the agent's own view, so every tool call is also mirrored:

- **Output > "Debugger MCP: Agent Activity"**: each call with its arguments, a readable summary and the exact (redacted) JSON the agent received.
  Redacted variables are marked as hidden from the agent while the Variables panel still shows the real value.
- **Debug Console**: one `[agent] ...` line per call that drives or changes the session (execution, breakpoints, `set_variable`, `evaluate`).
- **Status bar**: `agent: <tool>` while a call runs.

Settings: `vscodeDebuggerMcp.activity.autoReveal`, `.echoToDebugConsole`, `.maxRawChars`.

Known limit: VS Code caches the Variables panel per frame and extensions cannot invalidate it, so after `set_variable` the panel shows the old value until the next step or stop. The debuggee has the new value; the activity log shows before and after.

## Tools

| Group | Tools |
|---|---|
| Session | `list_debug_configurations`, `start_debugging`, `stop_debugging`, `restart_debugging`, `get_debug_state`, `wait_for_stop` |
| Breakpoints | `set_breakpoint`, `set_function_breakpoint`, `remove_breakpoint`, `clear_breakpoints`, `list_breakpoints`, `set_exception_breakpoints` |
| Execution (block until next stop) | `continue`, `step_over`, `step_into`, `step_out`, `pause`, `run_to_line` |
| Inspection | `get_threads`, `get_stack_trace`, `get_scopes`, `get_variables`, `evaluate`, `set_variable`, `get_exception_info`, `get_debug_output` |

Execution tools return a stop report: outcome, reason, hit breakpoints, top
frames, exception details and output since the command, plus `limitations`.

## Your own launch configurations

`start_debugging` takes a configuration name. Names resolve from, in order:

1. `.vscode/mcp-launch.json` in the workspace folder, agent-only
   configurations started as inline objects:
   ```json
   { "configurations": [ { "name": "mcp: api", "type": "debugpy", "request": "launch", "module": "uvicorn", "args": ["app:app"] } ] }
   ```
2. `.vscode/launch.json`, the `.code-workspace` file, and the user
   `launch` setting, started by name exactly as F5 does. Add
   `"presentation": { "hidden": true }` to hide agent configurations from the
   F5 dropdown.

Avoid `${file}` and `${input:...}` in agent configurations.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `vscodeDebuggerMcp.port` | `0` (free port) | Loopback port |
| `vscodeDebuggerMcp.requireToken` | `false` | Require a per-window bearer token (`VSCODE_DEBUG_MCP_TOKEN`) |
| `vscodeDebuggerMcp.allowMutation` | `true` | Allow `set_variable` and repl-context `evaluate` |
| `vscodeDebuggerMcp.redactSecrets` | `true` | Redact credential-looking variable values |
| `vscodeDebuggerMcp.defaultTimeoutSeconds` | `60` | Wait for blocking tools |
| `vscodeDebuggerMcp.startWaitSeconds` | `5` | Initial wait after `start_debugging` |

## Security

Loopback only, Host and Origin validated, optional bearer token, secret
redaction by variable name, mutation toggle, every tool call logged to the
"VS Code Debugger MCP" output channel. The server is still a debugger: anyone
who can reach your loopback interface and knows the port can run code in the
debuggee. Enable `requireToken` on shared machines.

## Status and limitations

- Verified against debugpy (Python) and js-debug (Node) on Windows. Other debug adapters (Java, Go, C#, C++) are untested; they should work through the standard Debug Adapter Protocol but may differ.
- Agents must speak MCP over Streamable HTTP. There is no stdio shim yet.
- VS Code has no API for exception breakpoint checkboxes, so `set_exception_breakpoints` does not update the Breakpoints view.
- After `set_variable` the Variables panel keeps the old value until the next step; the program has the new one.
- Redaction is by name only and errs towards hiding.
- Related project: Microsoft's DebugMCP. This one adds agent-only launch configs (`mcp-launch.json`), per-window ports and the Agent Activity view.

## Development

```bash
npm run check     # typecheck + unit tests + bundle
npm run watch     # rebuild on change; F5 launches the Extension Development Host
```

Fixtures for manual and end-to-end testing live in `fixtures/python`
(debugpy) and `fixtures/node` (js-debug).

## License

MIT
