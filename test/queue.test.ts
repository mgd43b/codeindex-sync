import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobKey, nowIso, parseJob, Queue } from "../src/queue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-sync-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("jobKey", () => {
  it("replaces every character that is unsafe in a filename", () => {
    expect(jobKey("/Users/matt/workspace/btctrader")).toBe("_Users_matt_workspace_btctrader");
  });

  it("preserves dots and dashes, which are filename-safe", () => {
    expect(jobKey("/a/b-c.d")).toBe("_a_b-c.d");
  });

  it("maps distinct repos to distinct keys", () => {
    expect(jobKey("/a/b")).not.toBe(jobKey("/a/c"));
  });
});

describe("nowIso", () => {
  it("emits second precision so timestamps sort lexicographically", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("Queue", () => {
  it("round-trips a job", () => {
    const q = new Queue(dir);
    q.enqueue({ repoPath: "/repo/a", hook: "post-commit" });
    const [job] = q.list();
    expect(job?.repoPath).toBe("/repo/a");
    expect(job?.hook).toBe("post-commit");
    expect(job?.full).toBe(false);
  });

  it("collapses repeat enqueues of the same repo into one job", () => {
    // The whole point: a burst of Git commands must not stack duplicates.
    const q = new Queue(dir);
    for (let i = 0; i < 20; i++) q.enqueue({ repoPath: "/repo/a", hook: "post-checkout" });
    expect(q.size).toBe(1);
  });

  it("keeps distinct repos separate", () => {
    const q = new Queue(dir);
    q.enqueue({ repoPath: "/repo/a", hook: "post-commit" });
    q.enqueue({ repoPath: "/repo/b", hook: "post-commit" });
    expect(q.size).toBe(2);
  });

  it("preserves the full flag across a round trip", () => {
    const q = new Queue(dir);
    q.enqueue({ repoPath: "/repo/a", hook: "manual", full: true });
    expect(q.list()[0]?.full).toBe(true);
  });

  it("removes a job", () => {
    const q = new Queue(dir);
    q.enqueue({ repoPath: "/repo/a", hook: "post-commit" });
    q.remove("/repo/a");
    expect(q.size).toBe(0);
  });

  it("ignores .tmp files from an enqueue that is mid-write", () => {
    const q = new Queue(dir);
    writeFileSync(path.join(dir, "_repo_a.job.tmp.123"), "repo_path=/repo/a\n");
    expect(q.size).toBe(0);
  });

  it("skips an unreadable job rather than wedging the drain", () => {
    const q = new Queue(dir);
    q.enqueue({ repoPath: "/repo/good", hook: "post-commit" });
    writeFileSync(path.join(dir, "broken.job"), "garbage with no repo_path\n");
    const jobs = q.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.repoPath).toBe("/repo/good");
  });

  it("returns empty for a directory that does not exist", () => {
    const q = new Queue(path.join(dir, "sub"));
    rmSync(path.join(dir, "sub"), { recursive: true, force: true });
    expect(q.list()).toEqual([]);
  });
});

describe("parseJob", () => {
  it("rejects a job with no repo_path", () => {
    expect(parseJob("hook=post-commit\n")).toBeNull();
  });

  it("defaults a malformed attempts count to 0 rather than NaN", () => {
    const job = parseJob("repo_path=/a\nattempts=not-a-number\n");
    expect(job?.attempts).toBe(0);
  });

  it("tolerates a truncated file", () => {
    // A crash mid-write can leave exactly this.
    expect(parseJob("repo_path=/a")?.repoPath).toBe("/a");
  });
});
