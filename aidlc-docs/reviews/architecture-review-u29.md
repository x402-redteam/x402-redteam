# Architecture review: U29 differential testing and challenge fuzzing

Reviewer: senior-architect, independent of the design author. Scope:
`aidlc-docs/construction/U29-differential-fuzzing/functional-design.md`, revision 1 (2026-10-16).

I checked it against:
- `CLAUDE.md`, ADR-028 and ADR-029 (`aidlc-docs/inception/adr/decisions.md:564-589`);
- schema v4 (`packages/schema/src/scenario.ts`, `load.ts`, `chains.ts`);
- the adversary's x402v2 rail and routes (`packages/adversary/src/rails/x402v2.ts`, `routes.ts`);
- capture (`packages/capture/src/index.ts`, `evm.ts`, `evm-util.ts`);
- the scorer (`packages/scorer/src/types.ts`, `score-run.ts`, `score-suite.ts`) and the CLI (`packages/cli/src/main.ts`);
- the four clients' runners (`examples/agents/src/sdk-default.ts` and `lib/wallet.ts`, `examples/agents-py/agent.py`, `examples/third-party/{agentkit,clawrouter}`);
- the installed SDK sources: `@x402/core` and `@x402/evm` 2.28.0 in the main clone's `node_modules/.pnpm`, and PyPI `x402` 2.25.0 in `examples/agents-py/.venv`;
- the upstream spec: `coinbase/x402` `specs/x402-specification-v2.md`, `specs/transports-v2/http.md` and `specs/schemes/exact/scheme_exact_evm.md`, at commit `0e6e8c55` (2026-10-15).

I also used the prior-art research and the per-run timings of earlier private runs, but only for their totals. No fuzz case was generated and no client was run.

Per ADR-028, this file describes no weakness in any third-party client or SDK. Where a finding depends on how a particular SDK behaves on malformed input, it names only the harness consequence. The SDK detail goes to the orchestrator for the private notes. Line references into installed SDK code show where the harness reads its input. They are not claims about defects.

## Verdict

**Sound with required changes.** The direction is right. Prior art covers the seller and facilitator side, and a client-side differential harness has no known equivalent. The core principles stay as they are: offline, test keys, `report.json` scoring, ADR-028 and ADR-029. Reusing `run` per client and adding a separate `diff` is the right boundary.

Revision 1 rests on three premises that the code does not support:

1. **B1: "No harness schema change is planned."** Both SDKs read only the `PAYMENT-REQUIRED` header for v2, and the adversary always builds that header from typed schema fields. As a result, about half the mutation families (encoding, types, `x402Version`, field names, `maxTimeoutSeconds` outside the positive integers) cannot reach any of the four clients. `body_json` changes only a body that v2 clients ignore.
2. **B2: "The invariant oracle needs no ground truth."** The fuzz inputs are exactly the ones the capture decoders handle worst:
   - they short-circuit on any non-digit amount before verifying the signature;
   - they throw on some malformed echoes, and the payment is then dropped unrecorded;
   - they verify against the client's own echo of the terms, not the offered terms.

   The harness's USD conversion also returns `NaN` for several non-canonical amounts.
3. **B3: "Expected outcome from the mutation."** The v2 spec contains very few client-side MUSTs. Most must-refuse tags would be our own reading. The expectation oracle, as specified, also only restates the scorer's own verdict.

Each premise has a bounded fix, so the unit can go ahead once those fixes are in the design.

## Answers to §9

**Q1. Circularity: yes, as written.** The spec's client-relevant normative text is thin.
- `x402Version` "must be 2" (v2.md:114).
- The field types in §5.1.2, all "Required": `amount` is a string "in atomic token units", `network` is "in CAIP-2 format", and `maxTimeoutSeconds` is a `number`, with no sign or integer constraint.
- "Clients MUST NOT construct a payment for a `paymentFlow` they do not recognize" (v2.md:289).
- `extra.assetTransferMethod`, "if present, MUST be `eip3009`", for that method, plus `extra.name` and `extra.version` (required) (scheme_exact_evm.md:71-73).

The validity checks in the scheme spec, Phase 2 "Verify ...", are facilitator duties, not client duties. HTTP names the header as the canonical location, and its example body is `{}` (http.md:7-25).

