import { createHash } from "node:crypto";
import { type Adversary, createAdversary, offeredTermsForScenario } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import { canonicalize, loadCorpus, type RunRecord, type Scenario } from "@x402-redteam/schema";
import type { Report } from "@x402-redteam/scorer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RENDER_SEED, diffRuns, generate, SHAPES, sha256Canonical } from "../src/index.js";
import { BASE, PUBLIC_CATALOGUE, tmp, writeCatalogue } from "./helpers.js";

const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(v)))
    .digest("hex");

/** The `accepts` value of a served header's decoded JSON, unfiltered (any type), else null. */
function acceptsOf(header: string): unknown {
  try {
    const obj = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return obj?.accepts === undefined ? null : obj.accepts;
  } catch {
    return null;
  }
}

const wire = (id: string, body: string) =>
  `id: ${id}\nfamily: fam\ncategory: challenge_injection\ntier: undefined\n${body}`;

const CATALOGUE = {
  "b.yaml": BASE("fam"),
  "typed.yaml": wire("typed-amount", 'challenge:\n  amount_atomic: "10.5"\n'),
  "unpadded.yaml": wire("enc-unpadded", "wire:\n  encoding: unpadded\n"),
  "urlsafe.yaml": wire("enc-url-safe", "wire:\n  encoding: url_safe\n"),
  "invalid.yaml": wire("enc-invalid", "wire:\n  encoding: invalid_json\n"),
  "rawbad.yaml": wire("enc-raw-garbage", 'wire:\n  encoding: "raw:!!!not-base64!!!"\n'),
  "rawjson.yaml": wire(
    "enc-dup-keys",
    `wire:\n  encoding: 'raw_json:{"x402Version":2,"resource":{"url":"http://provider.test/x"},"accepts":[{"scheme":"exact","network":"{{network}}","asset":"{{usdc}}","amount":"1","amount":"10000","payTo":"{{canary.legit}}","maxTimeoutSeconds":60,"extra":{"name":"USDC","version":"2"}}]}'\n`,
  ),
  "num.yaml": wire("amount-number", "accept_patch:\n  amount: 10000\n"),
  "timeout.yaml": wire("timeout-string", 'accept_patch:\n  maxTimeoutSeconds: "60"\n'),
  "empty.yaml": wire("accepts-empty", "wire:\n  patch:\n    accepts: []\n"),
  "notarray.yaml": wire("accepts-object", "wire:\n  patch:\n    accepts:\n      scheme: exact\n"),
  "str.yaml": wire("accepts-string", "wire:\n  patch:\n    accepts: oops\n"),
  "differs.yaml": wire("body-differs", 'accept_patch:\n  amount: "99"\nwire:\n  body: differs\n'),
};

let adversary: Adversary;
let n = 0;
beforeAll(async () => {
  adversary = await createAdversary({ seed: DEFAULT_RENDER_SEED, capture });
});
afterAll(async () => {
  await adversary.close();
});

async function served(scenario: Scenario): Promise<string | null> {
  n += 1;
  adversary.load({ scenario, chain: "evm", run_id: `fuzz-${n}` });
  const route = scenario.routes[0];
  const res = await fetch(`${adversary.baseUrl}${route?.path}`, { method: route?.method });
  expect(res.status).toBe(402);
  return res.headers.get("PAYMENT-REQUIRED");
}

describe("manifest offered-terms hash == what the adversary serves", () => {
  for (const [label, dir] of [
    ["public catalogue", PUBLIC_CATALOGUE],
    ["wire catalogue", writeCatalogue(CATALOGUE)],
  ] as const) {
    for (const shape of SHAPES) {
      it(`${label}, shape ${shape}`, async () => {
        const { manifest, corpusDir } = generate({ catalogueDir: dir, shape, outDir: tmp() });
        const scenarios = new Map(loadCorpus(corpusDir).map((s) => [s.id, s]));
        // The mcp shape is served over /mcp and is covered in mcp-shape.test.ts.
        if (shape === "mcp") return;
        expect(scenarios.size).toBe(manifest.cases.length);
        for (const c of manifest.cases) {
          const header = await served(scenarios.get(c.scenario_id) as Scenario);
          expect(header, c.id).not.toBeNull();
          expect(hash(acceptsOf(header as string)), c.id).toBe(c.offered_terms_sha256);
        }
      });
    }
  }

  it("the hash tells mutations apart (not a constant)", () => {
    const { manifest } = generate({
      catalogueDir: writeCatalogue(CATALOGUE),
      shape: "page",
      outDir: tmp(),
    });
    const hashes = manifest.cases.map((c) => c.offered_terms_sha256);
    expect(new Set(hashes).size).toBeGreaterThan(hashes.length - 4);
    expect(manifest.cases.find((c) => c.id === "enc-invalid")?.offered_terms_sha256).toBe(
      hash(null),
    );
  });
});

