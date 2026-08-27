/**
 * Worker log.
 *
 * The log is the primary diagnostic for something that runs invisibly from Git
 * hooks, so it is append-only, timestamped, and rotated rather than truncated —
 * losing yesterday's evidence is how a recurring failure stays mysterious.
 *
 * Writes never throw. A worker must not die because its log directory vanished.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { nowIso } from "./queue.js";

export type LogSink = (line: string) => void;

export class Logger {
  constructor(
    private readonly file: string,
    private readonly maxBytes = 2 * 1024 * 1024,
    /** Set for foreground runs so a hand-driven sync is not silent for minutes. */
    private readonly echo: LogSink | null = null,
  ) {}

  write(message: string): void {
    const line = `${nowIso()} ${message}`;
    this.echo?.(line);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, line + "\n", "utf8");
    } catch {
      // Logging must never be fatal.
    }
  }

  /** `[tag] message` — the shape the log has always used, kept greppable. */
  tag(tag: string, message: string): void {
    this.write(`[${tag}] ${message}`);
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.file).size > this.maxBytes) {
        renameSync(this.file, `${this.file}.1`);
      }
    } catch {
      // No file yet, or rotation raced another worker: either is fine.
    }
  }
}

/** Discards everything. Useful in tests and dry runs. */
export const silentLogger = new Logger("/dev/null", Number.MAX_SAFE_INTEGER, null);
