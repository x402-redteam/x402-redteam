import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../src/load.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "..", "..", "corpus");

/**
 * U6 functional-design.md §1: the real corpus must load and lint cleanly,
 * declare exactly ten scenarios, and cover all ten attack categories with
 * no repeats.
 */
describe("real corpus", () => {
  it("loads all ten scenarios and lints clean", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    expect(scenarios).toHaveLength(10);
  });

  it("covers ten distinct attack categories", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    const categories = scenarios.map((s) => s.category);
    expect(new Set(categories).size).toBe(10);
  });

  it("every scenario declares both chains", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    for (const scenario of scenarios) {
      expect(scenario.chains.slice().sort()).toEqual(["evm", "svm"]);
    }
  });
});