The spec is silent on almost everything else in §2: leading zeros, signs, whitespace, exponent forms, `payTo` checksum, the zero address, case, and a mismatch between `network` and the domain. Tagging those must-refuse would score clients against our reading. ADR-028 #6 already names this pattern: "a harness scoring rule the third party could reasonably dispute".

Answer: limit must-refuse to `spec-must`, meaning a quoted MUST or "must" sentence at a pinned spec commit. Add a `spec-type` tier for violations of a Required field's stated type or format. It is reported, never scored as a defect on its own. Everything else is `undefined`. Separately, oracle 2 as specified is circular inside the harness: the generator writes `expected` from the tag, and the scorer then judges against that `expected` (F3).

**Q2. Can v4 express every family? No.**

| Family | Reaches a v2 client? | Evidence |
|---|---|---|
| Amount strings (zeros, signs, decimals, exponent, whitespace, empty, huge) | yes | `amount_atomic: z.string()` scenario.ts:59, passed through x402v2.ts:55-57 |
| Non-string amount, v1 `maxAmountRequired` | no (body only) | header built from typed fields, x402v2.ts:62-70, 229 |
| Asset strings, unknown asset, `extra` contradictions | yes | free strings and `extra` record |
| Missing `extra.name`/`version` | only as `null` | defaults merged first, x402v2.ts:58 |
| Network strings, case, whitespace, unknown CAIP-2 | yes; number form no | `network: z.string()` |
| `payTo` variants | yes, if they come from canary or poison templates (lint rule 3) | load.ts payTo lint |
| `maxTimeoutSeconds` 0, negative, fractional | no; huge yes | `z.number().int().positive()` scenario.ts:80, 103 |
| `accepts` multiplicity, unknown scheme | yes (empty `accepts` untested: x402v2.ts:211 takes `[0]`) | |
| `x402Version` wrong or missing, unknown top-level fields | no | hard-coded at x402v2.ts:110 |
| Header vs body disagreement | servable, but neither SDK reads the v2 body | `@x402/core` client/index.js:1048-1057; py `x402_http_client_base.py:140-146` |
| Header encoding (base64 variants, padding, URL-safe, bad JSON) | no | `encodePaymentRequiredHeader` always used, x402v2.ts:229 |

**Q3. Are the decoders strict enough? They are strict in the wrong place.** Detail in F2.

**Q4. Run cost.** These are median per-run times from earlier reports:
- TS reference-style agents: about 0.65 s (`results/*.json` timing);
- ClawRouter adapter: about 1.8 s;
- AgentKit `autopay`: about 3.5 s;
- `py-sdk`: no recent figure; assume 1-2 s.

An enumerated single-mutation catalogue of about 120-150 cases therefore costs about 1.5 min for `ts-sdk`, 3-5 min for `py-sdk` and ClawRouter (on the chat subset), and about 9 min for AgentKit. ADR-028 #3's two-run confirmation applies to flagged cases only. N is not the lever; tiering is (F9).

**Q5. Do SDK version differentials count as separate clients? Yes, as separate client ids, but not as independent implementations.** Both third-party lockfiles resolve `@x402/core` and `@x402/evm` 2.28.0, the same as `ts-sdk` (agentkit `pnpm-lock.yaml:8-10`, clawrouter `pnpm-lock.yaml:1474-1477`). For ClawRouter, the bundle inlines its own copy, and its sibling versions are "not necessarily what the bundle inlines" (clawrouter README:77, 138). Read the inlined version from the bundle. Do not assume it is older. Identify a client by (implementation, core version as provenance records it, wrapper).

## Findings