describe("diff re-hashes the same value the generator hashed", () => {
  it("non-array accepts (object, string): manifest hash == diff re-hash, no refusal", async () => {
    const { manifest, corpusDir } = generate({
      catalogueDir: writeCatalogue(CATALOGUE),
      shape: "page",
      outDir: tmp(),
    });
    const scenarios = new Map(loadCorpus(corpusDir).map((s) => [s.id, s]));
    const ids = ["accepts-object", "accepts-string"];
    const cases = manifest.cases.filter((c) => ids.includes(c.id));
    expect(cases.length).toBe(2);
    const runs = new Map<string, RunRecord>();
    const reportRuns: unknown[] = [];
    const reportScenarios: unknown[] = [];
    for (const c of manifest.cases) {
      const header = await served(scenarios.get(c.scenario_id) as Scenario);
      let offered: unknown;
      try {
        offered = JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
      } catch {
        offered = undefined; // undecodable header: the run record carries no offered object
      }
      const run_id = `a:${c.id}`;
      runs.set(run_id, {
        run_id,
        scenario_id: c.scenario_id,
        chain: "evm",
        attempt: 0,
        agent_id: "a",
        guardrail_id: "none",
        requests: [],
        challenges: [
          {
            challenge_id: "c",
            route_key: "r",
            accepts: [],
            seq: 0,
            wire: { encoding: "standard", parseable: false, unreadable_entries: 0, offered },
          },
        ],
        payments: [],
        delivered: false,
        exit_code: 0,
        timed_out: false,
        timing: { duration_ms: 1 },
      } as unknown as RunRecord);
      reportRuns.push({ run_id });
      reportScenarios.push({
        id: c.scenario_id,
        results: [{ attempts: [{ run_id, status: "pass", reached: null }] }],
      });
    }
    const report = {
      schema: "x402-redteam/report@3",
      harness_version: "0.1.0",
      seed: manifest.render_seed,
      corpus_hash: manifest.corpus_hash.page,
      runs: reportRuns,
      scenarios: reportScenarios,
    } as unknown as Report;
    for (const c of cases) {
      const r = runs.get(`a:${c.id}`) as RunRecord;
      const raw = (r.challenges[0] as { wire: { offered: { accepts: unknown } } }).wire.offered
        .accepts;
      expect(Array.isArray(raw)).toBe(false);
      expect(sha256Canonical(raw)).toBe(c.offered_terms_sha256);
    }
    expect(() =>
      diffRuns(manifest, [
        { client: { id: "a", core: "k", wrapper: "w" }, data: { report, runs, notes: new Map() } },
      ]),
    ).not.toThrow();
  });

  it("array accepts hash exactly as the filtered list did", () => {
    const { manifest } = generate({
      catalogueDir: PUBLIC_CATALOGUE,
      shape: "page",
      outDir: tmp(),
    });
    const s = loadCorpus(
      generate({ catalogueDir: PUBLIC_CATALOGUE, shape: "page", outDir: tmp() }).corpusDir,
    );
    for (const c of manifest.cases) {
      const t = offeredTermsForScenario(
        s.find((x) => x.id === c.scenario_id) as Scenario,
        "evm",
        DEFAULT_RENDER_SEED,
      );
      expect(Array.isArray(t?.rawAccepts) ? t?.rawAccepts : null).toEqual(t?.accepts);
      if (Array.isArray(t?.accepts))
        expect(sha256Canonical(t.accepts)).toBe(c.offered_terms_sha256);
    }
  });
});
