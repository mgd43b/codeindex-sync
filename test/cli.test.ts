/**
 * CLI smoke tests.
 *
 * These run the built binary as a subprocess, because the things worth testing
 * here are exactly the things unit tests cannot see: exit codes, what a human
 * reads on a failure, and whether a first run teaches or just reports emptiness.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");
let home: string;
let state: string;
let cfgFile: string;

beforeAll(() => {
  if (!existsSync(CLI)) {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "ignore" });
  }
});

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "codeindex-cli-home-"));
  state = path.join(home, "state");
  cfgFile = path.join(home, "config.json");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
}

/** NO_COLOR keeps assertions readable; an isolated HOME keeps git config safe. */
function cli(args: string[], env: Record<string, string> = {}): Run {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        CODEINDEX_SYNC_STATE: state,
        CODEINDEX_SYNC_CONFIG: cfgFile,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeConfig(obj: unknown): void {
  writeFileSync(cfgFile, JSON.stringify(obj), "utf8");
}

describe("basics", () => {
  it("reports its version", () => {
    const r = cli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists commands in help", () => {
    const out = cli(["--help"]).out;
    for (const cmd of ["init", "doctor", "status", "sync", "providers", "install"]) {
      expect(out).toContain(cmd);
    }
  });
});

describe("first run teaches rather than just reporting emptiness", () => {
  it("status names the command that fills the queue", () => {
    const r = cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing queued/);
    expect(r.out).toMatch(/sync/);
  });

  it("init with no preset lists the presets and the next step", () => {
    const out = cli(["init"]).out;
    expect(out).toContain("socraticode");
    expect(out).toMatch(/init --preset/);
  });

  it("providers points a new user at init", () => {
    expect(cli(["providers"]).out).toMatch(/init/);
  });
});

describe("errors carry a remedy, never a stack trace", () => {
  it("invalid JSON", () => {
    writeFileSync(cfgFile, "{ nope", "utf8");
    const r = cli(["status"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not valid JSON/);
    expect(r.out).toMatch(/→/); // the remedy marker
    expect(r.out).not.toMatch(/at Object\.|node:internal/); // no stack
  });

  it("a provider missing its one required tool names the offending index", () => {
    writeConfig({ providers: [{ name: "x", command: "y" }] });
    const r = cli(["status"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("providers[0].tools.update");
    expect(r.out).toMatch(/→/);
  });

  it("sync with nothing configured suggests init", () => {
    writeConfig({ providers: [] });
    const r = cli(["sync", tmpdir()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/init/);
  });

  it("sync outside a git repo says so plainly", () => {
    writeConfig({ providers: [{ name: "x", command: "y", tools: { update: "u" } }] });
    const r = cli(["sync", tmpdir()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not inside a git repository/);
  });

  it("unknown preset lists the valid ones", () => {
    const r = cli(["init", "--preset", "nope"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/socraticode/);
  });
});

describe("init", () => {
  it("writes a config and points at doctor", () => {
    const r = cli(["init", "--preset", "socraticode"]);
    expect(r.code).toBe(0);
    expect(existsSync(cfgFile)).toBe(true);
    expect(r.out).toMatch(/doctor/);
  });

  it("refuses to clobber an existing config without --force", () => {
    cli(["init", "--preset", "socraticode"]);
    const r = cli(["init", "--preset", "socraticode"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--force/);
  });

  it("overwrites with --force", () => {
    cli(["init", "--preset", "socraticode"]);
    expect(cli(["init", "--preset", "generic-mcp", "--force"]).code).toBe(0);
  });

  it("emits config that the tool can read back", () => {
    // Guards against shipping a preset that fails its own validation.
    cli(["init", "--preset", "socraticode"]);
    expect(cli(["providers"]).code).toBe(0);
  });
});

describe("extensions", () => {
  it("reports the built-in indexer, proving the registry is wired", () => {
    // If indexing had a privileged path, this would be empty and the extension
    // point would be untested in practice.
    cli(["init", "--preset", "socraticode"]);
    const out = cli(["extensions"]).out;
    expect(out).toContain("index");
    expect(out).toContain("post-commit");
  });
});

describe("unlock", () => {
  it("is a no-op when no lock is held", () => {
    const r = cli(["unlock"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no lock held/);
  });
});

describe("providers --example", () => {
  it("prints a block that is itself valid config", () => {
    const out = cli(["providers", "--example"]).out;
    const parsed = JSON.parse(out) as { providers: unknown[] };
    expect(Array.isArray(parsed.providers)).toBe(true);
    writeConfig(parsed);
    expect(cli(["providers"]).code).toBe(0);
  });
});

describe("hook entry point", () => {
  it("ignores an unknown hook rather than failing the git command", () => {
    // This runs inside the user's git command; a non-zero exit would break it.
    cli(["init", "--preset", "socraticode"]);
    expect(cli(["hook", "pre-commit"]).code).toBe(0);
  });

  it("exits 0 when run outside any repository", () => {
    cli(["init", "--preset", "socraticode"]);
    expect(cli(["hook", "post-commit"]).code).toBe(0);
  });
});
