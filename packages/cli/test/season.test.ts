import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSeason } from "../src/season.js";

/** Security review #13: a literal, obviously-fake test seed with exactly 256 bits of
 * apparent entropy (64 hex chars = 32 bytes) - the minimum `loadSeason` now accepts. */
const TEST_SEED_256 = "a".repeat(64);

describe("loadSeason (ADR-011 seasons, U19)", () => {
  let corpusDir: string;
  const ENV_NAME = "X402_TEST_SEASON_SEED";

  beforeEach(() => {
    corpusDir = mkdtempSync(join(tmpdir(), "x402-redteam-season-"));
  });

  afterEach(() => {
    rmSync(corpusDir, { recursive: true, force: true });
    delete process.env[ENV_NAME];
  });

  it("no season is active when --season-seed-env isn't given", () => {
    const info = loadSeason({ corpusDir });
    expect(info).toEqual({ season: null, seed_commitment: null, seed: undefined });
  });

  it("reads the seed from the named env var and computes sha256 as seed_commitment", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    process.env[ENV_NAME] = TEST_SEED_256;

    const info = loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir });

    expect(info.season).toBe("s1");
    expect(info.seed).toBe(TEST_SEED_256);
    expect(info.seed_commitment).toBe(createHash("sha256").update(TEST_SEED_256).digest("hex"));
  });

  it("security review #13: rejects a hex seed shorter than 256 bits (64 hex chars)", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    process.env[ENV_NAME] = "a".repeat(63); // 63 hex chars: not even byte-aligned
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).toThrow(/256 bits/);
  });

  it("security review #13: accepts a base64-encoded 256-bit seed", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    process.env[ENV_NAME] = Buffer.alloc(32, 7).toString("base64");
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).not.toThrow();
  });

  it("security review #13: rejects a short base64 seed and a short raw-string seed", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    process.env[ENV_NAME] = Buffer.alloc(8, 7).toString("base64");
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).toThrow(/256 bits/);

    process.env[ENV_NAME] = "short-raw-seed";
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).toThrow(/256 bits/);
  });

  it("security review #13: never echoes the seed itself in the length-rejection message", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    process.env[ENV_NAME] = "short-raw-seed";
    try {
      loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir });
      throw new Error("expected loadSeason to throw");
    } catch (err) {
      expect(err instanceof Error ? err.message : "").not.toContain("short-raw-seed");
    }
  });

  it("throws when --season-seed-env is given but corpus/season.json is missing", () => {
    process.env[ENV_NAME] = "testseed";
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).toThrow(/season\.json/);
  });

  it("throws when season.json is malformed", () => {
    writeFileSync(join(corpusDir, "season.json"), JSON.stringify({ id: "s1" }));
    process.env[ENV_NAME] = "testseed";
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).toThrow(/season\.json/);
  });

  it("throws when the named env var is not set", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    expect(() => loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir })).toThrow(new RegExp(ENV_NAME));
  });

  it("the seed string never appears in the thrown error message when unset (no accidental echo)", () => {
    writeFileSync(
      join(corpusDir, "season.json"),
      JSON.stringify({ id: "s1", starts: "2026-01-01", ends: "2026-03-31" }),
    );
    process.env[ENV_NAME] = "";
    try {
      loadSeason({ seasonSeedEnv: ENV_NAME, corpusDir });
      throw new Error("expected loadSeason to throw");
    } catch (err) {
      expect(err instanceof Error ? err.message : "").not.toContain("testseed");
    }
  });
});
