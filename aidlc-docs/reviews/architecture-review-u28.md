# Architecture review: U28 ClawRouter adapter

Reviewer: senior-architect (independent of the design author). Scope:
`aidlc-docs/construction/U28-clawrouter-adapter/functional-design.md` revision 1. I checked it
against `CLAUDE.md`, ADR-028 and ADR-029 (`aidlc-docs/inception/adr/decisions.md:564-589`),
the U25 design, the AgentKit adapter (`examples/third-party/agentkit/`), and the harness sources
it depends on: schema v4, adversary routing and attribution, the scorer and the CLI. I also read
the private source review and the published 0.12.288 sources it cites. No ClawRouter code was
run.

Per ADR-028, this file names no ClawRouter scenario, mechanism or suspected weakness. Where a
finding depends on one, the detail is in the private notes
(`~/x402-redteam-private/bolt10/clawrouter-arch-notes.md`), cited here as "private notes, Pn".
No held-out content was read or is recorded here.

## Verdict

**Sound with required changes.** The shape is right: a scripted parent with no ClawRouter
import, a sandboxed child, the published build unmodified, header capture as the measured
result, and private scenarios on schema v4. The schema and adversary can serve a
`POST /v1/chat/completions` JSON route with a Base Sepolia challenge, a chat-completion
delivered body and a `GET /v1/models` catalog. Query strings are dropped before matching, and
no path prefix is added. But revision 1 has three defects that would produce wrong or
irreproducible numbers or weaken the real-funds guarantee, and several gaps that leave results
uninterpretable:

- **B1:** the harness attribution scores some correct repeat payments as `replay_paid`. That
  can fail controls and invalidate whole reports.
- **B2:** the payer's unawaited start-up requests race the first chat call. Payment ids in
  `report.json`, and possibly behaviour, change between runs.
- **B3:** the "never attach to a real proxy" rule rests on two options alone. Both isolation
  layers allow every loopback port.

The owner decisions (private, adapter-only, unmodified build) stand. None of them invalidates a
claim, provided M4's "unmeasured" class is added, because an unpatched build with header-only
capture gives a lower bound on signatures sent.

## Fact check of the design's claims

| Claim (design §) | Status | Evidence |
|---|---|---|
| v4 can express a `POST /v1/chat/completions` route with `content_type: application/json`, a `challenge` and a chat-completion `delivered_body` (§1) | correct | `RouteSchema` allows `method: POST`, any `content_type` and `delivered_body` (`packages/schema/src/scenario.ts:199-218`). Lookup is exact on method, host and path (`packages/adversary/src/render.ts:152-154, 331-337`). The delivered body is served with the route's `content_type` (`routes.ts:316-330`); the 402 is JSON plus the `PAYMENT-REQUIRED` header (`routes.ts:197-221`). **No corpus scenario uses POST with a challenge today** (`grep -rn "method: POST" corpus` is empty), so the smoke corpus is the first end-to-end test of that path. |
| Challenge network is Base Sepolia | correct by default | `CHAIN_DEFAULTS.evm.network = "eip155:84532"` (`packages/schema/src/chains.ts:17-21`). The payer registers `exact` on `eip155:*`, so it accepts Base Sepolia. |
| Query strings and path prefixes | handled | The adversary matches on `new URL(c.req.url).pathname` (`hosts.ts:24, 72`), so `GET /v1/models?format=json` matches a `GET /v1/models` route. ClawRouter forwards `${apiBase}${req.url}` with no normalisation, so the chat path is whatever the child sends. **But** both catalog fetches get the same body, because the route cannot discriminate by query (M5). |
| `apiBase: task.base_url` reaches the default host | correct in `localhost` and `path` modes | `task.base_url` is the harness origin (`packages/cli/src/task.ts:137`). A bare-loopback `Host` falls back to path parsing and then to `provider.test` (`hosts.ts:63-65, 23-33`). The design does not say which host modes are supported (m4). |
| The existing behaviours suffice (§1) | partly | `normal`, `402_forever`, `no_delivery` and `replay` work for POST. `redirect` is always a 302 (`routes.ts:173-176`), and a fetch client turns a 302 on a POST into a GET, so a POST route cannot be redirected with its method kept. That is a v4 limit the design should state (private notes, P4). |
| `allowExistingProxy: false` and `port: 0` prevent attaching to a real proxy (§3) | correct for the two code paths | Both the pre-listen check and the `EADDRINUSE` reuse path honour `allowExistingProxy === false` (ClawRouter `src/proxy.ts:2773-2774, 4447-4449`). With port 0, no probe is made. **But** nothing below the options enforces it (B3). |
| `HOME` set to a fresh temp dir isolates ClawRouter's files (§3) | correct | Node's `os.homedir()` reads `HOME`. The paths are computed at module load, so `HOME` must be set in the child's spawn env, as designed. The sandbox deny-list (`examples/third-party/agentkit/README.md`, sandbox section) does not include `~/.openclaw` or `~/.blockrun`, where the real CLI keeps wallet and key files (m2). |
| The update check can be answered with a local 204 (§6) | correct | The updater uses the global `fetch` and swallows every error, so a 204 with an empty body is harmless. |
| The header capture is the measured result, and the pre-sign log explains it (§5) | correct, but incomplete | See M4: the pre-sign log has to be reconciled with the header capture, or a blocked payment construction scores as a pass. |
| A missing or bad request-plan line exits 3 (§4) | correct, but under-specified | The exit-3 path is right (agent error, fails closed). The rest of the exit policy is missing (M1), and the line duplicates `task.parallel` and ignores the payer's response cache (M2). |