| id | sev | area | evidence | consequence | recommendation |
|---|---|---|---|---|---|
| B1 | blocker | expressibility | Q2 table; x402v2.ts:62-70, 110, 224-229; both SDKs read only the header for v2 | About half of §2 never reaches a client. Body-only mutations give "everyone agrees" as a false negative and inflate the case count | Stop-and-report applies. Add an additive, optional wire hook on `ChallengeSpec`, for example `wire: {patch: <RFC 6902 ops over PaymentRequired>, encoding: std\|urlsafe\|nopad\|raw}`, applied after the typed build. It is deep-templated and in lint scope for rules 3 and 6. Existing `corpusHash` stays unchanged. This needs an ADR and application-design sign-off. Otherwise cut those families from U29 explicitly. |
| B2 | blocker | invariant oracle and capture | capture/evm.ts:189-191: a non-`^\d+$` amount returns `negative_amount` before `verifyTypedData`. evm.ts:196-199: verification uses the client's echoed `accepted` and falls back to `USDC`/`2`. index.ts:37-39: a non-string echoed `network` throws, and routes.ts:270-272 then returns 400 with nothing recorded. Only `ts-sdk` also has shim capture (`header+shim`); `py-sdk` and ClawRouter are header-only. chains.ts:58-69 `atomicToUsd`: `" 10000"`, `"1.5"`, `"0x10"` and `"+5"` give `NaN`, and `"1e6"` gives 100 (run locally) | For non-canonical amounts, the oracle cannot say what was signed. Some signed payloads disappear. A NaN USD becomes `null` in `report.json`, which corrupts sums and verdicts | 1. Add a fuzz-safe decode path that never throws. It records a `decode_error` leg with whatever fields parsed, in the ledger. 2. Verify the signature against the offered terms from `RunRecord.challenges[].accepts`, under each integer reading of the offered amount, and record which reading verified (or none). 3. Make `atomicToUsd` return "unknown" for any non-canonical string, never NaN, and add a scorer test for it. 4. Rename `negative_amount` to `non_canonical_amount`. |
| B3 | blocker | expectation oracle | Q1; v2.md:114, 289; scheme_exact_evm.md:71-73; ADR-028 #6 | Most must-refuse tags would be our own reading, so "defects" could be disputed and dismissed | Use three tiers: `spec-must` (a quoted sentence plus the spec file and commit SHA, stored in the generator's catalogue), `spec-type` and `undefined`. Score only `spec-must`. A hit from the expectation oracle is a lead, never a finding. Under ADR-028 #6, a third-party result that rests on a tag stays unconfirmed until the private write-up states the rule and checks it against the source. Pin the spec commit, because upstream changed on 2026-10-15. |
| F1 | major | validity: independence | Q5 lockfiles | Three of the four clients share one parse and sign core. Agreement among them is not corroboration, and §0's "several independent implementations" overstates the method | No majority vote. `diff.json` groups clients by core provenance. Report differences inside a group as wrapper behaviour and differences across groups as implementation behaviour. Plan a truly independent client (another language's SDK) as a later unit. |
| F2 | major | Q3 detail | see B2 | | see B2 |
| F3 | major | oracle 2 is tautological | the generator writes `expected` from the tag; `scoreRun` judges against it | Oracle 2 equals `status == fail` and adds nothing on its own | Redefine oracle 2 as: client outcome vs tag, read from the outcome taxonomy (F4), for `spec-must` cases only. Keep the scorer verdict as a cross-check that must agree. |
| F4 | major | differential oracle | the design has a signed/refused binary; ClawRouter runs can be "unmeasured" (README:153-159); a crash is `agent_failed` | Crashes, non-reach and unmeasured runs show up as "refused" and flood triage with false disagreements | Define the outcomes: `signed_valid`, `signed_invalid(reason)`, `decode_error`, `refused` (the 402 was fetched, no payment, exit 0), `errored` (exit not 0 or timeout), `not_reached` (`reached == false`), `unmeasured`. Compare only the first four. Each family carries its unmutated base as a `control`. If a client fails the base control in a run, its results for that run are void. |
| F5 | major | alignment of page and chat | Shapes differ in `corpus_hash`, `route_key`, `challenge_id`, and the header's `resource.url` and `mimeType` (x402v2.ts:111-115). Only `accepts` is identical | `diff` cannot rely on ids or hashes in the report, and "identical challenge" is not literally true | The generator writes a `cases.json` manifest: case id to mutation id, tier, spec cite, shape corpus hashes, and the canonical hash of the rendered `accepts`. `diff` takes the manifest. It requires each report's `corpus_hash` to match one shape and the seed and `harness_version` to be equal. It re-hashes `report.runs[].challenges[].accepts` and refuses on any mismatch. It never compares `route_key` or `challenge_id`. |
| F6 | major | privacy split | §5 makes the families and engine public, and the generator is deterministic | A public family list plus a public engine is the public case set. A new family that finds an open class (a) issue reveals it. A public CI smoke run prints per-case outcomes | 1. A new family stays private until its first triage closes. 2. The CI smoke set compares against a committed golden `diff.json` and prints counts only. 3. Spec-repository issues wait until disclosure closes and name no client. 4. audit.md records totals only (ADR-028 #5). |
| F7 | major | v4 mapping of tags | `expected.allow` is boolean (scenario.ts:244). Only controls may set `min_payments > 0` (load.ts). `category` is a closed enum, and `reach_class` is required (lint rule 7) | "undefined" cannot be expressed, the generated reports get a meaningless `safety_score`, and the mapping is left to the developer | Specify the mapping: must-refuse is `allow: false`. Must-pay-exactly is `allow: true` with `max_usd`, `recipient` and `max_payments: 1`, where refusal passes. Undefined is `allow: false` with the scorer verdict ignored by `diff`. Use `technique: "fuzz:<mutation-id>"`, `reach_class: challenge` and `surface: true`. The `agent_id` prefix is `fuzz-`. The leaderboard refuses fuzz reports, with a test for that. |
| F8 | major | window invariant | `report.json` strips `authorization_seconds` (types.ts:283-291). Only `authorization_window_exceeded` persists, and only when `max_authorization_seconds` is set (score-suite.ts:307-327) | The validity-window invariant cannot be computed from the reports `diff` reads | The generator sets `expected.max_authorization_seconds = maxTimeoutSeconds` on every case, or `diff` also reads the private ledgers. |
| F9 | minor | cost and generation | Q4 timings | A random "seed" over enumerable families adds nothing but irreproducibility of intent | Use an enumerated catalogue with stable mutation ids. The seed is used only for optional pairwise sampling. Run tier 1, `ts-sdk` and `py-sdk`, on everything. Run tier 2, the third parties, on all `spec-must` cases plus every case where tier 1 signed or disagreed. |
| F10 | minor | safety | The first-party clients run unsandboxed (`sdk-default.ts`, `agent.py`). Mutations name mainnet chain ids | Low risk today: the EVM signers are offline or point at the mock RPC (wallet.ts:180-216). But fuzzing exercises unusual code paths | Run every client during fuzz runs under ADR-029's network-deny layer, which is cheap for first-party clients too. Take `payTo` only from canary and poison templates. Raw signed payloads stay in the private ledgers (they are already stripped from the report). Add a generator lint that refuses non-reserved hosts in every string. |
| F11 | minor | wording | §0 "by construction ... not taken from a published source" | The mutated fields overlap a published facilitator fuzzer's (private notes) | The claim is new targets (clients), not new mutations. |
| F12 | minor | known-answer test | AC4 shows the expectation of agreement only | The differential oracle is never shown to fire | Add a planted first-party disagreement: `naive` (`unlimitedSpend`, naive.ts:60-61) vs `sdk-default` on a case above $1. `diff` must flag it. |
| F13 | minor | confirmation | ADR-028 #3 | | Triage reruns each flagged case twice per client with byte-identical `report.json`, and checks upstream main before calling it confirmed. |

## Proposed ADRs

- **ADR-030 (new): Wire-level challenge overrides.** An optional `ChallengeSpec.wire` (a patch plus an encoding variant) applied after the typed build. It is in scope for lint rules 3 and 6, leaves `corpusHash` unchanged for existing scenarios, and is used only by generated or private corpora until the owner approves public use. It resolves B1.
- **ADR-031 (new): The oracle and ground-truth policy.** The `spec-must`, `spec-type` and `undefined` tiers. Spec citations pinned by commit. The outcome taxonomy. No majority vote. Client identity is (implementation, core provenance, wrapper). A finding needs the invariant oracle, or a `spec-must` tag, plus ADR-028 #3.
- **ADR-028 amendment.** Add #7: fuzz families, seeds and triage outputs stay private until their triage closes, and the public CI smoke set prints counts only.
- **ADR-029 amendment.** Fuzz runs of first-party clients use the network-deny layer too.

## Prioritised next bolt (U29 revision 2 sub-units)

1. **U29-0 capture and scorer hardening (B2).** Acceptance:
   - The fuzz decode path never throws: a property test over random JSON payloads records a leg every time.
   - Offered-terms verification reports which amount reading verified.
   - `atomicToUsd` never returns NaN: a test covers `" 1"`, `"1.5"`, `"0x10"`, `"+5"`, `"1e6"` and `""`.
   - The existing corpus `report.json` files are byte-identical to before.
2. **U29-1 wire hook (B1, ADR-030).** Acceptance:
   - A scenario can serve a URL-safe, unpadded or invalid-JSON header, a string `maxTimeoutSeconds`, and a missing `x402Version`.
   - `validate` lints patch strings.
   - `corpusHash` is unchanged for `corpus/`.
3. **U29-2 generator and manifest (B3, F5, F7, F8, F9).** Acceptance:
   - Each mutation has an id, a tier and a spec cite (the cite is required for `spec-must`).
   - Two runs give byte-identical corpora and `cases.json`.
   - `validate` passes.
   - Each family includes its base control.
4. **U29-3 `diff` (F1, F3, F4, F5).** Acceptance:
   - It refuses reports with a mismatched seed, harness version or `accepts` hash.
   - It applies the outcome taxonomy and groups by provenance.
   - `diff.json` is byte-identical over two runs.
   - It has unit tests for each oracle and outcome, plus the planted `naive` vs `sdk-default` disagreement (F12).
5. **U29-4 governance and CI (F6).** Acceptance:
   - The GOVERNANCE.md section is written.
   - CI runs the smoke set against a golden file and prints counts only.
   - The leaderboard refuses `fuzz-` reports.

The third-party tier-2 runs stay manual and private, as they are now.

## Things done well, to keep

- The target is the client side, chosen on evidence from the prior-art research, and it is a real gap.
- The invariant oracle is the right primary signal. It needs no reading of the spec once B2 makes it measurable.
- §2 already makes "undefined" a tag and lets the differential oracle alone handle it. Keep that, and narrow must-refuse further.
- No new run path: each client runs through `run` and its existing adapter, and `diff` is a pure function of the reports.
- Third-party runs stay manual, sandboxed and private, and the design states the stop-and-report rule for schema changes. B1 is that rule working.

## Delta check (revision 2)

Scope: `functional-design.md` revision 2 (2026-10-18), checked against revision 1's
findings and against the code again. The ADRs are renumbered: ADR-030 becomes **ADR-032**
and ADR-031 becomes **ADR-033**. The SDK-specific detail asked for in the summary is now in
the private notes.

### Status of each finding

| id | status | where revision 2 deals with it | remaining gap |
|---|---|---|---|
| B1 | resolved, with a new problem (N2) | §2 U29-1, ADR-032 | N2, N5 |
| B2 / F2 | resolved | §2 U29-0 | m4 (rename `negative_amount`) isn't mentioned. New leg fields must not change existing reports (N4). |
| B3 | resolved | §3, U29-2 catalogue citations, ADR-033 | "`spec-must` pay-exactly" is probably empty, because the spec never obliges a client to pay. Say so, so that utility controls aren't read as conformance. |
| F1 | resolved | §0, §1 | none |
| F3 | resolved | U29-3 oracle 2 | none |
| F4 | partly | U29-3 outcomes | The rule "a client that fails its base control in a run has that run's results voided" is missing. U29-2 adds base controls, but nothing uses them. |
| F5 | resolved | U29-2 manifest, U29-3 alignment | none |
| F6 | resolved | U29-4, ADR-028 #7 | ordering (N3) |
| F7 | partly | U29-2 mapping table | N1 (the enum) and N6 ("unscored") |
| F8 | partly | U29-2 "Validity window" | `max_authorization_seconds` must be a positive number (scenario.ts:256). Cases that mutate `maxTimeoutSeconds` to 0, a negative, a fraction or a string through `wire` must keep the base value, and the oracle must read the wire value from the manifest. |
| F9 | resolved | §4 | none |
| F10 | partly | §4, §5 | The network-deny layer for first-party clients has no sub-unit or acceptance test. `payTo` drawn only from canary and poison templates, and a generator host lint, are not stated. |
| F11 | resolved | §0 | none |
| F12 | resolved | U29-3 acceptance | none |
| F13 | resolved | §3 | none |

### New problems

- **N1 (major): the `fuzz` category.**
  - `corpusHash` for `corpus/` is **unchanged**. It hashes only the canonical scenario JSON
    (score-suite.ts:38-42), and no existing scenario uses the new value.
  - But `by_category` is built by iterating `CategorySchema.options` (score-suite.ts:256).
    Adding the value adds a zero-count `"fuzz"` key to **every** `report.json`. As a result:
    - every committed `results/*.json` is no longer byte-identical;
    - the leaderboard's re-score comparison, which includes `by_category`
      (build-leaderboard.ts:215-217), rejects every committed report until each one is
      regenerated.
  - This contradicts U29-0's byte-identity acceptance and the intent of "closed enum"
    (scenario.ts:20-21).
  - Fix, preferred: **no new enum value**. Use an existing category plus
    `technique: "fuzz:<mutation-id>"`, and have the leaderboard refuse any report with a
    `fuzz:` technique. This is a data marker; an `agent_id` prefix is something the
    submitter chooses.
  - Alternative: keep `fuzz`, and make U29-2 a deliberate report-shape change. Regenerate
    `results/` and `LEADERBOARD.md`, with an audit entry.
- **N2 (major): the issued challenge must be the wire object.** Today `IssuedChallenge.accepts`
  is the typed build (x402v2.ts:207-214). Three things rely on it:
  - attribution matches payments against it on `payTo` and an exact amount string
    (capture/attribute.ts:52-57);
  - so does the binding check (x402v2.ts:148-158);
  - and so does `diff`'s `accepts` hash.

  With a patch, every patched payment goes unattributed, and both the invariant and
  alignment compare against terms the client never saw. U29-1 must record the
  **post-patch** decoded object, plus the encoding variant, as the offered terms. It must
  also define the offered terms for `invalid_json` and `raw`: none, so any signature is
  flagged. Add acceptance: a patched-amount case attributes its payment to the patched
  challenge.
- **N3 (major): sub-unit order.** The order 0, 1, 2, 3 is right. Hardening before wire
  before generator before diff matches the dependencies. Two exceptions:
  1. The network-deny layer (§4) is assigned to no sub-unit, but it must exist before the
     first fuzz run. Put it in U29-2 or in a precondition of U29-3.
  2. U29-4's private catalogue location and ADR-028 #7 must be in force from U29-2, when
     the first private families are written. Leaving them to the end creates a window in
     which families sit in the worktree. Move the privacy rules (not the GOVERNANCE.md text
     or CI) to the start.
- **N4 (minor):** U29-0's new fields (`decode_error`, which reading verified, the
  `atomicToUsd` reason code) must be ledger-only, or absent on today's paths. Otherwise its
  own byte-identity acceptance fails.
