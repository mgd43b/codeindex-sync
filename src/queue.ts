/**
 * Durable on-disk job queue.
 *
 * One file per repository, named from the repo path with every unsafe character
 * replaced. Re-enqueuing a repo therefore *overwrites* its pending job rather
 * than stacking duplicates, so a burst of Git commands collapses into a single
 * sync. Writes go to a temp file and are renamed into place: rename is atomic on
 * POSIX, so a half-written job is never readable by a concurrent drain.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Job {
  repoPath: string;
  /** Which Git hook produced this job, or "manual". */
  hook: string;
  /** ISO-8601 UTC. Compared against the last index start to drop redundant work. */
  enqueuedAt: string;
  /** Force complete re-discovery. Never coalesced away. */
  full: boolean;
  attempts: number;
}

/** Must match the hook dispatcher's key derivation, or jobs will not collapse. */
export function jobKey(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Second-precision ISO-8601 UTC, so timestamps sort lexicographically. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function serialise(job: Job): string {
  const lines = [
    `repo_path=${job.repoPath}`,
    `hook=${job.hook}`,
    `enqueued_at=${job.enqueuedAt}`,
    `attempts=${job.attempts}`,
  ];
  if (job.full) lines.push("full=1");
  return lines.join("\n") + "\n";
}

/**
 * Job files are untrusted input — written by hooks, and possibly truncated if a
 * machine died mid-write — so parse defensively and never evaluate them.
 */
export function parseJob(text: string): Job | null {
  const get = (k: string): string | undefined => {
    const line = text.split("\n").find((l) => l.startsWith(`${k}=`));
    return line?.slice(k.length + 1);
  };
  const repoPath = get("repo_path");
  if (!repoPath) return null;
  const attempts = Number.parseInt(get("attempts") ?? "0", 10);
  return {
    repoPath,
    hook: get("hook") ?? "manual",
    enqueuedAt: get("enqueued_at") ?? "",
    full: get("full") === "1",
    attempts: Number.isFinite(attempts) ? attempts : 0,
  };
}

export class Queue {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(repoPath: string): string {
    return path.join(this.dir, `${jobKey(repoPath)}.job`);
  }

  /** Overwrites any pending job for the same repo. Atomic via rename. */
  enqueue(input: {
    repoPath: string;
    hook: string;
    full?: boolean;
    enqueuedAt?: string;
    attempts?: number;
  }): Job {
    const job: Job = {
      repoPath: input.repoPath,
      hook: input.hook,
      full: input.full ?? false,
      enqueuedAt: input.enqueuedAt ?? nowIso(),
      attempts: input.attempts ?? 0,
    };
    const target = this.fileFor(job.repoPath);
    const tmp = `${target}.tmp.${process.pid}`;
    writeFileSync(tmp, serialise(job), "utf8");
    renameSync(tmp, target);
    return job;
  }

  list(): Job[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const jobs: Job[] = [];
    for (const name of names) {
      // Skip .tmp files: a concurrent enqueue may be mid-write.
      if (!name.endsWith(".job")) continue;
      try {
        const job = parseJob(readFileSync(path.join(this.dir, name), "utf8"));
        if (job) jobs.push(job);
      } catch {
        // An unreadable job must not wedge the whole drain.
      }
    }
    return jobs;
  }

  remove(repoPath: string): void {
    rmSync(this.fileFor(repoPath), { force: true });
  }

  get size(): number {
    return this.list().length;
  }
}
