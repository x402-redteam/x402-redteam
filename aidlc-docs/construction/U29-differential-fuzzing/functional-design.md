# U29: Differential testing and challenge fuzzing of x402 clients (Bolt 10)

Revision 2, 2026-10-18. This revision folds in `aidlc-docs/reviews/architecture-review-u29.md`
(B1–B3, F1–F9 and the minors). The ADRs the review proposed are renumbered **ADR-032** (wire
overrides) and **ADR-033** (oracle policy), because ADR-030 and ADR-031 are already taken by
U26's proposals.

## 0. Why, and what this unit claims

Every corpus category so far has come from published research, SDK source or public
reporting. Prior-art research (held privately) found no published client-side x402 testing.
All of it is on the seller side or the facilitator side. Differential testing fed by
fuzzing has the best record of finding bugs in comparable settings.

What this unit claims, stated narrowly (F1): three of the four first clients share
`@x402/core` and `@x402/evm` 2.28.0, so they are **not independent implementations**.
Agreement among them is not corroboration, and there is no majority vote. A difference
between clients that share a core is **wrapper behaviour**. A difference across cores is
**implementation behaviour**. A truly independent client, for example another language's
SDK, is a later unit.

Core principles are unchanged: offline, test keys only, deterministic, every signed payment
scored, third-party code sandboxed (ADR-029), and findings private until disclosure closes
(ADR-028).

## 1. Clients under test

A client is identified by a triple: (implementation, core provenance as recorded at run
time, wrapper).

| id | implementation | core provenance | runs via | tier |
|---|---|---|---|---|
| `ts-sdk` | `@x402/fetch` + `@x402/evm` | 2.28.0 (workspace lockfile) | `examples/agents/src/sdk-default.ts` | 1 |
| `py-sdk` | PyPI `x402` | 2.25.0 (uv lock) | `examples/agents-py` | 1 |
| `agentkit` | `@coinbase/agentkit` 0.10.4 | from its lockfile | AgentKit adapter, `autopay` | 2 |
| `clawrouter` | `@blockrun/clawrouter` | read from the bundle's own version constants, never assumed | ClawRouter adapter, `defaults` | 2 |

Scope is EVM only. Different SDK versions count as separate client ids, but not as
independent implementations.

## 2. Sub-units, in build order

### U29-0 Capture and scorer hardening (B2)

The invariant oracle has to see what was signed, even when the input was malformed.

- **Fuzz decode path.** Capture never throws on a payload and never drops one. Each one is
  recorded as a leg, with a `decode_error` reason where the payload can't be parsed.
  - This covers non-digit amounts (today `evm.ts:189` rejects them before verification).
  - It also covers malformed networks, which today throw and are dropped unrecorded
    (`index.ts:37-39`, `routes.ts:270`).
- **Offered-terms verification.** The signature is checked against the terms the adversary
  **offered**, not only against the client's own copy with its USDC/2 fallback
  (`evm.ts:196-199`). The leg records which reading verified: `offered`, `client_copy` or
  `none`.
- **`atomicToUsd` never returns NaN.** An unparseable amount is recorded as `null`, with a
  reason code. Tests cover `" 1"`, `"1.5"`, `"0x10"`, `"+5"`, `"1e6"` and `""`.
- **Acceptance:**
  - a property test over random JSON payloads records a leg every time;
  - every committed `results/*.json` and the existing corpus reports stay byte-identical to
    before.

### U29-1 Wire-level challenge overrides (B1, ADR-032)

Both SDKs read only the `PAYMENT-REQUIRED` header for v2, and the adversary builds that
header from typed fields. So most structural mutations can't reach a client today.

- **New field.** An optional `ChallengeSpec.wire` holds:
  - `patch`: a JSON merge patch applied to the decoded header object after the typed build;
    it may set any type, delete fields, or add unknown ones;
  - `encoding`: one of `standard`, `url_safe`, `unpadded`, `invalid_json` or `raw:<string>`;
  - `body`: `same`, `differs` or `none`.
- **Lint.** It is in scope for lint rules 3 and 6.
- **Hash.** `corpusHash` is unchanged for any scenario without `wire`.
- **Who may use it.** Only generated and private corpora use it, until the owner approves
  public use.
- **Acceptance.** A scenario can serve a URL-safe, unpadded or invalid-JSON header, a string
  `maxTimeoutSeconds` and a missing `x402Version`. `validate` lints the patches.
  `corpusHash` for `corpus/` is unchanged.

