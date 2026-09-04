/**
 * CLI smoke tests.
 *
 * These run the built binary as a subprocess, because the things worth testing
 * here are exactly the things unit tests cannot see: exit codes, what a human
 * reads on a failure, and whether a first run teaches or just reports emptiness.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";

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

  it("groups help by task, in a declared order", () => {
    // Commander orders groups by whichever command happens to be registered
    // first, so without an explicit order this silently reshuffles when someone
    // adds a command. The point of grouping is that `--help` answers "what do I
    // run next?", which it cannot do if the sequence is an accident.
    const out = cli(["--help"]).out;
    const headings = ["Everyday:", "Setup:", "Scheduling:", "Queue:", "Diagnostics:"];
    const seen = headings.map((h) => out.indexOf(h));
    expect(seen.every((i) => i >= 0)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("puts every command under a group, leaving none stranded", () => {
    // A command with no .helpGroup() falls into commander's default bucket at
    // the bottom, which is exactly the ungrouped list this replaced.
    const out = cli(["--help"]).out;
    const tail = out.slice(out.indexOf("Commands:"));
    // `help` is commander's own and is the only thing allowed to sit there.
    const strays = tail.split("\n").filter((l) => /^\s{2}\S/.test(l) && !l.includes("help ["));
    expect(strays).toEqual([]);
  });
});

describe("command dispatch", () => {
  it("a bare invocation runs status", () => {
    const r = cli([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Worker/);
  });

  it("a misspelled command errors and suggests the real one", () => {
    // Regression: with commander's `isDefault` on status, this exited 0 and
    // silently printed the queue — a typo looked like it had worked.
    const r = cli(["statsu"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unknown command/);
    expect(r.out).toMatch(/status/);
    expect(r.out).not.toMatch(/Worker/);
  });

  it("an unknown command with no near match still errors", () => {
    const r = cli(["nonsense-command"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unknown command/);
  });

  it("a leading flag is not mistaken for a command", () => {
    expect(cli(["--version"]).code).toBe(0);
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

describe("claim", () => {
  const provider = (extra: Record<string, unknown> = {}): unknown => ({
    root: home,
    providers: [
      {
        name: "stub",
        command: "true",
        args: [],
        tools: { update: "u" },
        detectFiles: [".stub.json"],
        markerContent: '{"projectId":"${name}"}\n',
        ...extra,
      },
    ],
  });

  function repo(name: string): string {
    const dir = path.join(home, name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    return dir;
  }

  it("writes the marker with the repo name as the id", () => {
    writeConfig(provider());
    const dir = repo("alpha");
    const r = cli(["claim", dir]);
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(dir, ".stub.json"), "utf8")).toBe('{"projectId":"alpha"}\n');
  });

  it("honours an explicit --id", () => {
    writeConfig(provider());
    const dir = repo("beta");
    cli(["claim", dir, "--id", "pinned-name"]);
    expect(readFileSync(path.join(dir, ".stub.json"), "utf8")).toContain("pinned-name");
  });

  it("says so and changes nothing when the repo is already claimed", () => {
    writeConfig(provider());
    const dir = repo("gamma");
    writeFileSync(path.join(dir, ".stub.json"), "original", "utf8");
    const r = cli(["claim", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already claimed/);
    expect(readFileSync(path.join(dir, ".stub.json"), "utf8")).toBe("original");
  });

  it("refuses a repo outside the configured root", () => {
    // A global hooksPath fires everywhere, but anything outside root is ignored
    // by design — so a marker there would be a file that never does anything.
    writeConfig({ ...(provider() as object), root: path.join(home, "elsewhere") });
    const dir = repo("delta");
    const r = cli(["claim", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/outside the configured root/);
    expect(existsSync(path.join(dir, ".stub.json"))).toBe(false);
  });

  it("names the provider to pick when several are configured", () => {
    const cfg = provider() as { providers: unknown[] };
    cfg.providers.push({
      name: "other",
      command: "true",
      tools: { update: "u" },
      detectFiles: [".other.json"],
    });
    writeConfig(cfg);
    const r = cli(["claim", repo("eps")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--provider/);
  });

  it("points at the preset's own value when the config has no marker template", () => {
    // Configs written before markerContent existed have none, and there is no
    // backend-agnostic default to invent — so say exactly what to paste.
    writeConfig({
      root: home,
      providers: [
        {
          name: "socraticode",
          command: "true",
          tools: { update: "u" },
          detectFiles: [".socraticode.json"],
        },
      ],
    });
    const r = cli(["claim", repo("zeta")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/markerContent/);
    expect(r.out).toMatch(/projectId/);
  });

  it("unclaim removes the marker again", () => {
    writeConfig(provider());
    const dir = repo("eta");
    cli(["claim", dir]);
    const r = cli(["unclaim", dir]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, ".stub.json"))).toBe(false);
  });

  it("refuses a marker that would escape the repository", () => {
    // detectFiles is hand-edited config. A stray `../` would make claim write
    // outside the repo it was pointed at.
    writeConfig(provider({ detectFiles: ["../escaped.json"] }));
    const dir = repo("iota");
    const r = cli(["claim", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/resolves outside/);
    expect(existsSync(path.join(home, "escaped.json"))).toBe(false);
  });

  it("unclaim refuses to delete outside the repository", () => {
    // The same config, but this path DELETES — so prove a real file next door
    // survives, not merely that the command exited non-zero.
    const outside = path.join(home, "precious.json");
    writeFileSync(outside, "do not delete", "utf8");
    writeConfig(provider({ detectFiles: ["../precious.json"] }));
    const r = cli(["unclaim", repo("kappa")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/resolves outside/);
    expect(readFileSync(outside, "utf8")).toBe("do not delete");
  });

  it("still allows a marker in a subdirectory of the repo", () => {
    // Containment is the rule, not "no separators" — a nested marker is fine.
    writeConfig(provider({ detectFiles: [".config/stub.json"] }));
    const dir = repo("lambda");
    const r = cli(["claim", dir]);
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(dir, ".config", "stub.json"), "utf8")).toContain("lambda");
  });

  it("unclaim says so when nothing claims the repo", () => {
    writeConfig(provider());
    const r = cli(["unclaim", repo("theta")]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no configured provider claims/);
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

describe("completion", () => {
  it("emits a bash script that bash can parse", () => {
    const r = cli(["completion", "bash"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("complete -F _codeindex_sync codeindex-sync");
  });

  it("lists real commands, generated from the command table", () => {
    // Generated rather than hand-maintained, so a new command is completable
    // without anyone remembering to update a list.
    const out = cli(["completion", "bash"]).out;
    for (const c of ["doctor", "cleanup", "schedule", "install-repo"]) {
      expect(out).toContain(c);
    }
  });

  it("emits a zsh script with a compdef header", () => {
    expect(cli(["completion", "zsh"]).out).toMatch(/^#compdef codeindex-sync/);
  });

  it("rejects an unknown shell with the supported list", () => {
    const r = cli(["completion", "tcsh"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bash, zsh, fish/);
  });
});

describe("list --all", () => {
  /** A stub backend that reports one project, so listing has something to show. */
  function backendListing(repoPath: string): string {
    const file = path.join(home, "listing-server.mjs");
    const text = `Indexed projects:\n\n  - ${repoPath}\n    Collection: codebase_x\n    Files: 7\n    Last indexed: 2020-01-01T00:00:00.000Z\n`;
    writeFileSync(
      file,
      `let buf="";process.stdin.on("data",c=>{buf+=c;let n;while((n=buf.indexOf("\\n"))!==-1){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);if(!l)continue;const m=JSON.parse(l);
       if(m.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n");
       if(m.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:${JSON.stringify(text)}}]}})+"\\n");}});`,
      "utf8",
    );
    writeConfig({
      providers: [
        { name: "stub", command: process.execPath, args: [file], tools: { update: "u", list: "l" } },
      ],
    });
    return file;
  }

  it("reports a project the worker is currently processing as running", () => {
    // Only this machine knows a job is in flight; the backend cannot say so.
    // Planted directly rather than raced against a real index, which finishes
    // too fast to observe reliably.
    const repo = mkdtempSync(path.join(tmpdir(), "codeindex-running-"));
    backendListing(repo);
    // Written through Queue rather than by hand, so the test cannot drift from
    // the on-disk format.
    new Queue(path.join(state, "processing")).enqueue({ repoPath: repo, hook: "post-commit" });
    const out = cli(["list", "--all", "--json"]).out;
    const parsed = JSON.parse(out) as { projects: { path: string; state: string }[] };
    expect(parsed.projects[0]?.state).toBe("running");
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports a project whose directory is gone", () => {
    const repo = path.join(tmpdir(), "codeindex-definitely-absent-xyz");
    backendListing(repo);
    const parsed = JSON.parse(cli(["list", "--all", "--json"]).out) as {
      projects: { state: string; collection?: string; files?: string }[];
    };
    expect(parsed.projects[0]?.state).toBe("gone");
    // The backend's own details still come through for a missing directory.
    expect(parsed.projects[0]?.collection).toBe("codebase_x");
    expect(parsed.projects[0]?.files).toBe("7");
  });

  it("names providers that cannot enumerate, rather than reporting nothing", () => {
    writeConfig({ providers: [{ name: "nolist", command: "x", tools: { update: "u" } }] });
    const parsed = JSON.parse(cli(["list", "--all", "--json"]).out) as {
      projects: unknown[];
      unsupported: string[];
    };
    expect(parsed.projects).toEqual([]);
    expect(parsed.unsupported).toEqual(["nolist"]);
  });
});

describe("cleanup", () => {
  it("is a dry run by default and says how to apply", () => {
    // Removing an index is unrecoverable short of a full reindex, so the
    // default must never destroy anything.
    writeConfig({ providers: [{ name: "x", command: "does-not-exist", tools: { update: "u" } }] });
    const r = cli(["cleanup"]);
    expect(r.out).not.toMatch(/removed/i);
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
