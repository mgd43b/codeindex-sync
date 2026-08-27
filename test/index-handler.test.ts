import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexHandler } from "../src/handlers/index-handler.js";
import { HookRegistry, type HookEvent } from "../src/hooks.js";
import { Queue } from "../src/queue.js";

let dir: string;
let queueDir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-handler-"));
  queueDir = path.join(dir, "queue");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function event(over: Partial<HookEvent> = {}): HookEvent {
  return {
    hook: "post-commit",
    repoPath: path.join(dir, "repo"),
    args: [],
    at: "2026-08-27T13:00:00Z",
    ...over,
  };
}

describe("index handler", () => {
  it("enqueues the repo on a hook", () => {
    const h = createIndexHandler({ queueDir, root: dir });
    h.handle(event());
    expect(new Queue(queueDir).list()[0]?.repoPath).toBe(path.join(dir, "repo"));
  });

  it("carries the hook's own timestamp, not the dequeue time", () => {
    // Coalescing compares enqueue time against index start; using a later
    // timestamp here would make jobs look newer than the change that caused them.
    const h = createIndexHandler({ queueDir, root: dir });
    h.handle(event({ at: "2026-08-27T13:00:00Z" }));
    expect(new Queue(queueDir).list()[0]?.enqueuedAt).toBe("2026-08-27T13:00:00Z");
  });

  it("ignores repos outside the configured root", () => {
    // A global hooksPath fires in EVERY repo on the machine, including ones the
    // user never intended to index.
    const h = createIndexHandler({ queueDir, root: path.join(dir, "only-here") });
    h.handle(event({ repoPath: "/somewhere/else" }));
    expect(new Queue(queueDir).size).toBe(0);
  });

  it("subscribes to the hooks that change a tree without a commit", () => {
    // Rebase and `git am` fire post-rewrite / post-applypatch; without them a
    // repo silently stays stale after a rebase.
    const h = createIndexHandler({ queueDir, root: dir });
    expect(h.hooks).toContain("post-rewrite");
    expect(h.hooks).toContain("post-applypatch");
  });

  it("collapses a burst of hooks into a single job", () => {
    const h = createIndexHandler({ queueDir, root: dir });
    for (let i = 0; i < 25; i++) h.handle(event());
    expect(new Queue(queueDir).size).toBe(1);
  });

  it("never indexes inline — it only enqueues", () => {
    // Hooks run inside the user's git command; doing real work here would make
    // every commit wait on a backend.
    const started = Date.now();
    createIndexHandler({ queueDir, root: dir }).handle(event());
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("index handler through the registry", () => {
  it("is dispatched like any other subscriber", async () => {
    // Dogfooding: indexing gets no privileged path.
    const registry = new HookRegistry().register(createIndexHandler({ queueDir, root: dir }));
    const results = await registry.dispatch(event());
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(new Queue(queueDir).size).toBe(1);
  });

  it("still enqueues when a third-party handler throws first", async () => {
    const registry = new HookRegistry()
      .register({
        name: "broken",
        description: "throws",
        hooks: ["post-commit"],
        handle() {
          throw new Error("extension exploded");
        },
      })
      .register(createIndexHandler({ queueDir, root: dir }));

    const results = await registry.dispatch(event());
    expect(results[0]?.ok).toBe(false);
    expect(new Queue(queueDir).size).toBe(1);
  });

  it("does not receive hooks it did not subscribe to", async () => {
    const registry = new HookRegistry().register(
      createIndexHandler({ queueDir, root: dir, hooks: ["post-commit"] }),
    );
    await registry.dispatch(event({ hook: "post-merge" }));
    expect(new Queue(queueDir).size).toBe(0);
  });
});