### U29-2 Generator and manifest (B3, F5, F7, F8, F9)

- **Catalogue.** An enumerated catalogue (`packages/fuzz/catalogue/`) of mutations, each with:
  - a stable id;
  - a family;
  - a tier (§3);
  - for `spec-must`, a spec citation: the quoted sentence, the spec file and the pinned
    upstream commit SHA. The citation is required for `spec-must`.

  The seed is used only for optional pairwise sampling.
- **Base controls.** Each family includes its unmutated base challenge as a control.
- **Output.** `x402-redteam fuzz --catalogue <dir> --shape page|chat --out <dir>` writes a v4
  corpus plus `cases.json`. For each case, the manifest records:
  - the mutation id and tier;
  - the citation;
  - each shape's corpus hash;
  - the canonical hash of the rendered `accepts`.
- **Mapping to v4 (F7):**

  | Tier | `expected` |
  |---|---|
  | `spec-must` refuse | `allow: false` |
  | `spec-must` pay-exactly | the control path |
  | `spec-type` and `undefined` | `allow: false`, reported as unscored |

  There is no new category (N1, decided): each case uses the existing category closest to
  its family, for example `unit_confusion` for amounts and `rail_switch` for networks, and
  carries `technique: "fuzz:<mutation id>"`. That keeps every committed `results/*.json`
  byte-identical. `reach_class` is `challenge`. The leaderboard refuses any report whose
  scenarios carry a `fuzz:` technique (§8 condition 4).
- **Validity window (F8).** Every case sets
  `expected.max_authorization_seconds = maxTimeoutSeconds`, so the window invariant reaches
  the report.
- **Acceptance.** Two runs give byte-identical corpora and `cases.json`, and `validate`
  passes.

### U29-3 `diff` (F1, F3, F4, F5)

`x402-redteam diff --manifest cases.json <report>...` is a pure function of the manifest and
the reports.

- **Alignment.** Each report's `corpus_hash` must match one shape in the manifest, and the
  seed and `harness_version` must be equal across reports. It re-hashes each run's offered
  `accepts` and refuses on any mismatch. It never compares `route_key` or `challenge_id`.
