# Changelog

## 0.2.2

- Command **Debugger MCP: Reveal Value Hidden from the Agent**: pick something that was redacted and see the real value in a dialog (copyable). It is a command for you, not an MCP tool, so the agent cannot call it. Expressions with side effects are never re-run to reveal them.

## 0.2.1

- Stop and step reports are brief (no exception filters, no column) and the top frame carries `source_line`; JSON is compact.
- `evaluate` refuses calls and assignments when mutation is off (heuristic guard); results are masked for JWTs, Bearer headers, key prefixes, URL credentials and `password=` text; `token_count` style names are no longer treated as secrets.
- Variables and evaluate hint at `repr(x)` when nesting is shown as `[...]`.
- `get_debug_output` and `get_debug_state` default to the current session and skip telemetry (`all_sessions` for the rest).
- `set_breakpoint` rejects lines past the end of the file; a session whose process exited reports `exited`; duplicate launch configurations are listed once.

## 0.2.0

- Agent Activity: every MCP tool call is mirrored into VS Code (output channel with the exact redacted result the agent received, `[agent]` lines in the Debug Console, status bar indicator). Settings: `vscodeDebuggerMcp.activity.*`.
- `evaluate` hides its result when the expression mentions a credential-looking name (matched by name only).
- `set_variable` returns the previous value (redacted by name).
- Changing display-only settings no longer restarts the server.

## 0.1.0

- Initial release: 26 tools over Streamable HTTP on a per-window loopback port, instance registry, `.vscode/mcp-launch.json`, bundled Claude Code skill.
- Verified against debugpy (Python) and js-debug (Node) on Windows.
