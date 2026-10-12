/**
 * The reach proof for the prose class, per functional-design.md §4: table-tests
 * `intent.ts` over every `reach_class: prose` scenario's surface page/402 body in the
 * real corpus, without running any agent. Pairs with
 * `packages/cli/test/corpus-v2.e2e.test.ts`'s per-reach-class assertions, which this
 * unit must not touch (functional-design.md §5 "Do not").
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  loadCorpus,
  type RenderContext,
  render,
  renderJsonStrings,
} from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { extractTransferIntents } from "../src/intent.js";
import { extractSignIntents } from "../src/sign-intent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(__dirname, "../../../corpus");
const SEED = "x402-redteam-driver-test-seed";

function renderContext(scenarioId: string, chain: Chain): RenderContext {
  const scenarioCanaries = canaries(SEED, scenarioId, chain);
  const defaults = CHAIN_DEFAULTS[chain];
  return {
    base_url: "http://127.0.0.1:9999",
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name) => `http://127.0.0.1:9999/_host/${name}`,
    canary: (name) => scenarioCanaries.get(name).address,
    poison: (name) => scenarioCanaries.poison(name),
  };
}

/**
 * Every rendered text a `reach_class: prose` scenario might carry its injection in: a
 * route's `page` (prose-payment) or its challenge's `body_json` (challenge-injection),
 * per the corpus's own prose-class scenarios.
 *
 * `JSON.stringify(renderJsonStrings(body_json, ctx))` reconstructs the 402 body rather
 * than booting the adversary and fetching the real route - verified equivalent to what
 * the adversary actually serves: `packages/adversary/src/routes.ts` pushes exactly
 * `JSON.stringify(bodyJson)` (the same rendered `body_json`) into `pageBodies`, the same
 * text the harness's own prose-attribution rule scans.
 */
function renderedTextsFor(scenario: ReturnType<typeof loadCorpus>[number], chain: Chain): string[] {
  const ctx = renderContext(scenario.id, chain);
  const texts: string[] = [];
  for (const route of scenario.routes) {
    if (route.page !== undefined) texts.push(render(route.page, ctx));
    if (route.challenge?.body_json !== undefined) {
      texts.push(JSON.stringify(renderJsonStrings(route.challenge.body_json, ctx)));
    }
  }
  return texts;
}

function addressEquals(chain: Chain, a: string, b: string): boolean {
  return chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const scenarios = loadCorpus(CORPUS_DIR);

describe("intent.ts corpus reach proof", () => {
  const proseScenarios = scenarios.filter((s) => s.reach_class === "prose");
  // Guards against the whole describe block silently testing nothing if the corpus
  // loader or the reach_class tag ever moves.
  it("found at least one reach_class: prose scenario to test", () => {
    expect(proseScenarios.length).toBeGreaterThan(0);
  });

  // v4 (U26-3): a prose-class signature_request scenario carries no transfer; its page is
  // a sign request, which the driver turns into a GDP `sign` intent instead.
  const isSignRequest = (scenario: (typeof scenarios)[number]) =>
    scenario.routes.some((route) => route.behaviour === "collect_signature");

  for (const scenario of proseScenarios.filter(isSignRequest)) {
    for (const chain of scenario.chains) {
      it(`${scenario.id} (${chain}): the served sign request yields a sign intent`, () => {
        const ctx = renderContext(scenario.id, chain);
        const sources = scenario.routes.flatMap((route) => {
          const spec = route.sign_request;
          if (spec === undefined) return [];
          // Mirrors packages/adversary/src/render.ts `renderSignRequest`: the served body.
          const rendered = renderJsonStrings(spec, ctx) as Record<string, unknown>;
          const auth = rendered.authorization as
            | { chain_id: number; address: string; nonce: number }
            | undefined;
          const field =
            auth !== undefined
              ? {
                  authorization: {
                    chainId: auth.chain_id,
                    address: auth.address,
                    nonce: auth.nonce,
                  },
                }
              : { [spec.kind]: rendered[spec.kind] };
          const body = {
            ...(spec.text !== undefined ? { text: rendered.text } : {}),
            sign_request: {
              kind: spec.kind,
              ...field,
              submit_url: `${ctx.base_url}${spec.submit_path}`,
            },
          };
          return [{ url: `${ctx.base_url}${route.path}`, text: JSON.stringify(body) }];
        });
        expect(extractSignIntents(sources)).toHaveLength(1);
      });
    }
  }

  for (const scenario of proseScenarios.filter((s) => !isSignRequest(s))) {
    for (const chain of scenario.chains) {
      it(`${scenario.id} (${chain}): surface text yields an intent to the prose canary`, () => {
        const proseAddress = canaries(SEED, scenario.id, chain).get("prose").address;
        const texts = renderedTextsFor(scenario, chain);
        expect(texts.length).toBeGreaterThan(0);

        const allIntents = texts.flatMap((text) => extractTransferIntents(text));
        expect(allIntents.length).toBeGreaterThan(0);
        expect(allIntents.some((intent) => addressEquals(chain, intent.to, proseAddress))).toBe(
          true,
        );
      });
    }
  }

  const controlScenarios = scenarios.filter((s) => s.category === "control");
  it("found at least one control scenario to test", () => {
    expect(controlScenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of controlScenarios) {
    for (const chain of scenario.chains) {
      it(`${scenario.id} (${chain}): no page yields a spurious intent`, () => {
        const texts = renderedTextsFor(scenario, chain);
        const allIntents = texts.flatMap((text) => extractTransferIntents(text));
        expect(allIntents).toEqual([]);
      });
    }
  }
});
