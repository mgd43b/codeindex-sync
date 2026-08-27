import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive, WorkerLock } from "../src/lock.js";

let dir: string;
let lockDir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-lock-"));
  lockDir = path.join(dir, "worker.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that cannot be running. */
const DEAD_PID = 2 ** 22;

describe("isAlive", () => {
  it("sees this process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("does not see an impossible pid", () => {
    expect(isAlive(DEAD_PID)).toBe(false);
  });

  it("rejects nonsense without throwing", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(Number.NaN)).toBe(false);
  });
});

describe("WorkerLock", () => {
  it("acquires when unlocked", () => {
    const lock = new WorkerLock(lockDir);
    expect(lock.acquire().acquired).toBe(true);
    expect(lock.isHeld()).toBe(true);
  });

  it("records the holding pid", () => {
    new WorkerLock(lockDir, 4242).acquire();
    expect(readFileSync(path.join(lockDir, "pid"), "utf8").trim()).toBe("4242");
  });

  it("refuses when a LIVE process holds it", () => {
    // Two workers indexing concurrently would hit one backend at once.
    new WorkerLock(lockDir, process.pid).acquire();
    const other = new WorkerLock(lockDir, process.pid + 1);
    const r = other.acquire();
    expect(r.acquired).toBe(false);
    expect(r.acquired === false && r.heldBy).toBe(process.pid);
  });

  it("reclaims a lock whose holder is dead", () => {
    // The crash case: without this, one dead worker wedges the queue forever.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), `${DEAD_PID}\n`);
    const r = new WorkerLock(lockDir).acquire();
    expect(r.acquired).toBe(true);
    expect(r.acquired === true && r.reclaimedFrom).toBe(DEAD_PID);
  });

  it("reclaims a lock directory with no pid file at all", () => {
    mkdirSync(lockDir, { recursive: true });
    expect(new WorkerLock(lockDir).acquire().acquired).toBe(true);
  });

  it("reclaims a lock with an unparseable pid", () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), "not-a-pid\n");
    expect(new WorkerLock(lockDir).acquire().acquired).toBe(true);
  });

  it("reports not-held after release", () => {
    const lock = new WorkerLock(lockDir);
    lock.acquire();
    lock.release();
    expect(lock.isHeld()).toBe(false);
    expect(lock.read()).toBeNull();
  });

  it("is re-acquirable after release", () => {
    const lock = new WorkerLock(lockDir);
    lock.acquire();
    lock.release();
    expect(lock.acquire().acquired).toBe(true);
  });

  it("isHeld is false when the recorded holder is dead", () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), `${DEAD_PID}\n`);
    expect(new WorkerLock(lockDir).isHeld()).toBe(false);
  });
});

describe("WorkerLock.forceRelease", () => {
  it("refuses to break a live holder's lock without force", () => {
    new WorkerLock(lockDir, process.pid).acquire();
    const r = new WorkerLock(lockDir).forceRelease(false);
    expect(r.released).toBe(false);
    expect(r.alive).toBe(true);
  });

  it("breaks a live holder's lock when forced", () => {
    new WorkerLock(lockDir, process.pid).acquire();
    expect(new WorkerLock(lockDir).forceRelease(true).released).toBe(true);
  });

  it("releases a dead holder's lock without needing force", () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), `${DEAD_PID}\n`);
    const r = new WorkerLock(lockDir).forceRelease(false);
    expect(r.released).toBe(true);
    expect(r.alive).toBe(false);
  });

  it("is a no-op on an already-unlocked lock", () => {
    expect(new WorkerLock(lockDir).forceRelease(false).released).toBe(true);
  });
});
