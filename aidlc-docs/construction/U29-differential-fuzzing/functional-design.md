# U29: Differential testing and challenge fuzzing of x402 clients (Bolt 10)

Revision 1, 2026-10-16. Draft by the orchestrator, for senior-architect review.

## 0. Why

Until now every attack category has come from published research, SDK source or public
reporting. The harness measures known risks well, but it has no method of its own for
finding new ones. Prior-art research (held privately) found that all published x402
security work tests the seller side: servers and facilitators. None of it tests the clients
that sign payments. The two techniques with the best record of finding new bugs per unit
of effort in comparable settings are:

- **differential testing**: the same input sent to several independent implementations of
  one spec, then a check for where they disagree (Frankencerts for TLS, HTTP Garden,
  Fluffy for Ethereum clients);
- **fuzzing**: mutated, malformed and boundary-case inputs.

x402 has several independent client implementations. This unit sends each of them the
same generated 402 challenges and flags two things: disagreements between clients, and
violations of invariants that need no ground truth. By construction, anything found is
not taken from a published source.

Core principles that stay as they are: offline, test keys only, deterministic,
`report.json` scoring of every signed payment, third-party code sandboxed (ADR-029), and
third-party findings private until disclosure is closed (ADR-028).

## 1. Clients under test (first set)

| id | implementation | how it runs | notes |
|---|---|---|---|
| `ts-sdk` | `@x402/fetch` + `@x402/evm` 2.28.0 | `examples/agents/src/sdk-default.ts` | the SDK with no policy |
| `py-sdk` | PyPI `x402` 2.25.0 | `examples/agents-py` | an independent implementation |
| `agentkit` | `@coinbase/agentkit` 0.10.4 (its own `@x402` resolution) | AgentKit adapter, `autopay` mode | third party, sandboxed |
| `clawrouter` | `@blockrun/clawrouter` (bundled `@x402`) | ClawRouter adapter, `defaults` profile | third party, sandboxed; chat route only (§3) |

All are EVM only in this unit. SVM, `pay`, Cloudflare and mcpc join once their adapters
exist.

## 2. Generator

- **What.** A new package, `packages/fuzz` (public engine), with a CLI `x402-redteam fuzz`.
  From a seed and a mutation set it writes an ordinary **v4 corpus directory** of generated
  scenarios. Each scenario is one route with one challenge, and its expected outcome comes
  from the mutation. No harness schema change is planned. If a mutation needs one, stop and
  report.
- **Mutation families.** Each is applied to a fair base challenge:
  - **Amounts.** Atomic amounts at and beyond safe-integer limits, leading zeros, signs,
    decimal points, exponent forms, whitespace, empty, non-string types, and v1
    `maxAmountRequired` in place of v2 `amount`.
  - **Asset and decimals.** Unknown assets, assets with other decimals, `extra.decimals`
    that contradicts the asset, missing `extra.name`/`version`, and EIP-712 domain fields
    that don't match the asset.
  - **Network.** Unknown CAIP-2 values, mainnet in place of testnet, wrong case,
    whitespace, the chain id as a number, and a mismatch between `network` and the domain
    `chainId`.
  - **payTo.** Wrong checksum, mixed case, the zero address, a contract-shaped address, a
    lookalike, and the wrong length.
  - **Time.** `maxTimeoutSeconds` of 0, negative, huge, or fractional.
  - **Structure.**
    - `accepts`: empty, one entry, many entries, duplicates, entries for an unknown scheme.
    - `x402Version`: wrong or missing.
    - Unknown fields.
    - Header versus body disagreements (through `body_json`).
    - Header encoding: base64 variants, padding, URL-safe alphabet, and invalid JSON.
  - **Scheme.** An unknown scheme next to `exact`, and `extra.assetTransferMethod` variants.
- **Expected outcome per mutation.** Each mutation is tagged **must-refuse** (the input is
  invalid under the x402 v2 spec), **must-pay-exactly** (the input is valid, so the signed
  terms must equal the offered terms), or **undefined** (the spec is silent, so only the
  differential oracle applies). The tags cite the x402 spec section they rely on. Where
  there is no section to cite, the tag is undefined.
- **Determinism.** The same seed and mutation set give byte-identical scenario files. The
  generator never reads the network.

## 3. Route shapes per client

