# U28: ClawRouter adapter (Bolt 10, early)

Revision 2, 2026-10-14. This revision folds in `aidlc-docs/reviews/architecture-review-u28.md`
(B1–B3, M1–M5, m1–m6). Owner decisions already taken: the ClawRouter scenarios are private and
adapter-only, and we test the unmodified published build.

This adds `examples/third-party/clawrouter/`, an adapter that runs the published
`@blockrun/clawrouter` package under the harness, in the same way as the AgentKit adapter
(U25-B, ADR-028, ADR-029). Only the owner runs it, by hand. Its scenarios and results
stay outside the repo.

## 0. Private locations

- Scenarios: `~/x402-redteam-private/bolt10/clawrouter/corpus/`.
- Results: `~/x402-redteam-private/bolt10/clawrouter/runs/<profile>/<label>/`.
- Source review and architect notes: `~/x402-redteam-private/bolt10/`.

No repo file names a ClawRouter scenario, mechanism, suspected weakness or result. The repo
holds only the adapter code, its canary, a generic smoke corpus and this design. Repo docs
give scenario counts only.

## 1. What is being tested

ClawRouter is a local proxy that routes OpenAI-style chat requests to a model API and pays
for them with x402. The unit under test is **ClawRouter's payment logic under two
configurations** (§4). There is no LLM in the loop.

The public corpus does not reach it: every public scenario serves web pages, and ClawRouter
only pays on `POST <apiBase>/v1/chat/completions`. The private scenarios use scenario schema
v4 with no harness change:

- a `POST /v1/chat/completions` route on the default host with
  `content_type: application/json`, a `challenge`, and a `delivered_body` holding an OpenAI
  chat-completion JSON;
- optionally a `GET /v1/models` route serving a catalog (see the limit below);
- the existing `normal`, `402_forever`, `no_delivery` and `replay` behaviours.

Known v4 limits, which hold for every scenario:

- **Catalog.** The adversary matches paths without query strings, so `/v1/models` and
  `/v1/models?format=json` get the same body. ClawRouter fetches both and parses them
  differently. Before any catalog scenario is written, check from source that one body
  satisfies both parsers. If it doesn't, stop and report. Controls and the smoke corpus
  serve no catalog route; the 404 leaves ClawRouter on its bundled catalog, which is fixed
  for a pinned version.
- **Redirects.** A v4 `redirect` is always a 302, which fetch clients follow as a GET. A POST
  route can't be redirected with its method kept.
- **Repeat payments (B1).** The harness attribution marks a payment `replay` when its terms
  match only an earlier, already-paid challenge (`packages/capture/src/attribute.ts:52-91`),
  and the scorer counts that as `replay_paid` (`packages/scorer/src/score-run.ts:152`). A
  correct payer that pays twice on the same terms can therefore be scored as replaying. So:
  - every control makes **exactly one paid call per route**;
  - in a private write-up, a repeat-scenario result that rests only on `replay_paid` is
    **not confirmed** (ADR-028 §3) unless the source shows the payment re-used a signature or
    authorization rather than signing fresh;
  - separating "signed again on unchanged terms" from "replayed" is a generic harness
    change. It is raised as its own public unit for the owner to schedule, worded with no
    reference to ClawRouter. It is not part of U28.

If a scenario needs anything else v4 can't express, the developer or author stops and
reports. The schema doesn't change in this unit.

## 2. Package and provenance

- `@blockrun/clawrouter` pinned exactly: 0.12.288, or the newest version older than the
  3-day `minimumReleaseAge` when the build starts. It has its own lockfile and its own
  `pnpm-workspace.yaml` outside the root workspace, with lifecycle scripts off.
- The package bundles its own `@x402/*` and viem, so `overrides` can't change what runs.
- `provenance.json` records:
  - the package version and its lockfile integrity;
  - the sha256 of `dist/index.js`, which shows the build is unmodified (it is not patched);
  - the bundled `@x402/*` and viem versions;
  - the profile and every option passed to `startProxy`;
  - the proxy port, `catalog_settled`, the balance-stub value and the request plan.

## 3. Process split and port safety

Same split as AgentKit:

- **Parent** (`src/agent.ts`): our code only. It imports nothing from ClawRouter.
  - Reads `X402_REDTEAM_TASK` and `X402_CLAWROUTER_PROFILE`. A missing or unknown profile
    exits 1.
  - Refuses `proxy` host mode with exit 1. Only `localhost` and `path` modes are supported.
  - Refuses to start (exit 1) if anything accepts a connection on 127.0.0.1:8402 or
    [::1]:8402, ClawRouter's default port.
  - Picks a free port P (never 8402) for the child's proxy.
  - Starts the child, sends the request plan over fd 3, reconciles capture (§5), and writes
    `provenance.json`.
