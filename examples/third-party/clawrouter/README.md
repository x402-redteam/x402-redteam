# ClawRouter adapter

Runs the published `@blockrun/clawrouter` package under the harness (U28, ADR-028,
ADR-029). It is built from the AgentKit adapter and keeps its properties: this directory
sits outside the pnpm workspace, biome and CI, has its own lockfile, keeps lifecycle scripts
off, and splits a parent from a sandboxed child over fd 3. The OS sandbox and the guard are
copied here, not imported. Only run it by hand.

Scenarios and results stay outside the repository:

- scenarios: `~/x402-redteam-private/bolt10/clawrouter/corpus/`;
- results: `~/x402-redteam-private/bolt10/clawrouter/runs/<profile>/<label>/`.

Never point `--out` inside the repo tree. This repo holds only the adapter, its canary and
a generic smoke corpus. It names no scenario, mechanism or result (ADR-028).

## What is under test

ClawRouter is a local proxy that routes OpenAI-style chat requests to a model API and pays
for them with x402. The adapter tests its payment logic under two configurations
(`defaults` and `budget`, below). There is no LLM in the loop, so a run is free and
deterministic.

## How it is put together

- `src/agent.ts` is the **parent**. It is our code only and imports no ClawRouter code. It
  reads the task and the profile, refuses to start if anything accepts a connection on
  127.0.0.1 or [::1] port 8402 (the package's default port), picks a free port P for the
  child's proxy, starts the child, sends the planned requests, classifies the answers and
  writes provenance and run notes.
- `src/child.ts` is the **child**. It imports `@blockrun/clawrouter` and calls `startProxy`
  with the task's seed-derived EVM test key, `apiBase` set to the task's `base_url`,
  `paymentChain: "base"`, `port: P`, `allowExistingProxy: false`, `skipBalanceCheck: true`
  with a stub balance monitor that reports `task.wallet_balance_usd`, and an observing
  `SpendControl` on in-memory storage. Before the first chat request it checks that the
  handle is on port P, in wallet mode, with the task wallet (addresses compared
  case-insensitively), and it waits for the package's start-up catalog fetches to settle
  (the response body read or the fetch rejected, then one macrotask turn, within 10 s).
- The child gets a clean environment: `PATH`, `HOME` set to a fresh temp dir,
  `X402_REDTEAM_TASK` and `X402_CLAWROUTER_PORT` (P). No `BLOCKRUN_*`, `CLAWROUTER_*`,
  `HTTP(S)_PROXY`, `NODE_OPTIONS` or API key.
- Two isolation layers, both built from the harness port (from `task.base_url`) and P and
  nothing else (`src/ports.ts`):
  1. **OS sandbox** (`src/sandbox.ts`, macOS `sandbox-exec`). Outbound network only to
     `localhost:<harness port>` and `localhost:<P>`; the child may bind P only. It denies
     reads of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.npmrc`, `~/.netrc`,
     `~/.openclaw`, `~/.blockrun`, `~/x402-redteam-heldout`, `~/x402-redteam-private`
     (except the run's out dir), `~/x402-redteam-prepublish`, `~/Library/Keychains` and any
     `.env` file. Writes go only to the temp dir and the out dir.
  2. **Guard** (`src/guard.ts`, preloaded with `--import`). Wraps `net`, `tls`, `dgram`,
     `dns`, `fetch`, `WebSocket` and `child_process`. Loopback, `*.localhost` and the task's
     host names pass only on the two allowed ports, and only as 127.0.0.1 (::1 is refused,
     which the sandbox cannot do). The
     package's npm update check gets a local 204. Anything else is refused and logged to
     stderr as `EGRESS_BLOCKED <target>`.

## Setup

Use Node 22.14 or later and pnpm 10 through corepack. From the harness root:

```
pnpm install --frozen-lockfile
pnpm --filter @x402-redteam/schema build
```

Then, from this directory:

```
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm canary
```

`@x402-redteam/schema` is a `file:` link to this checkout's `packages/`.
`pnpm-workspace.yaml` keeps pnpm out of the root workspace and sets `minimumReleaseAge` to
3 days. The package is pinned exactly: `@blockrun/clawrouter` 0.12.282, the newest release
past that gate when this adapter was built. It bundles its own `@x402/*` and viem, so
`overrides` cannot change what runs. Lifecycle scripts stay off (the pnpm 10 default).

`pnpm-workspace.yaml` also moves vulnerable transitive dependencies to patched versions:
`axios` (0.27.2, asked for by `@polymarket/builder-relayer-client`) to 1.20.0, and `ws`
below 8.21.0 to 8.22.0. `elliptic` has no patched release, so it stays at 6.6.1 and is
listed in `osv-scanner.toml`. The published `dist/index.js` bundle inlines its own
dependencies, including axios, ws and elliptic, and imports no outside package apart from
optional natives (kerberos, bufferutil, utf-8-validate), so the installed copies are never
loaded. The adapter runs only by hand, offline and sandboxed.

## Profiles

Choose the profile with `X402_CLAWROUTER_PROFILE` and pass it with `--pass-env`. A missing
or unknown profile exits 1. Give each profile its own `--out` directory and
`--guardrail-id` (`clawrouter-defaults`, `clawrouter-budget`).

| Profile | Spending controls | Response cache |
|---|---|---|
| `defaults` | the package's defaults | package default |
| `budget` | `maxCostPerRunUsd = budget_usd` with `maxCostPerRunMode: "strict"`; `SpendControl` session limit and per-request limit both `budget_usd`; no payee, network or asset policy | package default |

Under `budget`, a scenario whose `budget_usd` is 0 exits 3 (the task file gives 0 when a
scenario sets none). Every scenario must therefore set `budget_usd` explicitly.

## Plan line

The scenario's `task.prompt` ends with exactly one line:

```
^clawrouter: model=(\S+) calls=([1-9][0-9]?) body=(same|distinct)$
```

- Any other line starting with `clawrouter:`, no such line, or a plan line that is not the
  last, exits 3. So does a prompt with no text before the plan line.
- The user message is the prompt text without that line. With `body=distinct`, call k
  appends ` (call k of n)`.
- Parallelism comes only from `task.parallel`: all calls at once, or in order.
- The package's response cache and request dedup are on by default. A scenario that needs n
  upstream requests uses `body=distinct`. The run notes record `body` and the cache setting.

## Running under the harness

Always set `--timeout` to 240 or less, so the package's periodic catalog refresh (if the
pinned version has one) never fires inside a run. From the harness root:

```
X402_CLAWROUTER_PROFILE=defaults pnpm x402-redteam run \
  --agent "node --import tsx examples/third-party/clawrouter/src/agent.ts" \
  --corpus <private corpus dir> --chains evm \
  --pass-env X402_CLAWROUTER_PROFILE --timeout 240 \
  --agent-id clawrouter --guardrail-id clawrouter-defaults \
  --out ~/x402-redteam-private/bolt10/clawrouter/runs/defaults/<label>
```

Then reconcile the pre-sign log with the harness capture (below):

```
node --import tsx examples/third-party/clawrouter/src/reconcile.ts <that out dir>
```

Only `localhost` and `path` host modes and `--chains evm` are supported.

## Outputs

Each run writes, beside the harness's own files:

- `provenance.json` (once per out dir; later runs must match it exactly or exit 3): the
  package version and its lockfile integrity, the sha256 of `dist/index.js` (the build is
  unmodified), the viem version read from the bundle, the installed sibling `@x402/*` and
  viem versions (not necessarily what the bundle inlines), the lockfile hash, the profile and
  every option passed to `startProxy`.
- `notes/<run_id>.json` and `notes/<run_id>.intents.jsonl`: the proxy port P,
  `catalog_settled`, the number of start-up catalog requests, the balance stub value, the
  request plan, each call's status and verdict, the pre-sign intents (route, payTo, network,
  asset and a pre-sign estimate of the amount, which matching does not use) and any
  `EGRESS_BLOCKED` lines with the number of intents before each.

Per-run values live in the notes, not in `provenance.json`, because one out dir holds many
runs and the provenance check compares the file byte for byte.

## Reconciliation

The harness writes `runs/<run_id>.json` only after the agent exits, so `reconcile.ts` runs
afterwards. It prints REVIEW for a run with an extra capture or any `EGRESS_BLOCKED`. The `intents` count in the notes covers allowed intents only. It sets aside intents the spend check refused (`allowed: false`, reported as `denied=N`; they never make a run unmeasured). It matches the other intents to header-captured payments in order on (route, payTo,
network), never on amount, and adds `intents`, `captured` and `unmatched` to the run's
notes. An intent with no captured payment makes the run **unmeasured**: leave it out of pass
totals. A payment captured with no intent is listed for review by hand and does not make the
run unmeasured. An `EGRESS_BLOCKED` that follows an intent is caught during the run and
exits 3. Signatures that never reach the seller are not captured, so results are a lower
bound on what was signed.

## Exit classes (`src/classify.ts`)

- `0`: the run measured what it set out to. The proxy returned a success, a passed-through
  402 challenge, a `invalid_payment` answer, one of the package's own spend-policy or
  cost-cap errors (`spend_policy_denied`, `cost_cap_exceeded`, `payment_in_doubt`), or a
  payment-parse error.
- `3`: it did not, and the harness scores it as an agent error. A transport error to the
  child's own proxy, a child crash, a bad plan line, a wallet or port mismatch,
  `catalog_settled: false`, a guard refusal naming a task host, an `EGRESS_BLOCKED` after a
  pre-sign intent, a 404 or 409 `no_run_loaded` from the upstream, any error body not in this
  list, or a provenance mismatch.
- `1`: a missing or unknown profile, `proxy` host mode, a non-EVM task, or something
  listening on port 8402.

The package's own errors are classified by `error.type`. Errors passed through from the
upstream are classified by status and by the harness adversary's own response bodies. When in
doubt the outcome is unmeasured.

## Canary and smoke gate

`corepack pnpm canary` runs `test/canary.test.ts`, `test/exit-code.test.ts` and
`test/reconcile.test.ts` one after another with `node --test`. Neither is part of the harness's `pnpm test` or CI. The canary checks that,
with each layer on its own and with both:

- fetch, `http.get`, WebSocket, `net.connect`, curl and DNS to example.com are refused, by
  name and by IP literal;
- decoy listeners on 8402 and on a random loopback port are refused on 127.0.0.1, ::1 and a
  `*.localhost` name, and accept no connection;
- reads of `~/.ssh`, `.env`, `~/.openclaw` and `~/.blockrun` fail (the last two are checked
  against real files in a stand-in home), and writes outside the temp dir and the out dir fail;
- the child's own proxy port and the harness port work, and the update check is answered
  locally while any other registry path is refused;
- the child environment holds only its four variables, the allowlist is built from P and the
  harness port only, and the parent refuses to start while something listens on 8402.

The exit-code test covers every row above, each malformed plan-line case, the profile and
host-mode cases and the budget case.

The smoke gate runs one paid control and one unpaid scenario in `test/smoke-corpus/` under both profiles, five
runs each, and checks byte-identical reports (minus `timing`), the same request order and
payment terms, every catalog request before the first chat request, `catalog_settled: true`,
no `EGRESS_BLOCKED` and zero unmatched intents. From the harness root:

```
node --import tsx examples/third-party/clawrouter/scripts/smoke.ts <dir outside the repo>
```

Set `CANARY_VERBOSE=1` to print every canary probe result.

## Linux caveat

A fresh network namespace has its own loopback, so the harness's mock servers on the host's
127.0.0.1 are not reachable from inside it, and `unshare` cannot name ports. The guard still
enforces the port allowlist there, but the adapter has only been verified on macOS.
