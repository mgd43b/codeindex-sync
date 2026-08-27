import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint, serialiseFingerprint, unchanged } from "../src/fingerprint.js";

let dir: string;
const run = (args: string[], cwd = dir) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-fp-"));
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "T"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  run(["add", "a.txt"]);
  run(["commit", "-q", "-m", "one"]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fingerprint", () => {
  it("captures HEAD and a clean tree", () => {
    const fp = fingerprint(dir);
    expect(fp?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(fp?.dirty).toBe(false);
  });

  it("reports a dirty tree", () => {
    writeFileSync(path.join(dir, "b.txt"), "x\n");
    expect(fingerprint(dir)?.dirty).toBe(true);
  });

  it("returns null outside a repository", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "codeindex-fp-plain-"));
    expect(fingerprint(plain)).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("unchanged", () => {
  it("is true when HEAD has not moved and the tree is clean", () => {
    // The whole point: a worktree checkout does not move the main repo's HEAD,
    // so the hook it fires resolves to "nothing to index".
    const fp = fingerprint(dir)!;
    expect(unchanged(fp, serialiseFingerprint(fp))).toBe(true);
  });

  it("is false after a new commit", () => {
    const before = serialiseFingerprint(fingerprint(dir)!);
    writeFileSync(path.join(dir, "c.txt"), "y\n");
    run(["add", "c.txt"]);
    run(["commit", "-q", "-m", "two"]);
    expect(unchanged(fingerprint(dir), before)).toBe(false);
  });

  it("is false when the tree is dirty, even at the same HEAD", () => {
    // Two different sets of uncommitted edits look identical, so a dirty tree
    // can never be treated as a comparable state.
    const clean = serialiseFingerprint(fingerprint(dir)!);
    writeFileSync(path.join(dir, "d.txt"), "z\n");
    expect(unchanged(fingerprint(dir), clean)).toBe(false);
  });

  it("is false when the STORED state was dirty", () => {
    writeFileSync(path.join(dir, "e.txt"), "z\n");
    const dirtyStored = serialiseFingerprint(fingerprint(dir)!);
    run(["add", "e.txt"]);
    run(["commit", "-q", "-m", "three"]);
    expect(unchanged(fingerprint(dir), dirtyStored)).toBe(false);
  });

  it("is false with no stored fingerprint — never skip a first index", () => {
    expect(unchanged(fingerprint(dir), undefined)).toBe(false);
  });

  it("is false when the current fingerprint cannot be read", () => {
    expect(unchanged(null, "abc123")).toBe(false);
  });

  it("is false after a checkout to a different commit", () => {
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(path.join(dir, "f.txt"), "q\n");
    run(["add", "f.txt"]);
    run(["commit", "-q", "-m", "four"]);
    const stored = serialiseFingerprint(fingerprint(dir)!);
    run(["checkout", "-q", first]);
    expect(unchanged(fingerprint(dir), stored)).toBe(false);
  });
});

describe("worktree churn (the case this exists for)", () => {
  it("a linked worktree checkout leaves the main repo's fingerprint unchanged", () => {
    const stored = serialiseFingerprint(fingerprint(dir)!);
    const wt = path.join(dir, "..", `fp-wt-${path.basename(dir)}`);
    run(["worktree", "add", "-q", "-b", "side", wt]);
    // Commit inside the worktree: the main repo is untouched.
    writeFileSync(path.join(wt, "side.txt"), "s\n");
    run(["add", "side.txt"], wt);
    run(["commit", "-q", "-m", "side"], wt);

    expect(unchanged(fingerprint(dir), stored)).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });
});
