import { describe, expect, it, vi } from "vitest";
import { HookRegistry, isGitHook, type HookEvent, type HookHandler } from "../src/hooks.js";

function event(over: Partial<HookEvent> = {}): HookEvent {
  return {
    hook: "post-commit",
    repoPath: "/repo",
    args: [],
    at: "2026-08-27T13:00:00Z",
    ...over,
  };
}

function handler(name: string, over: Partial<HookHandler> = {}): HookHandler {
  return {
    name,
    description: name,
    hooks: ["post-commit"],
    handle: () => {},
    ...over,
  };
}

describe("isGitHook", () => {
  it("accepts known hooks and rejects anything else", () => {
    expect(isGitHook("post-commit")).toBe(true);
    expect(isGitHook("pre-commit")).toBe(false);
    expect(isGitHook("")).toBe(false);
  });
});

describe("HookRegistry", () => {
  it("routes an event only to subscribed handlers", async () => {
    const commit = vi.fn();
    const checkout = vi.fn();
    const r = new HookRegistry()
      .register(handler("a", { hooks: ["post-commit"], handle: commit }))
      .register(handler("b", { hooks: ["post-checkout"], handle: checkout }));

    await r.dispatch(event({ hook: "post-commit" }));
    expect(commit).toHaveBeenCalledOnce();
    expect(checkout).not.toHaveBeenCalled();
  });

  it("rejects duplicate handler names", () => {
    const r = new HookRegistry().register(handler("dup"));
    expect(() => r.register(handler("dup"))).toThrow(/duplicate/);
  });

  it("passes the event through to the handler", async () => {
    let seen: HookEvent | undefined;
    const r = new HookRegistry().register(handler("a", { handle: (e) => void (seen = e) }));
    await r.dispatch(event({ repoPath: "/x", args: ["1", "2"] }));
    expect(seen?.repoPath).toBe("/x");
    expect(seen?.args).toEqual(["1", "2"]);
  });

  it("keeps running other handlers when one throws", async () => {
    // Containment is the whole reason third-party extensions are safe to add:
    // a broken one must not break the user's `git commit`.
    const after = vi.fn();
    const r = new HookRegistry()
      .register(handler("boom", { handle: () => { throw new Error("kaboom"); } }))
      .register(handler("after", { handle: after }));

    const results = await r.dispatch(event());
    expect(after).toHaveBeenCalledOnce();
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("kaboom");
    expect(results[1]?.ok).toBe(true);
  });

  it("never rejects, even when every handler fails", async () => {
    const r = new HookRegistry()
      .register(handler("a", { handle: () => { throw new Error("x"); } }))
      .register(handler("b", { handle: () => Promise.reject(new Error("y")) }));
    const results = await r.dispatch(event());
    expect(results.every((x) => !x.ok)).toBe(true);
  });

  it("awaits async handlers before returning", async () => {
    let done = false;
    const r = new HookRegistry().register(
      handler("slow", {
        handle: async () => {
          await new Promise((res) => setTimeout(res, 20));
          done = true;
        },
      }),
    );
    await r.dispatch(event());
    expect(done).toBe(true);
  });

  it("reports per-handler timing so a slow extension is identifiable", async () => {
    const r = new HookRegistry().register(
      handler("slow", { handle: () => new Promise((res) => setTimeout(res, 25)) }),
    );
    const [result] = await r.dispatch(event());
    expect(result?.ms).toBeGreaterThanOrEqual(20);
  });

  it("dispatches to nothing when no handler subscribes", async () => {
    const r = new HookRegistry().register(handler("a", { hooks: ["post-commit"] }));
    expect(await r.dispatch(event({ hook: "post-merge" }))).toEqual([]);
  });

  it("preserves registration order, so config order is the tie-break", async () => {
    const order: string[] = [];
    const r = new HookRegistry()
      .register(handler("first", { handle: () => void order.push("first") }))
      .register(handler("second", { handle: () => void order.push("second") }));
    await r.dispatch(event());
    expect(order).toEqual(["first", "second"]);
  });
});