## Findings

| id | sev | area | evidence | consequence | required change |
|---|---|---|---|---|---|
| B1 | blocker | Scoring validity | `packages/capture/src/attribute.ts:52-91`: a payment whose terms match only an already-paid challenge gets `replay = true` and that challenge's id. `routes.ts:293-302` still delivers, since the id is in `currentChallengeIds`. `packages/scorer/src/score-run.ts:152-153` flags `replay_paid`, which counts as fully unauthorized. A payer that sends a payment before any fresh challenge, using terms from an earlier challenge on the same route, hits this on every call after the first. Whether and when the payer under test does this is in the private notes, P1. | Any control with calls ≥ 2 on one route can record `replay_paid`. That is non-exempt, so the control fails and `summary.valid` becomes false (exit 2). Attack scenarios record a misleading code and inflated `unauthorized_usd`. | Design must (a) state this attribution rule and how private scenarios are built around it (controls make one paid call per route, or use a configuration that does not pre-sign), (b) state how `replay_paid` is read in private write-ups for repeat scenarios, and (c) decide whether a generic harness change ("pre-signed against unchanged terms" kept distinct from "replayed") is raised as its own public unit. Until (c), any repeat result that rests only on `replay_paid` is not "confirmed" under ADR-028 §3. |
| B2 | blocker | Determinism | ClawRouter starts two unpaid catalog GETs to `apiBase` without awaiting them (`src/proxy.ts:2767, 4554`). Each logged request consumes a `seq` (`routes.ts:19-21`), and `payment_id = p${seq}` (`packages/adversary/src/record.ts:106`) appears in report violations. A 300 s refresh timer follows (`src/proxy.ts:4555-4558`). | Payment ids in `report.json` depend on arrival order, which breaks the CLAUDE.md byte-identity rule and ADR-028 §3 confirmation. Acceptance 4 may pass by luck. If a scenario serves a catalog, the first call's behaviour can also differ between runs (private notes, P2). | Before its first chat call, the child waits until both catalog requests have settled. The guard already wraps `fetch`, so it can observe them without patching. On timeout it records `catalog_settled: false` in provenance and exits 3. Require `--timeout` ≤ 240 s, so the refresh timer never fires inside a run. Acceptance 4 runs the smoke corpus 5 times, not 2, and also asserts the request order in `runs/*.json`. |
| B3 | blocker | Safety (real funds) | Both layers allow every loopback port: the sandbox profile allows `(remote ip "localhost:*")` (`examples/third-party/agentkit/src/sandbox.ts:61`), and the guard passes 127.0.0.1, ::1 and `*.localhost` on any port (AgentKit README, guard section). ClawRouter's default port is 8402, and its default behaviour is to reuse a compatible proxy found there. A real one would sign with the owner's real wallet on Base mainnet. Today only two options stand between the child and that. The design's canary ("a decoy on 8402 gets no connection") passes trivially with `port: 0`, so it proves nothing. | One option change, one upstream default change, or a seller-chosen redirect to `127.0.0.1:<port>` reaches whatever local payer or service the owner has running. This is the only path in the design where real funds could move. | (1) The parent picks the child's proxy port P (not 8402) and passes `port: P` with `allowExistingProxy: false`. (2) The sandbox profile allows only `localhost:<harness port>` and `localhost:P`, and the guard enforces the same port allowlist on 127.0.0.1, ::1 and `*.localhost`. (3) The parent refuses to start if anything listens on 8402. (4) The child checks that `handle.port === P` and `handle.walletAddress` equals the task wallet before sending any request, and exits 3 otherwise. (5) The canary checks that a decoy on 8402 **and** a decoy on a random other loopback port are both refused at each layer on its own. Propose the ADR-029 amendment below. |
| M1 | major | Integration contract | Design §4 and §7.3 define only "clean run exits 0" and "bad plan line exits 3". ClawRouter wraps upstream failures in HTTP error responses to its client. A guard refusal of a task host, or an adversary 400, therefore reaches the child as a 4xx or 5xx body, not as a transport error. | An isolation failure looks like measured behaviour (exit 0), so an attack is scored `pass`. In the other direction, ClawRouter's own refusals, if treated as errors, score attacks `error` instead of `pass`. | Add a `classify.ts` table, as AgentKit has (U25 §3.3a). Exit 0 for any HTTP response from the child's proxy whose cause is a known payer outcome: success, a 402 passed through, a spend-policy or cost-cap error type, a payment parse failure. Exit 3 for a transport error to the child's own proxy, a child crash, any `EGRESS_BLOCKED` naming a task host, `catalog_settled: false`, or an unrecognised error body. When in doubt, unmeasured. Exit-code tests cover each row. |
| M2 | major | Request plan | (a) `[parallel]` duplicates `task.parallel` and `TaskFile.parallel` (`scenario.ts:233`, `task.ts:54`). (b) Every call sends the same prompt text. The payer's response cache (on by default) and its 30 s body-hash dedup then serve calls 2..n without reaching the seller (private notes, P7). (c) The parse rules are not specified. | Two sources of truth for parallelism. `calls=n` silently measures caching, not payment logic, in exactly the categories (repeat, budget, concurrency) that need n upstream requests. | Grammar: the last line exactly matches `^clawrouter: model=(\S+) calls=([1-9][0-9]?) body=(same\|distinct)$`; any other line starting `clawrouter:` exits 3. Parallelism comes from `task.parallel` only. `distinct` appends a deterministic suffix per call (`(call k of n)`). Record `body` and the cache setting in provenance. State in the design that under `defaults` the cache is part of what is measured. |
| M3 | major | Profiles | The `budget` profile sets `maxCostPerRunUsd` but not its mode. The default `graceful` mode does not check quoted amounts before signing (private notes, P6). `budget_usd` unset becomes 0 (`task.ts:140`). | The `budget` profile may not control spend on quoted amounts at all. Scenarios without a budget pass trivially under `budget`. | Set `maxCostPerRunMode: "strict"` and record it. Under `budget`, exit 3 if `budget_usd` is 0 and the scenario has a paid route. Write the exact mapping (session = `budget_usd`, perRequest = `budget_usd`, no payee, network or asset policy) into the design and provenance. |
| M4 | major | Measurement validity (capture) | §5 records the "known gap" but does not use the pre-sign log to detect it. A payment that clears the pre-sign hook and then fails to build (a blocked RPC read, for example) produces no header and scores `pass` (private notes, P5). A payment sent to a non-task host is blocked by the guard and also scores as no payment. | Isolation artefacts are counted as safe behaviour. A reviewer would rightly dismiss those passes. | The parent reconciles the pre-sign intents with the header-captured payments for each run, and writes `intents`, `captured` and `unmatched` to the private run notes. A run with an unmatched intent, or with an `EGRESS_BLOCKED` that follows an intent, is reported as **unmeasured** and left out of pass totals. Never use the pre-sign log's amount as the signed amount (P6). |
| M5 | major | Schema reach (catalog) | The adversary cannot serve different bodies for `/v1/models` and `/v1/models?format=json` (`hosts.ts:24, 72`). The two ClawRouter fetches parse with different code (private notes, P3). | A catalog scenario may satisfy only one parser, which makes the measured behaviour an artefact of the harness. | Before any catalog scenario is written, check from source that one body satisfies both parsers. If it does not, stop and report as §1 requires (needs query matching in v4). Controls and the smoke corpus serve no catalog route; a 404 leaves ClawRouter on its bundled catalog, which is deterministic for a pinned version. |
| m1 | minor | ADR-028 hygiene | Design §1 ("it pays whatever its upstream API asks for") and §5 ("an on-chain approve, for example") characterise behaviour in a public file. | This edges towards publishing a hypothesis before disclosure. | Use neutral wording: "the unit under test is ClawRouter's payment logic under two configurations", and "signatures that never reach the seller are not captured". |
| m2 | minor | Safety (files) | The sandbox read-deny list lacks `~/.openclaw` and `~/.blockrun`. Neither exists on the owner's machine today. | Defence in depth if `HOME` handling ever regresses. | Add both to the deny-list, and add a canary read probe. |
| m3 | minor | Determinism (balance) | The balance-monitor stub's value is not specified. | Values that differ from the harness's exposure model could steer the payer down another path (private notes, P8). | The stub reports `task.wallet_balance_usd` as USDC. Record it in provenance. |
| m4 | minor | Host modes | Host-mode support is not stated. In `proxy` mode the harness sets `HTTP_PROXY`, which the child drops. The plan line cannot put the chat route on a non-default host. | Silent misrouting in proxy mode; unclear scope. | Support `localhost` and `path` only, as AgentKit does. Exit 1 in `proxy` mode. The chat route always lives on the default host. |
| m5 | minor | Determinism (parallel) | Parallel calls, plus the payer's own concurrency, make arrival order (and so `seq`) vary. | Byte-identity can fail for parallel scenarios even when behaviour is the same. | Every parallel scenario needs its own 2-run byte-identity check before any result is confirmed. A mismatch is recorded in the private notes, not tuned away. |
| m6 | minor | Provenance | `X402_CLAWROUTER_PROFILE` has no stated behaviour when missing. | A run can silently fall back to a default profile. | Missing or unknown profile → exit 1. Each profile writes to its own `--out` dir and `--guardrail-id`. |

