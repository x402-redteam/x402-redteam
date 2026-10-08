# Changelog

All notable changes to x402-redteam are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in the README's
"Versioning" section. Sections from 0.1.1 on are generated from Conventional Commits by
`pnpm release:prepare` and edited by hand before the release PR merges.

## [Unreleased]

## [0.1.0] - 2026-10-08

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