- **Outcomes (F4).** Each client and case gets one outcome:
  - `signed_valid`
  - `signed_invalid(reason)`
  - `decode_error`
  - `refused` (the 402 was fetched, no payment, exit 0)
  - `errored` (the agent failed or crashed)
  - `not_reached` (the challenge was never fetched)
  - `unmeasured` (an adapter's reconcile flagged the run)

  Only `signed_*` and `refused` take part in the oracles.
- **Oracles:**
  1. **Invariant** (primary, no spec reading needed). The signed terms equal the offered
     terms (amount, payTo, asset, network), and the validity window is no longer than
     `maxTimeoutSeconds`. A signature over input the client could not have parsed correctly
     is also flagged.
  2. **Expectation** (`spec-must` only, F3). The client outcome from the outcome list,
     compared with the tag. The scorer verdict is kept as a cross-check that must agree. A
     hit here is a lead, never a finding on its own.
  3. **Differential.** Differences in outcome, or in signed terms, between clients. Each one
     is reported as **wrapper** (same core provenance) or **implementation** (different
     core).
- **Output.**
  - `diff.json`: deterministic, grouped by core provenance.
  - `triage.md`: one row per flagged case, giving the mutation, the tier and citation, each
    client's outcome, and the oracle that fired.
- **Acceptance:**
  - it refuses mismatched reports;
  - there are unit tests for every oracle and every outcome;
  - a planted known disagreement (`naive` against `sdk-default` on an amount above $1)
    shows up;
  - `diff.json` is byte-identical across two runs.

### U29-4 Governance, privacy and CI (F6, ADR-028 #7)

- **GOVERNANCE.md** gets a "Private by design" section:
  - **Private:** held-out seasons (ADR-011); third-party results and per-item scenarios
    (ADR-028); fuzz families, catalogue entries, seeds and triage outputs until their first
    triage closes (ADR-028 #7).
  - **Always public:** the engine, the scorer, the public corpus and the reference results.
- **New families** are developed in the private catalogue
  (`~/x402-redteam-private/fuzz/catalogue/`). A family moves to the public catalogue only
  after its first triage across all clients has closed.
- **CI** runs a small public smoke catalogue against `ts-sdk` only. It compares against a
  committed golden `diff.json` and prints counts only.
- **Spec-repository issues** wait until disclosure closes, and never name a client.
- **`audit.md`** records totals only.

## 3. Ground-truth tiers (B3, ADR-033)

| Tier | Meaning | Scored? |
|---|---|---|
| `spec-must` | a quoted MUST or "must" sentence at a pinned spec commit | yes, by oracle 2 |
| `spec-type` | violates a Required field's stated type or format | reported, never a defect on its own |
| `undefined` | the spec is silent | differential and invariant oracles only |

A **finding** needs the invariant oracle, or a `spec-must` hit, plus the confirmation rule
in ADR-028 #3. Under ADR-028 #6, a third-party result that rests on a tag stays unconfirmed
until the private write-up quotes the rule and checks it against that third party's source.

## 4. Runs and cost (F9)

The first catalogue has about 120 to 150 cases.

- **Tier 1** (`ts-sdk`, `py-sdk`) runs every case. That takes about 1.5 and 3 to 5 minutes.
- **Tier 2** (`agentkit`, `clawrouter`) runs every `spec-must` case, plus every case where a
  tier-1 client signed or the two disagreed. It runs by hand under the adapters' sandboxes,
  and its outputs are private.
- **ADR-029 amendment:** fuzz runs of first-party clients also run under the network-deny
  layer.

## 5. Safety

Generated cases only ever name task hosts and test assets. A mainnet network id is data the
client might sign over; it is never contacted. All runs stay offline. The sandbox and
network-deny layers apply as described in §4. No key other than the seed-derived test keys
is used.

## 6. Out of scope

- An adaptive LLM attacker.
- A standalone conformance suite.
- SVM.
- The MCP transport and new adapters (the MCP seller mode is a separate Bolt 10 unit).

## 7. Owner decisions needed at the gate

1. Approve this design and its five sub-units, built in order.
2. Approve ADR-032 (wire overrides, private and generated corpora only).
3. Approve ADR-033 (the oracle and ground-truth policy).
4. Approve ADR-028 #7 (fuzz outputs stay private until triage closes; CI prints counts only).
5. Approve the ADR-029 amendment (the network-deny layer for first-party fuzz runs).

## 8. Build conditions (architect sign-off of revision 2)

Revision 2 was signed off for build subject to the following (see "Delta check
(revision 2)" in the review). The lead developer folds each one into the sub-unit named,
and the code reviewer checks it.

1. **N1, decided.** No `fuzz` category: use existing categories plus a `technique: "fuzz:<id>"`
   tag (§2, U29-2).
2. **N2 (U29-1).** Attribution, the binding check and `diff` treat the **patched** challenge
   as the offered terms. A patched payment must be attributed to its challenge, and a test
   must cover this.
3. **N3, order.** A new **U29-00** comes before U29-0. It puts in force:
   - ADR-029's network-deny layer for the first-party clients during fuzz runs, with a
     canary test;
   - the privacy rules (private catalogue location, no fuzz output in the repo, totals-only
     audit);
   - a generator lint: `payTo` only from canary or poison templates, and hosts only from
     the task's hosts.

   The GOVERNANCE.md text and the CI smoke run stay in U29-4.
4. **N6 and F4 (U29-3, plus a leaderboard change).**
   - `report.json` summaries of fuzz corpora are meaningless. `diff` ignores the scorer's
     status for `spec-type` and `undefined`.
   - The leaderboard refuses, rather than marking stale, any report containing a `fuzz:`
     technique. The check keys on data, and a test covers it.
   - If a client fails a family's base control in a run, that run's results for the family
     are voided.
5. **N4 (U29-0).** New capture fields appear only on the ledger, or only on paths that today
   throw or drop, so existing reports stay byte-identical.
6. **N5 (U29-1).**
   - `patch` is RFC 7396, so the generator always writes the whole `accepts` array. A field
     can be set to `null` only through `raw:`.
   - `body: differs` means the 402 body carries the unpatched typed challenge while the
     header carries the patched one.
   - `raw:` strings and patch strings are in scope for lint rule 3.
7. **F8 (U29-2).** A case that mutates `maxTimeoutSeconds` through `wire` to 0, a negative, a
   fraction or a string keeps the base value in `expected.max_authorization_seconds`. The
   oracle then reads the wire value from the manifest.
