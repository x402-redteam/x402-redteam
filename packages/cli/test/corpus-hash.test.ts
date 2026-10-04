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
 *  - Bolt 6, U15 contract v3 landing: every attack scenario gains `reach_class` and a
 *    `surface: true` route, deliberately changing every attack scenario's content -
 *    this unit's functional-design.md §2 calls for exactly this (plus the new
 *    `corpus/decoy-domains.txt`, which `loadCorpus` doesn't hash). Code review item 8:
 *    the 4 `corpus/controls/**` YAML files are byte-for-byte untouched, but their
 *    *hashed* form changes too - `Scenario.rail` now has a zod `.default("x402v2")`
 *    (ADR-014), applied at parse time to every scenario including controls, and
 *    `corpusHash` hashes the parsed/canonicalized `Scenario`, not the raw YAML text.
 *    Still 31 scenarios total (27 attack + 4 controls, unchanged) -
 *    "3e977e72364f50d0931d24a321a5bfeeb553705814a7523824eb9333ba880ae3".
 *  - Bolt 6, U23 (corpus v3): 21 new attack-scenario variants added so every attack
 *    category reaches >= 3 variants (accepts_ordering, asset_swap,
 *    authorization_lifetime, budget_split, challenge_injection and resource_spoof went
 *    from 1 to 3; fake_delivery, ghost_paywall, lookalike_domain, price_bait,
 *    prose_payment, rail_switch, recipient_redirect, replay and retry_storm went from 2
 *    to 3; unit_confusion was already at 3 and is untouched) - this unit's
 *    functional-design.md §1 calls for exactly this deliberate corpus-content change.
 *    52 scenarios total (48 attack + 4 controls, unchanged) -
 *    "8107b948abd8563407abb3780cdfe1cfb47a5119ea5d6290254b4783058c6dc8".
 *  - Bolt 6, U23 code review round 1 fixes (this commit): accepts-ordering-2/-3
 *    dropped and replaced (the recipient variant was unpassable - two opaque
 *    canaries on the same allowed host - and the price variant was cost-optimality,
 *    not safety) with two detectably-wrong variants (a non-canonical, mispriced
 *    asset; an excessive authorization window inside accepts[0]); prose-payment-3
 *    and challenge-injection-3's injected amounts moved inside the $0.05 budget so
 *    passing requires refusing prose, not tripping a budget check;
 *    authorization-lifetime-2/-3, lookalike-domain-3, recipient-redirect-3 and
 *    budget-split-2 reworked to genuinely distinct mechanics instead of re-skins.
 *    accepts-ordering-3's first draft (an excessive authorization window inside
 *    accepts[0]) was evm-only, which collided with packages/schema/test/corpus.test.ts's
 *    "evm-only is limited to authorization_lifetime" invariant - redesigned to an
 *    `amount_atomic` sized for the wrong decimals (the same mechanism as
 *    `unit_confusion`), which is dual-chain. Still 52 scenarios total (48 attack + 4
 *    controls, unchanged).
 */
describe("corpusHash (Bolt 6 Phase C / U23 invariant)", () => {
  it("matches the corpus v3 content (>= 3 variants per attack category)", () => {
    const scenarios = loadCorpus(CORPUS_DIR);
    expect(corpusHash(scenarios)).toBe(
      "784a28223c64823b4603cb3844eed2c5fe6c2cb2b8b5645cf724bd64f0864ab4",
    );
  });
});
