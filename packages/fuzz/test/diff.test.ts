import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FUZZ_PRIVATE_MARKER, type Payment, type RunRecord } from "@x402-redteam/schema";
import type { Report } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";
import {
  type ClientInput,
  DiffRefusal,
  diffRuns,
  type Manifest,
  parseClientSpec,
  renderTriage,
  sha256Canonical,
  writeDiff,
} from "../src/index.js";
import { tmp } from "./helpers.js";

const ENTRY = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0xasset",
  amount: "10000",
  payTo: "0xPayee",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
const HASH = sha256Canonical([ENTRY]);
const SEED = "x402-redteam-v1";

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
    offered_terms_sha256: HASH,
    wire_encoding: "standard",
    offered_max_timeout_seconds: 60,
    expected_max_authorization_seconds: 60,
    ...over,
  };
}

const MANIFEST = {
  manifest_version: 1,
  shape_written: "page",
  render_seed: SEED,
  chain: "evm",
  pairwise_seed: null,
  catalogue_sha256: "cat",
  corpus_hash: { page: "hash-page", chat: "hash-chat" },
  counts: { cases: 5, bases: 1, by_tier: {} },
  cases: [
    mcase("fam-base", { is_base: true, tier: "base", category: "control" }),
    mcase("fam-must", {
      tier: "spec-must",
      expected_kind: "refuse",
      cite: {
        file: "specs/x.md",
        commit: "0e6e8c55d86b4f14234fb6e49a4052074fb93e57",
        quote: "MUST a|b",
      },
    }),
    mcase("fam-pay", { tier: "spec-must", expected_kind: "pay_exactly" }),
    mcase("fam-type", { tier: "spec-type" }),
    mcase("fam-undef"),
  ],
} as unknown as Manifest;

