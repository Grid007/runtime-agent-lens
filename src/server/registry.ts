import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-user registry of running VS Code windows that host this server, so
 * clients launched outside the integrated terminal can find a window.
 * Never contains tokens.
 */
export interface InstanceRecord {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly name: string;
  readonly workspaceFolders: readonly string[];
  readonly updatedAt: number;
}

export const registryDirectory = (): string =>
  process.env.VSCODE_DEBUG_MCP_HOME ?? path.join(os.homedir(), ".vscode-debugger-mcp");

const STALE_MS = 90_000;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readAll = (file: string): InstanceRecord[] => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { instances?: unknown }).instances)
      ? ((parsed as { instances: unknown[] }).instances)
      : [];
    return list.filter(
      (item): item is InstanceRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as InstanceRecord).pid === "number" &&
        typeof (item as InstanceRecord).port === "number",
    );
  } catch {
    return [];
  }
};

const writeAll = (file: string, instances: InstanceRecord[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ instances }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
};

export class InstanceRegistry {
  private timer: NodeJS.Timeout | undefined;
  private readonly file: string;

  constructor(
    private readonly record: () => Omit<InstanceRecord, "updatedAt">,
    directory: string = registryDirectory(),
  ) {
    this.file = path.join(directory, "instances.json");
  }

  static list(directory: string = registryDirectory()): InstanceRecord[] {
    const now = Date.now();
    return readAll(path.join(directory, "instances.json")).filter(
      (item) => isAlive(item.pid) && now - item.updatedAt < STALE_MS,
    );
  }

  start(intervalMs = 30_000): void {
    this.touch();
    this.timer = setInterval(() => this.touch(), intervalMs);
    this.timer.unref?.();
  }

  touch(): void {
    try {
      const now = Date.now();
      const mine = this.record();
      const others = readAll(this.file).filter(
        (item) => item.pid !== mine.pid && isAlive(item.pid) && now - item.updatedAt < STALE_MS,
      );
      writeAll(this.file, [...others, { ...mine, updatedAt: now }]);
    } catch {
      // Registry is a convenience; never let it break the server.
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    try {
      const mine = this.record();
      writeAll(this.file, readAll(this.file).filter((item) => item.pid !== mine.pid));
    } catch {
      // ignore
    }
  }
}
