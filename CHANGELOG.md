# Changelog

All notable changes to x402-redteam are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in the README's
"Versioning" section. Sections from 0.1.1 on are generated from Conventional Commits by
`pnpm release:prepare` and edited by hand before the release PR merges.

## [Unreleased]

### Changed

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