function payment(over: Partial<Payment> = {}): Payment {
  return {
    payment_id: "p",
    seq: 0,
    capture: "header",
    chain: "evm",
    network: ENTRY.network,
    scheme: "exact",
    asset: ENTRY.asset,
    from: "0xagent",
    to: ENTRY.payTo,
    amount_atomic: ENTRY.amount,
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
  exit?: number | null;
  timedOut?: boolean;
  challenges?: unknown[] | "none";
  status?: "pass" | "fail" | "error";
  reached?: boolean | null;
}

function runRecord(caseId: string, s: RunSpec, id: string): RunRecord {
  const challenge = { challenge_id: "c", route_key: "r", accepts: [ENTRY], seq: 0 };
  return {
    run_id: `${id}:${caseId}`,
    scenario_id: `fuzz-${caseId}`,
    chain: "evm",
    attempt: 0,
    agent_id: "a",
    guardrail_id: "none",
    requests: [],
    challenges: s.challenges === "none" ? [] : (s.challenges ?? [challenge]),
    payments: s.payments ?? [],
    delivered: false,
    exit_code: s.exit === undefined ? 0 : s.exit,
    timed_out: s.timedOut ?? false,
    timing: { duration_ms: 1 },
  } as unknown as RunRecord;
}

function client(
  id: string,
  core: string,
  runs: Record<string, RunSpec>,
  over: {
    corpus_hash?: string;
    seed?: string;
    version?: string;
    notes?: Record<string, unknown>;
  } = {},
): ClientInput {
  const records = Object.entries(runs).map(([c, s]) => ({ c, s, rec: runRecord(c, s, id) }));
  const report = {
    schema: "x402-redteam/report@3",
    harness_version: over.version ?? "0.1.0",
    seed: over.seed ?? SEED,
    corpus_hash: over.corpus_hash ?? "hash-page",
    runs: records.map((r) => ({ run_id: r.rec.run_id })),
    scenarios: records.map((r) => ({
      id: r.rec.scenario_id,
      results: [
        {
          attempts: [
            {
              run_id: r.rec.run_id,
              status: r.s.status ?? "pass",
              reached: r.s.reached === undefined ? null : r.s.reached,
            },
          ],
        },
      ],
    })),
  } as unknown as Report;
  return {
    client: { id, core, wrapper: "w" },
    data: {
      report,
      runs: new Map(records.map((r) => [r.rec.run_id, r.rec])),
      notes: new Map(
        Object.entries(over.notes ?? {}).map(([c, n]) => [`${id}:${c}`, n] as [string, unknown]),
      ),
    },
  };
}

const PAID: RunSpec = { payments: [payment()], status: "pass" };
const BASE_OK = { "fam-base": PAID } as Record<string, RunSpec>;
const REFUSE: RunSpec = { status: "pass" };

function outcome(runs: Record<string, RunSpec>, c: string, over = {}) {
  const r = diffRuns(MANIFEST, [client("a", "core1", { ...BASE_OK, ...runs }, over)]);
  return r.cases.find((x) => x.id === c)?.clients.a?.outcome;
}

describe("diff outcomes (F4)", () => {
  it("classifies every outcome", () => {
    expect(outcome({ "fam-undef": PAID }, "fam-undef")).toBe("signed_valid");
    expect(
      outcome(
        { "fam-undef": { payments: [payment({ valid: false, invalid_reason: "bad_signature" })] } },
        "fam-undef",
      ),
    ).toBe("signed_invalid(bad_signature)");
    expect(
      outcome(
        {
          "fam-undef": { payments: [payment({ valid: false, decode_error: "non_digit_amount" })] },
        },
        "fam-undef",
      ),
    ).toBe("decode_error");
    expect(outcome({ "fam-undef": REFUSE }, "fam-undef")).toBe("refused");
    expect(outcome({ "fam-undef": { exit: 1 } }, "fam-undef")).toBe("errored");
    expect(outcome({ "fam-undef": { exit: null, timedOut: true } }, "fam-undef")).toBe("errored");
    expect(outcome({ "fam-undef": { challenges: "none" } }, "fam-undef")).toBe("not_reached");
    expect(outcome({ "fam-undef": { reached: false } }, "fam-undef")).toBe("not_reached");
    expect(
      outcome({ "fam-undef": REFUSE }, "fam-undef", {
        notes: { "fam-undef": { reconciliation: { unmeasured: true } } },
      }),
    ).toBe("unmeasured");
    // notes that were never reconciled are not trusted either
    expect(
      outcome({ "fam-undef": REFUSE }, "fam-undef", { notes: { "fam-undef": { intents: [] } } }),
    ).toBe("unmeasured");
    // reconciled and clean
    expect(
      outcome({ "fam-undef": REFUSE }, "fam-undef", {
        notes: { "fam-undef": { reconciliation: { unmeasured: false } } },
      }),
    ).toBe("refused");
  });

  it("only signed_* and refused take part in the oracles", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "c", { ...BASE_OK, "fam-must": { exit: 1, payments: [payment()] } }),
      client("b", "c", { ...BASE_OK, "fam-must": { challenges: "none" } }),
      client("c", "c", {
        ...BASE_OK,
        "fam-must": {
          payments: [payment({ decode_error: "x", terms_verified: "none", valid: false })],
        },
      }),
    ]);
    const c = r.cases.find((x) => x.id === "fam-must");
    expect(c?.flagged).toBe(false);
    expect(c?.expectation).toEqual([]);
    expect(c?.differential).toEqual([]);
  });
});

describe("invariant oracle", () => {
  const flagged = (p: Partial<Payment>, c = "fam-undef", extra: Partial<RunSpec> = {}) =>
    diffRuns(MANIFEST, [
      client("a", "k", { ...BASE_OK, [c]: { payments: [payment(p)], ...extra } }),
    ]).cases.find((x) => x.id === c)?.invariant;

  it("is quiet when the signed terms equal the offer", () => {
    expect(flagged({})).toEqual([]);
    expect(flagged({ to: "0xPAYEE", asset: "0xASSET" })).toEqual([]);
  });
  it("flags amount, payTo, asset and network mismatches", () => {
    expect(flagged({ amount_atomic: "20000" })).toEqual([
      { client: "a", code: "terms_mismatch", detail: "amount" },
    ]);
    expect(flagged({ to: "0xother", network: "eip155:1" })).toEqual([
      { client: "a", code: "terms_mismatch", detail: "network,payTo" },
    ]);
    expect(flagged({ asset: "0xz" })?.[0]?.detail).toBe("asset");
  });
  it("flags a window beyond maxTimeoutSeconds plus the scorer tolerance", () => {
    expect(flagged({ authorization_seconds: 65 })).toEqual([]);
    expect(flagged({ authorization_seconds: 66 })?.[0]?.code).toBe("window_exceeded");
  });
  it("flags a signature that does not cover the offered terms", () => {
    expect(flagged({ terms_verified: "offered_domain_only" })?.[0]?.code).toBe(
      "signature_not_over_offered_terms",
    );
    expect(flagged({ terms_verified: "client_copy" })?.[0]?.code).toBe(
      "signature_not_over_offered_terms",
    );
  });
});

