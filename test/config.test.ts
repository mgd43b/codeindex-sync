import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, loadConfig, parseConfig, saveConfig } from "../src/config.js";
import { PRESETS, findPreset } from "../src/presets.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["CODEINDEX_SYNC_ROOT"];
});

const minimal = JSON.stringify({
  providers: [{ name: "x", command: "npx", args: ["-y", "thing"], tools: { update: "u" } }],
});

describe("parseConfig", () => {
  it("accepts a minimal provider", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.providers[0]?.name).toBe("x");
    expect(cfg.providers[0]?.tools.update).toBe("u");
  });

  it("applies defaults for anything omitted", () => {
    const cfg = parseConfig("{}");
    expect(cfg.maxAttempts).toBe(DEFAULT_CONFIG.maxAttempts);
    expect(cfg.providers).toEqual([]);
  });

  it("preserves provider order, which is the routing tie-break", () => {
    const cfg = parseConfig(
      JSON.stringify({
        providers: [
          { name: "first", command: "a", tools: { update: "u" } },
          { name: "second", command: "b", tools: { update: "u" } },
        ],
      }),
    );
    expect(cfg.providers.map((p) => p.name)).toEqual(["first", "second"]);
  });

  it("explains bad JSON with a remedy rather than a stack trace", () => {
    try {
      parseConfig("{ nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).remedy).toMatch(/syntax|defaults/);
    }
  });

  it("rejects a provider with no name, naming the offending index", () => {
    try {
      parseConfig(JSON.stringify({ providers: [{ command: "x", tools: { update: "u" } }] }));
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).message).toContain("providers[0].name");
    }
  });

  it("rejects a provider with no update tool — the one required tool", () => {
    try {
      parseConfig(JSON.stringify({ providers: [{ name: "x", command: "y", tools: {} }] }));
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).message).toContain("tools.update");
      expect((err as ConfigError).remedy).toContain("update");
    }
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", "2000"],
    ["NaN", Number.NaN],
  ])("rejects a %s pollIntervalMs rather than spinning on it later", (_label, value) => {
    // A non-positive interval turns the status poll into a spin loop against
    // the backend; this file's job is to catch that at load, not at 2am.
    try {
      parseConfig(
        JSON.stringify({
          providers: [{ name: "x", command: "y", tools: { update: "u" }, pollIntervalMs: value }],
        }),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("pollIntervalMs");
      expect((err as ConfigError).remedy).toContain("2000");
    }
  });

  it("accepts a positive pollIntervalMs", () => {
    const cfg = parseConfig(
      JSON.stringify({
        providers: [{ name: "x", command: "y", tools: { update: "u" }, pollIntervalMs: 500 }],
      }),
    );
    expect(cfg.providers[0]?.pollIntervalMs).toBe(500);
  });

  it("keeps optional fields when present", () => {
    const cfg = parseConfig(
      JSON.stringify({
        providers: [
          {
            name: "x",
            command: "c",
            tools: { update: "u" },
            detectFiles: [".marker"],
            busyMarkers: ["busy"],
            timeoutMs: 1234,
            env: { FOO: "bar" },
          },
        ],
      }),
    );
    const p = cfg.providers[0];
    expect(p?.detectFiles).toEqual([".marker"]);
    expect(p?.timeoutMs).toBe(1234);
    expect(p?.env).toEqual({ FOO: "bar" });
  });
});

describe("loadConfig", () => {
  it("returns defaults when no file exists", () => {
    expect(loadConfig(path.join(dir, "absent.json")).providers).toEqual([]);
  });

  it("round-trips through save", () => {
    const file = path.join(dir, "nested", "config.json");
    const cfg = parseConfig(minimal);
    saveConfig(cfg, file);
    expect(loadConfig(file).providers[0]?.name).toBe("x");
  });

  it("lets CODEINDEX_SYNC_ROOT override the configured root", () => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ root: "/from/file", providers: [] }));
    process.env["CODEINDEX_SYNC_ROOT"] = "/from/env";
    expect(loadConfig(file).root).toBe("/from/env");
  });
});

describe("presets", () => {
  it("every preset is itself valid config", () => {
    // Guards against shipping an `init` template that fails validation.
    for (const preset of PRESETS) {
      const cfg = parseConfig(JSON.stringify({ providers: [preset.config] }));
      expect(cfg.providers[0]?.name).toBe(preset.config.name);
    }
  });

  it("presets are data only — no executable behaviour", () => {
    for (const preset of PRESETS) {
      expect(typeof preset.config.command).toBe("string");
      expect(Object.values(preset.config)).not.toContainEqual(expect.any(Function));
    }
  });

  it("finds a preset by id and misses cleanly", () => {
    expect(findPreset("socraticode")?.title).toBe("SocratiCode");
    expect(findPreset("nope")).toBeUndefined();
  });
});