## Answers to the specific questions

- **Can schema v4 and the adversary serve what ClawRouter needs?** Yes for the chat route,
  the 402, the delivered JSON, the catalog GET, and query strings. ClawRouter adds no path
  prefix of its own. The limits are a query-blind catalog route (M5) and 302-only redirects
  (fact check).
- **Does the scorer produce meaningful results?** For one paid call per route, yes.
  `require_delivered` is a single per-run flag (`routes.ts:317-318`), so with calls > 1 it
  proves only one delivery; use `min_payments` for the count. Repeat payments need B1
  resolved, and blocked constructions need M4.
- **Is the `task.prompt` request-plan line sound?** It is acceptable as an adapter-only
  convention, because the scenarios are private, but it needs M2.
- **Safety.** The 8402 attach risk needs B3. `HOME` writes are handled, with m2 added. The
  update check is handled. Base mainnet RPC is blocked, and that blocking is a measurement
  problem (M4), not a safety one. The only key the child holds is the seed-derived test key,
  and signatures reach only the adversary. Outside a local payer on loopback (B3), I found no
  path to a real key or real funds.
- **Determinism.** Needs B2, M2, m3 and m5. The payer's in-process caches are fresh for each
  run, because the harness starts a new child for every run.
- **Does header capture miss anything that matters?** Yes: payments whose construction
  fails after the policy check, and payments sent to non-task hosts. M4 makes both visible as
  "unmeasured" instead of "pass". The payload extension the payer adds after signing is
  ignored by the binding check (`packages/adversary/src/rails/x402v2.ts:148-157`), so it does
  not break delivery.

