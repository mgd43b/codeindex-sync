import { describe, expect, it } from "vitest";
import { shouldCoalesce } from "../src/coalesce.js";
import type { Job } from "../src/queue.js";

function job(overrides: Partial<Job> = {}): Job {
  return {
    repoPath: "/repo",
    hook: "post-checkout",
    enqueuedAt: "2026-08-27T13:00:00Z",
    full: false,
    attempts: 0,
    ...overrides,
  };
}

describe("shouldCoalesce", () => {
  it("drops a job queued before the last index started", () => {
    // The scan at 13:00 already observed anything that existed at 12:00.
    const d = shouldCoalesce(job({ enqueuedAt: "2026-08-27T12:00:00Z" }), "2026-08-27T13:00:00Z");
    expect(d.skip).toBe(true);
  });

  it("keeps a job queued after the last index started", () => {
    // A hook fires only after the file changed, so this is genuinely new work.
    const d = shouldCoalesce(job({ enqueuedAt: "2026-08-27T14:00:00Z" }), "2026-08-27T13:00:00Z");
    expect(d.skip).toBe(false);
  });

  it("keeps a job queued in the same second as the index start", () => {
    // Ambiguous ordering must fail open: indexing twice is cheap, missing a
    // change is not.
    const d = shouldCoalesce(job({ enqueuedAt: "2026-08-27T13:00:00Z" }), "2026-08-27T13:00:00Z");
    expect(d.skip).toBe(false);
  });

  it("never coalesces an explicit full reindex", () => {
    const d = shouldCoalesce(
      job({ enqueuedAt: "2026-08-27T12:00:00Z", full: true }),
      "2026-08-27T13:00:00Z",
    );
    expect(d.skip).toBe(false);
  });

  it("keeps the job when the repo has never been indexed", () => {
    expect(shouldCoalesce(job(), undefined).skip).toBe(false);
  });

  it("fails open on malformed timestamps rather than skipping", () => {
    expect(shouldCoalesce(job({ enqueuedAt: "not-a-date" }), "2026-08-27T13:00:00Z").skip).toBe(false);
    expect(shouldCoalesce(job(), "yesterday").skip).toBe(false);
    expect(shouldCoalesce(job({ enqueuedAt: "" }), "2026-08-27T13:00:00Z").skip).toBe(false);
  });

  it("orders correctly across a year boundary", () => {
    // Guards the assumption that lexicographic == chronological for ISO-8601.
    expect(shouldCoalesce(job({ enqueuedAt: "2025-12-31T23:59:59Z" }), "2026-01-01T00:00:00Z").skip).toBe(true);
    expect(shouldCoalesce(job({ enqueuedAt: "2026-01-01T00:00:01Z" }), "2026-01-01T00:00:00Z").skip).toBe(false);
  });

  it("explains why it skipped", () => {
    const d = shouldCoalesce(job({ enqueuedAt: "2026-08-27T12:00:00Z" }), "2026-08-27T13:00:00Z");
    expect(d.skip && d.reason).toContain("already covered");
  });
});
