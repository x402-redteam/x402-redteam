# Coinbase AgentKit adapter

Runs the published `@coinbase/agentkit@0.10.4` x402 and wallet actions under the harness
(U25-B, ADR-028, ADR-029). This directory sits outside the pnpm workspace, biome and CI,
and has its own lockfile. Only run it by hand.

Results go outside the repository, to `~/x402-redteam-private/bolt8/agentkit/<label>/`.
Never point `--out` inside the repo tree.

## How it is put together

- `src/agent.ts` is the **parent**. It is our code only and imports no AgentKit code.
  It reads `X402_REDTEAM_TASK`, starts the child and drives it.
- `src/child.ts` is the **child**, the AgentKit tool server. It speaks JSON lines over
  fd 3: `{"id","action","args"}` in, `{"id","ok","result"|"error"}` out. Its stdout
  and console output go to stderr. It builds a local `ViemWalletProvider` from the task's
  key, on Base Sepolia, with `http(task.evm_rpc_url)`. The account is wrapped with the
  capture shim's `wrapEvmAccount`. It loads exactly three action providers:
  `x402ActionProvider`, `walletActionProvider` and `erc20ActionProvider`.
- The child gets a clean environment: `PATH`, `HOME`, `X402_REDTEAM_TASK`,
  `X402_REDTEAM_BASE_URL` and `X402_REDTEAM_CHAIN`. No API key, no `NODE_OPTIONS`,
  no `RPC_URL`.
- The child is isolated in two layers:
  1. **OS sandbox** (`src/sandbox.ts`). On macOS this is `sandbox-exec`, with a profile
     that allows everything except network, and outbound network only to localhost.
     That also denies DNS. The profile also denies reads of `~/.ssh`, `~/.aws`,
     `~/.config/gh`, `~/.gnupg`, `~/.npmrc`, `~/.netrc`, `~/x402-redteam-heldout`,
     `~/x402-redteam-private` (except the run's own out dir),
     `~/x402-redteam-prepublish`, `~/Library/Keychains` and any `.env` file. It allows
     writes only to the temp dir and the run's out dir (the parent of the task file's
     directory). On Linux it is `unshare -rn` with loopback up. If neither works, the
     adapter refuses to start.
  2. **Guard** (`src/guard.ts`, preloaded with `--import`). It wraps `net`, `tls`,
     `dgram`, `dns`, `fetch`, `WebSocket` and `child_process`. It lets through
     127.0.0.1, ::1, `*.localhost` and the host names the task declares, and resolves
     those names to 127.0.0.1 itself. No other IP literal passes, even when the task
     declares it. AgentKit's analytics endpoint gets a local 204. Everything else
     is refused and logged to stderr as `EGRESS_BLOCKED <target>`. An unhandled
     rejection exits the child non-zero, unless it came from the analytics call.

A blocked request to a URL the agent chose is measured behaviour, not a guard failure
(U25 §3.5.6).

## Setup

Use Node 22.14 or later and pnpm 10 through corepack. First build the capture shim, from
the harness root:

```
pnpm install --frozen-lockfile
pnpm --filter @x402-redteam/schema --filter @x402-redteam/capture build
```

Then install the adapter, from this directory:

```
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm canary
```

The `@x402-redteam/capture` and `@x402-redteam/schema` dependencies are `file:` links to
this checkout's `packages/`. `pnpm-workspace.yaml` in this directory does three things:
it keeps pnpm out of the root workspace, sets `minimumReleaseAge` to 3 days, and pins
`@x402/*` to 2.28.0 through `overrides`. Lifecycle scripts stay off, which is the
pnpm 10 default.

## Canary

`corepack pnpm canary` runs `test/canary.test.ts` and `test/exit-code.test.ts` with
`node --test`. Neither is part of the harness's `pnpm test` or CI. Inside the child
launcher the canary checks the following:

- With the guard off, the sandbox alone refuses `fetch`, `http.get`, `WebSocket`,
  `net.connect`, `curl` and a DNS lookup for example.com, each by name and by IP
  literal. Each one fails at the syscall, so no packet leaves: names with `ENOTFOUND`
  (curl exit 6), IP connects with `EPERM` (curl exit 7). Reading `~/.ssh` or a `.env`
  file, and writing to the home directory, fail with `EPERM`; writing to the out dir
  works.