## Proposed ADRs

- **ADR-029 amendment (3a):** "Loopback is not a trust boundary for a third-party local
  payer. The child may reach only the harness's own port and ports the parent assigned to the
  child. Both isolation layers enforce this. The parent refuses to start if a known default
  payer port is in use." This applies to every future adapter, not only ClawRouter.
- **ADR-028 addition (6):** "A third-party result that depends on a harness scoring rule
  the third party could reasonably dispute (for example, attribution of a pre-signed
  payment) is not confirmed until the rule is stated in the private write-up and checked
  against the source."
- No change to the public schema in this unit. If M5 or B1(c) turns out to need one, it is a
  separate public unit, described generically.

## Prioritised next bolt (this unit, revision 2)

1. **U28 r2 design:** fold in B1-B3, M1-M5 and the minors. Acceptance: the architect signs off.
2. **U28 build:**
   - The canary includes the port allowlist (B3) and the deny-list (m2).
   - The exit-code tests cover the M1 table and the M2 grammar.
   - The smoke corpus is one paid control and one unpaid control, each with exactly one paid
     call per route, and no catalog route.
   - Acceptance: both controls pass under both profiles; 5 runs are byte-identical minus
     `timing`; `catalog_settled: true` in every run; zero non-update-check egress; the
     reconciliation reports 0 unmatched intents.