Most clients fetch pages with GET. ClawRouter pays only on
`POST /v1/chat/completions`. The generator therefore renders each case in one of two
shapes from the same challenge: a `page` shape (GET) and a `chat` shape (POST with an
OpenAI chat body and the plan line). A case's id and challenge are identical in both
shapes, so results can be compared across clients.

## 4. Oracles

Each case is run once per client with the existing `run` command. A new
`x402-redteam diff <report>...` command compares the reports case by case and applies three
oracles:

1. **Invariant oracle (no ground truth needed).** For any payment a client signed, the
   decoded signed terms must equal the terms it was offered: amount, payTo, asset, network,
   and a validity window no longer than `maxTimeoutSeconds`. A signature on a must-refuse
   input is also flagged. These come from the existing capture decoders.
2. **Expectation oracle.** The scorer's verdict compared with the mutation's tag.
3. **Differential oracle.** For each case, whether each client signed or refused, and,
   where two clients both signed, whether their signed terms match. Any disagreement is
   flagged, even when the spec is silent.

**Output.** `diff.json`, which is deterministic, plus `triage.md`, with one row for each
flagged case: the case id, the mutation, each client's outcome, and the oracle that fired.

## 5. Triage and privacy

- **Public:** the engine (`packages/fuzz`, the `diff` command), the mutation families, and
  a small fixed **public smoke set** of generic cases, run in CI against `ts-sdk` only, and
  only after any finding they could reveal is closed.
- **Private by default:** every generated run and every triage output that involves a
  third-party client or reveals an SDK defect. These go to
  `~/x402-redteam-private/bolt10/fuzz/`.
- **After triage,** a flagged case is reduced to a minimal scenario and classified using
  ADR-028's classes, plus "spec ambiguity" (the spec is silent and the clients differ).
  Confirmed defects follow the disclosure process. Spec ambiguities may go to the x402 spec
  repository, which is an owner decision.
- **After disclosure closes,** each minimal case becomes a public scenario, a held-out
  scenario, or an item-only scenario. That is an owner decision for each case.

## 6. GOVERNANCE.md addition

Add a "Private by design" section listing what stays private and why:

- held-out seasons (ADR-011);
- third-party results and per-item scenarios (ADR-028);
- fuzz and differential outputs until triage and disclosure close (this unit).

It also states what is always public: the engine, the scorer, the public corpus and the
reference results.

## 7. Acceptance

1. `x402-redteam fuzz --seed S --families all --out <dir>` writes a corpus that
   `validate` accepts, and it is byte-identical across two runs.
2. On the public smoke set, `ts-sdk` and `py-sdk` both run. `diff` writes `diff.json`,
   which is byte-identical across two runs, and `triage.md`.
3. Each oracle has unit tests with hand-built reports: one case per firing condition, and
   one case for no false positive when both clients refuse identically.
4. A known-answer check: a mutation that exercises an already-documented behaviour, the
   SDK default $1 cap, shows the expected agreement or disagreement.
5. The AgentKit and ClawRouter runs work through their adapters unchanged. They are run
   by hand, never in CI.
6. `pnpm lint`, `typecheck`, `test` and `test:e2e` pass. The fuzz runs are not part of
   `test:e2e`, apart from the smoke set.

## 8. Out of scope

- An adaptive LLM attacker. It could come later, scoped to LLM agents and guardrails.
- A spec-conformance suite as a separate product. The must-refuse and must-pay-exactly
  tags are its seed.
- SVM, MCP transport and new adapters. The MCP seller mode remains a separate Bolt 10
  unit.

## 9. Open questions for the architect

1. Is "expected outcome from the mutation" sound, or does it import our own reading of the
   spec as ground truth, the same circularity seen before? Should must-refuse be limited
   to cases the spec states explicitly?
2. Can v4 express every mutation family? In particular: malformed headers, header versus
   body disagreement, and non-string amounts, given how the adversary encodes
   `PAYMENT-REQUIRED`.
3. The invariant oracle relies on the capture decoders. Are they strict enough that a
   malformed signed payload is still decoded and compared, rather than dropped?
4. Run cost: about 4 clients times N cases, with one harness run per client. What N gives
   useful coverage while each client's run stays within a few minutes?
5. Should SDK version differentials, such as `@x402` 2.x releases or ClawRouter's older
   bundled core, count as separate clients?
