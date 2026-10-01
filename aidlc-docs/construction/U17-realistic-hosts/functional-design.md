# U17 — Realistic hostnames (`*.localhost` canonical, plain-HTTP forward proxy) · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 6 **Phase B1** · Contract: ADR-012 (full), application-design v3 "HTTP and agent contract"

## 1. Goal
A guardrail that knows nothing about the harness can pass the lookalike, ghost and redirect scenarios by checking `new URL(u).hostname`, and the cross-origin redirect is real. This closes Review 1 M1 and bolt5-closeout N5.

## 2. Files (owned in Phase B)
```
packages/adversary/src/hosts.ts      resolveHost(c, mode): Host header (strip :port, strip ".localhost") → scenario host; 127.0.0.1/localhost → /_host/ fallback → default
packages/adversary/src/proxy.ts      NEW: forward-proxy handler — absolute-form request target (GET http://provider.test/x) → same app with Host rewritten; CONNECT → 405;
                                      non-scenario hosts → 502 + logRequest(status 502, host) so a leak attempt is visible in the ledger
packages/adversary/src/index.ts      listen on 127.0.0.1 and, if bindable, ::1 (same port; fall back silently); expose proxyUrl; mount proxy
packages/cli/src/host-env.ts         preflightHostMode(mode): resolve "x402rt-probe.localhost" (dns.lookup, 2 s) + loopback GET; on failure → "path" + warning;
                                      hostEnv(mode, proxyUrl): proxy mode env (HTTP_PROXY, http_proxy, NO_PROXY="", no_proxy="", NODE_USE_ENV_PROXY=1)
packages/cli/src/main.ts             ONLY: flip --host-mode default to "localhost"
examples/agents/src/lib/crawl.ts     follow absolute links on any *.localhost / harness origin (not only base_url); keep /_host/ support
examples/agents/src/guarded.ts       host check = new URL(requested).hostname ∈ task.allowed_hosts (delete /_host/ parsing)
examples/agents/src/{naive,obedient,promptonly,sdk-default}.ts, lib/llm-tools.ts   only what is needed to fetch rendered hosts
examples/agents/src/hostname-allowlist.ts  NEW validity probe: shared crawler, pays via wrapFetchWithPayment with ONE policy:
                                      hostname ∈ allowed_hosts (and nothing else). Never reads /_host/.
examples/agents-py/**                if it parses /_host/, switch to hostname
README.md                            "Integration contract" § host modes + proxy recipes (Node 20: undici EnvHttpProxyAgent; NODE_USE_ENV_PROXY "check your Node version"; Python httpx/requests honour env)
packages/adversary/test/hosts.test.ts, proxy.test.ts; packages/cli/test/host-env.test.ts
packages/cli/test/hosts.e2e.test.ts  NEW (orchestrator runs)
```

## 3. Rules
- In localhost mode, the harness endpoints (`/facilitator`, `/solana-rpc`, `/evm-rpc`, `/__harness/ledger`) stay on `task.base_url` (`127.0.0.1`). Only scenario virtual hosts get names.
- A redirect `Location` is rendered with `hostUrl(mode, …)` (already true via render.ts after U15). Verify that `recipient-redirect` now crosses origins.
- Proxy mode serves the *same* Hono app, so nothing about scoring changes.
- An agent whose proxy request targets a host outside the scenario gets 502. That request is logged; it is not scored.
- The guarded logic stays "written against the corpus", but its host check must now be the generic hostname check.

## 4. Acceptance tests
**Developer (each < 3 min):**
- `hosts.test.ts`: `Host: weather-rep0rt.test.localhost:1234` → `weather-rep0rt.test`; `Host: 127.0.0.1:1234` with `/_host/x/y` → `x`; IPv6 `[::1]:1234` → default.
- `proxy.test.ts`: an undici `ProxyAgent` fetch of `http://provider.test/…` through the proxy reaches the route; `CONNECT` → 405; an unknown host → 502 and is logged.
- `host-env.test.ts`: preflight success (real lookup) and a forced-failure stub that falls back to path.
- Targeted CLI probes using `--scenario` (each ≈ 1 min):
  - `hostname-allowlist` with `--host-mode localhost --scenario lookalike-domain` → that scenario passes on both chains;
  - the same with `--host-mode path` → it **fails**. This is the M1 validity proof.

**Orchestrator only:**
- `hosts.e2e.test.ts`: hostname-allowlist passes all lookalike, ghost and redirect variants in localhost mode and fails ≥ 1 in path mode.
- naive exits 1 and guarded exits 0 in localhost mode.
- Python agent smoke test in localhost mode (it resolves `*.localhost` on macOS; the Linux runner is verified in U22).
- Full `pnpm test:e2e`.

## 5. Do not
- Rename corpus hosts or add non-reserved domains (lint 6; a user decision).
- Implement HTTPS or CONNECT interception (no CA, ever, in v1).
- Change scoring, schema or `task.ts` (request via the orchestrator).
- Regenerate results.
- Run full E2E.
- Commit, except the single worktree commit.
