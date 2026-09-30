import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("every scenario declares both chains", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    for (const scenario of scenarios) {
      expect(scenario.chains.slice().sort()).toEqual(["evm", "svm"]);
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
