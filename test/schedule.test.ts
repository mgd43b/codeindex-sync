/**
 * Scheduling unit files.
 *
 * The generators are tested rather than the loading: writing a plist is
 * deterministic, while `launchctl` mutates the developer's real login session
 * and has no sandbox. What can go wrong here is the file content — a corrupt
 * plist or a relative binary path fails *silently*, which is the whole reason
 * this feature exists.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVAL,
  LABEL,
  detectScheduler,
  plistContent,
  serviceContent,
  timerContent,
} from "../src/schedule.js";

describe("plistContent", () => {
  it("embeds the absolute binary and the interval", () => {
    const p = plistContent("/usr/local/bin/codeindex-sync", 300);
    expect(p).toContain("<string>/usr/local/bin/codeindex-sync</string>");
    expect(p).toContain("<integer>300</integer>");
    expect(p).toContain(`<string>${LABEL}</string>`);
  });

  it("passes the drain subcommand as its own argument", () => {
    // One <string> per argv element; a combined "binary drain" string would be
    // treated as a single executable name and never run.
    expect(plistContent("/bin/x", 60)).toContain("<string>drain</string>");
  });

  it("escapes XML metacharacters in the path", () => {
    // A path containing & produces a plist that fails to parse, and launchd
    // reports nothing useful — it just never runs.
    const p = plistContent("/opt/a&b/codeindex-sync", 60);
    expect(p).toContain("/opt/a&amp;b/codeindex-sync");
    expect(p).not.toMatch(/a&b/);
  });

  it("declares itself a background job", () => {
    expect(plistContent("/bin/x", 60)).toContain("<string>Background</string>");
  });
});

describe("systemd units", () => {
  it("puts the binary in ExecStart", () => {
    expect(serviceContent("/usr/bin/codeindex-sync")).toContain(
      "ExecStart=/usr/bin/codeindex-sync drain",
    );
  });

  it("repeats on the interval and catches up after downtime", () => {
    const t = timerContent(90);
    expect(t).toContain("OnUnitActiveSec=90");
    expect(t).toContain("Persistent=true");
    expect(t).toContain("WantedBy=timers.target");
  });
});

describe("detectScheduler", () => {
  it("picks the mechanism this platform actually has", () => {
    const s = detectScheduler();
    const expected =
      process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "unsupported";
    expect(s).toBe(expected);
  });
});

describe("defaults", () => {
  it("uses an interval that is frequent but not busy", () => {
    expect(DEFAULT_INTERVAL).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_INTERVAL).toBeLessThanOrEqual(600);
  });
});