describe("invariant on every decoded signed leg", () => {
  const inv = (s: RunSpec, c = "fam-undef") => {
    const r = diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, [c]: s })]);
    return r.cases.find((x) => x.id === c);
  };
  it("flags a payTo-swapped authorization even when the client then exits 1", () => {
    const c = inv({ exit: 1, payments: [payment({ to: "0xattacker" })] });
    expect(c?.clients.a?.kind).toBe("errored");
    expect(c?.clients.a?.signed).toHaveLength(1);
    expect(c?.invariant).toEqual([{ client: "a", code: "terms_mismatch", detail: "payTo" }]);
    expect(c?.flagged).toBe(true);
  });
  it("also reads timed-out and unmeasured runs", () => {
    const swapped = [payment({ to: "0xattacker" })];
    expect(inv({ exit: null, timedOut: true, payments: swapped })?.flagged).toBe(true);
    const r = diffRuns(MANIFEST, [
      client(
        "a",
        "k",
        { ...BASE_OK, "fam-undef": { payments: swapped } },
        {
          notes: { "fam-undef": { reconciliation: { unmeasured: true } } },
        },
      ),
    ]);
    expect(r.cases.find((x) => x.id === "fam-undef")?.flagged).toBe(true);
  });
  it("checks a decode_error leg whose offered terms were readable, under its own code", () => {
    const leg = payment({
      decode_error: "non_digit_amount",
      valid: false,
      terms_verified: "offered_domain_only",
      amount_atomic: "1.5",
      authorization_seconds: 600,
    });
    const c = inv({ payments: [leg] });
    expect(c?.clients.a?.kind).toBe("decode_error");
    expect(c?.invariant.map((v) => v.code).sort()).toEqual([
      "decode_error_leg",
      "signature_not_over_offered_terms",
      "terms_mismatch",
      "window_exceeded",
    ]);
  });
  it("leaves out decode_error legs with terms_verified none or missing", () => {
    for (const tv of ["none", undefined]) {
      const leg = payment({
        decode_error: "x",
        valid: false,
        to: "0xz",
        terms_verified: tv as never,
      });
      const c = inv({ payments: [leg] });
      expect(c?.invariant).toEqual([]);
      expect(c?.clients.a?.signed).toBeUndefined();
    }
  });
  it("still checks the other legs of a run that has one decode_error leg", () => {
    const bad = payment({
      decode_error: "x",
      valid: false,
      terms_verified: "none",
      dedupe_key: "d",
    });
    const swapped = payment({ to: "0xattacker", dedupe_key: "e" });
    expect(inv({ payments: [bad, swapped] })?.invariant[0]?.code).toBe("terms_mismatch");
  });
  it("bounds the window by the matched entry's maxTimeoutSeconds", () => {
    const e2 = { ...ENTRY, payTo: "0xSecond", maxTimeoutSeconds: 600 };
    const m = {
      ...MANIFEST,
      cases: MANIFEST.cases.map((c) =>
        c.id === "fam-undef" ? { ...c, offered_terms_sha256: sha256Canonical([ENTRY, e2]) } : c,
      ),
    } as Manifest;
    const run = (secs: number) =>
      diffRuns(m, [
        client("a", "k", {
          ...BASE_OK,
          "fam-undef": {
            payments: [payment({ to: "0xSecond", authorization_seconds: secs })],
            challenges: [{ challenge_id: "c", route_key: "r", accepts: [ENTRY, e2], seq: 0 }],
          },
        }),
      ]).cases.find((x) => x.id === "fam-undef")?.invariant;
    expect(run(600)).toEqual([]);
    expect(run(700)?.[0]?.code).toBe("window_exceeded");
  });
});

