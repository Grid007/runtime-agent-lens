/**
 * Pure, vscode-free model of everything the MCP tools need to know about the
 * live debug sessions. The VS Code adapter feeds it DAP traffic observed by a
 * DebugAdapterTracker and session lifecycle events; the controller reads it
 * and waits on it.
 */

export type SessionStatus = "initializing" | "running" | "stopped" | "terminated";

export interface SessionInfo {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly parentId?: string;
  readonly configurationName?: string;
  readonly workspaceFolder?: string;
}

export interface ExceptionBreakpointFilter {
  readonly filter: string;
  readonly label: string;
  readonly description?: string;
  readonly default?: boolean;
  readonly supportsCondition?: boolean;
}

export interface AdapterCapabilities {
  readonly supportsRestartRequest?: boolean;
  readonly supportsExceptionInfoRequest?: boolean;
  readonly supportsSetVariable?: boolean;
  readonly supportsFunctionBreakpoints?: boolean;
  readonly supportsConditionalBreakpoints?: boolean;
  readonly supportsHitConditionalBreakpoints?: boolean;
  readonly supportsLogPoints?: boolean;
  readonly supportsTerminateRequest?: boolean;
  readonly supportsEvaluateForHovers?: boolean;
  readonly exceptionBreakpointFilters?: readonly ExceptionBreakpointFilter[];
}

export interface StopInfo {
  readonly seq: number;
  readonly at: number;
  readonly reason: string;
  readonly threadId?: number;
  readonly description?: string;
  readonly text?: string;
  readonly hitBreakpointIds?: readonly number[];
  readonly allThreadsStopped?: boolean;
}

export interface SessionRecord extends SessionInfo {
  status: SessionStatus;
  readonly startedAt: number;
  terminatedAt?: number;
  lastStop?: StopInfo;
  exitCode?: number;
  capabilities?: AdapterCapabilities;
  /** Thread ids seen in `thread` events, in order of first appearance. */
  readonly threadIds: number[];
}

export type StateEventKind =
  | "started"
  | "initialized"
  | "stopped"
  | "continued"
  | "exited"
  | "terminated"
  | "output";

export interface StateEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: StateEventKind;
  readonly sessionId: string;
  readonly body?: unknown;
}

export interface OutputEntry {
  readonly seq: number;
  readonly at: number;
  readonly sessionId: string;
  readonly category: string;
  readonly text: string;
}

export interface DapLogEntry {
  readonly seq: number;
  readonly at: number;
  readonly sessionId: string;
  readonly direction: "client" | "adapter";
  readonly summary: string;
}

/** Minimal shape of a DAP ProtocolMessage as seen by a tracker. */
export interface DapMessage {
  readonly seq?: number;
  readonly type?: string;
  readonly command?: string;
  readonly event?: string;
  readonly success?: boolean;
  readonly message?: string;
  readonly body?: unknown;
  readonly arguments?: unknown;
  readonly request_seq?: number;
}

export class RingBuffer<T extends { readonly seq: number }> {
  private readonly items: T[] = [];

  constructor(private readonly maxEntries: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxEntries) {
      this.items.splice(0, this.items.length - this.maxEntries);
    }
  }

  since(seq: number): T[] {
    return this.items.filter((item) => item.seq > seq);
  }

  tail(count: number): T[] {
    return count <= 0 ? [] : this.items.slice(-count);
  }

  all(): readonly T[] {
    return this.items;
  }

  /** Oldest retained seq; entries before it were discarded. */
  oldestSeq(): number | undefined {
    return this.items[0]?.seq;
  }

  get size(): number {
    return this.items.length;
  }
}

