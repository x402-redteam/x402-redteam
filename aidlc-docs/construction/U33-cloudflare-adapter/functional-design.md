# U33 — Cloudflare Agents SDK adapter (functional design, rev 2)

Bolt 10, third-party adapters (owner scope 2026-10-13). Source review held privately (ADR-028):
`~/x402-redteam-private/bolt10/cloudflare-review.md`. This file names no finding, mechanism or
result. Rev 2 folds in `aidlc-docs/reviews/architecture-review-u33.md` (not ready; B1, M1–M8,
m1–m4, P1–P2).

## 1. Facts the design depends on (interoperability only)

- Package `agents@0.30.1` (MIT), the newest version outside the 3-day `minimumReleaseAge`. The
  `agents/x402` subpath runs in plain Node; no Worker or Durable Object stub is needed.
- It wraps an MCP SDK client, takes a viem account (the task's seed-derived EVM test key),
  accepts `eip155:84532`, and connects to any URL (path and localhost host modes).
- It sends the payment in `params._meta["x402/payment"]`, which the adversary already reads.
- It reads a payment request from the tool result's `_meta`, a channel the adversary does not
  serve. The repo's record of the x402 MCP transport spec at `0e6e8c55` (U30 functional-design
  §1) places the challenge only in `structuredContent` and `content[0].text`, so this is a
  **non-spec extension** (M1): every mode that carries it is `undefined` tier (ADR-033 #6) and
  can never support a `spec-must` result.
- It reads a per-tool price from `tools/list` `_meta`, which the adversary cannot serve today.
- `@x402/*` and the MCP SDK are optional peers; one runtime dependency has a postinstall script.

## 2. U33-0 — adversary: an opt-in result-`_meta` challenge copy, and `tools/list` `_meta` (public)

### 2.1 Opt-in, two ways (B1, M2)

1. **Run option** `--mcp-challenge-meta` (adversary and CLI): every MCP challenge in that run
   also carries an identical copy of the `PaymentRequired` in `result._meta` under the key the
   client reads. Recorded in `report.json` `config` and in each issuance's `channels`. The
   leaderboard refuses (rejected, with a reason) any report whose config carries it. Corpus
   hashes do not move; `corpus-mcp/` and private scenarios need no edit.
2. **Fuzz-only `wire.channels` modes** (ADR-032 #5, generated scenarios only, loader unchanged):
   `both_meta` (structured, text and meta identical), `meta_only`, `meta_differs` (structured and
   text carry the base terms, meta carries the mutated terms). All three are `undefined` tier.

Not chosen: emitting it on every challenge. It would put a non-spec key on every `@x402/mcp`
challenge, break the "`both` is byte-identical" invariant (`transports/mcp.ts:238-239`) and move
the offered-terms hashes and their binding.

### 2.2 Implementation points (M3, M4)

- `_meta` is **merged**, never replaced, wherever a result is built: `paymentRequiredResult`
  (`transports/mcp.ts:53-63`), `planAnswer` (`:248`), `represent()`, and the settlement path
  (`:61`). Settlement `_meta` survives alongside the challenge copy.
- `MCP_CHANNELS` (`schema/src/ledger.ts:8`) gains `meta` **appended last**, so existing union
  order and every existing `offered_terms_sha256_by_channel` value stay put. `planOffers` /
  `unionAccepts` and the fuzz binding (`fuzz/src/diff.ts:448-461`) read it only when present.
  `sdk_schema_ok` / `readByX402Mcp` unchanged (that client never reads `meta`).
- Generator lint covers the new modes' embedded literals.

### 2.3 `tool.meta` (M5)

- An explicit optional field on the tool spec (`ToolSpecSchema`, `scenario.ts:266`, today loose,
  so an unknown key parses silently; the field is made explicit and unknown keys stay as they
  are), and `reprice.meta` for the repriced listing.
- Rendered like `description` (canary templates allowed), served in that tool's `tools/list`
  entry; covered by lint rule 3 and counted as prose for attribution (`pageBodies`).

### 2.4 ADRs

- ADR-034 amendment: the run option, the merge rule, `tool.meta`.
- ADR-032 #5 amendment: the three fuzz-only modes; ADR-033 #6 note: all `undefined` tier.

### 2.5 Must not change

HTTP output; `corpus/` and `corpus-mcp/` hashes; `results/**`; the fuzz golden (it covers HTTP
clients, and its `mcp` hash comes from the generated shape corpus, which this does not touch);
`@x402/mcp` interop with the option off.

## 3. U33-1 — the adapter (`examples/third-party/cloudflare/`; public code, private results)

### 3.1 Shape (copied from U28, m1–m3)

- Outside the workspace, biome and CI; own `pnpm-workspace.yaml` with `minimumReleaseAge`,
  lifecycle scripts off, `osv-scanner.toml`; one directory name.
- **Direct exact pins** for `agents`, `@x402/core`, `@x402/evm`, the MCP SDK and viem (M6). The
  child checks the `@x402/core` version actually loaded; a mismatch with the pin exits 3.
  `provenance.json` with file hashes, as in U28.
- Parent/child over fd 3; OS sandbox and guard copied, not imported; loopback allowlist of the
  harness port only; scrubbed child environment; read-deny list; proxy host mode refused;
  README warning that `--out` must be private.
- Scripted only (no model): a plan grammar as in U28; the child calls each planned tool through
  `withX402Client`. Runs are deterministic (5-run determinism test).

### 3.2 Profiles (M8)

- `default`: package defaults.
- `raised-cap`: per-payment cap $1.00.
- `approve`: an approval callback that approves only when every offered amount is at or below
  the task's stated price, and logs the accepts it saw.

### 3.3 Measured or not (M7)

1. Each batch starts with the smoke paid control. If it produces no captured payment, every run
   in the batch exits 3.
2. A payment was due when a result has `isError` and a parseable `PaymentRequired` in any
   channel, cross-checked against the adversary's issuance log. If the copy was not in the
   channel the client reads (the run option off), the outcome is `not-reached`, exit 3, never a
   pass.
3. A visible challenge left unpaid is measured only when it matches a known reason in the
   classify table; otherwise exit 3.
4. Reconciliation on route, `payTo` and network, as in U28 C4.

Exit codes: 0 measured, 1 refused config, 3 unmeasured; a test for every row.

### 3.4 In the repo

The adapter, its canary and a generic smoke corpus. No scenario, mechanism or result names.

## 4. U33-2 — private scenarios and runs (owner-run)

- About six private scenarios, each with an explicit `task.budget_usd` (U28 N2), written by an
  isolated agent outside the repo (`~/x402-redteam-private/bolt10/cloudflare/corpus/`), owner
  spot-check before any run.
- Runs: the private scenarios and the reachable `corpus-mcp/` scenarios, under
  `--mcp-challenge-meta`, all three profiles. Outputs under
  `~/x402-redteam-private/bolt10/cloudflare/runs/`.
- `audit.md` records counts only (ADR-028 #7); disclosure follows the existing bar.

## 5. Acceptance

U33-0:
1. With the run option, a minimal test client that reads only `result._meta` pays a
   `corpus-mcp/` scenario; without it, the same client sees no challenge.
2. With the option off, MCP challenge bytes are identical to today (byte test on
   `paymentRequiredResult` output for every existing mode).
3. Settlement `_meta` and the challenge copy coexist after the merge.
4. `both_meta`, `meta_only`, `meta_differs` generate, lint, bind and tier as `undefined`.
5. `tool.meta` is rendered, served verbatim in `tools/list`, linted, and counted as prose.
6. The leaderboard rejects a report whose config carries the option.
7. Tests touched by name: `packages/adversary/test/mcp-*.test.ts`, `packages/schema/test/wire*.test.ts`,
   `packages/fuzz/test/mcp-shape.test.ts`, `diff-mcp.test.ts`, `offered-hash.test.ts`,
   `packages/leaderboard/test/*`, `packages/cli/test/corpus-mcp*.test.ts` (must pass unedited
   with the option off). Hashes, results and golden unchanged.

U33-1:
1. Canary passes offline in path and localhost modes; proxy refused.
2. Every exit-code row tested; a core-version mismatch exits 3; a batch whose smoke control is
   unpaid exits 3.
3. 5 identical runs give identical classified output.

## 6. Owner decisions

1. The opt-in design in §2.1 (run option plus fuzz-only modes; never on by default).
2. The three profiles in §3.2, with the `raised-cap` value $1.00.
3. U33-2 private scenarios as in §4.

### Build conditions (delta check, architecture-review-u33.md)

C1–C7 as listed in the review's "Delta check (rev 2)" section; the lead developer folds each
in and the code reviewer checks them.

### Owner decisions (2026-10-31)

1. §2.1 opt-in approved: run option plus the three fuzz-only modes, off by default.
2. All three profiles (`raised-cap` = 1000000 atomic, $1.00).
3. U33-2 private scenarios written as in §4, owner spot-check before any run.
4. Build approved, U33-0 then U33-1; local commits only.
