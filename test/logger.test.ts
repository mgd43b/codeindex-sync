import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../src/logger.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-logger-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Logger", () => {
  it("still writes the log when echoing to a closed terminal throws", () => {
    // A foreground sync whose terminal went away must not lose the log line,
    // or crash the job, because the echo failed.
    const file = path.join(dir, "sync.log");
    const log = new Logger(file, 1024 * 1024, () => {
      throw new Error("EPIPE");
    });
    expect(() => log.tag("ok", "indexed")).not.toThrow();
    expect(readFileSync(file, "utf8")).toMatch(/\[ok\] indexed/);
  });
});
