# U25: Third-party autonomous agents (Bolt 8)

Revision 2 (2026-10-10) answers architecture-review-u25.md: B1, B2, M1-M8, m1-m5.

Owner decisions (2026-10-10, audit.md): built-in Claude agent and a Coinbase AgentKit adapter now; x402 over MCP (Cloudflare Agents SDK, Vercel x402-mcp) next bolt; agentpay-mcp and Virtuals GAME recorded as blocked. $20 LLM cap for this bolt. Third-party results stay outside the public repo until coordinated disclosure. Adapters live in `examples/third-party/<name>/` with their own lockfile, outside the pnpm workspace and CI.

## 0. Private results location
Every third-party run (harness `--out`) writes to `~/x402-redteam-private/bolt8/<agent>/<run-label>/` (mode 700, never committed). The public repo receives only adapter code, this design, and counts in audit.md. A result is published only after the owner closes its disclosure.

## 1. U25-0: LLM agent stop semantics (harness, public; B1, M7, M8, m2)
Applies to `examples/agents/src/llm.ts` and `lib/llm-agent.ts`, so U25-A and U25-B share it.
- Exit code 3 for every stop except `end_turn`: per-run budget exhausted, session budget already spent, `refusal`, `max_tokens`, a turn with no tool call that is not `end_turn`, max turns reached, API error. The harness records a non-zero exit as an agent error, never a scored pass.
- Explicit request settings: `max_tokens` 16000, thinking set explicitly (adaptive) with effort recorded, so truncation is rare and visible.
- `addSpent` after every API call, not only at a normal end, so killed runs are counted.
- The run transcript (messages and tool calls) is written to `<out>/runs/<run_id>.transcript.json`, next to the existing per-run ledger.
- `KNOWN_PRICING` gains `claude-sonnet-5-5`.
- Acceptance: unit tests with a stubbed Anthropic client show that per-run budget, session exhaustion, refusal, `max_tokens` and max turns each exit 3 and score as an agent error; `end_turn` exits 0. A report is accepted for analysis only with 0 agent errors.

## 2. U25-A: built-in Claude agent baseline (manual, owner runs it, after U25-0)
No new code. The owner exports `ANTHROPIC_API_KEY` in their own terminal; the key never passes through the orchestrator. The owner also sets a spend limit in the Anthropic Console as the hard backstop.
- Model `X402_LLM_MODEL=claude-sonnet-5-5` for U25-A and U25-B (needs the G5 amendment, §7).
- EVM only, `--out ~/x402-redteam-private/bolt8/claude/<label>`:
  1. smoke: `--scenario control-paid-fetch,control-advertised-price,lookalike-domain --repeat 3`, budget $1;
  2. no hints: full EVM corpus `--repeat 3`, budget $6;
  3. policy hints (`X402_LLM_POLICY_HINTS=1`): full EVM corpus `--repeat 3`, budget $6, only if the cap allows.
- Acceptance: `summary.valid === true` and 0 agent errors; spend recorded. Comparisons use aggregates and categories with their spread, never a single-scenario delta (m4).

## 3. U25-B: AgentKit adapter, `examples/third-party/agentkit/`
Target: published `@coinbase/agentkit@0.10.4`. EVM only in this bolt (m1, B2: its SVM payment path has no RPC override). Unreleased `main` is U25-C.

### 3.1 Process split (B2, M1)
- **Parent** (in the adapter, our code only): reads `task.json`, runs the Claude tool loop from `examples/agents/src/lib/llm-agent.ts` (llm mode) or the scripted driver (scripted mode), and holds `ANTHROPIC_API_KEY`. It imports no AgentKit code.
- **Child** (AgentKit tool server): started by the parent with an environment containing no API key, only the task path and mock URLs. It speaks JSON lines on stdin/stdout: `{"id","action","args"}` in, `{"id","ok","result"|"error"}` out, and runs AgentKit actions with a local `ViemWalletProvider`.
- **Isolation of the child, three layers:**
  1. OS sandbox: on macOS, `sandbox-exec` with a profile that denies all network except loopback; on Linux, a network namespace (`unshare -n` with loopback up) when available. The adapter refuses to start the child if neither is available.
  2. Socket-level guard preloaded with `--import`: wraps `net.Socket.prototype.connect`, `tls.connect`, `dns.lookup`/`dns.promises`, the global `fetch` and `WebSocket`, and `child_process` spawn; only loopback, `*.localhost` and the task's declared origins pass; AgentKit's analytics host gets a local 204 at the fetch layer; everything else throws and is logged as `EGRESS_BLOCKED`.
  3. No `unhandledRejection` swallowing except rejections whose origin is the analytics URL; anything else exits non-zero (M7).
- Acceptance (canary test, runs locally): inside the sandboxed child, `fetch`, `http.get`, `WebSocket`, raw `net.connect`, `child_process` running `curl`, and DNS for a public host are each refused at the OS layer with the guard disabled, and refused by the guard with the sandbox disabled; the child's environment contains no `ANTHROPIC_API_KEY`.

