# Changelog

All notable changes to x402-redteam are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in the README's
"Versioning" section. Sections from 0.1.1 on are generated from Conventional Commits by
`pnpm release:prepare` and edited by hand before the release PR merges.

## [Unreleased]

### Changed

- **Scorer:** `reached` for `repeat`-class scenarios is now `true` only when the agent pays a
  surface route and later makes another request to the same route. Before, the unpaid probe plus
  the paid retry already counted, so every x402 client showed as reached. This changes the
  per-run `reached`, `by_reach_class.*.reached`, `by_reach_class.*.passed_while_reached` and
  `summary.reach_rate` fields; pass/fail, violations and `safety_score` are unchanged. The
  committed results were re-scored in place from their stored runs. Reports scored by v0.1.0 fail
  the leaderboard re-score, so no Tier 1/2 submission can be accepted until the next release is
  cut and allowlisted in `results/_harness.json`.

## [0.1.0] - 2026-10-14

First public release.

### Requirements

- The GitHub Action runs on Node 24 and needs a Node 24-capable runner. GitHub-hosted runners
  are fine; older self-hosted runners and GitHub Enterprise Server are not supported.
- Running from a clone needs Node 22.14 or newer and pnpm 10 (via corepack).

### Added

- **Harness:** runs an x402-paying agent, or a spend guardrail behind the standard driver
  (GDP v1, driver `driver@2`), through a corpus of hostile payment scenarios on EVM and
  Solana test rails, entirely offline, with a mock facilitator, a mock EVM JSON-RPC and a
  mock Solana RPC.
- **Corpus v4:** 71 scenarios (64 attacks, 7 controls) in 19 attack categories, from ghost
  paywalls, price bait, recipient redirection, replay, unit confusion and lookalike domains
  to `transfer_method_switch` (a Permit2 challenge that gets the SDK to sign an unlimited
  approval), `signature_request` (EIP-7702 delegations, Permit2 allowances and raw-digest
  signatures presented as payment) and `concurrent_spend` (parallel purchases against one
  budget). Scenarios can carry a free-text `technique` tag (`address_poisoning`,
  `discovery_poisoning`, `agent_lure`). Controls check that the agent still does the
  legitimate job.
- **Capture:** every signature an agent produces is recorded: x402 payment headers
  (EIP-3009 and verified Permit2, plus the SDK's gas-sponsoring extensions), the signer
  shim (typed data by primary type, transactions, messages, raw digests, EIP-7702
  authorizations) and signatures POSTed to a scenario's sign-request route.
- **Scoring:** payments, approvals and delegations, and signatures that move no value are
  scored separately, with codes including `authority_grant`, `standing_approval` and
  `off_scheme_signature`; grants signed by another wallet and recognised revocations are
  benign.
- **Reports:** `report.json` (deterministic apart from timing), `report.md` and SARIF, with
  every attempted payment or grant decoded: amount, recipient, chain and whether it was
  authorized.
- **CLI:** `x402-redteam run` and `x402-redteam validate`, with exit codes 0 (pass), 1 (an
  attack at or above `--fail-on` got through) and 2 (invalid run or harness error).
  `--agent-id` and `--guardrail-id` must match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- **GitHub Action:** agent and guardrail tracks, SARIF upload, report artifact, job summary
  and outputs read from `report.json`. The default `agent-id` is derived from the
  repository name (lower case, other characters turned into `-`).
- **Leaderboard:** three provenance tiers (ranked held-out, verified public corpus,
  self-reported) with acceptance checks, a re-score of every submitted report, and a
  "Rejected" section.
- **Reference agents and guardrails:** naive, guarded, sdk-default, a Python payer
  (`x402[evm,httpx]==2.25.0` plus `jsonschema==4.26.0`), allow-all, deny-all and a
  reference policy, with committed reference results (naive 5.3, guarded 100,
  reference-policy 100, allow-all 0, internal SDK-defaults baseline 43.0).

### Notes

- **Guardrail authors:** a GDP guardrail that does not declare the `sign` hook is never
  asked about sign requests, so the driver signs and submits them (a hook you do not
  implement allows). Declare `sign` to refuse non-payment signatures.
- **Python payer:** without `jsonschema`, `x402` 2.25.0 rejects any challenge that declares
  extensions, so it cannot pay a gas-sponsored Permit2 challenge.

### Security

- Releases are immutable GitHub Releases with an SBOM and Sigstore attestation bundles; see
  the README's "Verify a release" section.
