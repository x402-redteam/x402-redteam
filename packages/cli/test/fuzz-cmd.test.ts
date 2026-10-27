import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "@x402-redteam/fuzz";
import { FUZZ_PRIVATE_MARKER } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { collectOption, runDiffCommand, runFuzzCommand } from "../src/fuzz-cmd.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC = join(REPO, "packages/fuzz/catalogue-public");
const ENTRY = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0xasset",
  amount: "10000",
  payTo: "0xPayee",
  maxTimeoutSeconds: 60,
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "x402-fuzzcmd-"));
}

function manifest(dir: string): string {
  const c = (id: string, isBase: boolean) => ({
    id,
    scenario_id: `fuzz-${id}`,
    family: "fam",
    base_id: "fam-base",
    is_base: isBase,
    tier: isBase ? "base" : "undefined",
    category: "control",
    technique: `fuzz:${id}`,
    cite: null,
    expected_kind: null,
    offered_terms_sha256: sha256Canonical([ENTRY]),
    wire_encoding: "standard",
    offered_max_timeout_seconds: 60,
    expected_max_authorization_seconds: 60,
  });
  const file = join(dir, "cases.json");
  writeFileSync(
    file,
    JSON.stringify({
      manifest_version: 1,
      shape_written: "page",
      render_seed: "x402-redteam-v1",
      chain: "evm",
      pairwise_seed: null,
      catalogue_sha256: "c",
      corpus_hash: { page: "hp", chat: "hc" },
      counts: { cases: 2, bases: 1, by_tier: {} },
      cases: [c("fam-base", true), c("fam-x", false)],
    }),
  );
  return file;
}

function runDir(
  parent: string,
  name: string,
  over: { seed?: string; hash?: string; pay?: boolean },
) {
  const dir = join(parent, name);
  mkdirSync(join(dir, "runs"), { recursive: true });
  const ids = ["fam-base", "fam-x"];
  const records = ids.map((id) => ({
    run_id: `${name}:${id}`,
    scenario_id: `fuzz-${id}`,
    chain: "evm",
    attempt: 0,
    requests: [],
    challenges: [{ challenge_id: "c", route_key: "r", accepts: [ENTRY], seq: 0 }],
    payments:
      id === "fam-base" || over.pay === true
        ? [
            {
              payment_id: "p",
              dedupe_key: `k-${name}-${id}`,
              network: ENTRY.network,
              asset: ENTRY.asset,
              to: ENTRY.payTo,
              amount_atomic: ENTRY.amount,
              valid: true,
              terms_verified: "offered",
              authorization_seconds: 60,
            },
          ]
        : [],
    delivered: false,
    exit_code: 0,
    timed_out: false,
  }));
  for (const r of records) writeFileSync(join(dir, "runs", `${r.run_id}.json`), JSON.stringify(r));
  writeFileSync(
    join(dir, "report.json"),
    JSON.stringify({
      schema: "x402-redteam/report@3",
      harness_version: "0.1.0",
      seed: over.seed ?? "x402-redteam-v1",
      corpus_hash: over.hash ?? "hp",
      runs: records.map((r) => ({ run_id: r.run_id })),
      scenarios: records.map((r) => ({
        id: r.scenario_id,
        results: [{ attempts: [{ run_id: r.run_id, status: "pass", reached: true }] }],
      })),
    }),
  );
  return dir;
}

const spec = (id: string, dir: string) => `id=${id},core=c,wrapper=w,dir=${dir}`;

describe("runDiffCommand (U29-3)", () => {
  it("succeeds on stubbed run dirs and prints counts only", () => {
    const root = tmp();
    const m = manifest(root);
    const a = runDir(root, "a", {});
    const b = runDir(root, "b", { pay: true });
    const out = join(root, "out");
    const line = runDiffCommand({ manifest: m, out, client: [spec("a", a), spec("b", b)] }, []);
    expect(line).toBe(
      "diff: 2 case(s), 1 flagged, invariant 0, expectation 0, differential wrapper 1 / implementation 0, voided 0, missing a=0 b=0",
    );
    expect(line).not.toMatch(/fam-/);
    expect(readFileSync(join(out, "diff.json"), "utf8")).toContain(FUZZ_PRIVATE_MARKER);
  });

  it("takes run dirs positionally when no --client has dir=", () => {
    const root = tmp();
    const m = manifest(root);
    const a = runDir(root, "a", {});
    const line = runDiffCommand(
      { manifest: m, out: join(root, "o"), client: ["id=a,core=c,wrapper=w"] },
      [a],
    );
    expect(line).toMatch(/^diff: 2 case\(s\)/);
  });

  it("refuses a mismatched corpus hash, a mismatched seed, a missing --client and an in-repo --out", () => {
    const root = tmp();
    const m = manifest(root);
    const bad = runDir(root, "h", { hash: "other" });
    expect(() =>
      runDiffCommand({ manifest: m, out: join(root, "o1"), client: [spec("h", bad)] }, []),
    ).toThrow(/corpus_hash/);
    const seed = runDir(root, "s", { seed: "nope" });
    expect(() =>
      runDiffCommand({ manifest: m, out: join(root, "o2"), client: [spec("s", seed)] }, []),
    ).toThrow(/render_seed/);
    const ok = runDir(root, "ok", {});
    expect(() => runDiffCommand({ manifest: m, out: join(root, "o3") }, [ok])).toThrow(
      /one --client/,
    );
    expect(() =>
      runDiffCommand({ manifest: m, out: join(root, "o4"), client: ["id=a,core=c,wrapper=w"] }, [
        ok,
        ok,
      ]),
    ).toThrow(/one --client/);
    expect(() =>
      runDiffCommand(
        { manifest: m, out: join(root, "o5"), client: [spec("a", ok), "id=b,core=c,wrapper=w"] },
        [],
      ),
    ).toThrow(/dir=/);
    expect(() =>
      runDiffCommand({ manifest: m, out: join(REPO, "d-out"), client: [spec("ok", ok)] }, []),
    ).toThrow(/inside a git repository/);
  });
});

describe("runFuzzCommand (U29-2)", () => {
  it("generates the public smoke catalogue and prints counts only", () => {
    const out = tmp();
    const line = runFuzzCommand({ catalogue: PUBLIC, shape: "page", out });
    expect(line).toMatch(/^fuzz: 4 case\(s\) \(2 base\), shape page/);
  });
  it("refuses a bad shape", () => {
    expect(() => runFuzzCommand({ catalogue: PUBLIC, shape: "sse", out: tmp() })).toThrow(
      /--shape "sse" is invalid \(expected page\|chat\|mcp\)/,
    );
  });
  it("generates the mcp shape under corpus-mcp/ and prints counts only", () => {
    const out = tmp();
    const line = runFuzzCommand({ catalogue: PUBLIC, shape: "mcp", out });
    expect(line).toMatch(/^fuzz: 4 case\(s\) \(2 base\), shape mcp, corpus .*corpus-mcp$/);
  });
});

describe("collectOption", () => {
  it("appends each use to the list", () => {
    expect(collectOption("a")).toEqual(["a"]);
    expect(collectOption("b", ["a"])).toEqual(["a", "b"]);
  });
});
