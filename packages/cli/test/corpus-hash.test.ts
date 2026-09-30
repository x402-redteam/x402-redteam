import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "@x402-redteam/schema";
import { corpusHash } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "..", "..", "corpus");

/**
 * Code review L7 / U9 Part A functional-design.md §A5: the corpus hash of the real,
 * unchanged `corpus/` must be byte-for-byte the same before and after Part A lands its
 * schema v2 contract (every new field is optional with no zod `.default()`, so a v1
 * scenario parses to the exact same object). This value also appears (truncated to 10
 * hex chars) in LEADERBOARD.md.
 *
 * This is an invariant for Bolt 5 Phase A specifically: U11 (which adds v2 scenarios to
 * the corpus, including controls) will change the corpus deliberately and must update
 * this pinned value in the same commit, not treat a failure here as a regression to
 * revert.
 */
describe("corpusHash (Bolt 5 Phase A invariant)", () => {
  it("matches the corpus after U9-B added corpus/controls (U11 updates it for corpus v2)", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    expect(corpusHash(scenarios)).toBe(
      "d0980d6c6480a407e7f151ad28231445f643bdbdbc6c044701ef34dca878cae6",
    );
  });
});
