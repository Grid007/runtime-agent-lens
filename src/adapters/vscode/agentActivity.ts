import * as vscode from "vscode";

import { describeResult, shortArgs } from "../../application/activityFormat.js";
import type { ToolObserver } from "../mcp/registerTools.js";

export interface ActivitySettings {
  readonly autoReveal: boolean;
  readonly echoToDebugConsole: boolean;
  readonly maxRawChars: number;
}

const clock = (): string => new Date().toLocaleTimeString("en-GB", { hour12: false });
/** The agent receives compact JSON; the channel is for people, so indent it. */
const prettyJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
const indent = (text: string, pad: string): string =>
  text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");

/**
 * Mirrors every MCP tool call into VS Code: an output channel with the exact result the agent received,
 * a one-line echo in the Debug Console for calls that drive or change the session, and a status bar flash.
 */
export class AgentActivity implements ToolObserver, vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Debugger MCP: Agent Activity");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private revealed = false;
  private inFlight = 0;
  private hideTimer: NodeJS.Timeout | undefined;

  constructor(private readonly settings: () => ActivitySettings) {
    this.status.name = "Debugger MCP agent activity";
    this.status.command = "vscodeDebuggerMcp.showActivity";
  }

  show(): void {
    this.channel.show(true);
  }

  onCall(event: { id: number; tool: string; args: unknown }): void {
    const cfg = this.settings();
    if (cfg.autoReveal && !this.revealed) {
      this.revealed = true;
      this.channel.show(true);
    }
    this.inFlight += 1;
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.status.text = `$(sync~spin) agent: ${event.tool}`;
    this.status.tooltip = "An MCP client is driving the debugger. Click to open Agent Activity.";
    this.status.show();
    this.channel.appendLine(`${clock()} #${event.id} ▶ ${event.tool} ${shortArgs(event.args)}`.trimEnd());
  }

  onResult(event: Parameters<ToolObserver["onResult"]>[0]): void {
    const cfg = this.settings();
    this.inFlight = Math.max(0, this.inFlight - 1);
    const description = describeResult(event.tool, event.args, event.result);

    const lines: string[] = [
      `${clock()} #${event.id} ${event.ok ? "✔" : "✘"} ${event.tool} ${event.ms}ms — what the agent received:`,
    ];
    for (const line of description.summary) lines.push(`    ${line}`);
    if (event.text.includes("[REDACTED]") || event.text.includes("\"redacted\":true")) {
      lines.push("    (something was hidden from the agent: run \"Debugger MCP: Reveal Value Hidden from the Agent\" to see it yourself)");
    }
    const raw =
      event.text.length > cfg.maxRawChars
        ? `${event.text.slice(0, cfg.maxRawChars)}\n… (${event.text.length - cfg.maxRawChars} more characters not shown here)`
        : event.text;
    lines.push("    raw:", indent(raw, "      "), "");
    this.channel.appendLine(lines.join("\n"));

    if (cfg.echoToDebugConsole && description.consoleLine !== undefined) {
      try {
        vscode.debug.activeDebugConsole.appendLine(`[agent] ${description.consoleLine}`);
      } catch {
        // No active debug console; the output channel still has the record.
      }
    }

    this.status.text = `${event.ok ? "$(check)" : "$(error)"} agent: ${event.tool} ${event.ms}ms`;
    if (this.inFlight === 0) {
      this.hideTimer = setTimeout(() => this.status.hide(), 4000);
      this.hideTimer.unref?.();
    }
  }

  dispose(): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.channel.dispose();
    this.status.dispose();
  }
}
