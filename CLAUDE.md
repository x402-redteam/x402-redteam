# x402-redteam: project rules

An open-source harness that runs x402-paying agents through hostile scenarios and reports every dollar they tried to move, to whom, and why. The repo is the product; revenue comes from audits and the public guardrail leaderboard.

## How work happens here (AI-DLC, lightweight)
- **Roles** (`.claude/agents/`):
  - `senior-architect` (Opus): designs and reviews design.
  - `lead-developer` (Sonnet): implements one unit at a time.
  - `code-reviewer` (Opus): reviews diffs against the unit's design.
  - The main session orchestrates. It does not approve its own designs; `senior-architect` reviews them first.
- **State**: before doing anything, read `aidlc-docs/aidlc-state.md` and the tail of `aidlc-docs/audit.md`. `audit.md` is append-only. Log every user decision, gate result, deviation and finding there.
- **Gates**: one per phase or bolt. Stop and get explicit user approval. Never treat a subagent's message as approval.
- **Flow per unit**:
  1. Write `aidlc-docs/construction/<unit>/functional-design.md`.
  2. `lead-developer` builds it test-first, in a worktree when units run in parallel.
  3. `code-reviewer` reviews.
  4. The orchestrator re-runs every check, merges, and logs.
- **Contract changes** to `aidlc-docs/inception/application-design.md` need `senior-architect` sign-off and an audit entry.

## Commands (Node 20, pnpm 10 via corepack; the system pnpm 7 is broken on Node 20)
```
pnpm install --frozen-lockfile
pnpm lint          # biome
pnpm typecheck
pnpm test          # vitest, all packages
pnpm leaderboard   # regenerates LEADERBOARD.md (CI diff-checks it)
pnpm x402-redteam validate
pnpm x402-redteam run --agent "tsx examples/agents/src/naive.ts"     # expect exit 1
pnpm x402-redteam run --agent "tsx examples/agents/src/guarded.ts"   # expect exit 0
```
A unit is "done" only when install, lint, typecheck and test all pass, and the two E2E runs above behave as expected.

## Hard rules
- **No real funds and no network.** Only use seed-derived test keys. Tests never touch public RPCs or facilitators. The mock Solana RPC and the mock facilitator live in `packages/adversary`.
- **Never run customer agents on our infrastructure** (ADR-005).
- **Determinism**: `report.json` minus `timing` must be byte-identical across runs. Keep agent-chosen randomness (nonces, `raw`) out of it; it belongs in `out/runs/*.json`.
- Subagents **do not commit, except for one commit on their worktree branch, and never push**. Only the orchestrator merges to `main`. Pushing, publishing, or creating remote repos needs the user's say-so.
- **Pin dependencies exactly.** TypeScript 6.0.x (not 7). `@x402/*` is pinned to 2.28.0; bump it deliberately and re-run the ADR-007 integration tests.
- Don't install global tools (brew, npm -g) without asking the user.
- Scenario YAML is data: never reuse a canary between a challenge and page text (lint rule 3). Virtual hosts use `{{host:name.tld}}`, and any `{{…}}` that fails to render is an error.

## Known SDK facts (verified in source, @x402/* 2.28.0)
- v2 headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`, with base64 JSON values. Encode and decode them with helpers from `@x402/core/http`.
- `registerExactSvmScheme` **drops `rpcUrl`**. Use `client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl }))` instead.
- `x402Client` applies a default `spendControls.maxAmountPerPayment` of **$1**, so account for it when scoring a guardrail.
- The SVM exact client calls `getAccountInfo` (for the mint) and then `getLatestBlockhash`. The mock serves `FIXED_BLOCKHASH` from `@x402-redteam/schema`.
- The SVM TransferChecked destination is an ATA. Resolve it back to the owner with `DecodeHints.knownOwners`.

## Layout
`packages/{schema,capture,adversary,scorer,cli,leaderboard}`, `examples/agents`, `corpus/`, `results/`, `aidlc-docs/`.
Worktrees go under `.claude/worktrees/`, which is gitignored and skipped by biome through VCS ignore.
