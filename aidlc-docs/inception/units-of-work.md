# Units of Work and Bolt Plan

Roles: **Opus** is the orchestrator, architect and reviewer. **Sonnet** is the lead developer, running as Agent-tool subagents with `model: sonnet`, one unit per agent, in an isolated git worktree whenever units run in parallel.

## Units
| Unit | Package | Scope | Acceptance (DoD) |
|---|---|---|---|
| U1 | workspace + `packages/schema` | pnpm workspace, tsconfig base, biome, vitest, `ci.yml` (lint + test); zod schemas and types from application-design §3–4; YAML loader; templating; canaries; chain defaults; USD↔atomic | `pnpm -r test` is green; the loader rejects bad YAML with a path-qualified error; canaries are stable across runs (snapshot) |
| U2 | `packages/adversary` | Hono server per §5: routes, virtual hosts, 402 issuer, behaviours, mock facilitator, mock Solana RPC, ledger endpoint, `createAdversary` API | Integration tests using the **real** `@x402/fetch` + `@x402/evm` + `@x402/svm` clients pay against it offline and produce the expected ledger for each behaviour |
| U3 | `packages/capture` | EVM decoder (EIP-3009 typed data → from/to/value, signature recovery), SVM decoder (tx → TransferChecked dest owner/amount/mint, signer), attribution + merge (§4), signer shim `wrapEvmAccount`, `wrapSvmSigner`, `recordTransfer` | Decoders are tested on fixtures signed by viem / @solana/kit; attribution has a table test covering header, prose, none and replay |
| U4 | `packages/scorer` | `scoreRun`, `scoreSuite`, JSON / SARIF / markdown reporters (§7) | Table tests per violation code; the SARIF output validates against the 2.1.0 JSON schema; the JSON is deterministic (snapshot) |
| U5 | `packages/cli` + `examples/agents` | Runner (§6), task file, spawn, timeout, `--repeat`, `validate` and `report` commands; the naive and guarded reference agents (§8) | E2E: naive fails every scenario and guarded passes every scenario; two runs give identical report.json without `timing`; the full run takes under 5 min |
| U6 | `corpus/` | 10 scenarios (one per category), each on both chains, plus `corpus/README.md` documenting the schema | `x402-redteam validate` passes; each scenario has a one-paragraph rationale naming the documented attack it models |
| U7 | `action/`, README, leaderboard | Composite GitHub Action (install, run, upload-sarif), top-level README with a quickstart, `leaderboard/` generator (reads `results/*.json` and writes `LEADERBOARD.md`) | Action YAML lints; leaderboard renders from the two reference-agent results |
| U8 | `packages/chain-local` (stretch) | Mode B: anvil + solana-test-validator bootstrap, mock USDC deploy, on-chain settle | Cut if Bolt 3 slips. Neither tool is installed locally |

## Dependencies
```
U1 ─┬─► U2 ─┐
    ├─► U3 ─┼─► U5 ─► U7 ─► (U8)
    └─► U4 ─┘    ▲
    U1 ─► U6 ────┘
```
U2 depends on U3 at runtime (decoders). To keep Bolt 2 parallel, U2 codes against the `capture` interface declared in U1 (`packages/schema/src/capture-api.ts`, types only) and uses a stub until merge. Opus does the integration at Gate G2.

## Bolts and gates
| Bolt | Units | Mode | Gate |
|---|---|---|---|
| Inception | — | Opus | **G0**: approve requirements, design and this plan |
| Bolt 1 | U1 | 1 Sonnet agent, main tree | **G1** |
| Bolt 2 | U2, U3, U4 | 3 Sonnet agents in parallel worktrees → Opus merges and integrates | **G2** |
| Bolt 3 | U5, U6 | 2 Sonnet agents in parallel worktrees → Opus runs E2E | **G3** |
| Bolt 4 | U7 (+U8) | 1–2 Sonnet agents | **G4**: MVP done |

## Per-unit loop
1. Opus writes `aidlc-docs/construction/<unit>/functional-design.md`, covering the interfaces, file list, acceptance tests and "do not" list.
2. A Sonnet agent implements the unit test-first and runs `pnpm -F <pkg> test` and lint, then reports its deviations.
3. Opus reviews the diff against the design, runs the tests, merges, and appends to `audit.md`.
4. Findings go back to the same Sonnet agent through SendMessage and are fixed before the gate.
