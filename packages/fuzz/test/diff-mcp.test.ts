import type { Payment, RunRecord } from "@x402-redteam/schema";
import type { Report } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";
import {
  type ClientInput,
  DiffRefusal,
  diffRuns,
  type Manifest,
  renderTriage,
  sha256Canonical,
} from "../src/index.js";

/**
 * U30-4 diff behaviour on the `mcp` shape (D2, D3, D7, D8, D10; N3, N5). Stubbed runs only:
 * hand-written manifests and run records, no agent outcome of any real client.
 */

const SEED = "x402-redteam-v1";
const entry = (amount: string) => ({
  scheme: "exact",
  network: "eip155:84532",
  asset: "0xasset",
  amount,
  payTo: "0xPayee",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
});
const E1 = entry("10000");
const E2 = entry("20000");
const H1 = sha256Canonical([E1]);
const H2 = sha256Canonical([E2]);

function mcase(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scenario_id: `fuzz-${id}`,
    family: "fam",
    base_id: "fam-base",
    is_base: false,
    tier: "undefined",
    category: "unit_confusion",
    technique: `fuzz:${id}`,
    cite: null,
    expected_kind: null,
    offered_terms_sha256: H1,
    wire_encoding: "standard",
    offered_max_timeout_seconds: 60,
    expected_max_authorization_seconds: 60,
    ...over,
  };
}

const HASHES = { page: "h-page", chat: "h-chat", mcp: "h-mcp" };
const ALL = ["page", "chat", "mcp"];

function manifest(cases: unknown[]): Manifest {
  return {
    manifest_version: 1,
    shape_written: "page",
    render_seed: SEED,
    chain: "evm",
    pairwise_seed: null,
    catalogue_sha256: "cat",
    corpus_hash: HASHES,
    counts: { cases: cases.length, bases: 1, by_tier: {} },
    cases,
  } as unknown as Manifest;
}

const BASE = mcase("fam-base", {
  is_base: true,
  tier: "base",
  category: "control",
  shapes: ALL,
  tier_by_shape: { page: "base", chat: "base", mcp: "base" },
});
// A spec-must case whose citation is the HTTP transport: it binds page and chat, not mcp.
const MUST = mcase("fam-must", {
  tier: "spec-must",
  expected_kind: "refuse",
  shapes: ALL,
  tier_by_shape: { page: "spec-must", chat: "spec-must", mcp: "undefined" },
});
const PLAIN = mcase("fam-plain", { shapes: ALL });
const DIFFERS = mcase("fam-differs", {
  shapes: ["mcp"],
  offered_terms_sha256: H2,
  offered_terms_sha256_by_channel: { structured: H1, text: H2 },
  sdk_schema_ok: { structured: true, text: true },
});
const PAGE_ONLY = mcase("fam-pageonly", { shapes: ["page", "chat"] });
const SLOW = mcase("fam-timer", {
  shapes: ALL,
  sdk_schema_ok: { structured: true, text: true },
  mcp_paid_timeout_ms: 1500,
});
const STEADY = mcase("fam-steady", {
  shapes: ALL,
  sdk_schema_ok: { structured: true, text: true },
  mcp_paid_timeout_ms: 60000,
});

const CASES = [BASE, MUST, PLAIN, DIFFERS, PAGE_ONLY, SLOW, STEADY];

function payment(over: Partial<Payment> = {}): Payment {
  return {
    payment_id: "p",
    seq: 0,
    capture: "header",
    chain: "evm",
    network: E1.network,
    scheme: "exact",
    asset: E1.asset,
    from: "0xagent",
    to: E1.payTo,
    amount_atomic: E1.amount,
    amount_usd: 0.01,
    dedupe_key: "k",
    instruction_source: "header",
    replay: false,
    valid: true,
    terms_verified: "offered",
    authorization_seconds: 60,
    ...over,
  } as Payment;
}

interface RunSpec {
  payments?: Payment[];
  challenges?: unknown[];
}

const issued = (extra: Record<string, unknown> = {}) => ({
  challenge_id: "c",
  route_key: "r",
  accepts: [E1],
  seq: 0,
  ...extra,
});

