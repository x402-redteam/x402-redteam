# Cloudflare Agents SDK adapter

Runs the published `agents` package (`agents/x402`, `withX402Client`) under the harness (U33,
ADR-028, ADR-029). It is built from the ClawRouter adapter and keeps its properties: this
directory sits outside the pnpm workspace, biome and CI, has its own lockfile, keeps lifecycle
scripts off, and splits a parent from a sandboxed child over fd 3. The OS sandbox and the
guard are copied here, not imported. Only run it by hand.

Scenarios and results stay outside the repository:

- scenarios: `~/x402-redteam-private/bolt10/cloudflare/corpus/`;
- results: `~/x402-redteam-private/bolt10/cloudflare/runs/<profile>/<label>/`.

Never point `--out` inside the repo tree. This repo holds only the adapter, its canary and a
generic smoke corpus. It names no scenario, mechanism or result (ADR-028).

## What is under test

The package wraps an MCP SDK client so that a tool call can be paid with x402. The adapter
builds that client with the task's seed-derived EVM test key and makes a scripted list of tool
calls through it, under three configurations (`default`, `raised-cap` and `approve`, below).
There is no LLM in the loop, so a run is free and deterministic.

The package reads a payment request from the tool result's `_meta["x402/error"]`. The
adversary serves that copy only under the run option `--mcp-challenge-meta` (U33-0), which is
off by default, non-spec and not publishable. **Every run of this adapter needs it.** Without
it the run is `not-reached` and exits 3.

## How it is put together

- `src/agent.ts` is the **parent**. It is our code only and imports no package code. It reads
  the task, the profile and the plan line, applies the batch gate, starts the child, sends
  each planned call, classifies the answers and writes provenance and run notes.
- `src/child.ts` is the **child**. It checks the loaded versions against the pins, builds an
  MCP SDK `Client` over a Streamable HTTP transport to the planned server's URL, wraps it with
  `withX402Client(client, config)` and calls `callTool(null, { name, arguments: {} })` once per
  planned tool, in order. The account is viem's `privateKeyToAccount` of the task key, with
  `signTypedData` wrapped only to write the pre-sign log.
- The child gets a clean environment: `PATH`, a fresh `HOME`, `TMPDIR` and
  `X402_REDTEAM_TASK`. No proxy variable, `NODE_OPTIONS` or API key. It is assigned no port and
  binds none.
