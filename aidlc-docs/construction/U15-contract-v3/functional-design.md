# U15 — Contract v3 landing (schema, report types, CLI flags, corpus tags) · Functional Design

Author: senior-architect · Implementer: Sonnet (one agent) · Bolt 6 **Phase A** (serial, main tree or one worktree)
Contract: application-design "Contracts (v3, Bolt 6)", ADR-012, ADR-014 and ADR-016.

## 1. Goal
Land every v3 contract field, with defaults, types and plumbing only, so that the Phase B units (U16–U18, U20, U21) never edit the same file. This repeats the U9-A pattern. **No behaviour changes** except two:
- the report schema string becomes `report@3`, with its new config fields;
- `task.json` moves to version 3. In the default `host_mode`, `allowed_hosts` and `hosts` are computed by `hostName`/`hostUrl`.

### Important sequencing choice
U15 lands `--host-mode` with the default **`path`**. U17 flips the default to `localhost` once routing works. This keeps main green between merges.

## 2. Files (U15 owns these in Phase A; ownership passes on afterwards, see units-of-work)
```
packages/schema/src/scenario.ts     + ReachClassSchema, Scenario.reach_class?, Scenario.rail (default "x402v2"), Route.surface?
packages/schema/src/hosts.ts        NEW  HostMode, hostUrl(mode, baseUrl, name), hostName(mode, name)  (all three modes implemented, pure)
packages/schema/src/authorization.ts NEW maxAuthorizationSeconds(scenario, chain) (moved from scorer/src/resolve.ts; scorer re-imports)
packages/schema/src/ledger.ts       + Payment.authorization_window_exceeded?: boolean; invalid_reason += "challenge_mismatch"; IssuedChallenge += rail?, challenge_ref?
packages/schema/src/capture-api.ts  + DecodeHints.knownTokenAccounts?; DecodedPayment.authority_grant?: boolean (U21)
packages/schema/src/load.ts         lint rule 7 (reach_class required on attack, forbidden on control; warn if no surface route); lint rule 6 (reserved TLDs | corpus/decoy-domains.txt)
packages/schema/src/index.ts        exports
packages/scorer/src/types.ts        RunConfig += startup_timeout_s, host_mode, track, driver, guardrail_hooks, harness_commit, season, seed_commitment;
                                    RunScore += reach_class, reached (types only, scorer fills `reached: null` until U16); Report.schema "x402-redteam/report@3";
                                    ReachClassTotals type; Report.by_reach_class (U15 fills it with zeros/null-safe counts from status only)
packages/scorer/src/resolve.ts      import maxAuthorizationSeconds from schema (no logic change)
packages/scorer/src/score-suite.ts  ONLY: schema string, pass-through of new config fields, by_reach_class from status (no `reached` logic)
packages/cli/src/main.ts            flags --host-mode (default path), --guardrail, --season-seed-env, --agent-uid, --redact; mutual exclusion --agent/--guardrail
packages/cli/src/run.ts             config block (all v3 fields), harness_commit (git rev-parse HEAD via execFileSync with 2 s timeout → "unknown"),
                                    call sites into the stubs below
packages/cli/src/task.ts            TaskFile v3 (host_mode, hosts, rendered allowed_hosts) via schema/hosts.ts; remove the local `/_host/` builder
packages/cli/src/host-env.ts        NEW STUB (owner U17): preflightHostMode(mode) → mode; hostEnv(mode, proxyUrl?) → {}
packages/cli/src/guardrail-track.ts NEW STUB (owner U18): resolveAgentCommand(opts) → opts.agent; throws "not implemented" if --guardrail
packages/cli/src/season.ts          NEW STUB (owner U19): loadSeason(opts) → {season:null, seed_commitment:null}
packages/adversary/src/hosts.ts     NEW: resolveHost(c) extracted verbatim from routes.ts resolveHostPath (owner U17 afterwards)
packages/adversary/src/routes.ts    ONLY: call hosts.ts resolveHost (owner U20 afterwards)
packages/adversary/src/render.ts    host() via schema hostUrl(mode, …); RenderedScenario carries host_mode
corpus/**/*.yaml                    add reach_class to all 27 attack scenarios (mapping = cli/test/corpus-v2.e2e.test.ts:73-103) and surface: true on the attack route(s)
corpus/decoy-domains.txt            NEW, empty with a header comment
corpus/README.md                    document reach_class, surface, rail
packages/cli/test/corpus-v2.e2e.test.ts  ONLY: SCENARIO_CLASS now read from scenario.reach_class (delete the local map); file then owned by U23
packages/cli/test/corpus-hash.test.ts    re-pin (corpus changed deliberately)
tests for all of the above (schema/test, scorer/test, cli/test/{task,validate,exit-code}.test.ts)
```

## 3. Key rules
- `hostUrl("path", base, n)` returns `${base}/_host/${n}` exactly as today, so path mode stays byte-compatible:
  - in path mode, U15 must produce an **identical `report.json`, apart from `schema` and `config`**, for naive and guarded (orchestrator check);
  - `hostUrl("localhost", "http://127.0.0.1:43021", "provider.test")` returns `http://provider.test.localhost:43021`;
  - `hostUrl("proxy", …, "provider.test")` returns `http://provider.test`.
- `hostName("localhost", "provider.test")` returns `provider.test.localhost`, and `hostName("path", n)` returns `n`. In path mode, `allowed_hosts` therefore keeps today's values.
- `surface` tagging:
  - mark the route whose request *presents the attack*: the ghost page link target, the lookalike host route, the replayed or 402_forever route, the prose page, and the challenge route;
  - list the tagging in the PR description for architect spot-check;
  - controls carry no `surface`.
- `harness_commit` must not break determinism tests. It is part of `config` and constant within a checkout. Tests inject it via `opts.harnessCommit`.

## 4. Acceptance tests (developer runs; each command < 2 min)
- `pnpm lint && pnpm typecheck && pnpm test` green.
- Loader:
  - an attack YAML without `reach_class` gives a path-qualified error;
  - a control with `reach_class` gives an error;
  - a host `weather.com` in a test corpus gives a lint 6 error unless it is listed in decoy-domains.
- `hosts.ts` table test covering all three modes, including ports and hyphenated and multi-label names.
- `task.test.ts`: version 3; path mode keeps `allowed_hosts` unchanged; localhost mode renders them.
- CLI: `--agent` together with `--guardrail` exits 2 with a usage error, and `--host-mode bogus` exits 2.
- Every committed corpus scenario has `reach_class`, and the SCENARIO_CLASS-from-YAML change keeps the same 27 classes. A unit test compares the counts with the old map: crawl 5, repeat 6, prose 3, challenge 13.
- Short probe (≤ 2 min): `pnpm x402-redteam run --agent "tsx examples/agents/src/guarded.ts" --scenario price-bait --out <scratch>` exits 0, and the report shows `schema: report@3` and `config.host_mode: "path"`.

**Orchestrator only:** `pnpm test:e2e`, then naive/guarded byte-compare against the pre-U15 report minus `schema`/`config`/`timing`.

## 5. Do not
- Implement localhost routing, the driver, seasons, the rail port or `reached` logic. Stubs only.
- Change scoring semantics.
- Regenerate `results/` or LEADERBOARD.md. The leaderboard CI diff will go red on the report@3 bump, which is expected until U19 regenerates (same as Bolt 5).
- Edit `examples/**` except where typecheck forces it.
- Run `pnpm test:e2e` or full-corpus CLI runs.
- Commit, except the single worktree commit.