function client(
  id: string,
  corpusHash: string,
  runs: Record<string, RunSpec>,
  core = "core1",
): ClientInput {
  const records = Object.entries(runs).map(([c, s]) => ({
    c,
    s,
    rec: {
      run_id: `${id}:${c}`,
      scenario_id: `fuzz-${c}`,
      chain: "evm",
      attempt: 0,
      agent_id: "a",
      guardrail_id: "none",
      requests: [],
      challenges: s.challenges ?? [issued()],
      payments: s.payments ?? [],
      delivered: false,
      exit_code: 0,
      timed_out: false,
      timing: { duration_ms: 1 },
    } as unknown as RunRecord,
  }));
  const report = {
    schema: "x402-redteam/report@3",
    harness_version: "0.1.0",
    seed: SEED,
    corpus_hash: corpusHash,
    runs: records.map((r) => ({ run_id: r.rec.run_id })),
    scenarios: records.map((r) => ({
      id: r.rec.scenario_id,
      results: [{ attempts: [{ run_id: r.rec.run_id, status: "pass", reached: null }] }],
    })),
  } as unknown as Report;
  return {
    client: { id, core, wrapper: "w" },
    data: {
      report,
      runs: new Map(records.map((r) => [r.rec.run_id, r.rec])),
      notes: new Map(),
    },
  };
}

const PAID: RunSpec = { payments: [payment()] };
const mcpClient = (runs: Record<string, RunSpec>) => client("mcp-c", HASHES.mcp, runs);
const pageClient = (runs: Record<string, RunSpec>) => client("page-c", HASHES.page, runs);
const find = (r: ReturnType<typeof diffRuns>, id: string) => r.cases.find((c) => c.id === id);

describe("old manifests and page-only runs (D10, N5)", () => {
  const strip = (m: Manifest): Manifest => {
    const copy = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
    const cases = (copy.cases as Record<string, unknown>[]).map((c) => {
      const {
        shapes: _s,
        tier_by_shape: _t,
        sdk_schema_ok: _k,
        mcp_paid_timeout_ms: _m,
        offered_terms_sha256_by_channel: _b,
        ...rest
      } = c;
      return rest;
    });
    const hash = copy.corpus_hash as Record<string, string>;
    copy.corpus_hash = { page: hash.page, chat: hash.chat };
    return { ...copy, cases } as unknown as Manifest;
  };

  it("an old manifest (no shapes, no corpus_hash.mcp) plus a page run gives an unchanged diff", () => {
    const full = manifest([BASE, MUST, PLAIN, PAGE_ONLY]);
    const runs = { "fam-base": PAID, "fam-must": PAID, "fam-plain": {}, "fam-pageonly": PAID };
    const withNew = diffRuns(full, [pageClient(runs)]);
    const old = diffRuns(strip(full), [pageClient(runs)]);
    // Everything but the echoed corpus_hash (the new manifest carries an mcp key) is equal.
    expect({ ...withNew, manifest: { ...withNew.manifest, corpus_hash: {} } }).toEqual({
      ...old,
      manifest: { ...old.manifest, corpus_hash: {} },
    });
    expect(old.manifest.corpus_hash).toEqual({ page: "h-page", chat: "h-chat" });
    // The old manifest's CaseResult.tier is the page/chat tier; oracle 2 fires on the page tier.
    expect(find(old, "fam-must")?.tier).toBe("spec-must");
    expect(find(old, "fam-must")?.expectation).toHaveLength(1);
  });

  it("a page client's results carry none of the mcp fields", () => {
    const r = diffRuns(manifest([BASE, SLOW, DIFFERS, STEADY]), [
      pageClient({ "fam-base": PAID, "fam-timer": PAID, "fam-steady": PAID }),
    ]);
    for (const c of r.cases) {
      for (const res of Object.values(c.clients)) {
        for (const key of ["channel", "sdk_schema_ok", "mcp_paid_timeout_ms", "timing_sensitive"]) {
          expect(key in res, `${c.id} ${key}`).toBe(false);
        }
      }
    }
  });

  it("missing_cases counts against the cases of the client's own shape", () => {
    const m = manifest(CASES);
    const page = diffRuns(m, [
      pageClient({
        "fam-base": PAID,
        "fam-must": PAID,
        "fam-plain": {},
        "fam-pageonly": {},
        "fam-timer": {},
        "fam-steady": {},
      }),
    ]);
    // fam-differs is mcp-only: the page client is not missing it.
    expect(page.clients[0]).toMatchObject({ shape: "page", cases_run: 6, missing_cases: 0 });
    const mcp = diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-plain": {} })]);
    // The mcp client carries 6 cases (all but fam-pageonly) and ran 2.
    expect(mcp.clients[0]).toMatchObject({ shape: "mcp", cases_run: 2, missing_cases: 4 });
  });
});

