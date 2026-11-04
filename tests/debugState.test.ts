import { describe, expect, it } from "vitest";

import { DebugState } from "../src/domain/debugState.js";

const stopped = (threadId: number, reason = "breakpoint", hitBreakpointIds?: number[]) => ({
  type: "event",
  event: "stopped",
  body: { reason, threadId, hitBreakpointIds, allThreadsStopped: true },
});

describe("DebugState", () => {
  it("tracks a stopped session and its last stop", () => {
    const state = new DebugState();
    state.sessionStarted({ id: "s1", name: "app", type: "debugpy" });
    state.recordDapMessage("s1", "adapter", { type: "event", event: "initialized" });
    expect(state.getSession("s1")?.status).toBe("running");
    state.recordDapMessage("s1", "adapter", stopped(7, "breakpoint", [3]));
    const record = state.getSession("s1");
    expect(record?.status).toBe("stopped");
    expect(record?.lastStop?.threadId).toBe(7);
    expect(record?.lastStop?.hitBreakpointIds).toEqual([3]);
    expect(state.lastStoppedSession()?.id).toBe("s1");
    state.recordDapMessage("s1", "adapter", { type: "event", event: "continued", body: { threadId: 7 } });
    expect(record?.status).toBe("running");
    expect(state.lastStoppedSession()).toBeUndefined();
  });

  it("emits events with increasing seq and keeps them for late waiters", () => {
    const state = new DebugState();
    const seen: string[] = [];
    state.subscribe((event) => seen.push(`${event.kind}:${event.seq}`));
    state.sessionStarted({ id: "s1", name: "app", type: "debugpy" });
    const before = state.currentSeq();
    state.recordDapMessage("s1", "adapter", stopped(1));
    state.recordDapMessage("s1", "adapter", { type: "event", event: "terminated" });
    expect(seen.length).toBe(3);
    const later = state.events.since(before).map((e) => e.kind);
    expect(later).toEqual(["stopped", "terminated"]);
    expect(state.getSession("s1")?.status).toBe("terminated");
    expect(state.listSessions()).toHaveLength(0);
  });

  it("captures capabilities from the initialize response", () => {
    const state = new DebugState();
    state.sessionStarted({ id: "s1", name: "app", type: "debugpy" });
    state.recordDapMessage("s1", "adapter", {
      type: "response",
      command: "initialize",
      success: true,
      body: { supportsSetVariable: true, exceptionBreakpointFilters: [{ filter: "raised", label: "Raised Exceptions" }] },
    });
    expect(state.getSession("s1")?.capabilities?.supportsSetVariable).toBe(true);
    expect(state.getSession("s1")?.capabilities?.exceptionBreakpointFilters?.[0]?.filter).toBe("raised");
  });

  it("bounds the output buffer and pages by seq", () => {
    const state = new DebugState({ maxOutputEntries: 3 });
    state.sessionStarted({ id: "s1", name: "app", type: "node" });
    for (let i = 0; i < 5; i += 1) {
      state.recordDapMessage("s1", "adapter", { type: "event", event: "output", body: { category: "stdout", output: `line ${i}\n` } });
    }
    expect(state.output.size).toBe(3);
    expect(state.output.tail(10).map((e) => e.text)).toEqual(["line 2\n", "line 3\n", "line 4\n"]);
    const oldest = state.output.oldestSeq() as number;
    expect(state.output.since(oldest)).toHaveLength(2);
  });

  it("knows parent/child relationships for js-debug style trees", () => {
    const state = new DebugState();
    state.sessionStarted({ id: "parent", name: "node", type: "pwa-node" });
    state.sessionStarted({ id: "child", name: "node [1234]", type: "pwa-node", parentId: "parent" });
    expect(state.isSameOrDescendant("child", "parent")).toBe(true);
    expect(state.isSameOrDescendant("parent", "child")).toBe(false);
    expect(state.leafSessions().map((s) => s.id)).toEqual(["child"]);
    expect(state.children("parent").map((s) => s.id)).toEqual(["child"]);
  });
});
