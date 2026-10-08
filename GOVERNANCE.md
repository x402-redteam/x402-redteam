# Governance

x402-redteam is a **maintainer-led** project with one maintainer, @OWNER_HANDLE. This page says
who decides what, how the code is actually produced, and what that does and does not
guarantee.

## Roles

| Role | Who | Responsibilities |
|---|---|---|
| Maintainer | @OWNER_HANDLE | Merges to `main`, cuts releases, owns the roadmap and final decisions, handles security reports ([SECURITY.md](SECURITY.md)) and Code of Conduct reports. |
| Ranked-run operator | the maintainer | Approves runs in the `ranked` environment (`.github/workflows/ranked-run.yml`) and commits the resulting reports and attestations. |
| Season-key custodian | the maintainer | Holds each season's seed, `age` key and held-out corpus offline, publishes the seed commitment, and reveals the seed and corpus at season end ([docs/seasons.md](docs/seasons.md)). Also holds the held-out guard key. |
| Contributor | anyone | Opens issues, proposes public scenarios, submits PRs and Tier 2 results ([CONTRIBUTING.md](CONTRIBUTING.md)). |

## How this project is built

Design, implementation and code review are performed by **AI agents under one human's gates**.

- The agent roles are defined in [`.claude/agents/`](.claude/agents/): a senior architect
  (designs and reviews designs), a lead developer (implements one unit at a time, test-first)
  and a code reviewer (reviews each diff against its design).
- The maintainer approves each phase at an explicit gate, and nothing merges to `main` without
  the maintainer.
- The trail of designs, decisions, gate results and review findings is kept in
  [`aidlc-docs/`](aidlc-docs/), including the architecture decision records and an
  append-only audit log.

### What that does not give you

- **No independent human review.** Every change is reviewed by an AI agent and approved by the
  same person who requested it. OpenSSF Scorecard does not count AI review, and neither should
  you.
- **CODEOWNERS is not enforced.** With one maintainer, an author cannot satisfy their own
  code-owner review, so `.github/CODEOWNERS` records ownership only. The mechanical control for
  `results/` is the `verify-results` workflow, which re-derives verification state on every PR
  that touches `results/**`.
- **The ranked environment is self-approved.** The person who approves a ranked run is the same
  person who maintains the harness. Seed commitments published before each season and the full
  reveal at season end are what let anyone audit a ranking afterwards.

Adding a second human maintainer is the change that would improve this most. It is wanted
before Season 1 is ranked.

## Decisions

Significant technical decisions are recorded as ADRs in
[`aidlc-docs/inception/adr/decisions.md`](aidlc-docs/inception/adr/decisions.md). To propose
one, open an issue describing the problem and the options; the maintainer decides and records
the outcome there. Everything else is decided in the PR that makes the change.

## Access continuity

OWNER_SUCCESSION_PLAN (pending an owner decision: who receives admin access to the
organization, the `ranked` and `guard` environments and the season keys if the maintainer
becomes unavailable).

## Becoming a maintainer

A contributor with a track record of merged, well-tested PRs or scenarios and constructive
reviews may be invited by the maintainer. New maintainers get merge rights first; ranked-run
and season-key roles follow once a season has run with them. Ask in an issue or Discussion
if you are interested.
