# Repository Guidelines

VS Code Debugger MCP is a VS Code extension that hosts an MCP server and
exposes the editor's live debugger (breakpoints, run, step, stack, variables,
evaluate) to agents such as Claude Code. See DESIGN.md for the exploration
and rationale.

## Authority

- The server binds loopback only and validates Host and Origin. Never add a
  non-loopback bind without an authentication story.
- Tools act on the user's live session. Tools that change debuggee state
  (`evaluate` with repl context, `set_variable`) honour
  `vscodeDebuggerMcp.allowMutation` and carry `destructiveHint`.
- Values of credential-looking variable names are redacted by name only.
  Never infer secrecy from values.
- Revealing a redacted value is a command for the person at the keyboard
  (`vscodeDebuggerMcp.revealRedacted`). Never expose it, or anything that
  returns redacted values, as an MCP tool.
- Configuration writers (`.mcp.json`, skill install) are additive, idempotent
  and back up what they replace, and they confirm before writing.

## Architecture

Dependencies flow inward: `domain/` (pure state and error algebra) ←
`application/` (controller, ports) ← `adapters/` (vscode, mcp) and
`server/` (HTTP transport, registry) ← `extension.ts`. `domain/` and
`application/` never import `vscode` or the MCP SDK, so they are unit-tested
with a fake host and could back a headless DAP server later.

- `contracts/toolContracts.ts` owns tool names, descriptions, zod inputs and
  annotations. Descriptions stay terse; workflow guidance lives in
  `skills/vscode-debugging/SKILL.md`.
- Tool handlers return `Result<T>`; failures are `{ code, message, details,
  remediation }` and are delivered with `isError: true`. Every success carries
  a `limitations` array where anything was bounded or could not be observed.
- Blocking execution tools wait on `DebugState` events and return the stop
  report in the same response. Keep that invariant.
- Answers are the smallest sufficient: page variables, bound value lengths,
  cap frames in stop reports, and bound the output buffer.

## Development

- `npm install`, then `npm run check` (typecheck, unit tests, bundle).
- `npm run package` produces the `.vsix`; `code --install-extension` it.
- F5 with "Run Extension (python fixture)" opens `fixtures/python` in an
  Extension Development Host.
- Real-debugger verification uses `fixtures/python` (debugpy) and
  `fixtures/node` (js-debug). Unit tests do not prove adapter behaviour; say
  which fixtures you actually ran.

## Known gaps

- No API for exception breakpoint checkboxes; `set_exception_breakpoints`
  sends DAP directly and documents that the UI does not follow.
- Output schemas are not advertised yet (SDK validation of structuredContent
  would need per-tool schemas).
- No stdio shim; clients that cannot speak Streamable HTTP are unsupported.