- **Child** (`src/child.ts`): imports `@blockrun/clawrouter` and calls `startProxy` with:
  - `wallet`: the task's EVM test key (it accepts only a raw key);
  - `apiBase`: the task's `base_url`;
  - `paymentChain: "base"`, `port: P`, `allowExistingProxy: false`;
  - `skipBalanceCheck: true`, with a stub balance monitor reporting
    `task.wallet_balance_usd` as USDC;
  - `spendControl`: an observing `SpendControl` subclass (§5) on in-memory storage;
  - the profile's settings (§4).

  Before its first chat request the child must:
  1. Check that `handle.port === P` and the handle's wallet address equals the task wallet,
     else exit 3.
  2. Wait until ClawRouter's two start-up catalog requests have settled. The guard wraps
     `fetch`, so it sees them. If they haven't settled within 10 s, record
     `catalog_settled: false` and exit 3.

  It then sends each planned chat request to `http://127.0.0.1:P/v1/chat/completions` and
  returns status, body and timing.
- **Child environment:** `PATH`, `HOME` set to a fresh temp dir, `X402_REDTEAM_TASK`. No
  `BLOCKRUN_*`, `CLAWROUTER_*`, `HTTP(S)_PROXY`, `NODE_OPTIONS` or API key.
- **Loopback allowlist.** Both isolation layers allow only the harness's port and P on
  127.0.0.1, ::1 and `*.localhost`. Every other loopback port is refused. This applies the
  proposed ADR-029 amendment (§10).
- **Timeout.** Runs use `--timeout` of 240 s or less, so ClawRouter's 300 s catalog refresh
  never fires during a run. The README's commands set it.

## 4. Request plan and profiles

The adapter is scripted only, so runs are free and deterministic. Each private scenario's
`task.prompt` ends with one line that must match exactly:

```
^clawrouter: model=(\S+) calls=([1-9][0-9]?) body=(same|distinct)$
```

- Any other line starting with `clawrouter:`, or no such line, exits 3.
- The user message is the prompt text without that line. With `body=distinct`, call k
  appends ` (call k of n)`.
- Parallelism comes only from `task.parallel`: all calls at once, or in order.
- Under `defaults`, ClawRouter's response cache and request dedup are part of what is
  measured. A scenario that needs n upstream requests uses `body=distinct`. Provenance records
  `body` and the cache setting.

The profile is chosen with `X402_CLAWROUTER_PROFILE` and passed with `--pass-env`. Each
profile writes to its own `--out` directory and reports under its own `--guardrail-id`
(`clawrouter-defaults`, `clawrouter-budget`).

| Profile | Spending controls | Cache |
|---|---|---|
| `defaults` | ClawRouter's defaults | ClawRouter default |
| `budget` | `maxCostPerRunUsd = budget_usd` with `maxCostPerRunMode: "strict"`; `SpendControl` session limit and per-request limit both `budget_usd`; no payee, network or asset policy | ClawRouter default |

Under `budget`, a scenario with a paid route and no `budget_usd` (which the task file
gives as 0) exits 3.

## 5. Capture and measured outcomes

- **Measured result.** Header capture at the adversary records every `PAYMENT-SIGNATURE`
  that reaches the seller. That is what the harness scores.
- **Pre-sign log.** The observing `SpendControl` records each payment ClawRouter is about to
  sign: route, amount, payTo, network. These are written as JSON lines to the out dir. They
  explain results and are never used as signed amounts.
- **Reconciliation (M4).** After each run, the parent compares the pre-sign intents with the
  captured payments and writes `intents`, `captured` and `unmatched` to the run's private
  notes. A run is **unmeasured**, and left out of pass totals, if it has an unmatched intent
  or an `EGRESS_BLOCKED` that follows an intent.
- **Known gap.** Signatures that never reach the seller are not captured. Results are a lower
  bound on what was signed.

### Exit classes (`src/classify.ts`, M1)

| Child outcome | Exit |
|---|---|
| Proxy returned success, a passed-through 402, a spend-policy or cost-cap error, or a payment-parse error | 0 (measured) |
| Transport error to the child's own proxy, child crash, bad plan line, wallet or port mismatch, `catalog_settled: false` | 3 |
| `EGRESS_BLOCKED` naming a task host | 3 |
| Any error body not in the table | 3 (unmeasured) |

The table is keyed on ClawRouter's error types for the pinned version. When in doubt, the
outcome is unmeasured. The exit-code tests cover every row.

## 6. Isolation

Reuse the AgentKit sandbox and guard. They are copied into this adapter, not imported across
example directories. The OS sandbox allows localhost-only network, denies reads of the private
folders, and allows writes only to the temp dir and the out dir. The guard is preloaded with
`--import`. Changes from AgentKit:

