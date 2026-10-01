import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  kindOf,
  loadHarnessAllowlist,
  loadResultsDir,
  loadResultsMeta,
} from "../src/load-results.js";

describe("loadResultsDir / loadResultsMeta (U13 functional-design.md §2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-leaderboard-results-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for a missing directory", () => {
    expect(loadResultsDir(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("loads every top-level *.json file, sorted by id, excluding _meta.json", () => {
    writeFileSync(join(dir, "b.json"), JSON.stringify({ v: 2 }));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ v: 1 }));
    writeFileSync(join(dir, "_meta.json"), JSON.stringify({ a: { kind: "reference" } }));
    writeFileSync(join(dir, "readme.txt"), "not json");

    const entries = loadResultsDir(dir);

    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(entries[0]?.data).toEqual({ v: 1 });
  });

  it("excludes every underscore-prefixed sidecar file, not just _meta.json (code review round 1, item 2)", () => {
    writeFileSync(join(dir, "naive-baseline.json"), JSON.stringify({ v: 1 }));
    writeFileSync(join(dir, "_meta.json"), JSON.stringify({}));
    writeFileSync(join(dir, "_harness.json"), JSON.stringify({ allow: ["*"] }));

    const entries = loadResultsDir(dir);

    expect(entries.map((e) => e.id)).toEqual(["naive-baseline"]);
  });

  it(
    "never reads results/internal/ — a subdirectory isn't a top-level *.json file " +
      "(user decision at G5: the SDK-default baseline stays internal)",
    () => {
      mkdirSync(join(dir, "internal"));
      writeFileSync(join(dir, "internal", "sdk-default-baseline.json"), JSON.stringify({ v: 1 }));
      writeFileSync(join(dir, "naive-baseline.json"), JSON.stringify({ v: 1 }));

      const entries = loadResultsDir(dir);

      expect(entries.map((e) => e.id)).toEqual(["naive-baseline"]);
    },
  );

  it("loadResultsMeta returns {} when _meta.json is absent or malformed", () => {
    expect(loadResultsMeta(dir)).toEqual({});
    writeFileSync(join(dir, "_meta.json"), "not json");
    expect(loadResultsMeta(dir)).toEqual({});
  });

  it("loadResultsMeta parses a well-formed _meta.json", () => {
    writeFileSync(
      join(dir, "_meta.json"),
      JSON.stringify({ "naive-baseline": { kind: "reference" } }),
    );
    expect(loadResultsMeta(dir)).toEqual({ "naive-baseline": { kind: "reference" } });
  });

  it("kindOf defaults to submitted for an id absent from meta", () => {
    const meta = { known: { kind: "reference" as const } };
    expect(kindOf(meta, "known")).toBe("reference");
    expect(kindOf(meta, "unknown")).toBe("submitted");
  });

  describe("loadHarnessAllowlist (ADR-011 'Harness identity', ADR-016 §3)", () => {
    it("defaults to the all-permissive wildcard when results/_harness.json is absent", () => {
      expect(loadHarnessAllowlist(dir)).toEqual(["*"]);
    });

    it("throws when the file exists but is malformed JSON (code review round 1, item 3)", () => {
      // A *missing* file is the expected "U19 hasn't filled it in yet" state and
      // defaults to the wildcard (above); a *present but corrupted* file must not
      // silently fall back to the same permissive default - that would turn a parsing
      // bug (or a tampered file) into a silent bypass of the whole allowlist check.
      writeFileSync(join(dir, "_harness.json"), "not json");
      expect(() => loadHarnessAllowlist(dir)).toThrow(/not valid JSON/);
    });

    it("throws when allow is missing or not a string array (code review round 1, item 3)", () => {
      writeFileSync(join(dir, "_harness.json"), JSON.stringify({}));
      expect(() => loadHarnessAllowlist(dir)).toThrow(/must be shaped like/);
      writeFileSync(join(dir, "_harness.json"), JSON.stringify({ allow: [1, 2] }));
      expect(() => loadHarnessAllowlist(dir)).toThrow(/must be shaped like/);
      writeFileSync(join(dir, "_harness.json"), JSON.stringify({ allow: "*" }));
      expect(() => loadHarnessAllowlist(dir)).toThrow(/must be shaped like/);
    });

    it("parses a well-formed allowlist (the file U19 eventually populates)", () => {
      writeFileSync(join(dir, "_harness.json"), JSON.stringify({ allow: ["abc123", "def456"] }));
      expect(loadHarnessAllowlist(dir)).toEqual(["abc123", "def456"]);
    });
  });
});