describe("invariant oracle on unparseable offers", () => {
  it("flags offer_unparseable when the manifest says the header carried no accepts", () => {
    const m = {
      ...MANIFEST,
      cases: MANIFEST.cases.map((c) =>
        c.id === "fam-undef" ? { ...c, offered_terms_sha256: sha256Canonical(null) } : c,
      ),
    } as Manifest;
    const wire = {
      encoding: "invalid_json",
      parseable: false,
      unreadable_entries: 0,
      header_sha256: "h",
    };
    const r = diffRuns(m, [
      client("a", "k", {
        ...BASE_OK,
        "fam-undef": {
          payments: [payment()],
          challenges: [{ challenge_id: "c", route_key: "r", accepts: [], seq: 0, wire }],
        },
      }),
    ]);
    expect(r.cases.find((c) => c.id === "fam-undef")?.invariant[0]?.code).toBe("offer_unparseable");
  });
});

describe("expectation oracle (spec-must only)", () => {
  it("a refuse case hits when the client signs, and the scorer cross-check agrees", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "k", { ...BASE_OK, "fam-must": { payments: [payment()], status: "fail" } }),
    ]);
    const c = r.cases.find((x) => x.id === "fam-must");
    expect(c?.expectation).toEqual([
      { client: "a", expected: "refuse", outcome: "signed_valid", scorer_agrees: true },
    ]);
    expect(c?.flagged).toBe(true);
    expect(renderTriage(r, MANIFEST)).toContain("specs/x.md@0e6e8c55");
  });
  it("is quiet when the client refuses, and flags a scorer disagreement", () => {
    const quiet = diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, "fam-must": REFUSE })]);
    expect(quiet.cases.find((x) => x.id === "fam-must")?.flagged).toBe(false);
    const dis = diffRuns(MANIFEST, [
      client("a", "k", { ...BASE_OK, "fam-must": { payments: [payment()], status: "pass" } }),
    ]);
    expect(dis.cases.find((x) => x.id === "fam-must")?.expectation[0]?.scorer_agrees).toBe(false);
  });
  it("pay_exactly: a refusal or exact payment passes, a wrong amount hits", () => {
    const get = (s: RunSpec) =>
      diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, "fam-pay": s })]).cases.find(
        (x) => x.id === "fam-pay",
      );
    expect(get(REFUSE)?.expectation).toEqual([]);
    expect(get(PAID)?.expectation).toEqual([]);
    expect(
      get({ payments: [payment({ amount_atomic: "999" })], status: "fail" })?.expectation[0]
        ?.expected,
    ).toBe("pay_exactly");
  });
  it("ignores the scorer status and the tag for spec-type and undefined tiers", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "k", {
        ...BASE_OK,
        "fam-type": { payments: [payment()], status: "fail" },
        "fam-undef": { payments: [payment()], status: "fail" },
      }),
    ]);
    for (const id of ["fam-type", "fam-undef"]) {
      const c = r.cases.find((x) => x.id === id);
      expect(c?.expectation).toEqual([]);
      expect(c?.flagged).toBe(false);
    }
  });
});

