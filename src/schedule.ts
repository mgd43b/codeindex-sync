/**
 * Periodic draining.
 *
 * Git hooks enqueue; they never index inline, because a git command must not
 * wait on a backend. Something therefore has to drain the queue, and asking
 * every user to hand-write a LaunchAgent or systemd unit is where a tool stops
 * being easy. This writes the right one for the platform and loads it.
 *
 * The binary is recorded as an absolute path. A LaunchAgent does not inherit a
 * login shell's PATH — the same reason git hooks do not — so a bare
 * `codeindex-sync` resolves at the terminal and silently fails under the
 * scheduler, which is the worst of both worlds: configured, and doing nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

export const LABEL = "dev.codeindex.sync";
export const DEFAULT_INTERVAL = 120;

export type Scheduler = "launchd" | "systemd" | "unsupported";

export function detectScheduler(): Scheduler {
  if (platform() === "darwin") return "launchd";
  if (platform() === "linux") return "systemd";
  return "unsupported";
}

export function plistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}
export function systemdDir(): string {
  return path.join(homedir(), ".config", "systemd", "user");
}
export function timerPath(): string {
  return path.join(systemdDir(), "codeindex-sync.timer");
}
export function servicePath(): string {
  return path.join(systemdDir(), "codeindex-sync.service");
}

/** XML-escape: a path can contain & or <, and a corrupt plist fails silently. */
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plistContent(binary: string, interval: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binary)}</string>
    <string>drain</string>
  </array>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function serviceContent(binary: string): string {
  return `[Unit]
Description=Drain the codeindex-sync queue

[Service]
Type=oneshot
ExecStart=${binary} drain
`;
}

export function timerContent(interval: number): string {
  return `[Unit]
Description=Drain the codeindex-sync queue every ${interval}s

[Timer]
OnBootSec=${interval}
OnUnitActiveSec=${interval}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function run(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface ScheduleResult {
  scheduler: Scheduler;
  files: string[];
  loaded: boolean;
  /** Set when the unit was written but activating it failed. */
  hint?: string;
}

export function installSchedule(binary: string, interval = DEFAULT_INTERVAL): ScheduleResult {
  const scheduler = detectScheduler();
  if (scheduler === "launchd") {
    const file = plistPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, plistContent(binary, interval), "utf8");
    // Replace any previous registration; bootout on a non-existent label is a
    // harmless failure, so its result is deliberately ignored.
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    const loaded =
      run("launchctl", ["bootstrap", `gui/${uid}`, file]) || run("launchctl", ["load", file]);
    return {
      scheduler,
      files: [file],
      loaded,
      ...(loaded ? {} : { hint: `launchctl bootstrap gui/${uid} ${file}` }),
    };
  }
  if (scheduler === "systemd") {
    mkdirSync(systemdDir(), { recursive: true });
    writeFileSync(servicePath(), serviceContent(binary), "utf8");
    writeFileSync(timerPath(), timerContent(interval), "utf8");
    run("systemctl", ["--user", "daemon-reload"]);
    const loaded = run("systemctl", ["--user", "enable", "--now", "codeindex-sync.timer"]);
    return {
      scheduler,
      files: [servicePath(), timerPath()],
      loaded,
      ...(loaded ? {} : { hint: "systemctl --user enable --now codeindex-sync.timer" }),
    };
  }
  return { scheduler, files: [], loaded: false, hint: "no supported scheduler on this platform" };
}

export function removeSchedule(): { removed: string[]; scheduler: Scheduler } {
  const scheduler = detectScheduler();
  const removed: string[] = [];
  if (scheduler === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    run("launchctl", ["unload", plistPath()]);
    if (existsSync(plistPath())) {
      rmSync(plistPath(), { force: true });
      removed.push(plistPath());
    }
  } else if (scheduler === "systemd") {
    run("systemctl", ["--user", "disable", "--now", "codeindex-sync.timer"]);
    for (const f of [timerPath(), servicePath()]) {
      if (existsSync(f)) {
        rmSync(f, { force: true });
        removed.push(f);
      }
    }
    run("systemctl", ["--user", "daemon-reload"]);
  }
  return { removed, scheduler };
}

/** Is a drain scheduled? Reported by `doctor`, since its absence is invisible. */
export function scheduleInstalled(): boolean {
  const s = detectScheduler();
  if (s === "launchd") return existsSync(plistPath());
  if (s === "systemd") return existsSync(timerPath());
  return false;
}

/**
 * Absolute path to this executable, for embedding in a unit file.
 *
 * Prefers the wrapper on PATH (`codeindex-sync`) over argv[1], which for a
 * global npm install is a file inside a versioned directory that an upgrade
 * can move.
 */
export function resolveBinary(): string {
  try {
    // `/bin/sh -c` rather than `shell: true` with args: the latter concatenates
    // unescaped and Node now warns about it (DEP0190).
    const found = execFileSync("/bin/sh", ["-c", "command -v codeindex-sync"], {
      encoding: "utf8",
    }).trim();
    if (found && path.isAbsolute(found)) return found;
  } catch {
    // Not on PATH yet — fall through.
  }
  // argv[1] is this script; absolute so a scheduler can find it without a PATH.
  const self = process.argv[1];
  return self ? path.resolve(self) : "codeindex-sync";
}