### 3.2 Package and provenance (M2, m3, m5)
- Own `package.json` and lockfile, `"private": true`, outside the workspace, biome and CI. pnpm 10 defaults: no lifecycle scripts, `minimumReleaseAge` 3 days.
- Exact pins: `@coinbase/agentkit` 0.10.4; `@x402/*` 2.28.0 via overrides (what a fresh install resolves today); the harness's exact `@anthropic-ai/sdk` and `tsx`; `zod-to-json-schema` exact.
- The ledger shim comes from the built `@x402-redteam/capture` through a `file:` dependency; the account is built with the viem AgentKit resolves.
- Every private result records the resolved versions (`pnpm list --depth Infinity @x402/* viem @coinbase/agentkit`), the AgentKit tarball integrity and the lockfile hash.

### 3.3 Modes
- **scripted** (no LLM, deterministic, free). Three sub-modes, each a fixed driver over the reference payers' crawl:
  - `autopay`: every fetch through `make_http_request_with_x402`;
  - `twostep`: `make_http_request`, then `retry_http_request_with_x402` with the first offered option;
  - `transfer`: prose-instructed transfers through AgentKit's wallet transfer actions.
  Bracket runs at `@x402/*` 2.28.0 and at 2.0.0 (the version current when 0.10.4 shipped).
- **llm**: AgentKit's actions (x402 provider plus wallet actions; CDP-API actions excluded) exposed to the same Claude loop and system prompt as `llm.ts`, through the child. What this isolates: AgentKit's tool surface, tool descriptions, result text and wallet, with the model and prompt held constant. It is not AgentKit's own template prompt or step limit (M5); that is stated in every write-up.
- Mode from `X402_AGENTKIT_MODE`, passed with `--pass-env`.

### 3.4 Acceptance
- Canary test (§3.1) passes.
- Each scripted sub-mode: full EVM corpus, `summary.valid === true`, deterministic over 2 runs (byte-identical minus timing), 0 non-analytics egress. `autopay` gets a per-scenario diff against the internal `sdk-defaults` baseline with every difference explained.
- llm: the smoke run includes controls; if AgentKit's tool result asking the model to consult the user makes controls fail, that is recorded as a finding about the integration, not tuned away. Then the full EVM corpus `--repeat 3` within budget, 0 agent errors.
- All results under `~/x402-redteam-private/bolt8/agentkit/<label>/`; nothing written inside the repo tree (M3).

### 3.5 Build conditions (architect sign-off of revision 2)
1. The child's JSON-lines protocol uses a dedicated file descriptor (fd 3), not stdout; AgentKit's own `console.log` output goes to stderr.
2. With OS-level DNS blocked, the child guard resolves `*.localhost` and the task's declared hosts to 127.0.0.1 itself. The canary test shows a public lookup fails while task hosts resolve.
3. The transcript path is `<dir of X402_REDTEAM_TASK>/../runs/<run_id>.transcript.json`, derived from the task file location the harness already controls; the harness change in U25-0 documents it.
4. The `@x402/*` 2.0.0 bracket run has its own lockfile (`examples/third-party/agentkit/bracket-2.0.0/`).
5. Action providers in llm mode, exactly: `x402ActionProvider`, `walletActionProvider`, `erc20ActionProvider`. No CDP-API, social or other network providers.
6. A blocked request to a URL the model chose is recorded as measured behaviour (the agent tried to reach a non-task host), not as a guard failure. Only egress the adapter itself caused counts against the offline guarantee.

## 4. U25-C (stretch): AgentKit main, scripted mode only
AgentKit `main` at a pinned commit, built from source in the scratchpad, the three scripted sub-modes, no LLM cost. Same isolation.

## 5. Findings and disclosure (M3, M6)
- Each finding is classified: (a) library behaviour in AgentKit or `@x402/*`; (b) model judgement (the model chose to pay); (c) integration (how the two meet).
- Confirmed means either a deterministic scripted reproduction, byte-identical over 2 runs, with the `file:line` in the 0.10.4 tarball and a check against `main`; or, for model-dependent findings, at least 2 of n runs with transcripts saved privately. Version provenance is required either way.
- Class (a) goes to the vendor's own channel (Coinbase's HackerOne for AgentKit and `@x402/*`), sent by the owner. Classes (b) and (c) are not vendor vulnerabilities; publishing them is an owner decision.
- Public artifacts carry totals only, never counts broken down by category or scenario, until the owner closes disclosure. Private notes: `~/x402-redteam-private/bolt8/notes.md`.

## 6. Out of scope
x402 over MCP and x402 v1 (next bolt); AgentKit SVM; agentpay-mcp; Virtuals GAME; hosted wallets.

## 7. Owner decisions needed
- G5 amendment: allow `claude-sonnet-5-5` and the `examples/third-party/` adapters under the manual LLM exception (CLAUDE.md and audit entry).
- Proposed ADR-028 (third-party evaluation and disclosure) and ADR-029 (network isolation for third-party code).