describe("tier per shape for oracle 2 (D7, N3)", () => {
  it("a spec-must citation of the HTTP transport hits for a page client, not for an mcp client", () => {
    const m = manifest([BASE, MUST]);
    const page = diffRuns(m, [pageClient({ "fam-base": PAID, "fam-must": PAID })]);
    expect(find(page, "fam-must")?.expectation).toHaveLength(1);
    const mcp = diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-must": PAID })]);
    expect(find(mcp, "fam-must")?.expectation).toEqual([]);
    expect(find(mcp, "fam-must")?.flagged).toBe(false);
    // CaseResult.tier stays the page/chat tier, whichever client ran.
    expect(find(mcp, "fam-must")?.tier).toBe("spec-must");
  });
});

describe("per-channel alignment (D3)", () => {
  const m = manifest([BASE, DIFFERS]);
  const channels = (c: Record<string, unknown>) => ({
    challenges: [issued({ accepts: [E1, E2], channels: c })],
  });

  it("a differs-mode fixture aligns: each channel against its own hash", () => {
    const r = diffRuns(m, [
      mcpClient({
        "fam-base": PAID,
        "fam-differs": {
          ...channels({ structured: { accepts: [E1] }, text: { accepts: [E2] } }),
          payments: [payment({ amount_atomic: "20000" })],
        },
      }),
    ]);
    expect(find(r, "fam-differs")?.clients["mcp-c"]).toMatchObject({
      kind: "signed_valid",
      channel: "text",
      sdk_schema_ok: { structured: true, text: true },
    });
    expect(find(r, "fam-differs")?.invariant).toEqual([]);
  });

  it("a planted disagreement is reported as a refusal that names counts only", () => {
    const run = (c: Record<string, unknown>) =>
      diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-differs": channels(c) })]);
    expect(() => run({ structured: { accepts: [E2] }, text: { accepts: [E2] } })).toThrow(
      DiffRefusal,
    );
    expect(() => run({ structured: { accepts: [E1] } })).toThrow(/do not match the manifest hash/);
    expect(() =>
      run({ structured: { accepts: [E1] }, text: { accepts: [E2] }, error: { accepts: [E1] } }),
    ).toThrow(DiffRefusal);
    // A channel case answered with an issuance that records no channels does not align.
    expect(() => diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-differs": {} })])).toThrow(
      DiffRefusal,
    );
    // And a channel recorded for a case the manifest holds no per-channel hashes for.
    expect(() =>
      diffRuns(manifest([BASE, PLAIN]), [
        mcpClient({
          "fam-base": PAID,
          "fam-plain": channels({ structured: { accepts: [E1] } }),
        }),
      ]),
    ).toThrow(DiffRefusal);
    try {
      run({ structured: { accepts: [E2] }, text: { accepts: [E2] } });
    } catch (err) {
      expect((err as Error).message).not.toMatch(/fam-differs|fuzz-/);
    }
  });

  it("the union of the channels' entries keeps the invariant quiet for either channel", () => {
    for (const amount of ["10000", "20000"]) {
      const r = diffRuns(m, [
        mcpClient({
          "fam-base": PAID,
          "fam-differs": {
            ...channels({ structured: { accepts: [E1] }, text: { accepts: [E2] } }),
            payments: [payment({ amount_atomic: amount })],
          },
        }),
      ]);
      expect(find(r, "fam-differs")?.invariant, amount).toEqual([]);
    }
  });

  it("a signature over neither channel is `none` and breaks the invariant", () => {
    const r = diffRuns(m, [
      mcpClient({
        "fam-base": PAID,
        "fam-differs": {
          ...channels({ structured: { accepts: [E1] }, text: { accepts: [E2] } }),
          payments: [payment({ amount_atomic: "999" })],
        },
      }),
    ]);
    const c = find(r, "fam-differs");
    expect(c?.clients["mcp-c"]?.channel).toBe("none");
    expect(c?.invariant.map((v) => v.code)).toEqual(["terms_mismatch"]);
  });
});