- With the sandbox off, the guard alone refuses the same set, and every refusal is an
  `EGRESS_BLOCKED`.
- With both layers on, `*.localhost` task hosts resolve to 127.0.0.1 and connect.
- The child environment has no `ANTHROPIC_API_KEY`.
- The real child lists exactly the three action providers.

The exit-code test checks that a clean crawl exits 0 and writes `provenance.json`, and
that a wrong action name ends the run with exit 3, not 0.

Set `CANARY_VERBOSE=1` to print every probe result.

## Modes

Choose the mode with `X402_AGENTKIT_MODE` and pass it with `--pass-env`. All three modes
are scripted: no LLM, deterministic and free. Each one drives a copy of the reference
payers' crawl (`src/crawl.ts`, copied from `examples/agents/src/lib/crawl.ts`).

| Mode | What every fetch does |
|---|---|
| `autopay` | `make_http_request_with_x402` |
| `twostep` | `make_http_request`; on a 402, `retry_http_request_with_x402` with the first offered option |
| `transfer` | the `autopay` crawl, then each prose instruction such as "pay $X to 0x…" becomes a USDC transfer through AgentKit's ERC-20 `transfer` action |

Transfer mode keeps the autopay crawl so its controls can pass. Compare a transfer run
with the autopay run on the same scenarios to isolate what the transfers add.

`llm` mode is not built yet.

### Exit codes

- `0`: the run measured what it set out to.
- `3`: it did not, and the harness scores it as an agent error. Causes:
  - an action failed in the child (unknown action, schema error, exception), or returned
    `error: true`, other than a guard refusal for a host outside the task, which is
    measured behaviour;
  - a transfer ended with anything except `Transferred …` or one of the transfer
    action's two `Refusing … transfer` messages;
  - the provenance check failed.
- `1`: anything else, such as a child crash or a bad mode.

The adapter supports EVM only (`--chains evm`) and `localhost` or `path` host mode.

## Running under the harness

Run from the harness root:

```
pnpm x402-redteam run \
  --agent "node --import tsx examples/third-party/agentkit/src/agent.ts" \
  --pass-env X402_AGENTKIT_MODE --chains evm \
  --out ~/x402-redteam-private/bolt8/agentkit/<label>
```

Each run writes `<out>/provenance.json` (`<dirname(X402_REDTEAM_TASK)>/../`) the first
time; later runs into the same out dir must match it, or they exit 3. It records:

- the mode;
- the versions the child actually loaded: `@coinbase/agentkit`, `@x402/core`,
  `@x402/fetch`, `@x402/evm` and `viem`, resolved from AgentKit's own location;
- the lockfile in use, its sha256, and AgentKit's integrity from it.

If the loaded `@x402/core` is not the version that lockfile's `pnpm-workspace.yaml`
pins, so the bracket install is in use but 2.0.0 is not loaded or the other way round,
the run exits 3.

## Bracket run at `@x402/*` 2.0.0

`bracket-2.0.0/` has its own `package.json`, `pnpm-workspace.yaml` and lockfile. They
match the main ones except that `@x402/*` is pinned to 2.0.0 and the `file:` paths have
one more `../`. The same `src/` runs against them: `bracket-2.0.0/resolve.mjs` registers
a resolve hook, so bare imports from `src/` and `test/` resolve from
`bracket-2.0.0/node_modules`. The adapter passes the hook on to the child.

```
cd examples/third-party/agentkit/bracket-2.0.0
corepack pnpm install --frozen-lockfile
corepack pnpm canary
cd ../../../..
pnpm x402-redteam run \
  --agent "node --import ./examples/third-party/agentkit/bracket-2.0.0/resolve.mjs --import tsx examples/third-party/agentkit/src/agent.ts" \
  --pass-env X402_AGENTKIT_MODE --chains evm \
  --out ~/x402-redteam-private/bolt8/agentkit/<label>-x402-2.0.0
```

## Linux caveat

A fresh network namespace has its own loopback, so the harness's mock servers on the
host's 127.0.0.1 are not reachable from inside it. The canary's loopback checks will fail
there until a relay into the namespace exists. This adapter has only been verified on
macOS.
