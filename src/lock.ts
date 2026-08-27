/**
 * Worker lock.
 *
 * `mkdir` is used as the primitive because it is atomic on every POSIX
 * filesystem, and because `flock(1)` does not exist on macOS — a portability
 * trap that repeatedly bit the shell implementation this replaces.
 *
 * A lock whose holder has died must be reclaimable, or a crashed worker wedges
 * the queue forever. Liveness is checked with `kill(pid, 0)`, which tests for
 * the process without signalling it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso } from "./queue.js";

export interface LockInfo {
  pid: number;
  since: string;
}

export type AcquireResult =
  | { acquired: true; reclaimedFrom?: number }
  | { acquired: false; heldBy: number };

/** Does a process exist? Signal 0 checks without delivering anything. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class WorkerLock {
  constructor(
    private readonly dir: string,
    private readonly pid: number = process.pid,
  ) {}

  /** Current holder, or null if unlocked/unreadable. */
  read(): LockInfo | null {
    try {
      const pid = Number.parseInt(readFileSync(path.join(this.dir, "pid"), "utf8").trim(), 10);
      if (!Number.isInteger(pid)) return null;
      let since = "";
      try {
        since = readFileSync(path.join(this.dir, "since"), "utf8").trim();
      } catch {
        // A lock dir without `since` is still a valid lock.
      }
      return { pid, since };
    } catch {
      return null;
    }
  }

  /** True only when a *live* process holds it. */
  isHeld(): boolean {
    const info = this.read();
    return info !== null && isAlive(info.pid);
  }

  /**
   * Take the lock, reclaiming it if the holder is gone.
   *
   * `maxReclaims` bounds the retry loop so two workers racing to reclaim the
   * same stale lock cannot spin indefinitely — one wins, the other reports the
   * winner rather than looping.
   */
  acquire(maxReclaims = 3): AcquireResult {
    let reclaimedFrom: number | undefined;
    for (let attempt = 0; attempt <= maxReclaims; attempt++) {
      try {
        mkdirSync(this.dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const info = this.read();
        if (info && isAlive(info.pid)) return { acquired: false, heldBy: info.pid };
        // Holder is gone (or the dir is unreadable): reclaim and retry.
        reclaimedFrom = info?.pid;
        rmSync(this.dir, { recursive: true, force: true });
        continue;
      }
      writeFileSync(path.join(this.dir, "pid"), `${this.pid}\n`, "utf8");
      writeFileSync(path.join(this.dir, "since"), `${nowIso()}\n`, "utf8");
      return reclaimedFrom === undefined ? { acquired: true } : { acquired: true, reclaimedFrom };
    }
    const info = this.read();
    return { acquired: false, heldBy: info?.pid ?? -1 };
  }

  release(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Release a lock this process does not own.
   *
   * Refuses while the holder is alive unless forced, because breaking a live
   * worker's lock lets two indexers run concurrently against one backend.
   */
  forceRelease(force = false): { released: boolean; heldBy?: number; alive: boolean } {
    const info = this.read();
    if (!info) {
      rmSync(this.dir, { recursive: true, force: true });
      return { released: true, alive: false };
    }
    const alive = isAlive(info.pid);
    if (alive && !force) return { released: false, heldBy: info.pid, alive };
    rmSync(this.dir, { recursive: true, force: true });
    return { released: true, heldBy: info.pid, alive };
  }
}

export function ensureStateDirs(dirs: string[]): void {
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
