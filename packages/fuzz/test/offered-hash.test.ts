import { createHash } from "node:crypto";
import { type Adversary, createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import { canonicalize, loadCorpus, type Scenario } from "@x402-redteam/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RENDER_SEED, generate, SHAPES } from "../src/index.js";
import { BASE, PUBLIC_CATALOGUE, tmp, writeCatalogue } from "./helpers.js";

const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(v)))
    .digest("hex");

/** What a client can read from a served header: the `accepts` of its decoded JSON, else null. */
function acceptsOf(header: string): unknown {
  try {
    const obj = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return Array.isArray(obj?.accepts) ? obj.accepts : null;
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
