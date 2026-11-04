---
name: vscode-debugging
description: Drive the live VS Code debugger through the vscode-debugger MCP tools to find the root cause of a bug by observing real runtime state instead of guessing.
---

# Debugging with the VS Code debugger MCP

Use these tools when a bug needs runtime facts: a wrong value, an exception,
unexpected control flow, or behaviour you cannot explain from reading code.
The tools act on the same session the user sees in VS Code, so the user can
step, inspect and set breakpoints alongside you.

## Workflow

1. `get_debug_state` first. It tells you whether a session is live, where it
   is stopped, which exception filters the adapter offers, and the server URL.
   If no session exists, `list_debug_configurations` shows what you can start.
2. Form a hypothesis and place breakpoints before running:
   `set_breakpoint` with a `condition` to stop only on the interesting case,
   or `log_message` to trace without pausing. Prefer one or two well-placed
   breakpoints over stepping from the entry point.
3. Start with `start_debugging` using a configuration name. For servers and
   long-running programs it returns `outcome: running`; the user then triggers
   the code path and you call `wait_for_stop`.
4. When stopped, read the stop report: `reason`, `hit_breakpoints`, `frames`,
   `exception`, and `output` since the last command. Use `get_variables`
   (Locals by default) and `evaluate` with `context: "watch"` to confirm or
   reject the hypothesis. Drill into containers via `variables_reference`.
5. Move with `continue`, `step_over`, `step_into`, `step_out` or
   `run_to_line`. Every execution tool blocks until the next stop and returns
   a fresh report, so you rarely need polling.
6. Stop with `stop_debugging` when done, and remove breakpoints you added
   with `remove_breakpoint` unless the user wants them kept.

## Reading results

- Every result has `limitations`. Read them; they explain truncation, missing
  frames, or UI state that cannot be reflected.
- Stop and step reports are brief: the top frame carries `source_line`, so
  you know which line you landed on without reading the file. Exception
  filters and session setup are in `get_debug_state`, not in every report.
- Values of credential-looking variables are shown as `[REDACTED]`, and so
  is the result of an `evaluate` whose expression names one (`api_key`,
  `api_key[:3]`). Credential-shaped text (JWTs, Bearer headers, key
  prefixes) is masked wherever it appears. Do not try to recover it.
- Containers nested more than two levels deep appear as `[...]` (debugpy).
  `evaluate` `repr(x)` to read one, or page `get_variables` with the
  `variables_reference`.
- When mutation is disabled, `evaluate` refuses calls and assignments; read
  containers with `get_variables` instead.
- `outcome: timeout` means nothing stopped in time. The program may be
  waiting for input or finished a path with no breakpoint. Check
  `get_debug_output`, add breakpoints, or `pause`.
- `outcome: terminated` or `exited` means the program ended. Read
  `exit_code` and the output.

## Exceptions

- The exception checkboxes in VS Code's Breakpoints view have no API. Ask
  the user to tick "Raised Exceptions" (Python) or the relevant filter, or
  call `set_exception_breakpoints` with filter ids from
  `exception_breakpoint_filters` and note that the UI will not reflect it.
- Frameworks such as Azure Functions, Flask or Express catch exceptions
  themselves, so "Uncaught" filters rarely fire. Use raised or user-uncaught
  filters, or a breakpoint on the first line of the handler.
- When stopped with `reason: exception`, the report includes `exception`
  details when the adapter supports it; `get_exception_info` fetches them
  again.

## Multiple sessions

JavaScript debugging creates a parent session plus child sessions per
process. Tools default to the session that stopped most recently, which is
usually right. Pass `session_id` from `get_debug_state` when it is not.

## Launch configurations

`start_debugging` takes a name from `list_debug_configurations`, or an inline
`configuration` object when nothing suitable is listed (for example a
`unittest` or `pytest` launch for one test: `{"type": "debugpy", "request":
"launch", "module": "unittest", "args": ["pkg.test_mod.Case.test_x"]}`).
Entries from
`.vscode/mcp-launch.json` are agent-specific and started as inline objects;
`launch.json`, workspace and user configurations are started by name through
VS Code. Avoid configurations using `${file}` or `${input:...}` because they
depend on editor focus or prompt the user.

## Etiquette

- Do not clear breakpoints the user set unless asked; `clear_breakpoints`
  removes everyone's.
- `evaluate` with `context: "repl"` and `set_variable` can change program
  state. Say so when you use them.
- Report what you observed, not what you assumed; quote the frame, line and
  value that supports each conclusion.
