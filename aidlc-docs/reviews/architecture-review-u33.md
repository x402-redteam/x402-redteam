# Architecture review: U33 Cloudflare Agents SDK adapter (functional design rev 1)

Reviewed: `aidlc-docs/construction/U33-cloudflare-adapter/functional-design.md` against the MCP
transport (`packages/adversary/src/transports/mcp.ts`, `mcp-server.ts`, `mcp-offered.ts`), schema
(`wire.ts`, `scenario.ts`, `load.ts`, `ledger.ts`, `generator-lint.ts`), fuzz (`generate.ts`,
`diff.ts`, golden), CI, U28 and the ClawRouter adapter, and ADR-028/029/032/033/034/035. Facts about the
package were checked against the private source review (§1, §2, §3, §6 of that file) and are not repeated
here. Read-only; nothing was run.

## Facts checked

- **Spec standing.** The repo cites `specs/transports-v2/mcp.md` at `0e6e8c55…`
  (`U30-mcp-seller/functional-design.md:7-8`, `transports/mcp.ts:14-17`, fuzz cites at
  `packages/fuzz/test/helpers.ts:36`). No copy of the spec is vendored or cached in the repo or the local
  dependency tree, so the text could not be re-read here. As recorded in the repo, the spec defines the
  challenge in `structuredContent` and `content[0].text` (both MUST, identical copies) and uses `_meta`
  only for `x402/payment` and `x402/payment-response` (`U30…/functional-design.md:16-24`,
  `transports/mcp.ts:20-23,50-52`). Before this design, no challenge key in result `_meta` appears anywhere
  in the repo. So the result-`_meta` challenge is **not a spec channel**. Under ADR-033 #6 every mode that
  carries it is `undefined` tier, the identical-copies `both` mode included.