3. **Private scenario authoring (owner):** each scenario is tagged measurable or
   stop-and-report against M5, P3 and P4 before it is run. Every repeat or parallel scenario
   gets its own 2-run identity check.

## Things done well, to keep

- The parent and child split, with no third-party import in the parent and protocol on fd 3,
  reused from U25.
- Testing the unmodified published build, with its bundle hash in provenance: the result is
  about what users actually run.
- Header capture as the scored layer, with the policy hook used only to explain results.
- `port: 0`/`allowExistingProxy: false`, `HOME` redirection and env stripping, all in the
  design from the start.
- The rule to stop and report instead of changing the schema, and keeping scenarios and
  results out of the repo.
- A scripted, LLM-free driver: free and deterministic, which suits a non-reasoning payer.

## Delta check (revision 2)

Scope: `functional-design.md` revision 2 (same worktree, uncommitted), checked against the
findings above, the harness sources, and the pinned 0.12.288 sources. Nothing was run.

### Status of each finding

| id | status | where | note |
|---|---|---|---|
| B1 | resolved | §1 "Repeat payments", §9, §10 | Controls make one paid call per route. A repeat result that rests only on `replay_paid` is not confirmed. The generic harness change is a separate public unit. |
| B2 | resolved, with build condition C1 | §3 (child step 2, timeout), §7.4 | A 10 s wait is workable. ClawRouter's own timeouts on the two catalog fetches are 5 s and 4 s (ClawRouter `src/proxy.ts:372`, `src/model-catalog.ts:136`), and both fetches start before `startProxy` returns. Both go through the global `fetch` that the guard wraps. Five runs plus a check on request order is a sound gate. |
| B3 | resolved, with build condition C2 | §3 (parent checks, port P, loopback allowlist), §6, §7.2, §10 | The handle exposes `port: number` and `walletAddress: string` ("" in API-key mode), plus `authMode` (ClawRouter `src/proxy.ts:1632-1646`), so the §3 check works as written. `allowExistingProxy: false` also makes an `EADDRINUSE` on P fail instead of reusing (`src/proxy.ts:4447-4449`), so the free-port race fails closed. |
| M1 | partly resolved; build condition C3 | §5 "Exit classes" | The ClawRouter-local refusals named in the table exist as client error types for the pinned version: `spend_policy_denied` (403), `cost_cap_exceeded` (429), and also `payment_in_doubt` (502) (`src/proxy.ts:4834-4866`). But an upstream error is returned to the client as the upstream's own body and status, not as a ClawRouter type. "Keyed on ClawRouter's error types" therefore cannot classify the adversary's responses. Without C3, every `402_forever` or invalid-payment outcome falls into "not in the table" and exits 3, which leaves those scenarios unmeasurable. |
| M2 | resolved | §4 | Grammar, `body=same/distinct`, parallelism from `task.parallel` only, and provenance are all as recommended. |
| M3 | resolved | §4 table and the line after it | `maxCostPerRunMode: "strict"` exists under that name (`src/proxy.ts:1583`; checked at `6349`). See N2 on the budget-0 rule. |
| M4 | partly resolved; build condition C4 | §5 "Reconciliation" | Unmatched intents and post-intent egress blocks make a run unmeasured, as required. The matching key and the reverse direction are not specified. |
| M5 | resolved | §1 "Catalog", §7.4 | |
| m1 | resolved | §1, §5 | The wording is neutral. §10's "pre-signed payment" example is generic. |
| m2 | resolved | §6, §7.2 | |
| m3 | resolved | §3 | |
| m4 | resolved | §1, §3 | |
| m5 | resolved | §8.3 | |
| m6 | resolved | §3, §4 | |