describe("channel observation (D2)", () => {
  const m = manifest([BASE, PLAIN]);
  it("identical copies (no channels recorded) are `multiple`; nothing signed has no observation", () => {
    const r = diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-plain": PAID })]);
    expect(find(r, "fam-plain")?.clients["mcp-c"]?.channel).toBe("multiple");
    const refused = diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-plain": {} })]);
    expect("channel" in (find(refused, "fam-plain")?.clients["mcp-c"] ?? {})).toBe(false);
  });

  it("the observation lives in diff.json's client results only", () => {
    const r = diffRuns(m, [mcpClient({ "fam-base": PAID, "fam-plain": PAID })]);
    expect(Object.keys(r)).toEqual([
      "diff_version",
      "manifest",
      "harness_version",
      "clients",
      "groups",
      "voided",
      "counts",
      "cases",
    ]);
  });
});

describe("timing-sensitive cases (D8, N4)", () => {
  const m = manifest(CASES.filter((c) => [BASE, SLOW, STEADY].includes(c)));
  const runs = { "fam-base": PAID, "fam-timer": PAID, "fam-steady": PAID };

  it("marks a timer below 5000 ms and keeps it out of the differential", () => {
    const r = diffRuns(m, [
      mcpClient(runs),
      pageClient({ "fam-base": PAID, "fam-timer": {}, "fam-steady": {} }),
    ]);
    const slow = find(r, "fam-timer");
    expect(slow?.clients["mcp-c"]).toMatchObject({
      timing_sensitive: true,
      mcp_paid_timeout_ms: 1500,
    });
    expect(slow?.differential).toEqual([]);
    // The same difference on a steady case is reported.
    const steady = find(r, "fam-steady");
    expect(steady?.clients["mcp-c"]?.timing_sensitive).toBeUndefined();
    expect(steady?.clients["mcp-c"]?.mcp_paid_timeout_ms).toBe(60000);
    expect(steady?.differential).toHaveLength(1);
  });
});

describe("page vs mcp on a case both carry", () => {
  it("compares them in one group and reports a wrapper difference", () => {
    const m = manifest([BASE, PLAIN]);
    const r = diffRuns(m, [
      client("ts-sdk", HASHES.page, { "fam-base": PAID, "fam-plain": PAID }, "core1"),
      client("mcp-sdk-default", HASHES.mcp, { "fam-base": PAID, "fam-plain": {} }, "core1"),
    ]);
    expect(r.groups).toEqual([{ core: "core1", clients: ["mcp-sdk-default", "ts-sdk"] }]);
    expect(find(r, "fam-plain")?.differential).toMatchObject([
      { scope: "wrapper", kind: "outcome" },
    ]);
    expect(r.clients.map((c) => [c.id, c.shape, c.missing_cases])).toEqual([
      ["mcp-sdk-default", "mcp", 0],
      ["ts-sdk", "page", 0],
    ]);
  });
});

describe("triage annotations (D1, D6, D8)", () => {
  const ERR = mcase("fam-err", {
    shapes: ["mcp"],
    offered_terms_sha256_by_channel: { error: H1 },
    mcp_error_code: -32042,
    sdk_schema_ok: { error: false },
  });

  it("names the known causes of an mcp difference and never gives a verdict", () => {
    const m = manifest([BASE, ERR, SLOW]);
    const r = diffRuns(m, [
      mcpClient({
        "fam-base": PAID,
        "fam-err": {
          challenges: [issued({ channels: { error: { accepts: [E1] } } })],
          payments: [payment({ amount_atomic: "999" })],
        },
        "fam-timer": { payments: [payment({ amount_atomic: "999" })] },
      }),
    ]);
    const text = renderTriage(r, m);
    expect(text).toContain("mcp clients (U30-4)");
    expect(text).toContain("sdk_schema_ok false");
    expect(text).toContain("base-protocol code collision");
    expect(text).toContain("no verdict");
  });

  it("a page-only triage has no mcp text", () => {
    const m = manifest([BASE, PLAIN]);
    const r = diffRuns(m, [pageClient({ "fam-base": PAID, "fam-plain": PAID })]);
    expect(renderTriage(r, m)).not.toMatch(/mcp|known:/);
  });
});