- Two isolation layers, both built from the harness port (from `task.base_url`) and nothing
  else (`allowedPorts` in the shared package):
  1. **OS sandbox** (shared `profile.ts` and `spawn.ts`, macOS `sandbox-exec`). Outbound network only to
     `localhost:<harness port>`. It denies reads of `~/.ssh`, `~/.aws`, `~/.config/gh`,
     `~/.gnupg`, `~/.npmrc`, `~/.netrc`, `~/.wrangler`, `~/x402-redteam-heldout`,
     `~/x402-redteam-private` (except the run's out dir), `~/x402-redteam-prepublish`,
     `~/Library/Keychains` and any `.env` or `.dev.vars` file. Writes go only to the child's own
     `HOME`. The out dir is readable and not writable.
  2. **Guard** (`src/guard.ts` is configuration only; the shared guard is preloaded with `--import`). Wraps `net`, `tls`, `dgram`, `dns`,
     `fetch`, `WebSocket` and `child_process`. Loopback, `*.localhost` and the task's host
     names pass only on the harness port, and only as 127.0.0.1 (::1 is refused, which the
     sandbox cannot do). Nothing is answered locally. Anything else, including the facilitator
     URL the package names as a default, is refused and logged to stderr as
     `EGRESS_BLOCKED <target>`.

  The sandbox, the guard and the child launcher are not in this adapter: they are the shared
  `@x402-redteam/sandbox` package (`packages/sandbox`, linked with `link:`), which this
  adapter configures in `src/guard.ts` and `src/child-client.ts` (U35). The child's only
  writable path is its own fresh `HOME` (`TMPDIR=<home>/tmp`), where nothing can be executed;
  the run's out dir is read-only to it, and the C1-C9 conformance canary runs from
  `test/canary.test.ts`. Before every run the launcher runs a one-shot check that other
  processes' environments are hidden from the child and refuses to start if one of the
  checks leaks, naming the probe: process-environment read via sysctl is not blocked by
  sandbox-exec on macOS 26, so third-party runs are blocked unless the owner records a
  residual (ADR-029). Do not export `ANTHROPIC_API_KEY` in the shell that runs the harness.

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

`@x402-redteam/schema` is a `file:` link to this checkout's `packages/`. `pnpm-workspace.yaml`
keeps pnpm out of the root workspace and sets `minimumReleaseAge` to 3 days. Lifecycle scripts
stay off (the pnpm 10 default; there is no `onlyBuiltDependencies`).

Pins, all exact and direct (`package.json`): `agents` 0.30.1, `@x402/core` 2.28.0,
`@x402/evm` 2.28.0, `@modelcontextprotocol/sdk` 1.32.1, viem 2.57.1, and the package's
required peers `@modelcontextprotocol/client` 2.3.1, `@modelcontextprotocol/server` 2.3.1 and
zod 4.6.7. `@x402/core` and `@x402/evm` are optional peers of the package, so pnpm would not
install them for us. The child checks the version actually on disk beside the package, and the
adapter's own top-level copy, against these pins before it connects. Any difference exits 3.

`osv-scanner.toml` lists the advisories accepted for this install.

## Profiles

Choose the profile with `X402_CLOUDFLARE_PROFILE` and pass it with `--pass-env`. A missing or
unknown profile exits 1. Give each profile its own `--out` directory and `--guardrail-id`
(`cloudflare-default`, `cloudflare-raised-cap`, `cloudflare-approve`).

| Profile | `withX402Client` config |
|---|---|
| `default` | `{ account, network }`, the package's defaults |
| `raised-cap` | as `default`, with `maxPaymentValue` 1000000 atomic ($1.00 of a 6-decimal asset) |
| `approve` | as `default`, with a `confirmationCallback` that approves only when every offered amount is at or below the plan's price, and records the accepts it saw |

`network` is the task's network. The `approve` rule needs the plan's price: a plan whose price
is `none` exits 1 under `approve`.

## Plan line

The scenario's `task.prompt` ends with exactly one line:

```
cloudflare: server=<host> tools=<t1>[,<t2>...] price=<usd|none> role=<control|run>
```

- `server` is a key of `task.mcp_servers`, such as `provider.test`; one that the task does not
  serve exits 3.
- `tools` are tool names (`^[a-z][a-z0-9_]{0,63}$`, up to 20), called once each in the order
  written. A tool that `tools/list` does not show exits 3.
- `price` is the stated price per call in USD, up to six decimals, or `none`.
- `role=control` marks the batch's smoke paid control (below).
- Any other line starting with `cloudflare:`, no such line, a plan line that is not last, or a
  prompt with no text before it exits 3.

To run a `corpus-mcp/` scenario, copy it outside the repo and append a plan line to its prompt.

## Running under the harness

MCP scenarios load only from a directory named `corpus-mcp`. From the harness root:

```
X402_CLOUDFLARE_PROFILE=default pnpm x402-redteam run \
  --agent "node --import tsx examples/third-party/cloudflare/src/agent.ts" \
  --corpus <private corpus-mcp dir> --chains evm --mcp-challenge-meta \
  --pass-env X402_CLOUDFLARE_PROFILE --timeout 120 \
  --agent-id cloudflare --guardrail-id cloudflare-default \
  --out ~/x402-redteam-private/bolt10/cloudflare/runs/default/<label>
```

Then reconcile with the harness record:

```
node --import tsx examples/third-party/cloudflare/src/reconcile.ts <that out dir>
```

Only `localhost` and `path` host modes (`--host-mode`) and `--chains evm` are supported; `proxy`
host mode exits 1.

## What counts as measured

A run is measured only if all of these hold. Anything else exits 3, and `reconcile.ts` marks
a run it finds unmeasured as UNMEASURED: leave it out of pass totals.

1. **Batch gate.** A batch starts with the smoke paid control (`role=control`). Its id must
   sort before every other scenario's in the batch, because the harness runs scenarios in id
   order. A control exits 3 unless every one of its calls ends in a paid delivery. Every other
   run first checks that an earlier control of the same batch (same seed; notes left in the out dir by an earlier batch
   are ignored) exited 0, that no control of this batch did not, and that the harness captured a
   payment in it (`runs/<run_id>.json`); if not, it exits 3.
2. **A payment was due** when a result has `isError` and a parseable `PaymentRequired` in any
   channel (`_meta["x402/error"]`, `structuredContent`, a text content item). If the copy is
   not in `_meta["x402/error"]`, the channel the package reads (the run option is off), the
   outcome is `not-reached`: exit 3, never a pass. `reconcile.ts` cross-checks each call
   against the adversary's issuance log: a payment request the adversary never issued, a
   challenge issued that the client never saw, or one issued without the `_meta` copy all make
   the run unmeasured.
3. **A visible challenge left unpaid** is measured only when it matches a known reason in
   `src/classify.ts`: the approval callback declined, the package's own cap message, its
   payload-failure message, no exact-scheme offer on an `eip155` network, or every exact offer
   over the default per-payment spend control (1000000 atomic). Otherwise it exits 3.
4. **Reconciliation** on (route, payTo, network), never on amount. An intent with no captured
   payment makes the run unmeasured; a payment captured with no intent is listed for review by
   hand. An `EGRESS_BLOCKED` that follows an intent is caught during the run and exits 3.
   Signatures that never reach the seller are not captured, so results are a lower bound on
   what was signed.

## Exit classes

- `0`: the run measured what it set out to. A paid delivery, an error result after payment, a
  result with no payment due, an unpaid call with a known reason (above), or a JSON-RPC
  payment-required error thrown to the caller (`402` or `-32042`).
- `3`: it did not, and the harness scores it as an agent error. A bad plan line, a failed batch
  gate, a smoke control that did not pay, a child crash or transport error, loaded versions that
  differ from the pins, a provenance mismatch, `not-reached`, an unexplained outcome, a guard
  refusal naming a task host, an `EGRESS_BLOCKED` after a pre-sign intent, or any thrown error
  not in the table.
- `1`: a missing or unknown profile, `proxy` host mode, a non-EVM task, or `approve` with a
  plan that states no price.

`reconcile.ts` exits 2 when it finds a run unmeasured on reconciliation (an unmatched intent or an
issuance mismatch), as in U28.

When in doubt the outcome is unmeasured.

## Outputs

Each run writes, beside the harness's own files:

- `provenance.json` (once per out dir; later runs must match it exactly or exit 3): the pins,
  the versions found on disk, lockfile integrity for the package, `@x402/core`, `@x402/evm`,
  the MCP SDK and viem, the sha256 of the package's x402 entry file and the module it imports
  (the build is unmodified), the lockfile hash, the profile and its settings.
- `notes/<run_id>.json` and `notes/<run_id>.intents.jsonl`: the plan, each call's outcome,
  reason, channels seen, signed count, the callback's decisions and the accepts it saw, the
  pre-sign intents (route, payTo, network, asset and the value, which matching does not use)
  and any `EGRESS_BLOCKED` lines with the number of intents before each.

## Canary and smoke gate

`corepack pnpm canary` runs `test/canary.test.ts`, `test/exit-code.test.ts` and
`test/reconcile.test.ts` one after another with `node --test`. None is part of the harness's
`pnpm test` or CI. The canary checks that, with each layer on its own and with both, in
localhost and path host modes:

- fetch, `http.get`, WebSocket, `net.connect`, curl and DNS to example.com are refused, by name
  and by IP literal, and so is the package's default facilitator URL;
- decoy listeners on a random loopback port are refused on 127.0.0.1, ::1 and a `*.localhost`
  name, and accept no connection; the child cannot listen on any port;
- reads of `~/.ssh`, `.env`, `.dev.vars` and `~/.wrangler` fail (the last is checked against a
  real file in a stand-in home), and writes outside the child's own `HOME` (including the out dir) fail;
- the harness port works;
- the child environment holds only its three variables, the allowlist is built from the harness
  port only, and `proxy` host mode is refused.

The exit-code test covers every row above, each malformed plan-line case, the profile and
host-mode cases, the `approve` rule, the version pins and the batch gate.

The smoke gate runs the two scenarios in `test/smoke/corpus-mcp/` (a paid control and an
unpaid scenario) under all three profiles, five runs each in localhost mode and one in path
mode, with `--mcp-challenge-meta`. It checks byte-identical reports (minus `timing`), the same
request order and payment terms, no `EGRESS_BLOCKED`, and no unmatched intent or issuance
mismatch. It then runs the corpus once without the run option and checks that every run exits
3. From the harness root:

```
node --import tsx examples/third-party/cloudflare/scripts/smoke.ts <dir outside the repo>
```

Set `CANARY_VERBOSE=1` to print every canary probe result.

## Linux caveat

A fresh network namespace has its own loopback, so the harness's mock servers on the host's
127.0.0.1 are not reachable from inside it, and `unshare` cannot name ports. The guard still
enforces the port allowlist there, but the adapter has only been verified on macOS.