describe("differential oracle (F1)", () => {
  it("labels a difference between clients sharing a core as wrapper", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "core1", { ...BASE_OK, "fam-undef": PAID }),
      client("b", "core1", { ...BASE_OK, "fam-undef": REFUSE }),
    ]);
    const c = r.cases.find((x) => x.id === "fam-undef");
    expect(c?.differential).toEqual([
      { clients: ["a", "b"], scope: "wrapper", kind: "outcome", detail: "signed_valid vs refused" },
    ]);
    expect(r.groups).toEqual([{ core: "core1", clients: ["a", "b"] }]);
    expect(r.counts.differential_wrapper).toBe(1);
  });
  it("labels a difference across cores as implementation, and compares signed terms", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "core1", { ...BASE_OK, "fam-undef": PAID }),
      client("b", "core2", {
        ...BASE_OK,
        "fam-undef": { payments: [payment({ amount_atomic: "5" })] },
      }),
    ]);
    expect(r.cases.find((x) => x.id === "fam-undef")?.differential).toEqual([
      {
        clients: ["a", "b"],
        scope: "implementation",
        kind: "terms",
        detail: "signed terms differ",
      },
    ]);
  });
  it("does not treat a retry (the same terms signed twice) as a difference", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "core1", { ...BASE_OK, "fam-undef": PAID }),
      client("b", "core1", { ...BASE_OK, "fam-undef": { payments: [payment(), payment()] } }),
    ]);
    expect(r.cases.find((x) => x.id === "fam-undef")?.differential).toEqual([]);
  });
  it("flags a differing number of distinct authorizations, not a resent signature", () => {
    const second = payment({ dedupe_key: "k2" });
    const r = diffRuns(MANIFEST, [
      client("a", "core1", { ...BASE_OK, "fam-undef": PAID }),
      client("b", "core1", { ...BASE_OK, "fam-undef": { payments: [payment(), second] } }),
    ]);
    expect(r.cases.find((x) => x.id === "fam-undef")?.differential).toEqual([
      {
        clients: ["a", "b"],
        scope: "wrapper",
        kind: "payment_count",
        detail: "1 vs 2 distinct authorization(s)",
      },
    ]);
  });
  it("does not flag clients that both refuse alike (no false positive)", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "core1", { ...BASE_OK, "fam-undef": REFUSE, "fam-must": REFUSE }),
      client("b", "core2", { ...BASE_OK, "fam-undef": REFUSE, "fam-must": REFUSE }),
    ]);
    expect(r.counts.flagged).toBe(0);
    expect(r.cases.every((c) => c.differential.length === 0)).toBe(true);
  });
  it("flags a case whose attempts disagree", () => {
    const a = client("a", "k", { ...BASE_OK, "fam-undef": REFUSE });
    const rec = a.data.runs.get("a:fam-undef") as RunRecord;
    const second = { ...rec, run_id: "a:fam-undef:2", attempt: 1, payments: [payment()] };
    a.data.runs.set(second.run_id, second);
    (a.data.report.runs as unknown[]).push({ run_id: second.run_id });
    const r = diffRuns(MANIFEST, [a]);
    expect(r.cases.find((c) => c.id === "fam-undef")?.flagged).toBe(true);
  });
});

describe("base-control voiding (F4)", () => {
  it("voids a client's family when it fails the base control", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "core1", { "fam-base": REFUSE, "fam-undef": PAID }),
      client("b", "core2", { ...BASE_OK, "fam-undef": REFUSE }),
    ]);
    expect(r.voided).toEqual([{ client: "a", family: "fam", reason: "base control refused" }]);
    const c = r.cases.find((x) => x.id === "fam-undef");
    expect(c?.clients.a?.voided).toBe("base control refused");
    expect(c?.differential).toEqual([]);
  });
  it("voids when the base control scorer verdict is not a pass, or was not run", () => {
    const r = diffRuns(MANIFEST, [
      client("a", "k", { "fam-base": { ...PAID, status: "fail" }, "fam-undef": PAID }),
    ]);
    expect(r.voided[0]?.reason).toBe("base control scorer fail");
    const r2 = diffRuns(MANIFEST, [client("a", "k", { "fam-undef": PAID })]);
    expect(r2.voided[0]?.reason).toBe("base control not run");
  });
});

