import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  kindOf,
  loadHarnessAllowlist,
  loadResultsDir,
  loadResultsMeta,
  loadSeasonRecords,
  loadVerifiedMap,
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

    it("reads release entries in object form as their commit", () => {
      const commit = "a".repeat(40);
      writeFileSync(
        join(dir, "_harness.json"),
        JSON.stringify({
          allow: [{ commit, version: "v0.1.0", image: `sha256:${"b".repeat(64)}` }, "def456"],
        }),
      );
      expect(loadHarnessAllowlist(dir)).toEqual([commit, "def456"]);
    });

    it("throws when an object entry has a missing or malformed commit, version or image", () => {
      const good = { commit: "a".repeat(40), version: "v0.1.0", image: `sha256:${"b".repeat(64)}` };
      for (const entry of [
        { version: good.version, image: good.image },
        { commit: good.commit, image: good.image },
        { commit: good.commit, version: good.version },
        { ...good, commit: 1 },
        { ...good, commit: "abc123" },
        { ...good, commit: "A".repeat(40) },
        { ...good, version: "0.1.0" },
        { ...good, version: "v0.1" },
        { ...good, image: "sha256:abc" },
        { ...good, image: "b".repeat(64) },
        { ...good, image: `sha512:${"b".repeat(64)}` },
        null,
      ]) {
        writeFileSync(join(dir, "_harness.json"), JSON.stringify({ allow: [entry] }));
        expect(() => loadHarnessAllowlist(dir), JSON.stringify(entry)).toThrow(
          /must be shaped like/,
        );
      }
    });
  });

  describe("loadVerifiedMap (ADR-011 provenance tiers, U19)", () => {
    it("defaults to {} (every entry is Tier 3) when results/_verified.json is absent", () => {
      expect(loadVerifiedMap(dir)).toEqual({});
    });

    it("throws when the file exists but is malformed JSON", () => {
      writeFileSync(join(dir, "_verified.json"), "not json");
      expect(() => loadVerifiedMap(dir)).toThrow(/not valid JSON/);
    });

    it("throws when an entry isn't shaped like {tier, signer, subject_sha256}", () => {
      writeFileSync(join(dir, "_verified.json"), JSON.stringify({ a: { tier: 3, signer: "x" } }));
      expect(() => loadVerifiedMap(dir)).toThrow(/must be shaped like/);
      writeFileSync(join(dir, "_verified.json"), JSON.stringify({ a: { tier: 1 } }));
      expect(() => loadVerifiedMap(dir)).toThrow(/must be shaped like/);
      // Security review HIGH-5: subject_sha256 is now required, not optional.
      writeFileSync(join(dir, "_verified.json"), JSON.stringify({ a: { tier: 1, signer: "x" } }));
      expect(() => loadVerifiedMap(dir)).toThrow(/must be shaped like/);
    });

    it("parses a well-formed verified map", () => {
      writeFileSync(
        join(dir, "_verified.json"),
        JSON.stringify({
          "guard-one": {
            tier: 1,
            signer: ".github/workflows/ranked-run.yml",
            subject_sha256: "a".repeat(64),
          },
          "guard-two": {
            tier: 2,
            signer: ".github/workflows/rank.yml",
            subject_sha256: "b".repeat(64),
            run_url: "https://x",
          },
        }),
      );
      expect(loadVerifiedMap(dir)).toEqual({
        "guard-one": {
          tier: 1,
          signer: ".github/workflows/ranked-run.yml",
          subject_sha256: "a".repeat(64),
        },
        "guard-two": {
          tier: 2,
          signer: ".github/workflows/rank.yml",
          subject_sha256: "b".repeat(64),
          run_url: "https://x",
        },
      });
    });

    it("is never loaded as a report by loadResultsDir (underscore-prefixed sidecar)", () => {
      writeFileSync(join(dir, "_verified.json"), JSON.stringify({}));
      writeFileSync(join(dir, "naive-baseline.json"), JSON.stringify({ v: 1 }));
      expect(loadResultsDir(dir).map((e) => e.id)).toEqual(["naive-baseline"]);
    });
  });

  describe("loadSeasonRecords (security review MEDIUM-11)", () => {
    it("defaults to {} when results/_seasons.json is absent", () => {
      expect(loadSeasonRecords(dir)).toEqual({});
    });

    it("throws when the file exists but is malformed JSON", () => {
      writeFileSync(join(dir, "_seasons.json"), "not json");
      expect(() => loadSeasonRecords(dir)).toThrow(/not valid JSON/);
    });

    it("throws when an entry isn't shaped like a SeasonRecord", () => {
      writeFileSync(join(dir, "_seasons.json"), JSON.stringify({ s1: { seed_commitment: "x" } }));
      expect(() => loadSeasonRecords(dir)).toThrow(/must be shaped like/);
    });

    it("parses a well-formed season record map", () => {
      const record = {
        seed_commitment: "a".repeat(64),
        corpus_hash: "b".repeat(64),
        starts: "2026-01-01",
        ends: "2026-03-31",
      };
      writeFileSync(join(dir, "_seasons.json"), JSON.stringify({ s1: record }));
      expect(loadSeasonRecords(dir)).toEqual({ s1: record });
    });

    it("is never loaded as a report by loadResultsDir (underscore-prefixed sidecar)", () => {
      writeFileSync(join(dir, "_seasons.json"), JSON.stringify({}));
      writeFileSync(join(dir, "naive-baseline.json"), JSON.stringify({ v: 1 }));
      expect(loadResultsDir(dir).map((e) => e.id)).toEqual(["naive-baseline"]);
    });
  });

  describe("contentHash (security review HIGH-5)", () => {
    it("is independent of key order and whitespace", () => {
      expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    });

    it("changes when content changes", () => {
      expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    });

    it("loadResultsDir attaches a matching sha256 to every entry", () => {
      writeFileSync(join(dir, "a.json"), JSON.stringify({ v: 1 }));
      const entries = loadResultsDir(dir);
      expect(entries[0]?.sha256).toBe(contentHash({ v: 1 }));
    });
  });
});
