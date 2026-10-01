import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "@x402-redteam/schema";
import { corpusHash } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "..", "..", "corpus");

/**
 * Code review L7 / U9 Part A functional-design.md §A5: the corpus hash of the real
 * `corpus/` is pinned here so an accidental corpus edit shows up as a failing test
 * instead of silently changing every report's `corpus_hash` (also shown, truncated to
 * 10 hex chars, in LEADERBOARD.md).
 *
 * Update history:
 *  - Phase A (U9-A): unchanged by the schema v2 contract landing (every new field
 *    optional, no zod `.default()`, so a v1 scenario parses to the exact same object) -
 *    "d84a7992e1779349d2ba3e430670142519df3568b49cf00d175e64b8e86fb6df".
 *  - Phase B, U9-B merge: corpus/controls/ added (4 controls) -
 *    "d0980d6c6480a407e7f151ad28231445f643bdbdbc6c044701ef34dca878cae6".
 *  - Phase B, U11 corpus v2: deliberately updated again, twice - once at first merge,
 *    again after code review fixes F1-F7 (asset-swap addresses/reachability,
 *    unit-confusion-3 added, price-bait-2/authorization-lifetime/retry-storm(-2)
 *    corrected). The oracle fixes to replay/retry-storm/fake-delivery, the de-hinted
 *    prompts on lookalike-domain/recipient-redirect/rail-switch, the severity
 *    recalibration (rail_switch/unit_confusion -> high, authorization_lifetime ->
 *    medium), and the new scenario files (2+ variants per v1 category + 6 new attack
 *    classes) all change the corpus content on purpose - per functional-design.md §5,
 *    this is the deliberate update the design calls for, not a regression to revert.
 *    31 scenarios total (27 attack + 4 controls) -
 *    "98871d3a83c4e7b0819c5ab8f53652b2ac3fe3cd39a492bc22a3e93edcab486d".
 *  - Bolt 6, U15 contract v3 landing (this commit): every attack scenario gains
 *    `reach_class` and a `surface: true` route, deliberately changing every attack
 *    scenario's content - this unit's functional-design.md §2 calls for exactly this
 *    (plus the new `corpus/decoy-domains.txt`, which `loadCorpus` doesn't hash).
 *    Code review item 8: the 4 `corpus/controls/**` YAML files are byte-for-byte
 *    untouched, but their *hashed* form changes too - `Scenario.rail` now has a zod
 *    `.default("x402v2")` (ADR-014), applied at parse time to every scenario including
 *    controls, and `corpusHash` hashes the parsed/canonicalized `Scenario`, not the raw
 *    YAML text. Still 31 scenarios total (27 attack + 4 controls, unchanged).
 */
describe("corpusHash (Bolt 6 Phase A / U15 invariant)", () => {
  it("matches the corpus v3 content (reach_class + surface added to every attack scenario)", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    expect(corpusHash(scenarios)).toBe(
      "3e977e72364f50d0931d24a321a5bfeeb553705814a7523824eb9333ba880ae3",
    );
  });
});