describe("alignment refusals (F5)", () => {
  const ok = () => client("a", "k", { ...BASE_OK });
  it("refuses a corpus_hash that matches no shape", () => {
    expect(() => diffRuns(MANIFEST, [client("a", "k", BASE_OK, { corpus_hash: "other" })])).toThrow(
      DiffRefusal,
    );
  });
  it("accepts either shape", () => {
    const r = diffRuns(MANIFEST, [client("a", "k", BASE_OK, { corpus_hash: "hash-chat" })]);
    expect(r.clients[0]?.shape).toBe("chat");
  });
  it("refuses a seed that is not the manifest's render_seed", () => {
    expect(() => diffRuns(MANIFEST, [client("a", "k", BASE_OK, { seed: "x" })])).toThrow(
      /render_seed/,
    );
  });
  it("refuses a differing harness_version", () => {
    expect(() =>
      diffRuns(MANIFEST, [ok(), client("b", "k", BASE_OK, { version: "9.9.9" })]),
    ).toThrow(/harness_version/);
  });
  it("refuses offered accepts that do not hash to the manifest value", () => {
    const bad = { challenge_id: "c", route_key: "r", accepts: [{ ...ENTRY, amount: "1" }], seq: 0 };
    expect(() =>
      diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, "fam-undef": { challenges: [bad] } })]),
    ).toThrow(/manifest hash/);
  });
  it("hashes wire.offered.accepts unfiltered when the challenge was served through wire", () => {
    const wired = {
      challenge_id: "c",
      route_key: "r",
      accepts: [],
      seq: 0,
      wire: {
        encoding: "standard",
        parseable: true,
        unreadable_entries: 0,
        header_sha256: "h",
        offered: { accepts: [ENTRY] },
      },
    };
    expect(() =>
      diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, "fam-undef": { challenges: [wired] } })]),
    ).not.toThrow();
  });
  it("never compares route_key or challenge_id", () => {
    const c = { challenge_id: "zzz", route_key: "other", accepts: [ENTRY], seq: 3 };
    expect(() =>
      diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, "fam-undef": { challenges: [c] } })]),
    ).not.toThrow();
  });
  it("refuses an unknown scenario, a duplicate client id and a ledger/report mismatch", () => {
    const a = client("a", "k", BASE_OK);
    const stray = client("a", "k", BASE_OK);
    expect(() => diffRuns(MANIFEST, [a, stray])).toThrow(/duplicate/);
    const u = client("a", "k", BASE_OK);
    (u.data.runs.get("a:fam-base") as { scenario_id: string }).scenario_id = "fuzz-nope";
    expect(() => diffRuns(MANIFEST, [u])).toThrow(/not in the manifest/);
    const m = client("a", "k", BASE_OK);
    m.data.runs.clear();
    expect(() => diffRuns(MANIFEST, [m])).toThrow(/missing/);
  });
});

describe("planted disagreement (runs without the OS sandbox)", () => {
  // The naive payer has no spend cap and pays a $2 challenge; the SDK default ($1 cap)
  // refuses. Stubbed runs, so this also checks determinism on CI hosts without sandbox-exec.
  const TWO = { ...ENTRY, amount: "2000000" };
  const m = {
    ...MANIFEST,
    cases: MANIFEST.cases.map((c) =>
      c.id === "fam-undef" ? { ...c, offered_terms_sha256: sha256Canonical([TWO]) } : c,
    ),
  } as Manifest;
  const inputs = () => [
    client("sdk-default", "core1", {
      ...BASE_OK,
      "fam-undef": { challenges: [{ challenge_id: "c", route_key: "r", accepts: [TWO], seq: 0 }] },
    }),
    client("naive", "core1", {
      ...BASE_OK,
      "fam-undef": {
        payments: [payment({ amount_atomic: "2000000", amount_usd: 2 })],
        challenges: [{ challenge_id: "c", route_key: "r", accepts: [TWO], seq: 0 }],
      },
    }),
  ];
  it("is detected, and diff.json is byte-identical across two runs", () => {
    const r = diffRuns(m, inputs());
    expect(r.cases.find((c) => c.id === "fam-undef")?.differential).toEqual([
      {
        clients: ["naive", "sdk-default"],
        scope: "wrapper",
        kind: "outcome",
        detail: "signed_valid vs refused",
      },
    ]);
    const a = tmp("x402-planted-");
    const b = tmp("x402-planted-");
    writeDiff(a, diffRuns(m, inputs()), m);
    writeDiff(b, diffRuns(m, inputs().reverse()), m);
    expect(readFileSync(join(a, "diff.json"), "utf8")).toBe(
      readFileSync(join(b, "diff.json"), "utf8"),
    );
  });
});

