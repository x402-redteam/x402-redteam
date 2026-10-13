/**
 * U27 §1.4: `intent.ts` splits sentences with a linear regex (CodeQL polynomial-redos).
 * The new split must match the old one on every page and challenge text in the corpus,
 * and must stay fast on a long run of punctuation.
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
import { sentences } from "../src/intent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(__dirname, "../../../corpus");
const SEED = "x402-redteam-driver-test-seed";

/** The regex `intent.ts` used before U27 (polynomial on long punctuation runs). */
const OLD_SPLIT = /[.!?]+(?=\s|$)/;

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

/** Every page, challenge and sign-request text of every scenario on every chain, rendered. */
function corpusTexts(): string[] {
  const texts: string[] = [];
  for (const scenario of loadCorpus(CORPUS_DIR)) {
    for (const chain of scenario.chains) {
      const ctx = renderContext(scenario.id, chain);
      for (const route of scenario.routes) {
        if (route.page !== undefined) texts.push(render(route.page, ctx));
        if (route.challenge?.body_json !== undefined) {
          texts.push(JSON.stringify(renderJsonStrings(route.challenge.body_json, ctx)));
        }
        if (route.sign_request !== undefined) {
          texts.push(JSON.stringify(renderJsonStrings(route.sign_request, ctx)));
        }
      }
    }
  }
  return texts;
}

describe("sentences (linear split)", () => {
  const texts = corpusTexts();

  it("found corpus texts to compare", () => {
    expect(texts.length).toBeGreaterThan(50);
  });

  it("splits every corpus page and challenge text exactly as the old regex did", () => {
    for (const text of texts) {
      expect(sentences(text)).toEqual(text.split(OLD_SPLIT));
    }
  });

  it("matches the old split on punctuation edge cases", () => {
    const cases = [
      "",
      ".",
      "...",
      "a..b. c",
      "Pay $5.00 now!! Then stop?! ok",
      "end?..",
      "x. . y",
      "a.\nb",
      "billing.test.example. next",
      "!?!a?! b",
    ];
    for (const text of cases) {
      expect(sentences(text), JSON.stringify(text)).toEqual(text.split(OLD_SPLIT));
    }
  });

  it("stays fast on a long run of punctuation not followed by whitespace", () => {
    const text = `${".".repeat(100_000)}x`;
    const started = performance.now();
    const parts = sentences(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect(parts).toEqual([text]);
  });
});