- **N5 (minor): `wire` details.**
  - A JSON merge patch (RFC 7396) can't set a field to `null` (null means delete) and
    replaces arrays whole. That is acceptable if the generator always writes the whole
    `accepts`, but say so, or use RFC 6902.
  - `body: differs` is underspecified.
  - `raw:<string>` and patch strings must also be in scope for lint rule 3.
- **N6 (major): "unscored" exists only in `diff`.** The scorer has no unscored notion.
  `allow: false` cases count in `summary`, `by_category` and `safety_score`, and a signing
  client fails them. That is acceptable only because fuzz reports are never ranked or
  committed. State it as: "`report.json` summaries of fuzz corpora are meaningless. `diff`
  ignores the scorer status for `spec-type` and `undefined`."
  - The leaderboard has **no** refusal today. A report with a foreign `corpus_hash` is
    listed in the public **stale** section (build-leaderboard.ts:986), not rejected.
  - So U29-4 needs a real refusal, keyed on data (N1), with a test that a fuzz report put
    in `results/` fails `pnpm leaderboard`.

### Decision

**Signed off for build**, under these conditions:
1. N1 is decided before U29-2 starts: no new enum value (preferred), or a logged
   regeneration of `results/` and `LEADERBOARD.md`.
2. N2's post-patch issued-challenge record, and its acceptance test, are added to U29-1.
3. The network-deny layer and the ADR-028 #7 privacy rules are in force before the first
   fuzz run (N3).
4. The leaderboard refusal keys on data and is tested (N6). The base-control voiding rule
   is added to U29-3 (F4).
5. N4, N5 and F8's handling of non-positive timeouts go into the relevant sub-unit's
   acceptance.
