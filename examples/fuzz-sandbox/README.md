# fuzz-sandbox: network-deny launcher for first-party fuzz runs

U29-00, ADR-029 3b. During fuzz runs, the first-party payers (`ts-sdk`, `py-sdk`) run under
an OS layer that lets them connect only to the harness's own loopback port. A fuzz run of a
first-party client must go through this wrapper. Normal `run` and `test:e2e` do not use it
and are unaffected.

```
pnpm x402-redteam run --agent "node examples/fuzz-sandbox/run.mjs tsx examples/agents/src/sdk-default.ts"
pnpm x402-redteam run --agent "node examples/fuzz-sandbox/run.mjs examples/agents-py/.venv/bin/python examples/agents-py/agent.py"
```

The wrapper reads the port from `base_url` in the task file (`X402_REDTEAM_TASK`) and runs
the command inside:

- macOS: `sandbox-exec` with `(deny network*)` and an allow for `localhost:<harness port>`
  only. Mach service lookups are denied too (`(deny mach-lookup)`), which closes the system
  resolver and other IPC daemons; Node, tsx and Python run without them (the canary checks
  each). Unix sockets are allowed only under a fresh per-run temp dir (`TMPDIR`, `TMP` and
  `TEMP` point at it; the `tsx` CLI listens on a socket there). The dir is removed on exit.
  A unix socket anywhere else, such as `/private/tmp`, is refused.
- Linux: unsupported. The launcher exits 2. `unshare -rn` gives a fresh network namespace
  whose loopback is not the host's, so the harness port would be unreachable from inside
  it. Linux returns after a Linux canary passes with a way to reach the harness port.

It exits 2 and starts nothing when no sandbox works, when the harness port is unknown, when
`base_url` has an empty port (`http://host:`; a URL with no port uses the scheme default),
or when the task's `host_mode` is `proxy`. Proxy mode sends requests through `HTTP_PROXY` to
bare names that no in-process shim can map to the harness, and `base_url` is not then the
port the client dials; use `localhost` (the default) or `path`.

DNS is denied by the layer too (the resolver is a network socket), so the harness's
`*.localhost` virtual hosts are resolved in-process by `dns-shim.mjs` (Node, preloaded
through `NODE_OPTIONS`) and `pyshim/sitecustomize.py` (Python, through `PYTHONPATH`). Every
other name still fails, and an IP literal fails at `connect()`.

## Canary (manual; not part of `pnpm test` or CI)

From the repository root:

```
node --test examples/fuzz-sandbox/canary.mjs
```

It runs a probe inside the wrapper and checks that `fetch` and DNS for example.com, a raw
TCP connect to example.com, and an IP literal (over `fetch` and TCP) all fail, while the
harness port works by IP and by a `*.localhost` name. A unix socket outside the run's temp
dir is refused and one inside it works. It also checks the `tsx` CLI case,
the exit-code pass-through, temp-dir cleanup, a start through a symlink, and the refusals
(no port, empty port, proxy mode). The Python case runs when
`examples/agents-py/.venv` exists; set `FUZZ_CANARY_PYTHON` to use another interpreter
(a git worktree has no venv of its own). Nothing leaves the machine: every public attempt is
refused by the OS.

## CI smoke run and its golden

CI runs the public smoke catalogue (`packages/fuzz/catalogue-public/`) through this wrapper on
macOS (`packages/cli/test/fuzz-smoke.e2e.test.ts`, the `fuzz-smoke` job). It compares the
`diff.json` of `sdk-default` with `packages/fuzz/test/golden/smoke-diff.json` and prints
counts only on a mismatch. The test fails, rather than skips, when the wrapper finds no
sandbox.

After an `@x402/*` bump, or any change to the public catalogue, regenerate the golden on a
Mac and review the diff of the file:

```
UPDATE_GOLDEN=1 pnpm vitest run --project cli fuzz-smoke.e2e
pnpm vitest run --project cli fuzz-smoke.e2e fuzz-diff.e2e
```

The golden holds public-catalogue case ids only. It is stored without the private marker.
