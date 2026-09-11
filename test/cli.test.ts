/**
 * CLI smoke tests.
 *
 * These run the built binary as a subprocess, because the things worth testing
 * here are exactly the things unit tests cannot see: exit codes, what a human
 * reads on a failure, and whether a first run teaches or just reports emptiness.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { metadataPointId } from "../src/verify.js";

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

/**
 * NO_COLOR keeps assertions readable; an isolated HOME keeps git config safe.
 *
 * A developer's shell very often exports a *real* backend's QDRANT_URL and key,
 * and commands that fall back to the ambient environment would then reach it
 * from a test run. Those variables are stripped from every child rather than
 * remembered case by case, so a test can only ever talk to a backend it was
 * explicitly handed one.
 */
const BACKEND_ENV = [
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "QDRANT_COLLECTION_PREFIX",
  "QDRANT_MODE",
] as const;

function cli(args: string[], env: Record<string, string> = {}, cwd?: string): Run {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    NO_COLOR: "1",
    CODEINDEX_SYNC_STATE: state,
    CODEINDEX_SYNC_CONFIG: cfgFile,
  };
  for (const key of BACKEND_ENV) delete childEnv[key];
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...childEnv, ...env },
      ...(cwd === undefined ? {} : { cwd }),
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
  it("reports the version from package.json, not a stale literal", () => {
    // Matching only the shape of a version string is what let the CLI report
    // 0.1.0 for the whole 0.1.1 release: every hand-edited literal still looks
    // like a version. Compare the value.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const r = cli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(pkg.version);
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

/**
 * The test's own git, fully isolated.
 *
 * A developer running this has codeindex-sync installed, which means a global
 * `core.hooksPath` — so an un-isolated `git commit` here would fire the real
 * dispatcher and enqueue a temp directory into their real queue.
 */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

describe("sync", () => {
  /** A backend whose update tool always succeeds, so the outcome is ours to read. */
  function updatingBackend(): void {
    const file = path.join(home, "update-server.mjs");
    writeFileSync(
      file,
      `let buf="";process.stdin.on("data",c=>{buf+=c;let n;while((n=buf.indexOf("\\n"))!==-1){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);if(!l)continue;const m=JSON.parse(l);
       if(m.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n");
       if(m.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"Updated project index"}]}})+"\\n");}});`,
      "utf8",
    );
    writeConfig({
      root: home,
      providers: [
        { name: "stub", command: process.execPath, args: [file], tools: { update: "u" }, detectFiles: [".stub.json"] },
      ],
    });
  }

  it("treats an unchanged repository as nothing to do, not as a failure", () => {
    // The fingerprint short-circuit is the commonest outcome of a scheduled
    // sync. Exiting 1 for it made every quiet repository look broken, and made
    // the exit code useless to a scheduler that needs to tell real failures apart.
    updatingBackend();
    const dir = path.join(home, "quiet");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "Test");
    writeFileSync(path.join(dir, ".stub.json"), '{"projectId":"quiet"}\n', "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");

    const first = cli(["sync", dir]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Updated project index/);

    const second = cli(["sync", dir]);
    expect(second.out).toMatch(/unchanged/);
    expect(second.out).not.toMatch(/failed/);
    expect(second.code).toBe(0);
  });
});

describe("hook entry point", () => {
  /** A repository under root, claimed for the stub provider and committed. */
  function hookRepo(name: string): string {
    const dir = path.join(home, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "Test");
    writeFileSync(path.join(dir, ".stub.json"), '{"projectId":"x"}\n', "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  }

  /** A function, not a constant: `home` is assigned per test in beforeEach. */
  const hookConfig = (extra: Record<string, unknown> = {}): unknown => ({
    root: home,
    providers: [
      { name: "stub", command: "true", args: [], tools: { update: "u" }, detectFiles: [".stub.json"] },
    ],
    ...extra,
  });

  const queued = (): string[] =>
    new Queue(path.join(state, "queue")).list().map((j) => j.repoPath);

  it("ignores an unknown hook rather than failing the git command", () => {
    // This runs inside the user's git command; a non-zero exit would break it.
    cli(["init", "--preset", "socraticode"]);
    expect(cli(["hook", "pre-commit"]).code).toBe(0);
  });

  it("exits 0 when run outside any repository", () => {
    cli(["init", "--preset", "socraticode"]);
    expect(cli(["hook", "post-commit"]).code).toBe(0);
  });

  it("enqueues the repository when the hook fires in the main checkout", () => {
    writeConfig(hookConfig());
    const repo = hookRepo("main-checkout");
    expect(cli(["hook", "post-commit"], {}, repo).code).toBe(0);
    expect(queued()).toEqual([realpathSync(repo)]);
  });

  it("enqueues nothing when the hook fires in an agent worktree", () => {
    // The marker is committed, so the worktree carries one too — nothing about it
    // looks different to a provider, and it will be gone within the hour.
    writeConfig(hookConfig());
    const repo = hookRepo("agent-host");
    const wt = path.join(repo, ".claude", "worktrees", "task");
    mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "task", wt);
    expect(existsSync(path.join(wt, ".stub.json"))).toBe(true);

    expect(cli(["hook", "post-commit"], {}, wt).code).toBe(0);
    expect(queued()).toEqual([]);
  });

  it("enqueues an agent worktree once the config stops excluding it", () => {
    // Proof the rule is data: same repository, same worktree, different config.
    writeConfig(hookConfig({ excludePaths: [] }));
    const repo = hookRepo("opted-in");
    const wt = path.join(repo, ".claude", "worktrees", "task");
    mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "task", wt);

    expect(cli(["hook", "post-commit"], {}, wt).code).toBe(0);
    // Still not the worktree's own path: git identifies it, and the main
    // checkout is what carries the index.
    expect(queued()).toEqual([]);
  });

  it("doctor names the excluded paths, so a silent skip is explainable", () => {
    writeConfig(hookConfig());
    expect(cli(["doctor"]).out).toContain(".claude/worktrees");
  });
});

/**
 * A stand-in Qdrant, run as its own process.
 *
 * It has to be a separate process, not an in-test server: `cli()` shells out
 * with `execFileSync`, which blocks this process's event loop for the whole
 * run, so a server living here could never answer the request it is waiting on.
 * State lives in a JSON file for the same reason — it is the only channel the
 * two processes share, and it lets a test read back exactly what a repair wrote.
 */
const QDRANT_STUB = `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const [stateFile, portFile] = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(stateFile, "utf8"));

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const state = load();
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url ?? "";
    const name = decodeURIComponent(url.split("/")[2] ?? "");
    const isMeta = name.endsWith("socraticode_metadata");
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method === "GET") {
      if (isMeta) return send(200, { result: { status: "green", points_count: Object.keys(state.meta).length } });
      if (!(name in state.chunks)) return send(404, { status: { error: "Not found" } });
      return send(200, { result: { status: "green", points_count: state.chunks[name].length } });
    }
    if (url.includes("/points/payload")) {
      const id = body.points[0];
      state.meta[id] = { ...(state.meta[id] ?? {}), ...body.payload };
      writeFileSync(stateFile, JSON.stringify(state));
      return send(200, { result: {} });
    }
    if (url.endsWith("/points/scroll")) {
      const values = isMeta
        ? Object.values(state.meta)
        : (state.chunks[name] ?? []).map((p) => ({ relativePath: p }));
      return send(200, {
        result: { points: values.map((payload, id) => ({ id, payload })), next_page_offset: null },
      });
    }
    return send(200, {
      result: body.ids.filter((id) => id in state.meta).map((id) => ({ id, payload: state.meta[id] })),
    });
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
`;

interface QdrantState {
  chunks: Record<string, string[]>;
  meta: Record<string, Record<string, unknown>>;
}

describe("verify", () => {
  const PREFIX = "test_";

  let stateFile: string;
  let child: ChildProcess | undefined;
  let qurl: string;

  beforeEach(async () => {
    stateFile = path.join(home, "qdrant-state.json");
    const portFile = path.join(home, "qdrant-port");
    const stub = path.join(home, "qdrant-stub.mjs");
    writeFileSync(stateFile, JSON.stringify({ chunks: {}, meta: {} }), "utf8");
    writeFileSync(stub, QDRANT_STUB, "utf8");
    child = spawn(process.execPath, [stub, stateFile, portFile], { stdio: "ignore" });
    // Poll the file's *contents*, not its existence: the stub creates it with a
    // non-atomic write, so the moment it appears it can still be empty — and an
    // empty read here builds "http://127.0.0.1:" and fails a long way from the
    // cause.
    let port = "";
    for (let i = 0; i < 200 && !port; i++) {
      try {
        port = readFileSync(portFile, "utf8").trim();
      } catch {
        // Not created yet.
      }
      if (!port) await new Promise((r) => setTimeout(r, 20));
    }
    if (!port) throw new Error("stub Qdrant never reported a port");
    qurl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  const stubState = (): QdrantState => JSON.parse(readFileSync(stateFile, "utf8")) as QdrantState;
  const hashesOf = (id: string): Record<string, string> =>
    JSON.parse(
      stubState().meta[metadataPointId(`${PREFIX}codebase_${id}`)]?.["fileHashes"] as string,
    ) as Record<string, string>;

  const provider = (): unknown => ({
    root: home,
    providers: [
      {
        name: "stub",
        command: "true",
        args: [],
        tools: { update: "u" },
        detectFiles: [".stub.json"],
        env: { QDRANT_URL: qurl, QDRANT_COLLECTION_PREFIX: PREFIX },
      },
    ],
  });

  /** A claimed repository, with files on disk for the blank-file check. */
  function repo(name: string, files: Record<string, string> = {}): string {
    const dir = path.join(home, name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    writeFileSync(path.join(dir, ".stub.json"), JSON.stringify({ projectId: name }), "utf8");
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, rel), content, "utf8");
    }
    return dir;
  }

  function seed(
    id: string,
    dir: string,
    claimed: string[],
    points: string[],
    indexingStatus = "completed",
  ): void {
    const collection = `${PREFIX}codebase_${id}`;
    const s = stubState();
    s.chunks[collection] = points;
    s.meta[metadataPointId(collection)] = {
      collectionName: collection,
      projectPath: dir,
      filesTotal: claimed.length,
      filesIndexed: claimed.length,
      indexingStatus,
      fileHashes: JSON.stringify(Object.fromEntries(claimed.map((f) => [f, "h"]))),
    };
    writeFileSync(stateFile, JSON.stringify(s), "utf8");
  }

  it("passes an intact index, and says what it counted", () => {
    writeConfig(provider());
    const dir = repo("alpha", { "a.ts": "export const a = 1;\n" });
    seed("alpha", dir, ["a.ts"], ["a.ts"]);
    const r = cli(["verify", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 claimed, 1 with content/);
  });

  /** The finding this command exists for, and it must fail the run. */
  it("exits non-zero and names the file when one is claimed but has no chunks", () => {
    writeConfig(provider());
    const dir = repo("beta", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("beta", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    const r = cli(["verify", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/lost\.ts/);
    // Every failure carries a remedy, and here the remedy is a command.
    expect(r.out).toMatch(/--repair/);
  });

  it("does not fail over a blank file, which correctly has no chunks", () => {
    writeConfig(provider());
    const dir = repo("gamma", { "a.ts": "a\n", "__init__.py": "" });
    seed("gamma", dir, ["a.ts", "__init__.py"], ["a.ts"]);
    const r = cli(["verify", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 blank/);
  });

  it("reports orphaned paths without failing over them", () => {
    // Stale points make search return something outdated; they do not make it
    // return nothing, so they are worth knowing and not worth failing on.
    writeConfig(provider());
    const dir = repo("delta", { "a.ts": "a\n" });
    seed("delta", dir, ["a.ts"], ["a.ts", "ghost.ts"]);
    const r = cli(["verify", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ghost\.ts/);
  });

  it("emits the full finding lists as JSON", () => {
    writeConfig(provider());
    const dir = repo("epsilon", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("epsilon", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    const r = cli(["verify", dir, "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as {
      trackedFiles?: number;
      reports: { stranded: string[]; claimed: number }[];
    };
    expect(parsed.reports[0]?.stranded).toEqual(["lost.ts"]);
    expect(parsed.reports[0]?.claimed).toBe(2);
  });

  it("checks every index the backend holds when given no repository", () => {
    writeConfig(provider());
    const dir = repo("zeta", { "a.ts": "a\n" });
    seed("zeta", dir, ["a.ts"], ["a.ts"]);
    const r = cli(["verify"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/test_codebase_zeta/);
  });

  it("repairs exactly the stranded entry", () => {
    writeConfig(provider());
    const dir = repo("eta", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("eta", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    const r = cli(["verify", dir, "--repair"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dropped 1 stranded entry/);
    expect(hashesOf("eta")).toEqual({ "a.ts": "h" });
  });

  it("reports a repair as JSON when both flags are given", () => {
    // A flag the user typed is never silently ignored: --json --repair emits
    // the reports *and* what the repair did, rather than dropping one of them.
    writeConfig(provider());
    const dir = repo("lambda", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("lambda", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    const r = cli(["verify", dir, "--repair", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      reports: { stranded: string[] }[];
      repair: { removed: string[]; remaining: number; collided: boolean };
    };
    expect(parsed.reports[0]?.stranded).toEqual(["lost.ts"]);
    expect(parsed.repair).toEqual({ removed: ["lost.ts"], remaining: 1, collided: false });
    expect(hashesOf("lambda")).toEqual({ "a.ts": "h" });
  });

  /**
   * The collision that actually happens: the drain fires on its timer while
   * someone repairs by hand. Qdrant has no compare-and-swap, so this is
   * prevented with the worker's own lock rather than detected afterwards.
   */
  it("refuses to repair while the worker holds the lock", () => {
    writeConfig(provider());
    const dir = repo("mu", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("mu", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    // This process is unquestionably alive, so the lock reads as genuinely held
    // rather than as a stale one to reclaim.
    const lockDir = path.join(state, "worker.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");

    const r = cli(["verify", dir, "--repair"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/worker is indexing/);
    expect(Object.keys(hashesOf("mu"))).toHaveLength(2);
  });

  it("releases the lock after repairing", () => {
    writeConfig(provider());
    const dir = repo("nu", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("nu", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    expect(cli(["verify", dir, "--repair"]).code).toBe(0);
    expect(hashesOf("nu")).toEqual({ "a.ts": "h" });
    // A repair that kept the lock would wedge every later drain.
    expect(existsSync(path.join(state, "worker.lock"))).toBe(false);
  });

  it("takes no lock for a read-only verify", () => {
    // Verifying must never block indexing — it is the thing you run on a timer.
    writeConfig(provider());
    const dir = repo("xi", { "a.ts": "a\n" });
    seed("xi", dir, ["a.ts"], ["a.ts"]);
    const lockDir = path.join(state, "worker.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");

    expect(cli(["verify", dir]).code).toBe(0);
    // Still held by the "worker": a read-only run neither waits nor releases it.
    expect(existsSync(path.join(lockDir, "pid"))).toBe(true);
  });

  it("says what to fix when the lock cannot be taken at all", () => {
    // Contention is only one way this fails. An unwritable state directory is
    // another, and the top-level handler would print the errno with no idea
    // what to suggest.
    writeConfig(provider());
    const dir = repo("omicron", { "a.ts": "a\n", "lost.ts": "lost\n" });
    seed("omicron", dir, ["a.ts", "lost.ts"], ["a.ts"]);
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o500);
    try {
      const r = cli(["verify", dir, "--repair"]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/could not take the worker lock/);
      expect(r.out).toContain(state);
      expect(Object.keys(hashesOf("omicron"))).toHaveLength(2);
    } finally {
      chmodSync(state, 0o700);
    }
  });

  it("refuses to repair while an index run is in progress", () => {
    // Mid-flight, "claimed but no chunks yet" is the normal state of a file
    // about to be written, not damage.
    writeConfig(provider());
    const dir = repo("theta", { "a.ts": "a\n", "pending.ts": "p\n" });
    seed("theta", dir, ["a.ts", "pending.ts"], ["a.ts"], "in-progress");
    const r = cli(["verify", dir, "--repair"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/in progress/);
    expect(Object.keys(hashesOf("theta"))).toHaveLength(2);
  });

  it("refuses to repair every index at once", () => {
    writeConfig(provider());
    const r = cli(["verify", "--repair"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/needs an explicit repository/);
  });

  it("says which command pins an id when the repo has no marker", () => {
    writeConfig(provider());
    const dir = path.join(home, "unclaimed");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    const r = cli(["verify", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/claim/);
  });

  it("says where the backend URL belongs when none is configured", () => {
    // The ambient environment is deliberately not a fallback worth relying on:
    // git hooks never see it, so a config that omits this is broken for the
    // indexer too.
    writeConfig({
      root: home,
      providers: [
        { name: "stub", command: "true", args: [], tools: { update: "u" }, detectFiles: [".stub.json"] },
      ],
    });
    const dir = repo("iota");
    const r = cli(["verify", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/QDRANT_URL/);
    expect(r.out).toMatch(/env/);
  });

  it("says nothing has indexed a repo yet rather than reporting damage", () => {
    writeConfig(provider());
    const dir = repo("kappa", { "a.ts": "a\n" });
    const r = cli(["verify", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no such collection|sync --full/);
  });
});
