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

---

## Bolt 5 — Measurement validity (from Architecture Review 1, accepted at G5)

| Unit | Scope | Design |
|---|---|---|
| U9 | **Part A:** schema v2 contract landing. **Part B:** controls, run validity, exposure cap, safety score, CLI exit v2 | `construction/U9-validity/` |
| U10 | Mock EVM RPC; Solana `sendTransaction` capture; naive switches to real RPC transfers | `construction/U10-chain-capture/` |
| U11 | Corpus v2: oracle fixes, no-hint prompts, variants, 6 new attack classes, guarded fix *after* recording its failures | `construction/U11-corpus-v2/` |
| U12 | TS LLM agent (skipped without a key) and a Python x402 agent; integration docs; `action.yml` | `construction/U12-real-agents/` |
| U13 | Leaderboard acceptance checks, re-scoring, ranking v2, sdk-default baseline, honest CONTRIBUTING | `construction/U13-leaderboard-hygiene/` |

### Dependencies and parallelism
```
Phase A (sequential, main tree or 1 worktree):  U9-A schema v2 ──► merge + full checks
Phase B (3 parallel worktrees):                 U9-B   U10   U11   ──► merge in the order U9-B, U10, U11; integrate
Phase C (2 parallel worktrees):                 U12    U13          ──► merge U12, then U13 (regenerates results last)
Gate G6 after Phase C.
```
- **Why Part A first:** `schema/scenario.ts`, `ledger.ts`, `chains.ts`, `load.ts`, `cli/task.ts` and the env block in `cli/run.ts` would otherwise be edited by three units at once. Part A lands every contract field (defaults and types only), so Phase B units consume them without touching those files.
- **Merge order in Phase B:**
  - U9-B changes the report shape and the E2E expectations.
  - U10 changes naive's prose path.
  - U11 changes the corpus and guarded, and needs U10's `solana-rpc.ts` `assetInfo` mint decimals for `asset-swap` on svm.
  - Expect the orchestrator to fix up the E2E test expectations after the U11 merge; U11's `corpus-v2.e2e.test.ts` is authoritative for corpus-level counts.
- **Cross-unit features verified only at integration:**
  - `authorization-lifetime`: U10 capture fills `authorization_seconds`, U9 scores it, U11 supplies the scenario.
  - `asset-swap` on svm: U10's mint decimals and U11's scenario.
- **The CI leaderboard diff-check** will be red from the U9-B merge until U13 regenerates `results/`. That's expected; don't hand-patch it in between.
- **Lockfile:** only U12 adds dependencies (`@anthropic-ai/sdk`). The Python lock is separate (`examples/agents-py/uv.lock`).

### File ownership (Bolt 5; one owner per file; others must request changes via the orchestrator)
| Path | Owner |
|---|---|
| `packages/schema/src/**`, `cli/src/task.ts`, the env block in `cli/src/run.ts` | U9-A |
| `packages/schema/test/corpus.test.ts` | U9-A, then U11 |
| `packages/scorer/**`, `cli/src/{run,main}.ts` (rest), `cli/test/{run-suite.e2e,exit-code}.test.ts`, `corpus/controls/**` | U9-B |
| `adversary/src/{record,evm-rpc,solana-rpc,ledger-endpoint,state,index}.ts`, `capture/src/{evm,svm,merge}.ts`, `examples/agents/src/{naive.ts,lib/**}` | U10 |
| `adversary/src/{challenge,routes,render}.ts`, `capture/src/attribute.ts`, `corpus/**` (except controls), `corpus/README.md`, `examples/agents/src/guarded.ts` | U11 |
| `examples/agents/src/llm.ts`, `examples/agents/scripts/**`, `examples/agents/package.json`, `examples/agents-py/**`, `action.yml`, README "Integration contract" section | U12 |
| `packages/leaderboard/**`, `results/**`, `LEADERBOARD.md`, `CONTRIBUTING.md`, `examples/agents/src/sdk-default.ts`, README quickstart and "Leaderboard" sections | U13 |

### Bolt 6 (before public launch; not designed yet)
- ADR-010 guardrail-track driver;
- ADR-011 provenance and a held-out seasonal corpus;
- ADR-012 realistic hostnames / proxy mode;
- ADR-014 Rail port (MPP runway);
- a real-runner Action verification;
- ≥ 3 variants per category.
