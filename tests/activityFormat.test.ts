import { describe, expect, it } from "vitest";

import { describeResult, short, shortArgs } from "../src/application/activityFormat.js";
import { fail, ok } from "../src/domain/result.js";

describe("describeResult", () => {
  it("lists variables and flags redacted ones without showing a value", () => {
    const described = describeResult(
      "get_variables",
      {},
      ok({
        scope: "Locals",
        has_more: false,
        variables: [
          { name: "api_key", value: "[REDACTED]", type: "str", redacted: true },
          { name: "avg", value: "4.33", type: "float" },
        ],
      }),
    );
    const text = described.summary.join("\n");
    expect(text).toContain("Locals (2)");
    expect(text).toContain("api_key = [REDACTED]");
    expect(text).toContain("hidden from the agent");
    expect(text).toContain("avg     = 4.33   : float");
    expect(described.consoleLine).toContain("api_key");
  });

  it("stays quiet in the Debug Console when nothing was redacted", () => {
    const described = describeResult("get_variables", {}, ok({ scope: "Locals", variables: [{ name: "n", value: "1", type: "int" }] }));
    expect(described.consoleLine).toBeUndefined();
  });

  it("shows set_variable as before to after with the type change", () => {
    const described = describeResult(
      "set_variable",
      {},
      ok({ name: "total", value: "26", type: "int", previous_value: "12.0", previous_type: "float" }),
    );
    expect(described.summary[0]).toBe("total: 12.0 → 26  (float → int)");
    expect(described.consoleLine).toContain("12.0 → 26");
  });

  it("summarises an execution stop with its frame and breakpoint", () => {
    const described = describeResult(
      "continue",
      {},
      ok({
        outcome: "stopped",
        reason: "breakpoint",
        frames: [{ name: "apply_discount", file: String.raw`e:\fx\app.py`, line: 5 }],
        hit_breakpoints: [{ file: String.raw`e:\fx\app.py`, line: 5 }],
      }),
    );
    expect(described.summary).toContain("at: apply_discount app.py:5");
    expect(described.summary).toContain("breakpoints hit: app.py:5");
    expect(described.consoleLine).toBe("continue → stopped at apply_discount app.py:5");
  });

  it("reports exits with the exit code", () => {
    const described = describeResult("continue", {}, ok({ outcome: "exited", exit_code: 0 }));
    expect(described.consoleLine).toBe("continue → exited (exit 0)");
  });

  it("describes failures with their remediation", () => {
    const described = describeResult("step_over", {}, fail("not_stopped", "Session is running.", { remediation: "Call pause first." }));
    expect(described.summary).toEqual(["not_stopped: Session is running.", "remediation: Call pause first."]);
    expect(described.consoleLine).toBe("step_over failed: not_stopped");
  });

  it("does not echo read-only tools to the Debug Console", () => {
    expect(describeResult("get_stack_trace", {}, ok({ frames: [{ name: "f", file: "a.py", line: 1 }] })).consoleLine).toBeUndefined();
  });

  it("never throws on unexpected shapes", () => {
    expect(describeResult("continue", {}, ok("text")).summary).toEqual([]);
    expect(describeResult("get_variables", {}, ok({ variables: "nope" })).summary.length).toBeGreaterThan(0);
  });
});

describe("short helpers", () => {
  it("collapses whitespace and truncates", () => {
    expect(short("a\n  b", 10)).toBe("a b");
    expect(short("abcdefghij", 5)).toBe("abcd…");
  });
  it("omits empty args", () => {
    expect(shortArgs({})).toBe("");
    expect(shortArgs({ line: 5 })).toBe('{"line":5}');
  });
});
