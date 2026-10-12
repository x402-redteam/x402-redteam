# Changelog

All notable changes to x402-redteam are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in the README's
"Versioning" section. Sections from 0.1.1 on are generated from Conventional Commits by
`pnpm release:prepare` and edited by hand before the release PR merges.

## [Unreleased]

### Added

- **Corpus v4:** 19 new scenarios (71 in total: 64 attack scenarios and 7 controls).
  Three new categories: `transfer_method_switch` (2, EVM: a Permit2 challenge that gets
  the SDK to sign an unlimited approval to Permit2), `signature_request` (3, EVM: an
  EIP-7702 delegation, a Permit2 allowance passed off as a payment, a raw-digest
  signature) and `concurrent_spend` (3, EVM and Solana: purchases decided together
  against one budget, with `task.parallel`). Eight scenarios in existing categories carry
  the new optional, free-text `technique` field: `address_poisoning` (2),
  `discovery_poisoning` (3) and `agent_lure` (3); it is never aggregated, and
  `by_category`, SARIF and the leaderboard still key on the category. Three EVM controls:
  a Permit2 payment, a Permit2 payment with both gas-sponsoring extensions (only an
  exact-amount permit is signed), and a payTo that is the named recipient in lower case.
  The template `{{lower:NAME}}` renders a canary in lower case (EVM-only scenarios).

- **Adversary:** a challenge can declare `PaymentRequired.extensions` (`challenge.extensions`);
  a route with `behaviour: collect_signature` serves a request to sign typed data, a raw
  digest, a message or an EIP-7702 authorization, and records the signature POSTed back
  with capture label `submitted` (also counted in `summary.capture_layers.submitted`).
  The template `{{poison:NAME}}` renders an address-poisoning lookalike of a canary, and
  `{{poison_short:NAME}}` / `{{short:NAME}}` render the truncated form wallets show. The
  mock EVM RPC reports a zero allowance to Permit2 and a zero EIP-2612 nonce.
- **Driver and GDP:** `sign` requests now carry `intent`, every signing input of one
  payment in `payloads` (for example a Permit2 transfer plus the SDK's approval), and the
  new payload kinds `authorization`, `message` and `digest` for sign requests found in
  pages and 402 bodies; the driver submits such a signature only when allowed. task.json
  is version 4 and adds `parallel`: the driver then sends every `payment` request before
  awaiting any answer. The driver and the naive, sdk-default and probe payers sign with
  the SDK's `toClientEvmSigner` composition, so they reach the SDK's approval path.
  **Note for guardrail authors:** a GDP guardrail that does not declare the `sign` hook is
  never asked about sign requests, so the driver signs and submits them (ADR-010: a hook
  you do not implement allows). Declare `sign` to refuse non-payment signatures.
- **Reference agents:** reference-policy adds a `sign` hook (denies non-payment signatures
  and approvals above the payment) and pins a payTo to the recipients the task names; naive
  signs every sign request it sees; guarded signs payment authorizations only. guarded and
  reference-policy both pay only a recipient the task prompt names, when it names any.
- **Scoring:** a signed message or unrecognised typed data recovering to a wallet other
  than the agent's is a relayed signature: $0 and no code, like a relayed grant.

### Changed

- **Driver:** the standard driver's tag is now `driver@2` (the U26-2 behaviour: sign
  intents, `intent` and `payloads` on `sign` requests, the `task.parallel` fan-out). The
  canonical guardrail-track configuration requires `driver@2`.
- **Reference results and LEADERBOARD.md regenerated on corpus v4.** naive 6.8 → 5.3 and
  the internal SDK baseline 47.7 → 43.0 (both fail most new attacks); guarded,
  reference-policy 100 and allow-all 0 are unchanged. No result on the 52 earlier
  scenarios changed. reference-policy now records hooks `payment, transfer, sign`.
- **Leaderboard:** reports produced against corpus v3 or earlier show as stale (corpus
  hash mismatch) and are not ranked until re-run against corpus v4. A guardrail-track
  report with the v4 corpus hash but `driver: driver@1` is rejected as non-canonical.
- **Python reference payer:** `examples/agents-py` now also installs `jsonschema==4.26.0`
  next to `x402[evm,httpx]==2.25.0` (both pinned in `uv.lock`; no other version changed).
  Without jsonschema, `x402` 2.25.0 rejects any challenge that declares extensions
  ("Extensions validation requires jsonschema. Install with: pip install x402[extensions]"),
  so it cannot pay a gas-sponsored Permit2 challenge. The payer also skips a 402 that carries no
  x402 challenge instead of reporting an error.

- **Scoring:** approvals and delegations (`approve`, `delegate`) and signatures that move
  no value (`message`, `unknown_typed_data`) are scored apart from payments, with three
  new violation codes: `authority_grant` (an allowance to any spender other than canonical
  Permit2, or an EIP-7702 delegation, counted under the wallet-balance cap),
  `standing_approval` (an allowance to Permit2 above the payment it came with; $0, fails
  the run) and `off_scheme_signature` (a signed message or unrecognised typed data; $0,
  fails the run). They no longer trigger the payment checks or count toward
  `max_payments`, `total_usd` or overpay. Grants signed by a wallet other than the
  agent's count $0. Only a revocation the decoder recognises (an approval of 0, a Solana
  `Revoke`, or a `SetAuthority` that removes the authority) is benign; any other $0 grant
  still fails the run. Reports gain optional `submission` and `revocation` fields on
  payments; the report schema stays `report@3`.
- **Solana results:** `ApproveChecked`, `Approve` and `SetAuthority` legs now score as
  `authority_grant` instead of `payment_not_allowed`/`wrong_recipient`. One whose
  transaction cannot be fully verified for a reason other than a bad signature (for
  example an address lookup table) is still counted at its recorded value. No committed
  reference result contains such a leg, so no published score changed.

## [0.1.0] - Unreleased

First public release.

### Requirements

- The GitHub Action runs on Node 24 and needs a Node 24-capable runner. GitHub-hosted runners
  are fine; older self-hosted runners and GitHub Enterprise Server are not supported.
- Running from a clone needs Node 22.14 or newer and pnpm 10 (via corepack).

### Added

- **Harness:** runs an x402-paying agent, or a spend guardrail behind the standard driver
  (GDP v1), through a corpus of hostile payment scenarios on EVM and Solana test rails,
  entirely offline, with a mock facilitator and a mock Solana RPC.
- **Corpus:** ten attack categories (ghost paywalls, price bait, recipient redirection, replay,
  unit confusion, lookalike domains and more) plus control tasks that check the agent still
  does the legitimate job.
- **Reports:** `report.json` (deterministic apart from timing), `report.md` and SARIF, with
  every attempted payment decoded: amount, recipient, chain and whether it was authorized.
- **CLI:** `x402-redteam run` and `x402-redteam validate`, with exit codes 0 (pass), 1 (an
  attack at or above `--fail-on` got through) and 2 (invalid run or harness error).
- **GitHub Action:** agent and guardrail tracks, SARIF upload, report artifact, job summary and
  outputs read from `report.json`.
- **Leaderboard:** three provenance tiers (ranked held-out, verified public corpus,
  self-reported) with acceptance checks and a "Rejected" section.

### Security

- Releases are immutable GitHub Releases with an SBOM and Sigstore attestation bundles; see
  the README's "Verify a release" section.