### New problems introduced by the rewrite

- **N1 (minor, consistency).** §3 lists the child environment as `PATH`, `HOME` and
  `X402_REDTEAM_TASK`. The guard and the child, however, need P and the harness port to
  enforce the loopback allowlist and to call `startProxy`. State how they are passed (an
  extra `X402_CLAWROUTER_PORT` variable, or argv), and make the canary check that the
  allowlist is built from them and nothing else.
- **N2 (minor, judgement).** §4 exits 3 under `budget` when `budget_usd` is 0 and the scenario
  has a paid route. In the harness, a budget of 0 means "never pay" (`packages/cli/src/task.ts:105-111`),
  so a limit of 0 is a faithful mapping, not a broken run. Both choices are defensible. The
  exit-3 rule only removes such scenarios from the `budget` profile. Keep it, but every
  private scenario must then set `budget_usd` explicitly, so that nothing drops out
  silently. Add that to §8.1.
- **N3 (minor).** The §3 wallet check should compare addresses case-insensitively and also
  require `handle.authMode === "wallet"`.

### Build conditions

- **C1 (B2).** "Settled" means the response body has been fully read, or the fetch has
  rejected, followed by one macrotask turn before the first chat call. A response arriving is
  not enough, because ClawRouter applies a catalog after parsing its body. The adversary log
  in each smoke run shows exactly the expected catalog requests, all before the first chat
  request.
- **C2 (B3).** The sandbox profile and the guard allowlist are both generated from the
  harness port (taken from `task.base_url`) and P. The canary decoys also cover `::1` and a
  `*.localhost` name on a disallowed port.
- **C3 (M1).** `classify.ts` keys on the HTTP status and on the error's origin. ClawRouter-local
  errors are classified by `error.type`. Upstream pass-through errors are classified by
  matching the adversary's own response bodies:
  - 402 with an x402 challenge: measured.
  - 402 or 400 `invalid_payment`: measured. The scorer already handles invalid signatures.
  - 404 `not found` or 409 `no_run_loaded`: exit 3, because they mean a scenario or harness
    fault.
  - Anything else: exit 3.

  `payment_in_doubt` is measured. One exit-code test covers each row.
- **C4 (M4).** Match intents to captured payments in order on (route, payTo, network), and
  never on amount. The pre-sign amount is not reliable (private notes, P6). Record mismatches in
  both directions in the private run notes: intents with no capture, and payments
  captured with no intent. A
  captured-without-intent payment is reviewed by hand, but it does not make the run
  unmeasured.

**Signed off for build**, subject to C1–C4 and N1–N3 being folded in by the lead developer
and checked by the code reviewer. No further design revision is needed. The two ADR changes
in §10 still need owner approval before the build merges.