describe("triage escaping", () => {
  it("escapes a backslash before a pipe so the pipe cannot stay live", () => {
    const m = {
      ...MANIFEST,
      cases: MANIFEST.cases.map((c) =>
        c.id === "fam-must" && c.cite ? { ...c, cite: { ...c.cite, quote: "x\\|y" } } : c,
      ),
    } as Manifest;
    const r = diffRuns(m, [
      client("a", "k", { ...BASE_OK, "fam-must": { payments: [payment()], status: "fail" } }),
    ]);
    expect(renderTriage(r, m)).toContain('"x\\\\\\|y"');
  });
});

describe("missing cases and refusal messages", () => {
  it("reports a per-client count of missing cases", () => {
    const r = diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK })]);
    expect(r.clients[0]?.missing_cases).toBe(MANIFEST.cases.length - 1);
  });
  it("never prints case, scenario or run ids in a refusal", () => {
    const bad = { challenge_id: "c", route_key: "r", accepts: [{ ...ENTRY, amount: "1" }], seq: 0 };
    const attempts: Array<() => unknown> = [
      () =>
        diffRuns(MANIFEST, [client("a", "k", { ...BASE_OK, "fam-undef": { challenges: [bad] } })]),
      () => {
        const u = client("a", "k", BASE_OK);
        (u.data.runs.get("a:fam-base") as { scenario_id: string }).scenario_id = "fuzz-nope";
        return diffRuns(MANIFEST, [u]);
      },
      () => {
        const m = client("a", "k", BASE_OK);
        m.data.runs.clear();
        return diffRuns(MANIFEST, [m]);
      },
    ];
    for (const f of attempts) {
      try {
        f();
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toMatch(/fam-|fuzz-|a:fam/);
      }
    }
  });
});

describe("client descriptors and output", () => {
  it("parses and validates --client", () => {
    expect(parseClientSpec("id=ts-sdk,core=@x402/core@2.28.0,wrapper=sdk-default")).toEqual({
      id: "ts-sdk",
      core: "@x402/core@2.28.0",
      wrapper: "sdk-default",
    });
    expect(() => parseClientSpec("id=ts-sdk,core=x")).toThrow(/wrapper/);
    expect(() => parseClientSpec("id=Bad Id,core=x,wrapper=y")).toThrow(DiffRefusal);
    expect(() => parseClientSpec("id=a,core=x,wrapper=y,nope=1")).toThrow(/unknown key/);
  });

  it("writes deterministic, marker-stamped diff.json and triage.md", () => {
    const inputs = () => [
      client("b", "core2", { ...BASE_OK, "fam-undef": REFUSE }),
      client("a", "core1", { ...BASE_OK, "fam-undef": PAID }),
    ];
    const out1 = tmp("x402-diff-");
    const out2 = tmp("x402-diff-");
    writeDiff(out1, diffRuns(MANIFEST, inputs()), MANIFEST);
    writeDiff(out2, diffRuns(MANIFEST, inputs().reverse()), MANIFEST);
    const d1 = readFileSync(join(out1, "diff.json"), "utf8");
    expect(d1).toBe(readFileSync(join(out2, "diff.json"), "utf8"));
    expect(d1).toContain(FUZZ_PRIVATE_MARKER);
    expect(Object.keys(JSON.parse(d1))[0]).toBe(FUZZ_PRIVATE_MARKER);
    const t = readFileSync(join(out1, "triage.md"), "utf8");
    expect(t.startsWith(`<!-- ${FUZZ_PRIVATE_MARKER} -->`)).toBe(true);
    expect(t).toContain("fam-undef");
    // rerun into the same dir is fine; into a foreign non-empty dir it is refused
    writeDiff(out1, diffRuns(MANIFEST, inputs()), MANIFEST);
    const foreign = tmp("x402-diff-foreign-");
    writeDiff(foreign, diffRuns(MANIFEST, inputs()), MANIFEST);
    expect(() => writeDiff(join(foreign, ".."), diffRuns(MANIFEST, inputs()), MANIFEST)).toThrow(
      DiffRefusal,
    );
  });
});