export interface DebugStateOptions {
  readonly maxOutputEntries?: number;
  readonly maxDapLogEntries?: number;
  readonly maxEventEntries?: number;
  readonly now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export class DebugState {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(event: StateEvent) => void>();
  private seq = 0;
  private readonly now: () => number;
  readonly output: RingBuffer<OutputEntry>;
  readonly dapLog: RingBuffer<DapLogEntry>;
  readonly events: RingBuffer<StateEvent>;

  constructor(options: DebugStateOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.output = new RingBuffer<OutputEntry>(options.maxOutputEntries ?? 2000);
    this.dapLog = new RingBuffer<DapLogEntry>(options.maxDapLogEntries ?? 500);
    this.events = new RingBuffer<StateEvent>(options.maxEventEntries ?? 500);
  }

  currentSeq(): number {
    return this.seq;
  }

  subscribe(listener: (event: StateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  listSessions(options: { includeTerminated?: boolean } = {}): SessionRecord[] {
    const all = [...this.sessions.values()];
    return options.includeTerminated ? all : all.filter((s) => s.status !== "terminated");
  }

  /** Leaf sessions: live sessions no other live session names as parent. */
  leafSessions(): SessionRecord[] {
    const live = this.listSessions();
    const parentIds = new Set(live.map((s) => s.parentId).filter((p): p is string => p !== undefined));
    return live.filter((s) => !parentIds.has(s.id));
  }

  children(sessionId: string): SessionRecord[] {
    return this.listSessions().filter((s) => s.parentId === sessionId);
  }

  isSameOrDescendant(candidateId: string, ancestorId: string): boolean {
    let current = this.sessions.get(candidateId);
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      if (current.id === ancestorId) return true;
      seen.add(current.id);
      current = current.parentId === undefined ? undefined : this.sessions.get(current.parentId);
    }
    return false;
  }

  /** The live session that stopped most recently and is still stopped. */
  lastStoppedSession(): SessionRecord | undefined {
    let best: SessionRecord | undefined;
    for (const session of this.sessions.values()) {
      if (session.status !== "stopped" || session.lastStop === undefined) continue;
      if (best === undefined || (best.lastStop?.seq ?? -1) < session.lastStop.seq) best = session;
    }
    return best;
  }

  sessionStarted(info: SessionInfo): SessionRecord {
    const existing = this.sessions.get(info.id);
    if (existing !== undefined) return existing;
    const record: SessionRecord = {
      ...info,
      status: "initializing",
      startedAt: this.now(),
      threadIds: [],
    };
    this.sessions.set(info.id, record);
    this.emit("started", info.id);
    return record;
  }

  sessionTerminated(id: string): void {
    const record = this.sessions.get(id);
    if (record === undefined || record.status === "terminated") return;
    record.status = "terminated";
    record.terminatedAt = this.now();
    this.emit("terminated", id);
  }

  adapterExited(id: string, code: number | undefined, signal: string | undefined): void {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    if (record.status !== "terminated") {
      record.status = "terminated";
      record.terminatedAt = this.now();
      this.emit("terminated", id, { adapterExitCode: code, signal });
    }
  }

  /** Drop terminated sessions older than the given age to bound memory. */
  pruneTerminated(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const [id, record] of this.sessions) {
      if (record.status === "terminated" && (record.terminatedAt ?? 0) < cutoff) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Interpret one DAP message observed between VS Code and an adapter. */
  recordDapMessage(sessionId: string, direction: "client" | "adapter", message: DapMessage): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    this.dapLog.push({
      seq: ++this.seq,
      at: this.now(),
      sessionId,
      direction,
      summary: summarizeDap(message),
    });
    if (direction === "adapter" && message.type === "response" && message.command === "initialize") {
      if (isRecord(message.body)) record.capabilities = message.body as AdapterCapabilities;
      return;
    }
    if (direction !== "adapter" || message.type !== "event") return;
    const body = isRecord(message.body) ? message.body : {};
    switch (message.event) {
      case "initialized":
        if (record.status === "initializing") record.status = "running";
        this.emit("initialized", sessionId);
        return;
      case "stopped": {
        record.status = "stopped";
        const seq = ++this.seq;
        const hit = Array.isArray(body.hitBreakpointIds)
          ? body.hitBreakpointIds.filter((v): v is number => typeof v === "number")
          : undefined;
        record.lastStop = {
          seq,
          at: this.now(),
          reason: asString(body.reason) ?? "unknown",
          threadId: asNumber(body.threadId),
          description: asString(body.description),
          text: asString(body.text),
          hitBreakpointIds: hit,
          allThreadsStopped: typeof body.allThreadsStopped === "boolean" ? body.allThreadsStopped : undefined,
        };
        const threadId = asNumber(body.threadId);
        if (threadId !== undefined && !record.threadIds.includes(threadId)) record.threadIds.push(threadId);
        this.emitWithSeq(seq, "stopped", sessionId, body);
        return;
      }
      case "continued":
        record.status = "running";
        this.emit("continued", sessionId, body);
        return;
      case "exited":
        record.exitCode = asNumber(body.exitCode);
        this.emit("exited", sessionId, body);
        return;
      case "terminated":
        record.status = "terminated";
        record.terminatedAt = this.now();
        this.emit("terminated", sessionId, body);
        return;
      case "thread": {
        const threadId = asNumber(body.threadId);
        if (threadId === undefined) return;
        if (body.reason === "started" && !record.threadIds.includes(threadId)) record.threadIds.push(threadId);
        if (body.reason === "exited") {
          const index = record.threadIds.indexOf(threadId);
          if (index >= 0) record.threadIds.splice(index, 1);
        }
        return;
      }
      case "output": {
        const text = asString(body.output);
        if (text === undefined) return;
        const seq = ++this.seq;
        const entry: OutputEntry = {
          seq,
          at: this.now(),
          sessionId,
          category: asString(body.category) ?? "console",
          text,
        };
        this.output.push(entry);
        this.emitWithSeq(seq, "output", sessionId, { category: entry.category });
        return;
      }
      default:
        return;
    }
  }

  private emit(kind: StateEventKind, sessionId: string, body?: unknown): void {
    this.emitWithSeq(++this.seq, kind, sessionId, body);
  }

  private emitWithSeq(seq: number, kind: StateEventKind, sessionId: string, body?: unknown): void {
    const event: StateEvent = { seq, at: this.now(), kind, sessionId, body };
    this.events.push(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener failure must never break state bookkeeping.
      }
    }
  }
}

const summarizeDap = (message: DapMessage): string => {
  if (message.type === "event") return `event ${message.event ?? "?"}`;
  if (message.type === "request") return `request ${message.command ?? "?"}`;
  if (message.type === "response") {
    const status = message.success === false ? ` failed: ${message.message ?? ""}` : "";
    return `response ${message.command ?? "?"}${status}`;
  }
  return `message ${message.type ?? "?"}`;
};