- The loopback port allowlist (§3) in both layers.
- `~/.openclaw` and `~/.blockrun` added to the read-deny list.
- ClawRouter's npm update check gets a local 204, like AgentKit's analytics. Anything else
  outside the task's hosts is refused and logged as `EGRESS_BLOCKED`.

## 7. Acceptance

1. `corepack pnpm install --frozen-lockfile` and `typecheck` pass with lifecycle scripts off.
2. Canary (`corepack pnpm canary`), like AgentKit's:
   - each layer on its own refuses fetch, http, WebSocket, net, curl and DNS to example.com;
   - each layer on its own refuses a decoy listener on 8402 **and** one on a random other
     loopback port;
   - reads of `~/.ssh`, `.env`, `~/.openclaw` and `~/.blockrun` fail, and writes outside the
     temp dir and out dir fail;
   - the child environment has no API key and no `BLOCKRUN_*` or `CLAWROUTER_*` variables;
   - the parent refuses to start while something listens on 8402;
   - the update check is answered locally and nothing else leaves.
3. Exit-code tests: one per row of the §5 table; each malformed plan-line case; missing or
   unknown profile; `proxy` host mode; `budget` with no budget.
4. A smoke corpus in the adapter's `test/` folder: one paid control and one unpaid control,
   each with exactly one paid call per route and no catalog route. Generic and revealing
   nothing. Under both profiles:
   - both controls pass;
   - five runs give byte-identical reports (minus `timing`), with the same request order in
     `runs/*.json`;
   - every run has `catalog_settled: true`, zero egress apart from the update check, and zero
     unmatched intents.
5. The README covers setup, profiles, the plan-line grammar, the timeout, exit classes and the
   private locations. It warns never to point `--out` inside the repo.
6. Not part of `pnpm test`, biome or CI, as with AgentKit.

## 8. After the build (owner, by hand)

1. The orchestrator writes the private scenarios (about 12 to 15) into the private corpus
   folder. Each is tagged measurable, or stop-and-report against the §1 limits, before it is
   run.
2. The owner runs both profiles. No API key is needed and nothing is spent.
3. Every repeat or parallel scenario gets its own 2-run identity check. A mismatch is recorded
   in the private notes, not tuned away.
4. Findings follow the disclosure process in U25 §5. Nothing is published before that.

## 9. Out of scope

- Solana payments.
- Image commands and any route other than chat completions.
- A public "paid API seller" scenario family. It waits for the Bolt 10 MCP seller mode.
- Patching the package.
- The generic repeat-attribution harness change (§1). That is a separate public unit.

## 10. Proposed ADR changes (owner approval)

- **ADR-029 amendment 3a.** Loopback is not a trust boundary for a third-party local payer.
  The child may reach only the harness's port and ports the parent assigned to it. Both
  isolation layers enforce this. The parent refuses to start if a known default payer port is
  in use. This applies to every future adapter.
- **ADR-028 addition 6.** A third-party result that depends on a harness scoring rule the
  third party could reasonably dispute (for example, how a pre-signed payment is attributed)
  is not confirmed until the rule is stated in the private write-up and checked against the
  source.

## 11. Build conditions (architect sign-off of revision 2)

The architect signed off revision 2 for build subject to conditions C1–C4 and minors N1–N3 in
`aidlc-docs/reviews/architecture-review-u28.md` ("Delta check (revision 2)"). The lead
developer folds them in, and the code reviewer checks them:

- **C1:** "settled" means each catalog response body has been read, or the fetch has rejected,
  followed by one macrotask turn. The smoke-run adversary log shows the catalog requests, all
  before the first chat request.
- **C2:** the sandbox profile and the guard allowlist are both generated from the harness port
  (taken from `task.base_url`) and P. The canary decoys also cover `::1` and a `*.localhost`
  name on a disallowed port.
- **C3:** `classify.ts` keys on HTTP status and on where the error came from. ClawRouter's own
  errors are classified by `error.type`. Pass-through errors are classified by matching the
  adversary's own response bodies, as the review's table sets out.
- **C4:** intents are matched to captured payments in order on (route, payTo, network), never on
  amount. Mismatches in both directions go in the private run notes. A payment captured with no
  intent is reviewed by hand and does not make the run unmeasured.
- **N1:** P reaches the child and the guard as `X402_CLAWROUTER_PORT`. The canary checks that
  the allowlist is built only from P and the harness port.
- **N2:** every private scenario sets `budget_usd` explicitly (§8.1).
- **N3:** the wallet check compares addresses case-insensitively and requires
  `handle.authMode === "wallet"`.
