import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kindOf, loadResultsDir, loadResultsMeta } from "../src/load-results.js";

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
});
