import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { type Chain, loadCorpus } from "@x402-redteam/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildRequirementsList } from "../src/rails/x402v2.js";
import { renderScenario } from "../src/render.js";
import { makeCapture } from "./stub-capture.js";

/**
 * U6 note (U11 v2: accepts[]/resource_url/body_json-aware): loads the *real* corpus
 * (not a fixture) into a live adversary server, for both chains, and checks that every
 * declared route serves exactly what its YAML says before any payment is made:
 *  - a free page -> 200 with the rendered page body
 *  - a redirect -> 302 with the rendered target as Location
 *  - a paywalled route -> 402 with a decodable PAYMENT-REQUIRED whose full `accepts[]`
 *    list (network/asset/amount/payTo/extra, in order) matches what
 *    `buildRequirementsList` + the chain defaults resolve to, `resource.url` matches
 *    the route's `resource_url` override (else the real request URL), and the JSON body
 *    matches the route's `body_json` override (else the v1 default shape) - per
 *    application-design.md §5 "v2".
 *
 * This does not simulate an agent (no payments are made here) - U5's own
 * reference-agent suite covers pay/deliver/replay behavior. This test's job
 * is narrower: prove the corpus content, once rendered and served, is
 * internally consistent with itself.
 */

const SEED = "x402-redteam-v1";
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "..", "..", "corpus");

const scenarios = loadCorpus(CORPUS_DIR);

function routeUrl(baseUrl: string, host: string, path: string): string {
  return host === "provider.test" ? `${baseUrl}${path}` : `${baseUrl}/_host/${host}${path}`;
}

describe("corpus smoke (real corpus/*.yaml against a live adversary)", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  it("loaded every corpus v2 scenario (2+ variants x 10 v1 categories + 6 new classes + 4 controls)", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(30);
  });

  for (const scenario of scenarios) {
    for (const chain of scenario.chains as Chain[]) {
      it(`${scenario.id} (${chain}): every declared route responds as expected`, async () => {
        adversary.load({ scenario, chain, run_id: `smoke-${scenario.id}-${chain}` });
        const rendered = renderScenario(scenario, chain, adversary.baseUrl, SEED);

        expect(rendered.routes.length).toBeGreaterThan(0);

        for (const route of rendered.routes) {
          const url = routeUrl(adversary.baseUrl, route.host, route.path);
          const res = await fetch(url, { method: route.method, redirect: "manual" });

          if (route.redirect !== undefined) {
            expect(res.status).toBe(302);
            expect(res.headers.get("location")).toBe(route.redirect);
            continue;
          }

          if (route.challenge !== undefined) {
            expect(res.status).toBe(402);
            const header = res.headers.get("PAYMENT-REQUIRED");
            expect(header).toBeTruthy();
            const decoded: PaymentRequired = decodePaymentRequiredHeader(header as string);
            const expectedList = buildRequirementsList(route, chain, SEED, scenario.assets);

            expect(decoded.accepts).toEqual(expectedList);
            expect(decoded.resource.url).toBe(route.challenge.resource_url ?? url);

            const bodyJson = (await res.clone().json()) as unknown;
            const expectedBody = route.challenge.body_json ?? {
              x402Version: 2,
              error: "payment_required",
              accepts: expectedList,
            };
            expect(bodyJson).toEqual(expectedBody);
            continue;
          }

          expect(res.status).toBe(200);
          const body = await res.text();
          expect(body).toBe(route.page ?? "ok");
        }
      });
    }
  }
});
