import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress as isSvmAddress } from "@solana/kit";
import { isAddress as isEvmAddress } from "viem";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../src/load.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "..", "..", "corpus");
const CONTROLS_DIR = join(CORPUS_DIR, "controls");

/** The ten v1 attack categories (application-design.md §3), each still owed at least
 * one attack scenario once v2 categories exist alongside them. */
const V1_CATEGORIES = [
  "ghost_paywall",
  "prose_payment",
  "recipient_redirect",
  "price_bait",
  "retry_storm",
  "fake_delivery",
  "replay",
  "unit_confusion",
  "lookalike_domain",
  "rail_switch",
] as const;

/**
 * U6 functional-design.md §1, relaxed by U9 Part A functional-design.md §A4 (Bolt 5):
 * the real corpus must load and lint cleanly under the v2 schema. The old "exactly 10 /
 * 10 distinct categories" assertions don't survive v2 (Bolt 5 adds control and new
 * attack-class scenarios), so this now checks coverage instead of an exact count.
 * U11 tightens these assertions later; it owns this file after Part A merges.
 */
describe("real corpus", () => {
  it("loads and lints clean", () => {
    expect(() => loadCorpus(CORPUS_DIR)).not.toThrow();
  });

  it("has at least one attack scenario per v1 category", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    const categories = new Set(scenarios.map((s) => s.category));
    for (const category of V1_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
  });

  // U11 (Bolt 5): authorization_lifetime is evm-only (its EIP-3009 validBefore/
  // validAfter mechanism has no svm equivalent), so this no longer requires every
  // scenario to declare both chains - it requires every scenario to declare at least
  // one, and every evm-only scenario to be justified.
  it("every scenario declares at least one chain, and evm-only is limited to authorization_lifetime", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    for (const scenario of scenarios) {
      expect(scenario.chains.length).toBeGreaterThan(0);
      if (scenario.chains.length === 1) {
        expect(scenario.category).toBe("authorization_lifetime");
        expect(scenario.chains).toEqual(["evm"]);
      }
    }
  });

  it("has at least two attack scenarios per v1 category", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    const counts = new Map<string, number>();
    for (const scenario of scenarios) {
      counts.set(scenario.category, (counts.get(scenario.category) ?? 0) + 1);
    }
    for (const category of V1_CATEGORIES) {
      expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  /** U11 new attack classes (application-design.md §3 "v2"): one scenario each. */
  const V2_CATEGORIES = [
    "resource_spoof",
    "authorization_lifetime",
    "asset_swap",
    "budget_split",
    "challenge_injection",
    "accepts_ordering",
  ] as const;

  it("has at least one attack scenario per v2 new attack class", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    const categories = new Set(scenarios.map((s) => s.category));
    for (const category of V2_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
  });

  // Code review F1: a scenario's `assets:` list (asset_swap) is a real address/mint an
  // agent's SDK would have to parse and sign against - a malformed one (wrong byte
  // length, invalid base58) makes the scenario unfailable by any real client, not just
  // "SDK-defended." Verified with the same address validators the reference agents use
  // (viem's `isAddress` for evm, `@solana/kit`'s `isAddress` for svm), so this test
  // fails exactly when a real payment attempt against that asset would also fail.
  //
  // This lives here (packages/schema/test), not packages/cli/test as first suggested,
  // because `packages/schema` already depends on `viem`/`@solana/kit` (used by
  // canary.ts) while `packages/cli` depends on neither - same constraint noted for the
  // promptonly/obedient probes living under examples/agents/src/.
  it("every scenario's assets[].address is a real, valid address/mint for its chain", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    for (const scenario of scenarios) {
      for (const asset of scenario.assets ?? []) {
        const valid =
          asset.chain === "evm" ? isEvmAddress(asset.address) : isSvmAddress(asset.address);
        expect(
          valid,
          `${scenario.id}: assets[] address "${asset.address}" is not a valid ${asset.chain} address`,
        ).toBe(true);
      }
    }
  });

  // Guarded so this file passes on Part A alone: corpus/controls/ doesn't exist yet
  // (U9 Part B adds it). Once it exists with at least one *.yaml file, require it to
  // hold at least one "control" scenario.
  it("has at least one control scenario once corpus/controls/ exists", () => {
    if (!existsSync(CONTROLS_DIR)) return;
    const hasYaml = readdirSync(CONTROLS_DIR).some(
      (name) => name.endsWith(".yaml") || name.endsWith(".yml"),
    );
    if (!hasYaml) return;

    const scenarios = loadCorpus(CORPUS_DIR);
    const controls = scenarios.filter((s) => s.category === "control");
    expect(controls.length).toBeGreaterThanOrEqual(1);
  });
});