- **Option (b) has no opt-in path today.** `wire` (and so `wire.channels`) is refused on a tool route
  unless the scenario is generated (`load.ts:774-789`, ADR-032 #5). The U33-1 smoke corpus, the U33-2
  private scenarios and `corpus-mcp/` cannot use it.
- **What option (a) touches.** Every MCP challenge, not only `wire` ones: `paymentRequiredResult`
  (`mcp.ts:53-63`) is the non-wire path (`mcp-server.ts:268-276,300-302`), and the "a `both` plan is
  byte-identical to `paymentRequiredResult`" invariant (`mcp.ts:238-239`) moves with it. It also changes
  `planOffers`/`unionAccepts` (`mcp.ts:259-288`, fixed channel order), the `channels` record (written only
  when not `both`, `mcp.ts:317`) and so `offered_terms_sha256_by_channel` and its binding check
  (`generate.ts:319`, `diff.ts:448-461`), `sdk_schema_ok` and `readByX402Mcp` (`mcp-offered.ts:59-80,173-187`).
  `@x402/mcp` would get an extra, non-spec key on every challenge; `mcp-interop.e2e.test.ts:95-115` checks
  request order and the payment-response, not challenge bytes, so it would not catch a change in how the
  key is treated. `results/mcp/*.json` hold no result bodies (no `_meta`/`structuredContent`), so they
  probably would not move, but each would need to be re-run to show it.
- **The golden is not at risk under either option.** `smoke-diff.json` records HTTP clients only. Its
  `mcp` corpus hash (`:137`) comes from the generated shape corpus (`generate.ts:220-233`). Design
  `:33-35` overstates the risk; it moves only if the smoke catalogue gains `meta` cases.
- **`tool.meta` parses silently today.** `ToolSpecSchema` is a `looseObject` (`scenario.ts:266`), and
  `listTools` serves only `name/description/inputSchema` (`mcp-server.ts:166-185`).
- **Adapter pattern.** U28 §2-§7 and §11 C1-C4/N1-N3 (`U28…/functional-design.md:63-206,237-262`), ClawRouter
  `pnpm-workspace.yaml` (`minimumReleaseAge: 4320`, overrides there, not in `package.json`), and
  `osv-scanner.toml`.

## Findings

| id | sev | evidence | required change |
|---|---|---|---|
| B1 | blocker | `load.ts:774-789`; ADR-032 #5; design §2 U33-0 `:27-28`, U33-2 `:56-57` | Say how a scenario or run opts in outside fuzz. Recommended: (i) fuzz-only `wire.channels` modes `both_meta`, `meta_only`, `meta_differs`; (ii) an adversary run option (for example `--mcp-challenge-meta`) that adds an identical copy to every challenge in that run. Record it in `report.json` and in each issuance's `channels`. Corpus hashes do not move, and `corpus-mcp/` becomes reachable without being edited. The leaderboard refuses reports that carry it. Amend ADR-032 #5 and ADR-034. |
| M1 | major | facts "Spec standing"; ADR-033 #6 | State in the design and in the ADR-034 amendment that the channel is a non-spec interoperability extension, `undefined` tier in every mode. Cite the pinned commit and quote the spec's channel MUSTs. No result that rests on it may be `spec-must`. |
| M2 | major | facts "What option (a) touches" | Reject (a): every spec-shaped answer would stop being spec-shaped, and every test above would need changing. If the owner still picks (a), regenerate `results/mcp/` and say why, and add an interop assertion on challenge bytes. |
| M3 | major | `ledger.ts:8-9`, `mcp.ts:261,277`, `diff.ts:448`, `catalogue.ts:123`, `wire.ts:115-144` | Append `meta` to `MCP_CHANNELS` (after `error`, so existing union order and hashes are unchanged). A run-option `both` + meta copy must record `channels`, or the F5 binding fails. Bump the ledger version comment (v8). Define which object each `*_differs` mode puts in `meta`. |
| M4 | major | `mcp.ts:61,69,248`; `mcp-server.ts:282-302` | The merge covers `paymentRequiredResult`, `planAnswer` and `represent()`, not only the two lines cited. Use a fixed key order. Test that a settle-failure answer carries both keys, and that with no opt-in the answer is byte-identical to today. |
| M5 | major | `scenario.ts:266`; `load.ts:212-222,286-330`; `mcp-server.ts:178` | `tool.meta`: make it an explicit field (no default). Decide whether it is rendered or verbatim; if verbatim, lint must refuse templates. Add it to `toolTextFields` (rule 3) and push it to `pageBodies` (prose attribution). Add `reprice.meta`. Restrict keys to `_meta`-legal names. Add tests in `schema/test/generator-lint.test.ts` and `adversary/test/mcp-endpoint.test.ts`. |
| M6 | major | design `:11,47-48`; U28 §2 | Optional peers are not installed for you. Pin `@x402/core`, `@x402/evm`, the MCP SDK and viem as exact direct dependencies. If the loaded core/evm version differs from the pin, exit 3 (not just a note). Write `provenance.json` as U28 does: lockfile integrity and sha256 of the package's dist entry files. |
| M7 | major | design `:49-50` | "Never paid = unmeasured" is undefined. Adopt the rule below. |
| M8 | major | design `:44-46` | `approve` needs a decision rule, for example: approve only if every offered amount is at or below the task's stated price, and log the accepts it saw. A callback that always approves exercises no decision. State the exact `raised-cap` value. Each profile gets its own `--guardrail-id` and `--out`. |
| m1 | minor | ADR-029 3a; U28 §3/§6 | Carry over U28's rules: a loopback allowlist of the harness port only (no assigned ports); child env with a temp `HOME` and no proxy vars, `NODE_OPTIONS` or API key; read-deny list; refuse unless the sandbox exists. Add a canary case for any public endpoint the package names as a default. |
| m2 | minor | U28 §4, §7.3-§7.6 | Define the scripted plan (which tools, from what prompt text; anything unknown exits 3). Add an exit-code test per classify row (neutral wording, as U28 §5 has). Require 5-run byte-identical smoke reports. The README warns about `--out`. Keep it out of `pnpm test`, biome and CI. Add `osv-scanner.toml`. No `onlyBuiltDependencies`. |
| m3 | minor | design `:37` vs private review §6 | Use one directory name. Reconcile on (route, payTo, network), never on amount (U28 C4). |
| m4 | minor | `.github/workflows/ci.yml:224` | The U33-0 acceptance names the tests: `mcp-channels`, `mcp-endpoint`, `wire`, `generator-lint`, `diff-mcp`, `offered-hash`, `mcp-shape`, `fuzz-guard`, and the `mcp-interop` shard unchanged. |
| P1 | low (privacy) | design `:15-16` | Delete "Against the current `corpus-mcp/` it would make no payment at all" (a predicted result). Keep "reads the challenge from result `_meta`, which the adversary does not serve". |
| P2 | low (privacy) | design `:44-45`, `:56` | Drop the reasons ("so outcomes are not decided by the cap", "priced under the default cap"). State the profile values and the scenario count only. |

## Proposed "unmeasured" rule (M7)

A run is measured only if all of these hold:

1. **Batch gate.** Earlier in the same batch, the adapter's smoke paid control produced a captured
   payment. If it did not, every run in the batch exits 3.
2. **Per call, the child classifies what it got back.** A payment was due when the result has
   `isError: true` and a parseable `PaymentRequired` in any channel; the adversary's log shows
   402 for `<host>/mcp#<tool>`. If no copy is in the channel the client reads, the outcome is
   `not-reached`: exit 3, never a pass.
3. **A visible challenge left unpaid** is measured (exit 0) only with a known reason from the classify
   table. With no pre-sign intent, no capture and no known reason, exit 3.
4. **Reconciliation.** As U28 C4: an intent with no capture, or `EGRESS_BLOCKED` after an intent,
   exits 3. A capture with no intent is reviewed by hand.

## Recommended owner answers (§5)

1. **(b) opt-in**, using the B1 mechanism (fuzz modes plus a recorded run option); not (a).
2. **`default` and `raised-cap`** are required. Add `approve` only with the M8 decision rule; otherwise
   drop it.
3. **Write them**: an isolated agent, outside the repo, owner spot-check, each with an explicit
   `budget_usd` (U28 N2). Also run the reachable `corpus-mcp/` scenarios under the run option.
   Counts only in `audit.md`.

## Verdict

**Not ready for build.** Revise to rev 2 covering B1 and M1-M8. P1-P2 are wording fixes. U33-0 is sound
once B1 and M1 are settled. U33-1 follows the U28 pattern once M6-M8 are folded in.

## Delta check (rev 2)

Every rev 1 finding is resolved in rev 2: B1 (§2.1), M1 (§1), M2 (§2.1), M3/M4 (§2.2), M5 (§2.3), M6 (§3.1), M7 (§3.3), M8 (§3.2), m1-m3 (§3.1), m4 (§5), P1-P2 (§1, §3.2, §4). The privacy wording is clean: no finding, mechanism or predicted result appears. New or remaining points:

| id | sev | evidence | condition |
|---|---|---|---|
| C1 | major | `scorer/src/types.ts:103-125` (`RunConfig`, ADR-016 #3 fingerprint), `cli/src/run.ts:581-600` | The run option goes in `config` as an **optional key written only when on**. Reports with the option off stay byte-identical, and `results/**` does not move. The leaderboard rejects it the same way it rejects fuzz reports (`build-leaderboard.ts:655-676`). |
| C2 | major | `mcp-server.ts:268-276` (a non-wire issuance never goes through `issuedUnderWire`); `diff.ts:448-451` | With the option on, a non-wire issuance must still record `channels` (as rev 2 §2.1 says), so it has to go through the plan path. The fuzz runner never passes the option: a `both` case would then record `channels` with no `offered_terms_sha256_by_channel` and fail F5. Test both. |
| C3 | minor | rev 2 §2.2 | `sdk_schema_ok` iterates `plan.served` (`mcp-offered.ts:175`), so it gains a `meta` entry without any code change. `readByX402Mcp` must return null for `meta_only`. Say so; don't call either "unchanged". The new modes take no argument, so "generator lint covers embedded literals" means only that the mode names are in the `wire.ts` sets. |
| C4 | minor | rev 2 §3.2, §4 | Define where `approve` gets the "task's stated price": a plan-grammar field. A plan with no price exits 1 under `approve`. The `corpus-mcp/` runs under `approve` need that field in their plan lines. State `raised-cap` as 1000000 atomic (6-decimal USDC). |
| C5 | minor | rev 2 §1 `:21` | Only `@x402/core`/`@x402/evm` are optional peers; the MCP SDK peers are not. Fix the sentence. The version check covers `@x402/evm` as well as core. |
| C6 | minor | rev 2 §5 U33-0 #5, #7 | "rendered, served verbatim" is contradictory: say "served as rendered". Add `schema/test/generator-lint.test.ts`, `fuzz/test/catalogue.test.ts`, `scripts/test/fuzz-guard.test.ts` and the `mcp-interop` e2e shard (unchanged with the option off) to the named tests. |
| C7 | minor | rev 1 m1 | Keep the canary case for any public endpoint the package names as a default (rev 2 §3.1 dropped it). |

**Verdict (rev 2): signed off for build, subject to C1-C2 (U33-0) and C3-C7.** The lead developer folds them in, and the code reviewer checks them. Owner decisions §6.1-6.3 match the recommendations.
