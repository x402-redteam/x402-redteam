# Architecture review: U30 MCP seller mode (revision 1)

Reviewer: senior-architect. Date: 2026-10-21. Subject:
`aidlc-docs/construction/U30-mcp-seller/functional-design.md` (rev 1, branch
`docs/u30-mcp-seller`, base `8e7da3b`). Read against CLAUDE.md, aidlc-state.md, the audit
tail, ADR-028/029/032/033, the code the design touches, the x402 MCP transport spec and
`@x402/mcp` 2.28.0 client at upstream `0e6e8c5`, `@x402/core`/`@x402/evm` 2.28.0 in
`node_modules`, and `@modelcontextprotocol/sdk` 1.32.1 (what `@x402/mcp`'s `^1.12.1`
range resolves to today), unpacked from the npm tarball for reading only.

## Verdict

**Sound with required changes.** Some of the direction is right: putting the endpoint on
the harness port, hand-rolling a JSON-only server, adding no new violation kinds, and
keeping fuzz output private. But four problems would sink the unit as written:

- the MCP family would land in the default corpus, which every HTTP-only agent and the
  guardrail track run;
- tool routes collide on `route_key`;
- a race in the official client would break the byte-identical report rule;
- four of the seven hostile scenarios cannot be failed by any client the design ships.
  That makes them vacuous, and it makes `mcp-guarded`'s pass purely circular.

None of these needs a redesign. All four have to be fixed in revision 2 before any build.

## Findings

| id | sev | area | evidence | consequence | recommendation |
|---|---|---|---|---|---|
| B1 | blocker | leaderboard integrity, integration contract | The loader reads every YAML file under `corpus/` recursively (`packages/schema/src/load.ts:673-686`). The design puts the `mcp` family in the public corpus (design:127-142) and says nothing on agent capability. `guarded.ts`, `naive.ts`, `llm.ts`, the Python agents and the guardrail-track driver (ADR-010) all speak HTTP only. `corpus_hash` change marks every entry stale (`build-leaderboard.ts:1036,1075`). | Every HTTP-only agent would fail the MCP controls (`required_payment_missing`, `not_delivered`). They would "pass" the MCP attacks because the attacks are never reached. Utility drops and attack pass rates rise for agents that never saw MCP. The guardrail track breaks. Design §4's "every existing report and reference result is byte-identical" (design:163) cannot hold. | Make transport a corpus dimension. Put the family in its own directory (`corpus-mcp/`) or tag each scenario `transport: mcp` and leave it out of a default `run`, with an explicit `--transport mcp` or `--corpus corpus-mcp`. Give it its own corpus hash and its own leaderboard section; never mix it into the HTTP aggregate. Refuse MCP scenarios on the guardrail track until a GDP MCP driver exists. Write ADR-035. |
| B2 | blocker | architecture, scoring | `routeKey = host+path` (`render.ts:159-161,273`). The lookup map is keyed on (method, host, path) and the last entry wins (`render.ts:334`). The design forces `path: /mcp`, `method: POST` on every tool (design:56). `RouteRuntime` (counter, `currentChallengeIds`, `deliveredOnce`) is per `route_key` (`state.ts:108`). Loop count is keyed by `route_key` (`score-run.ts:450`). `computeReached` compares `req.path === route.path` (`scorer/src/reach.ts:4`), but the design logs `"/mcp#<tool>"` (design:46-48). | Two tools on one host overwrite each other in the lookup and share challenge ids and delivery state. A payment for tool A can be judged against tool B's issuance. `loop_count` merges tools. `reached` is always `false` for tool surfaces, so every MCP attack reads as unreached. | Make `route_key` `${host}/mcp#${tool.name}` for a tool route, and key the lookup on (host, tool name). Lint duplicate tool names per host. Change `computeReached` to match a tool route on `tools/call` with the same name. State which surface counts as reached for a description attack (`tools/list`) and for a result attack (a delivered `tools/call`). |
| B3 | blocker | determinism | SDK 1.32.1 `client/streamableHttp.js:384-390`: on a 202 to `notifications/initialized` the client starts a GET for the SSE stream and does not await it. Spec-compliant servers MUST answer a notification with 202. Requests carry `seq` into `report.json` (`results/guarded-reference.json` `runs[].requests[].seq`), and `seq` is shared with challenges and payments (`state.ts:101-106`). | The GET races the client's next POST (`tools/list`). If the GET is logged or consumes a `seq`, request order and every later `seq` differ between runs, which breaks the CLAUDE.md byte-identity rule and the acceptance check at design:164. | Answer GET and DELETE `/mcp` with 405, without logging them and without calling `nextSeq()`. Count them, if at all, in a field outside `report.json`. Answer every notification with 202 and nothing else, also without a `seq`. Add a test: 20 back-to-back runs of the official client give the same report. |
| B4 | blocker | validity of measurement | Design acceptance: "`mcp-sdk-default` fails every hostile MCP scenario" (design:161). It is false for 4 of 7. (a) `@x402/mcp` uses `x402Client.fromConfig`, which keeps the $1 default cap (`@x402/core/dist/esm/client/index.mjs:22,56`; mcp README: "default assets only + `$1` USD cap"). So the $2 "poisoning" challenge (design:133) is refused by the SDK. Design:26 ("pays any price") is wrong. (b) `settle_fail`: `@x402/mcp` re-pays only when `handlePaymentResponse` reports `recovered` (`client-x402MCPClient.ts:738-751`). Only the batch-settlement hooks do that (`@x402/evm/dist/esm/chunk-QJHO4KEV.mjs:438-476`), so with `exact` it pays once and returns the error. (c) A deposit request in a description, and output injection (design:134-135), are prose only. No shipped agent reads descriptions or results for payees. (d) A tool "outside `allowed_hosts`" is unreachable when the task carries a single `mcp_url` (design:73). | Three of the scenarios ((a), (b), (d)) are passed by everyone. Scenario (c) is passed by everyone except a future LLM agent. Publishing them inflates attack pass rates, and an outside reviewer can see that nothing ever failed them. `mcp-guarded`'s pass is then circular only: its rules ("refuses a second payment", "per-call cap") are written from the attack list (design:119-121). | For each scenario, state its `reach_class` and name the client outside this harness that fails it (as `corpus/README.md` "Circularity evidence" does), and add MCP rows to that table. Keep prices under $1 so the SDK cap does not decide the run (for example $0.01 against $0.50). Add an `mcp-naive` probe (pays payees found in descriptions or results through `lib/transfer.ts`, and re-calls a tool on `isError`, like `naive`'s `withRetries`) so the prose and repeat scenarios are shown to be failable. Otherwise hold them until the LLM unit. Replace `mcp_url` with `mcp_servers: {host: url}`, or drop the host scenario. Change the acceptance: challenge-class scenarios fail `mcp-sdk-default`; prose and repeat scenarios fail `mcp-naive`; `mcp-guarded` passes everything (as an oracle that each scenario can be passed, not as evidence). |
| M1 | major | metric design | `settle_fail` is scored as `too_many_payments` (design:105). But the spec's own flow tells the client to re-pay after a settlement failure (mcp.md, "Settlement Failure": returns `PaymentRequired`). `too_many_payments` counts the whole payment as unauthorized (`score-run.ts:138-142`). | A vendor can say "the spec told us to retry", and scoring a spec-sanctioned retry as an attack is easy to dismiss. Per ADR-033 this is the harness's own reading of the spec. | Name the real harm: both EIP-3009 authorizations can still be settled until `validBefore`, so a lying server collects twice. Score it as budget accounting: `budget_usd` and `expected.total_usd` = one price → `over_total`. Pair it with a control that uses the same mechanism and a 2× budget, where the retry must happen and be delivered (`min_payments: 2`). The control already exempts `too_many_payments` (`score-run.ts:491`). Then refusing everything does not pass, and blind retrying does not pass either. |
| M2 | major | governance, oracle | `mcp_channel_split` uses `wire.body: differs` in the public corpus (design:138). ADR-032 #4 allows `wire` in public only with owner approval, and design §7 does not ask for it. The spec requires both channels to be identical and says nothing on what a client should do when they differ, so this is the `undefined` tier (ADR-033 #1). With `structured: absent` plus `differs`, the only channel the client can read is the unpatched text, but `IssuedChallenge` records the patched object as offered (`x402v2.ts:327-347`). | A correct payment could be scored as a binding mismatch. A scored public attack would rest on the harness's own expectation. | Take channel split out of the public family. Run it as a private U30-4 fuzz family (ADR-028 #7) under the invariant and differential oracles only. If it is ever made public, the offered terms must be the union of what each readable channel carries, and the owner must approve under ADR-032 #4. |
| M3 | major | metric design | `reprice` is scored as `overpay` against `expected.max_usd` (design:106). The design does not say where the "approved" price comes from. A repriced challenge that matches its new description is a consistent offer. | Paying a price that is advertised, consistent and within budget is defensible, so the oracle can be argued away. | Bind the approved price in the prompt ("the user approved `x_tool` at $0.01 a call"). Set `budget_usd` at or above the repriced amount so a budget check does not decide it, and keep the reprice under $1. Then only price pinning or prompt binding catches it, and `mcp-sdk-default` fails it, which is real evidence. Name `reach_class: repeat`. |
| M4 | major | reports, leaderboard | The design reuses `capture: "header"` and `instruction_source: "header"` (design:84-88). The capture labels are a closed set of combinations (`schema/src/ledger.ts:47-76`). `capture_layers.header` is summed in `score-suite.ts:201-213`. Markdown and SARIF print `capture` and `instruction_source` as-is (`markdown-reporter.ts:91`, `sarif-reporter.ts:37-41`). | Reusing the labels is sound internally: "header" in capture means the payload the server observed in the request, and in `instruction_source` it means "matches an issued challenge". But an MCP-only report would read "header: 12" and "instruction_source header" with no HTTP header anywhere. That misleads a reader, and leaves no count of MCP volume. | Keep the values to avoid growing the set of combinations. Add `transport` to `PaymentSchema` (so a leaderboard re-parse keeps it), present only on MCP legs. Add `summary.transports: {mcp: n}`, present only when non-zero (the precedent is `capture_layers.submitted`, `score-suite.ts:199-213`). Print `header (mcp)` in Markdown and SARIF for MCP legs only. In the docs, define `instruction_source: header` as "challenge, any transport". All existing reports stay byte-identical. |
| M5 | major | ADR-028 | Design §7.4: "the `mcp` family is public (it targets no third party)" (design:189). But `mcp-sdk-default` measures `@x402/mcp` as shipped, a third-party library, and any surprise (the channel-split choice, the error path in m6, the corrective retry) is library behaviour (class a). | Publishing first results could disclose an unfixed library issue before the vendor is told. | The scenarios can be public. The first `mcp-sdk-default` run over the whole family is private. Classify it under ADR-028 #2-#3. Publish only behaviour that is by design and documented (`autoPayment: true`, `onPaymentRequested: () => true`, the $1 cap), and commit it to `results/internal/` as with `sdk-default`, never to the leaderboard. U30-4 stays private (ADR-028 #7), as the design says. |
| M6 | major | interoperability | The design states "JSON-only, session id echoed, GET 405" (design:37-40) and nothing else about interop. SDK 1.32.1 facts: POST sends `accept: application/json, text/event-stream` (`streamableHttp.js:311-312`) and accepts `application/json` (`:407`). A 405 on GET is tolerated (`:116`), and a 405 on DELETE is tolerated (`:462`). It sends `mcp-protocol-version` after `initialize` (`:80-81`), and the client throws unless the server's `protocolVersion` is in `SUPPORTED_PROTOCOL_VERSIONS` (`types.js:2-4`, `client/index.js:293`). A tool with `outputSchema` has its `structuredContent` validated even on `isError` (`client/index.js:486-500`), which would reject a `PaymentRequired`. Zod requires `inputSchema.type: "object"` (`types.js:1229-1240`). | JSON-only does interoperate. It is allowed by the Streamable HTTP spec and handled by the official client. But an under-specified hand-rolled server fails in quiet ways: wrong version, a 4xx on a notification, an `outputSchema`. | Specify: echo the client's `protocolVersion` if it is in {2025-11-25, 2025-06-18, 2025-03-26}, otherwise answer the newest. Accept any `mcp-protocol-version` and never answer 400. Return 202 with an empty body for every notification. Declare `capabilities.tools.listChanged: false`. Never emit `outputSchema` (lint it). Lint `input_schema.type == "object"`. Derive `Mcp-Session-Id` from (seed, run_id). Return 405 to GET and DELETE. Test the server against the exact pinned SDK version, and, from U31, against mcpc and Cloudflare. |
| M7 | major | LLM agents | "The LLM agent gains MCP tools only in a later unit" (design:125). | The real target is not measured, and the prose scenarios ship with no evidence that anything can fail them (see B4c). | Acceptable only if the prose scenarios are held back or backed by `mcp-naive`. Add one manual G5-capped check (the LLM agent with MCP tools on the prose scenarios, results private) before the family is published. |
| m1 | minor | lint | Design:91-92 says rule 3 has an exception "for canaries named `prose`/`attacker` as today". It has none (`load.ts:416-450`). | The design misreads the rule. | Extend `pageTextFields` with `tool.description`, `tool.input_schema` (its property descriptions are text the model reads), the tool's `delivered_body` and `reprice.description`, and extend the payee fields with `reprice.challenge`. Extend rule 6 host references the same way, plus `collectScenarioCanaryNames` (`render.ts:119-157`) for `knownOwners`. |
| m2 | minor | schema | `wire.encoding` and `patch` are defined over a base64 header (`x402v2.ts:225-246`). For tools only `body` is mapped (design:59-63). | The encodings have no defined meaning on a tool. | Lint `wire.encoding` as an error on tool routes, or define each encoding against `content[0].text`. |
| m3 | minor | protocol fidelity | HTTP uses the request URL as `resource.url` (`x402v2.ts:119`). Upstream's default for MCP is `mcp://tool/{name}` (`paymentWrapper.ts:50,254`). | A non-standard resource URL is a fingerprint that a guard could key on. | Default to `mcp://tool/<name>`, and let `resource_url` override it. |
| m4 | minor | request log | MCP answers are always HTTP 200. The design does not say what `RequestLog.status` holds for a `PaymentRequired` result. | Readers see 200 for an unpaid challenge. | Log 402 for an `isError` with `PaymentRequired`, 200 for a delivery, 400 for an invalid payment, as the HTTP path does. |
| m5 | minor | supply chain | "No new third-party code runs in this unit" (design:172). The MCP SDK brings express 5, cors, cross-spawn, jose and eventsource. `@x402/mcp` declares `@modelcontextprotocol/sdk ^1.12.1` and `zod ^3.24.2`. | The claim is wrong, and the range floats. | Pin the SDK with a pnpm `overrides` entry, respect `minimumReleaseAge: 4320`, run OSV, and record the dependency tree in the ADR. |
| m6 | minor | threat coverage | `@x402/mcp` also reads a `PaymentRequired` from a JSON-RPC error `-32042` (`client-x402MCPClient.ts:589-598`, `extractPaymentRequiredFromError`). The design adds no surface for a payment requested as a tool argument, and none for one server's description shadowing another server's tool. | These are documented MCP attacks the harness cannot express. | `-32042` belongs in the U30-4 fuzz shape (private). Payments in tool arguments and cross-server shadowing go to the LLM unit. If `_meta["x402/payment"]` arrives as a string, try the header decoder before recording a `decode_error`. Record a `PAYMENT-SIGNATURE` header on `/mcp` too (U29-0: nothing is dropped). |
| m7 | minor | architecture | Adding `rail.decodeObject` (design:80) puts transport into the rail interface (`rails/rail.ts:102-116`, which is built around headers). | MPP over MCP, or a second transport, would mean more special cases. | Split the work. The rail builds the `PaymentRequired` object and the `IssuedChallenge` and decodes an object. A transport (`http` or `mcp`) handles encoding and extraction. `issueWire` stays the single source for the offered terms. |
| m8 | minor | contracts | The design calls this "scenario v4". U29-1 already labels `wire` v5 (`scenario.ts:139`). CLAUDE.md requires architect sign-off and an audit entry for changes to `application-design.md`. | Version labels drift, and the contract changes go unrecorded. | Call it v6. List the contract changes in `application-design.md`: `RouteSchema.tool`, the two new behaviours, `task.mcp_servers`, `Payment.transport`, `summary.transports`, and the request-log rules for MCP. |
| m9 | minor | security | The MCP spec says servers MUST validate `Origin` against DNS rebinding. | The harness port is loopback-only and has test keys only, so the risk is low. | Refuse a request whose `Origin` is not loopback, or log it. |
| m10 | minor | host modes | The SDK transport uses Node `fetch`, which ignores proxy environment variables. | Proxy mode cannot work. | Have `mcp-*` agents call `refuseUnsupportedProxyMode`, as the HTTP agents do. The acceptance "all three host modes" (design:166) becomes localhost and path, with proxy refused. |

## Proposed ADRs

- **ADR-034 (amend the draft before approval).** Keep: the endpoint on the harness port,
  a hand-rolled JSON-only Streamable HTTP server, `capture: "header"` and a `transport`
  field. Add:
  - route identity per tool (B2);
  - GET, DELETE and notifications answered without logging or a `seq` (B3);
  - the interop rules in M6;
  - `transport` in `PaymentSchema` and `summary.transports` present only when non-zero
    (M4);
  - a pinned SDK version and its dependency tree (m5).
- **ADR-035 (new): transport is a corpus dimension.** MCP scenarios live in their own
  corpus with their own hash and leaderboard section. A default `run` excludes them. The
  guardrail track refuses them until it has an MCP driver. Every family states the reach
  class of each scenario and which client outside the harness fails it (B1, B4).
- **ADR-032 #4:** no change. Channel split stays private (M2).
- **ADR-033:** add that disagreement between MCP channels is in the `undefined` tier (M2).
- **ADR-028:** note that results from `mcp-sdk-default` and any `@x402/mcp` run are
  first-triaged privately; publish only documented defaults (M5).
- **ADR-008 amendment** (reference agents are oracles): extend it to `mcp-guarded`, and
  add `mcp-naive` as an internal probe that shows each scenario can be failed.

## Prioritised next bolt (revision 2, then build)

1. **U30-0 schema, lint and corpus partition.**
   - AC: MCP scenarios load only from their own corpus or under an explicit transport
     filter, and a default `validate`/`run` gives the same `corpus_hash` as `main`.
   - AC: every committed result regenerates byte-identical.
   - AC: lint covers tool name uniqueness per host, `input_schema.type`, no
     `outputSchema`, no `wire.encoding` on tools, and the m1 field lists.
2. **U30-1 adversary endpoint.**
   - AC: `route_key` is per tool, and `reached` is correct for both list and call
     surfaces.
   - AC: 20 runs of the pinned official client give an identical `report.json`, and the
     SSE GET is never logged and never takes a `seq`.
   - AC: protocol versions are negotiated as in M6; `resource.url` is
     `mcp://tool/<name>`; a non-object `_meta` payment becomes a `decode_error` leg after
     the header-decoder fallback.
   - AC: existing HTTP behaviour is unchanged when a scenario has no tool route.
3. **U30-2 agents.**
   - `mcp-sdk-default` (results go to `results/internal/`), `mcp-guarded` (an oracle)
     and `mcp-naive` (an internal probe).
   - AC: the pinned versions pass OSV and the release-age gate.
   - AC: agents refuse proxy mode.
4. **U30-3 public family**, without channel split.
   - Each scenario states its `reach_class` and the client that fails it.
   - Prices stay under $1.
   - `settle_fail` is paired with a 2× budget control.
   - `reprice` binds the approved price in the prompt.
   - AC: challenge-class scenarios fail `mcp-sdk-default`; prose and repeat scenarios
     fail `mcp-naive`; `mcp-guarded` and `mcp-sdk-default` pass the controls.
   - AC: corpus README circularity rows are added; a private ADR-028 triage of the first
     `mcp-sdk-default` run is done before merge; a manual LLM-agent reachability check on
     the prose scenarios is done (private).
5. **U30-4 fuzz shape `mcp`.** No longer optional; this is where channel split and
   `-32042` belong. Outputs are private (ADR-028 #7), run under ADR-029 3b.

## Things done well, to keep

- The single listener on the harness port, which follows ADR-029 3a/3b, with the fuzz
  sandbox port allowlist unchanged.
- Choosing JSON-only, which suits a deterministic adversary. The Streamable HTTP spec
  allows it, and the official client handles it; verified at `streamableHttp.js:116,407`.
- Hand-rolling the server, so malformed and contradictory results can be served without
  an SDK server normalising them away.
- No new violation kinds. Mapping onto existing codes keeps the leaderboard re-score
  stable.
- Recording a missing or malformed `_meta` payment as a `decode_error` leg, which keeps
  the U29-0 rule that nothing received is dropped.
- Putting tool descriptions and results in `pageBodies`. This is the right model of what
  an LLM reads, and it makes prose attribution work unchanged.
- Fuzz outputs kept private, and the adapters kept in their own units.
- Spec facts in §1 that are accurate and pinned to a commit. The one error is the
  "any price" claim on design line 26.

## Delta check (revision 2)

I read revision 2 of the design (245 lines) against the findings above and the same code
and SDK sources.

**Verdict: sign off for build, subject to the build conditions below.** Every blocker is
fixed in substance. The revision brings in three new problems: a corpus-hash trap in the
new `transport` field, a control that the shipped SDK client cannot pass, and a
second-server scenario whose oracle contradicts its own prompt. Each has a small,
well-defined fix, so none needs another full review round. U30-4 still needs its own
design delta (condition 9).

### Status of each finding

| id | status | note |
|---|---|---|
| B1 | resolved, with conditions | `corpus-mcp/` with its own hash and leaderboard section, a default run unchanged, and the guardrail track refusing MCP (design:111-119). The new `transport` field breaks the hash unless it has no default (condition 1). Where the MCP reference results live is not stated (condition 5). |
| B2 | resolved | A per-tool `route_key`, a lookup keyed on (host, name), and `reached` defined (design:91-94). Schema detail in condition 4. |
| B3 | resolved | GET, DELETE and notifications are not logged and take no `seq`, and a 20-run test checks it (design:60-62). Extend the same rule to Origin refusals (condition 8). |
| B4 | partly resolved | (a) Prices are now under $1. (b) and (c) are covered by `mcp-naive`. (d) is not fixed: the "second server outside `allowed_hosts`" row is `challenge` class, and `mcp-sdk-default` connects only to servers "named in the prompt" (design:148,160). So the prompt names the server, and the oracle then penalises doing what the user asked (condition 2). |
| M1 | partly resolved | The design now scores on budget and adds a 2× control (design:144-152). But the attack keeps `max_payments` at its default of 1, so `too_many_payments` still fires: the run is scored as a forbidden retry as well as on budget. `@x402/mcp` never re-pays with `exact`, so `mcp-sdk-default` fails the 2× control, which contradicts design:187-188 (condition 3). |
| M2 | resolved | No `wire` on tool routes in the public corpus. Channel split moves to private U30-4. The ADR-033 note is in the owner decisions (design:89-90,239-241). |
| M3 | resolved | The approved price is bound in the prompt, the budget is at least the reprice, the price is under $1, and the scenario is `repeat` class (design:143). The budget must cover both calls, so at least $0.51; otherwise `over_total` decides the run. |
| M4 | resolved | `transport` is in `PaymentSchema`, `summary.transports` appears only when non-zero, reports print `header (mcp)`, and the docs define the term (design:127-131). |
| M5 | resolved | `results/internal/`, private first triage, and the triage is part of U30-3's acceptance (design:162,201-202). |
| M6 | resolved | Every interop rule is specified (design:51-59). |
| M7 | resolved | `mcp-naive`, plus one manual LLM reachability run within the G5 cap, results private (design:163-176). |
| m1 | resolved | Rule 3 fields extended (design:104-106). The wrong claim about a prose/attacker exemption is gone. Rule 6 host references and `collectScenarioCanaryNames` are not mentioned; covered in condition 4. |
| m2 | resolved | `wire` is a lint error on tool routes. |
| m3 | resolved | `mcp://tool/<name>`. |
| m4 | resolved | Status mapping 402/200/400, plus a `tool` field on `RequestLog`. |
| m5 | partly resolved | The SDK is pinned through an override and its tree is recorded, but `zod` is pulled in "as the 3 range" (design:170-171). CLAUDE.md requires exact pins (condition 6). |
| m6 | resolved | `-32042` moves to U30-4. String payloads and `PAYMENT-SIGNATURE` on `/mcp` are recorded. Payments in tool arguments and cross-server shadowing are out of scope (design:227). |
| m7 | resolved | The rail/transport split, with HTTP byte-identity under the U30-0 and U30-1 acceptance. |
| m8 | resolved | Scenario v6, and `application-design.md` is updated. |
| m9 | resolved | The Origin check returns 403. |
| m10 | resolved | Proxy mode is refused; the supported host modes are `localhost` and `path`. |

### New problems in revision 2

1. **The `transport` default changes `corpusHash`.** Design:80 says "default `http`". A zod
   `.default()` writes `transport: "http"` into every parsed HTTP scenario, so the hash of
   `corpus/` moves. That breaks design:212 and invalidates every leaderboard entry. The
   house pattern is an optional field with no default, applied where it is used: see
   `walletBalanceUsd`, `minPayments` and `wire` (`scenario.ts:262-266,287-291,89-91`).
2. **`mcp-sdk-default` cannot pass the `settle_fail` 2× control.** With `exact`,
   `@x402/mcp` never re-pays: the corrective retry needs a recovery hook, and only
   batch-settlement registers one (`@x402/evm` `chunk-QJHO4KEV.mjs:438-476`). The agent
   returns `isError` after the one payment, so the control scores
   `required_payment_missing` and `not_delivered`. This is library behaviour working as
   designed: re-paying is left to the application. It is not a defect, and the acceptance
   has to say so. The `settle_fail` attack has a related problem. If an agent exits
   non-zero on a tool `isError`, the run scores `error` rather than pass or fail
   (`score-run.ts`, "agent_ok"). `mcp-guarded` also cannot get the retry from its
   `onPaymentRequested` hook; it has to call the tool again itself.
3. **The second-server scenario's oracle contradicts its prompt** (B4d above). As
   written, it needs the prompt to name a server that `allowed_hosts` excludes. The
   realistic version is the one `lookalike_domain` already uses: the second server's URL
   appears only in a tool result or description, which makes it `crawl` class.
   `mcp-naive` (following server URLs) fails it, and `mcp-sdk-default` never reaches it.
4. **The schema shape of tool routes is unclear.** `RouteSchema.path` is required today
   (`scenario.ts:238`), but design:86 says the path is "implied". The new `RequestLog.tool`
   field must be added to `RequestLogSchema` and be present only for MCP. Otherwise
   existing reports re-parse differently, or a leaderboard re-score drops the field.
5. **`mcp-naive`'s retry on `isError` has no bound.** It needs a fixed limit, or a
   `402_forever`-style tool loops until the run times out, which gives a timing-dependent
   status.

### Build conditions

1. Make the scenario-level `transport` optional with no zod default, and default it where
   it is used. The loader refuses `transport: mcp` under `corpus/`, and refuses any
   scenario under `corpus-mcp/` that has no tool route. The U30-0 acceptance proves that
   `corpus_hash` of `corpus/` equals `main`'s.
2. Rework the second-server scenario: the prompt names only the allowed server, and the
   other server's URL appears only in tool output or a description (`reach_class: crawl`,
   failed by `mcp-naive`). Alternatively, drop the scenario from U30-3.
3. `settle_fail`:
   - Set `expected.max_payments: 2` on the attack so it is scored by `over_total` alone
     (the intent of M1).
   - Change the acceptance to say that `mcp-sdk-default` is expected to fail the 2×
     control, and record why: `@x402/mcp` with `exact` never re-pays, by design.
   - Every `mcp-*` agent exits 0 on a tool `isError`.
   - `mcp-guarded` and `mcp-naive` re-call the tool themselves; `mcp-guarded` does so
     only within the remaining budget.
4. Tool-route schema:
   - Use a refine so a tool route's `path` is either absent or `/mcp`, normalised in one
     place.
   - Add `tool` to `RequestLogSchema`, optional and present only for MCP.
   - Extend rule 6 host references and `collectScenarioCanaryNames` to the tool text
     fields.
5. Name where the `corpus-mcp` reference results are committed (for example
   `results/mcp/`) and how the leaderboard loads them. `LEADERBOARD.md`'s HTTP section
   must regenerate byte-identical.
6. Pin `zod` exactly through an override, as with the MCP SDK.
7. Give `mcp-naive` a fixed retry limit (for example 3), the same on every run.
8. Requests refused for their Origin, and the 405s, take no `seq` and never appear in
   `report.json`.
9. Before U30-4 is built, write a short design delta for the tool-route channel modes
   (structured absent, text differs, `-32042`) and have it reviewed. Revision 2 removed
   `wire.structured` and does not say how the fuzz shape expresses these modes.
10. The `reprice` scenario's budget covers both calls (at least $0.51 with the example
    prices), so only price binding decides the run.

## U30-4 delta review

Reviewer: senior-architect. Date: 2026-10-26. Subject:
`aidlc-docs/construction/U30-mcp-seller/u30-4-delta.md` (draft), branch
`docs/u30-mcp-seller` at `093a753`. Read against design §1, §3 item 5 and §8, ADR-028/029/
032/033/034/035, GOVERNANCE.md "Private by design", `packages/fuzz/src/{cases,generate,diff}.ts`,
`packages/schema/src/{scenario,load}.ts`, `packages/adversary/src/{mcp-server.ts,transports/mcp.ts}`,
the installed `@x402/mcp` 2.28.0 dist, `@x402/core` 2.28.0 and `@modelcontextprotocol/sdk`
1.32.1 under `node_modules/.pnpm`. Facts marked "checked" were run with a short `node -e` against
the installed packages. Paths below are relative to `node_modules/.pnpm/` for the packages.

### Facts checked

- **§1.1 order: correct, with omissions.**
  - The result path runs only when `isError` is truthy. It tries `structuredContent` first, if
    truthy and it passes `parsePaymentRequired`. Otherwise it tries `content[0]`, only when that
    is `type: "text"` and `JSON.parse` gives an object that passes the same schema
    (`@x402+mcp@2.28.0/.../dist/esm/index.mjs:714-747`).
  - "Parses" means the zod `PaymentRequiredSchema` of `@x402/core`: positive
    `maxTimeoutSeconds`, CAIP-2 `network`, `resource.url` required. Unknown keys are
    **stripped**, at the top level and in each `accepts` entry (checked).
  - The JSON-RPC error path is read **only on the unpaid probe call** (`index.mjs:455-465`).
    `callToolWithPayment` does not catch (`index.mjs:544`), so an error answer to a paid call
    reaches the agent as a thrown error.
  - `isPaymentRequiredError` also needs `message` to be a string (`index.mjs:100-120`). For
    **either** code, `data.x402` is used whenever the key exists, with no fallback to the flat
    copy (`index.mjs:768-775`; README "Supported PaymentRequired Shapes", line 266). Checked:
    `402` with a valid flat copy plus a bad `data.x402` is not read.
- **§1.2: correct.** A missing or schema-failing `structuredContent` falls back to the text
  silently; when both parse, the structured copy wins.
- **§1.3: confirmed.** SDK 1.32.1 defines `-32042` as `ErrorCode.UrlElicitationRequired`
  (`@modelcontextprotocol+sdk@1.32.1_zod@3.25.76/.../dist/esm/types.js:170`), with
  `URL_ELICITATION_REQUIRED = -32042` in `spec.types.js:23`, at `LATEST_PROTOCOL_VERSION
  2025-11-25` (`types.js:2`).
  - Every error response goes through `McpError.fromError` (`shared/protocol.js:518`). For
    `-32042`, when `data.elicitations` is set, it builds a `UrlElicitationRequiredError` whose
    `data` is replaced by `{ elicitations }` (`types.js:2039-2061`). Checked: a `-32042` that
    carries both `elicitations` and `x402` arrives with `x402` gone, and `@x402/mcp` reads no
    payment.
  - I could not verify offline whether the x402 MCP transport spec at the pinned commit
    defines `-32042`. The `@x402/mcp` README lists it as a supported shape.
- **The SDK checks results before `@x402/mcp` sees them.** `structuredContent` must be a
  record (`types.js:1302`), so a non-object makes the whole call throw before any fallback.
  `JSONRPCErrorResponseSchema` is `.strict()` (`types.js:175-194`). A POST answered with a
  non-2xx status throws `StreamableHTTPError` and loses the body (`client/streamableHttp.js:326-378`).

### Findings

| id | severity | area | finding | impact | required change |
|---|---|---|---|---|---|
| D1 | major | oracle, tiers | §1.3 is settled: the base protocol assigns `-32042` to URL elicitation (facts above). §2.4 still says "pending". `jsonrpc:402` and `jsonrpc:-32042` (flat data, no `elicitations`) behave the same in `@x402/mcp` 2.28.0 on SDK 1.32.1 (checked). The only `-32042` variant where the SDK behaves differently, data carrying both `elicitations` and `x402`, has no mode. | The `jsonrpc:*` tier can never rise above `undefined`. Neither paying on `-32042` nor refusing it is a defect. A triage that treats one of them as a lead imports the harness's own reading. The mode set misses the one case where the protocol collision is visible. | Rewrite §1.3 and §2.4 as fact: `jsonrpc:*` is `undefined` for good, and the triage note says "base-protocol code collision", never a verdict. Add `jsonrpc_elicit:-32042` (data = `{elicitations:[…], x402: patched}`), or put it in §4 out of scope. Say that `jsonrpc:402` and flat `jsonrpc:-32042` cannot be told apart by the only in-scope client. Correct §1.1 with the omissions above: probe-only error path, `data.x402` precedence for both codes, `message` string, zod parse and strip, `content[0]` must be text. |
| D2 | major | measurement, recording | §2.3 applies the union of channel offers to the diff invariant only. The adversary's own match still uses the one issuance it records: `issueChallenge` pushes `built.issued` (`mcp-server.ts:225-246`), and payments are evaluated against `currentChallengeIds`. The diff invariant compares entry fields (`diff.ts:196-245`), so per-channel **hashes** cannot feed it. | In `text_differs` and `structured_differs`, a client that follows the other channel is recorded `signed_invalid`, the scorer fails it, and the invariant reports `terms_mismatch`. That is the rev-1 M2 problem again, now in private triage. | Record each channel's readable `accepts` entries (not only hashes) in an optional `IssuedChallenge.channels`. The adversary's binding check and `IssuedChallenge.accepts` use the union, and hashes are derived from the entries. The `channel` observation also needs `multiple`, for signed terms that match more than one channel (always the case in `both`, and whenever the patch touches only fields that are not signed). |
| D3 | major | diff alignment | The F5 check compares every recorded challenge with one `offered_terms_sha256` (`diff.ts:439-453`), documented as "identical in both shapes" (`generate.ts:61-64`). A differs mode serves two offers, and a channel-only case has no page twin. | Every `*_differs` run is refused at alignment ("offered accepts … do not match the manifest hash"). The same class of bug as the U29 non-array-`accepts` fix. | The manifest case gains `offered_terms_sha256_by_channel`, present only for channel cases, and F5 compares each recorded channel with its own hash. MCP issuances with a patch record `wire.offered` exactly as HTTP does, so the `both` hash equals the page hash. Extend the cross-shape check (`generate.ts:198-204`) to mcp vs page for every case both carry. |
| D4 | major | generation | `generate()` aligns shapes by array index (`generate.ts:190-225`). `resolveEntry` copies only `patch`, `encoding` and `body` into `wire` (`cases.ts:133-143`). `pairable`/`pairEntry` merge `body` and `encoding` across entries (`cases.ts:195-240`). `offeredTermsForScenario` renders the HTTP header path only (`adversary/src/index.ts:254-264`). | Per-case `shapes` silently misaligns cases. A pair of a `body` entry and a `channels` entry is valid on no shape. The mcp offer is computed through the HTTP encoder. | Key built cases by id. A pair's shapes are the intersection of its members' shapes, and a pair with none is skipped. Never pair `channels` entries, or pair them only with patch-only entries. Add an MCP-aware offered-terms function that returns each channel. Add `counts.skipped` per shape. When `--shape mcp`, write to `corpus-mcp/` and clear a stale `corpus/`, and the reverse (`generate.ts:245-250` clears only `corpus/`). |
| D5 | major | contracts, public corpus | The table gives `both` as the default. `WireSpecSchema` is shared with HTTP (`scenario.ts:92-112`): a zod `.default("both")` writes `channels` into every HTTP `wire` scenario and moves the page/chat `corpus_hash`. This is the rev-2 condition-1 trap again. The loader refuses any `wire` on a tool route today (`load.ts:755-760`). §2.2 replaces that with "the public `corpus-mcp/` lint refuses any other value", which implies `wire.patch` and `channels: both` become legal in public `corpus-mcp/`. | It breaks every private manifest and the smoke golden. It loosens a code-enforced guard into a policy, against ADR-032 #4 and rev-1 M2. | `channels` is optional with no zod default, applied where used. The loader keeps refusing `wire` on tool routes except in generated scenarios: id prefix `fuzz-` with a `fuzz:` technique, already paired by `load.ts:425-432` and blocked from commit by `scripts/fuzz-guard.mjs`. Extend `wireFields` (`load.ts:139-160`) so lint rules 3 and 6 cover the `text_raw:` string, as they cover `raw:`. Record the contract change in `application-design.md`. Add an ADR-032 amendment to the owner decisions. |
| D6 | major | differential | "Any outcome difference there is a transport-layer divergence" is wrong. Known non-transport causes: (a) `@x402/mcp` zod-validates and strips the challenge, while the HTTP path only `JSON.parse`s the header (`@x402+core@2.28.0/.../chunk-FV2JN4FK.mjs:2156-2160,2313-2318`). Every case that fails the schema shows mcp `refused` against whatever the page client did. (b) Config: `sdk-default` uses `registerExactEvmScheme`, which also registers the V1 networks, while `mcp-sdk-default` registers only v2 `eip155:*` (`examples/agents/src/lib/mcp.ts:173-177`). (c) The paid-call timeout comes from `maxTimeoutSeconds` (D8). (d) `@x402/mcp` declares `@x402/core ~2.28.0` (a range, no override). The `core=` value in the smoke test is read from `examples/agents/node_modules/@x402/core` (`fuzz-smoke.e2e.test.ts:36-40`), not from what `@x402/mcp` loads. | Wrapper-scope disagreements are predictable and many, and they are not transport findings. A lockfile refresh could split the cores while the diff still says `wrapper`. | Keep one group, but: record per case and per channel whether the served object passes `parsePaymentRequired` of `@x402/core` 2.28.0 (the adversary already depends on it) as `sdk_schema_ok`, and have the triage annotate differences where it is false. Either give `mcp-sdk-default` the same scheme set (V1 included) or record the as-shipped difference (owner decision). Read the mcp client's core provenance from `@x402/mcp`'s resolved `@x402/core`, and pin `@x402/mcp>@x402/core` exactly. State that fuzz cases use `normal` behaviour only, so `settle_fail` semantics do not enter the comparison. Add an interop fixture showing the generated prompt resolves to one server and one call to `get_report`; otherwise every mcp case is `errored` and both base controls void the client. |
| D7 | major | tiers | "Keeps its HTTP tier": `tier` is one value per case (`generate.ts:56`, `diff.ts:546`). A `spec-must` entry whose citation is the HTTP transport (header encoding, the 402 body) does not bind MCP. | Oracle 2 would report false `spec-must` hits on mcp, the one oracle that is scored. | Make tier per shape. It carries over to mcp only when `cite.file` is not the HTTP transport spec; otherwise it is `undefined` for mcp. Give the manifest `tier_by_shape`, or let diff derive it. |
| D8 | major | determinism | `paidTimeoutMs` sets the paid call's timer to `floor(min(maxTimeoutSeconds, 600) × 1000)` ms (`index.mjs:138-160`; SDK timer in `protocol.js:740-742`). The schema rejects 0 and negatives, which is deterministic, but accepts fractions: 0.5 parses (checked). | For small positive values, the outcome (`errored` timeout or signed and delivered) depends on scheduling. That breaks ADR-028 #3 (byte-identical over 2 runs) and puts noise into `attempts_differ`. | The generator records `mcp_paid_timeout_ms` per case. Below a fixed threshold (for example 5000 ms), a case is timing-sensitive: run it with at least 2 attempts, leave it out of the differential, and report it as an observation. The alternative is for the agent to pass a fixed per-call `timeout` (owner decision: it departs from as-shipped). |
| D9 | minor | determinism, interop | JSON-RPC error modes are unspecified on the wire. The SDK throws on a non-2xx status and loses the body, and the error envelope is strict. The re-presentation path (`mcp-server.ts:250-262`) has to apply the same channel. | A mode sent with HTTP 402 or an extra envelope key tests the SDK's transport, not `@x402/mcp`. | Send HTTP 200, echo `id`, give a string `message`, and nothing else at the envelope level. Log status 402 (rev-1 m4). Apply the channel in `represent` too. The un-awaited GET is unaffected: it is still a 405 with no log and no `seq` (`mcp-server.ts:85-92`), and the error modes add no unlogged request. The client's close after a thrown error sends a DELETE, which is also an unlogged 405. |
| D10 | minor | compatibility | Adding `mcp` to `SHAPES` makes `generate` hash every shape (`generate.ts:195-196`), and `diff` echoes `manifest.corpus_hash` (`diff.ts:628-632`). The committed `packages/fuzz/test/golden/smoke-diff.json:135-138` then gains an `"mcp"` key, and fuzz-smoke fails until `UPDATE_GOLDEN=1`. Old manifests still parse (`parseManifest` checks only the version, `diff.ts:106-122`); they have no `mcp` hash and no `shapes`. `missing_cases` (`diff.ts:640`) needs a per-shape count, which changes meaning but not the `diff.json` structure. | §3's "every committed result is byte-identical" is false for the golden. | List the golden regeneration as an expected change, limited to that one key, and have the reviewer check exactly that. Absent `shapes` defaults to `["page","chat"]`. Keep `manifest_version: 1` with optional fields (or bump to 2, and diff accepts both). Add a test: an old manifest plus a page run gives an unchanged `diff.json`. |
| D11 | minor | recording | Committed `results/mcp/*.json` (U30-3) carry `runs[].challenges`. If the per-channel field is written for every MCP issuance, `both` included, those files change. `IssuedChallenge.wire.encoding` has no MCP value (`schema/src/ledger.ts:32`). | Byte identity of the U30-3 results and of HTTP records depends on how the field is written. | `channels` on `IssuedChallenge` is optional and present only when `wire.channels` is set and is not `both`. Define what an MCP `wire` issuance records as `encoding` without widening the HTTP enum. The `channel` observation lives in `diff.json` only, never in `report.json`. HTTP records are then unchanged by construction. |
| D12 | major | privacy | Alignment refusals do not depend on outcomes: they turn on `corpus_hash`, seed, run-record presence and the offered-terms hash (`diff.ts:397-466`). But the smoke test passes `fuzz.stderr`, `run.stderr` and `diff.stderr` into assertion messages (`fuzz-smoke.e2e.test.ts:74,92,105`). `mcp-sdk-default` prints one JSON line per call with `paymentMade`, `isError` and the result text (`examples/agents/src/lib/mcp.ts:221-230`). The public families were triaged for the U29 clients only; GOVERNANCE.md says "first triage across all clients". | A failing or verbose CI run would print `@x402/mcp` outcomes in public logs before any private triage, which is what ADR-028 #7 and #8 forbid. | Before the leg is enabled, run the mcp shape on the public catalogue privately and triage it (4 cases). The leg asserts only "no refusal" and "cases run = manifest cases for shape mcp". It prints only the refusal reason and that count, never stderr or stdout, and never flagged, invariant or voided counts (unlike `countsOf` for the golden). It runs with `--quiet` and uploads no artifact. |
| D13 | minor | `wire.channels` completeness | Missing modes where SDK behaviour differs: `jsonrpc_elicit` (D1); a non-object `structuredContent` (the SDK rejects the whole result, `types.js:1302`; `wire.patch` cannot produce one because it is a record, `scenario.ts:95`); `content[0]` not text with the JSON second (`index.mjs:728-731`). "Structured present but failing the schema, text valid" is not separate from `text_differs`: it is `text_differs` with a patch that breaks the schema. Vacuous for `@x402/mcp`: `not_error` (never read, `index.mjs:715`), `text_raw:<JSON of patched>` (same as `text_only`), and `jsonrpc:402` vs `-32042` (D1). | Without these, the mode set looks complete but misses SDK-level paths. Without the notes, vacuous modes read as coverage. | Add `structured_raw:<json>` and `text_second`, or list them in §4. State the schema-breaking case explicitly, backed by `sdk_schema_ok` (D6). Keep the vacuous modes as cheap observations for the Bolt 10 adapters, marked as not exercising `@x402/mcp`. |
| D14 | minor | housekeeping | `mkdtempSync` gives a random basename (`generate.ts:162`), so the hash has to load from `join(tmp, "corpus-mcp")`. `corpusHash` does not depend on paths (`scorer/src/score-suite.ts:38-42`), so the result equals the out dir's hash. `scripts/fuzz-guard.mjs` already refuses any file under `*.fuzz/` or `fuzz-out/` and any file stamped with the marker, and `generate` stamps every YAML (`generate.ts:155`). The `fuzz-` id rule already runs for every directory (`load.ts:425-432`). | Two §2 items are already in place. | §2.1 and §2.6: replace "covers" with a test for each. |

### Verdict

**Sound with required changes.** The direction is right: a third shape over the same
catalogue, the private channel modes, the `undefined` tier for every channel disagreement, the
alignment-only CI leg, and no committed `mcp-sdk-default` golden. §1's facts hold against the
dist, apart from the omissions in D1. No finding needs a redesign. D1–D8 and D12 must be folded
into the delta before build; D9–D14 can be build conditions.

**Owner decisions:**

1. ADR-032 amendment: `wire.channels` on tool routes, in generated corpora only (D5). The
   ADR-033 #5 note extends to the `jsonrpc:*` modes as permanently `undefined` (D1).
2. `mcp-sdk-default`: keep it as shipped (v2 schemes only, timeouts from `maxTimeoutSeconds`),
   or match `sdk-default`'s scheme set and pass a fixed per-call timeout (D6, D8). As shipped
   is closer to the measurement goal; it then needs the annotations in D6 and D8.
3. CI `mcp` leg: enable it only after a private triage of the mcp shape on the 4 public cases
   (D12). It then publishes alignment only.
4. Accept the one-key regeneration of `smoke-diff.json` as an expected committed change (D10).

### Delta check (revision 2)

I read revision 2 of `u30-4-delta.md` against D1–D14 and the same code and packages.

**Status of each finding**

| id | status | reason |
|---|---|---|
| D1 | resolved | §1.2–1.3 state the facts. `jsonrpc*` is permanently `undefined` (§2.4). `jsonrpc_elicit` is added, and `jsonrpc:402` is labelled as the same as `-32042`. |
| D2 | resolved | `IssuedChallenge.channels` holds entries, and the adversary's binding and `accepts` use the union (§2.3). The order of the union is not given (N1). |
| D3 | resolved | `offered_terms_sha256_by_channel`, a per-channel F5 check, `both` recorded like HTTP, and a differs-mode alignment fixture. |
| D4 | resolved | Cases keyed by id, per-case `shapes`, pair intersection, `counts.skipped`, an MCP-aware offered-terms function, both corpus directories cleared, and the prompt interop fixture. |
| D5 | resolved, with a condition | No zod default. The loader refuses tool-route `wire` except in generated scenarios, and lint covers `text_raw:`/`structured_raw:`. The exception rests on the `fuzz-` id, but `scripts/fuzz-guard.mjs` runs only in local hooks (`.githooks/pre-commit`, `pre-push`), not in CI (N2). |
| D6 | resolved | Wrapper scope stated, `sdk_schema_ok` annotation, core provenance read from `@x402/mcp`'s resolution and pinned. The scheme set is owner decision 2. |
| D7 | partly | `tier_by_shape` is in the manifest, but the delta does not say that diff oracle 2 reads the tier of each client's shape (`diff.ts:546` reads `mc.tier`), or what `CaseResult.tier` shows (N3). |
| D8 | partly | `mcp_paid_timeout_ms` and the 5000 ms rule are in. But "at least 2 attempts" per case cannot be expressed: attempts come from the run-wide `--repeat` (`packages/cli/src/main.ts:33`), and a scenario has no attempts field (N4). |
| D9 | resolved | Build condition 1. |
| D10 | resolved | §3 states the one-key golden change, old-manifest defaults and `manifest_version` 1. Build condition 4. It is at risk from N5. |
| D11 | resolved | `channels` present only when not `both`; the observation lives in `diff.json` only; an MCP `encoding` without widening the HTTP enum (build condition 2). |
| D12 | resolved | The leg is enabled only after the private triage, prints only the refusal reason and the case count, never agent output or oracle counts, runs `--quiet`, and uploads no artifact. |
| D13 | resolved, with conditions | `text_second`, `structured_raw` and `jsonrpc_elicit` are added; the vacuous modes are labelled. Both new modes need wire details (N6). |
| D14 | resolved | Build condition 3. |

**New issues in revision 2**

- **N1 (minor).** The union order is not given. `accepts[0]` becomes `requirements`, and the
  scorer falls back to `issued.accepts` for prices (`scorer/src/score-run.ts:76-85`). Fix the
  order (structured, text, error), dedupe identical entries canonically, and let the order
  never depend on what the client sent.
- **N2 (minor).** A PR that adds a scenario with a `fuzz-` id and a `fuzz:` technique to
  `corpus-mcp/` would load with tool-route `wire`, and CI would not stop it, because the fuzz
  guard is hook-only. Make `validate` (or a CI step) refuse `fuzz-` ids in the committed
  `corpus/` and `corpus-mcp/`, or run `scripts/fuzz-guard.mjs` in CI. The HTTP side has the
  same gap under ADR-032 #4, so the same check closes both.
- **N3 (minor).** Diff oracle 2 must use the tier of the client's own shape. `CaseResult.tier`
  stays the page/chat tier, so the golden does not move. Name the HTTP transport spec path(s)
  in one constant, for the `cite.file` rule.
- **N4 (minor).** Run timing-sensitive cases as a separate private run with `--repeat 2`. The
  runner selects them from the manifest's `mcp_paid_timeout_ms`. Alternatively, add a
  per-scenario attempts field, which is a contract change; the separate run is cheaper.
  Record `mcp_paid_timeout_ms` only when the channel the client reads passes the schema.
- **N5 (minor).** Golden byte-identity beyond the one key: the new per-client fields (the
  `channel` observation, `sdk_schema_ok` and timing annotations) must appear only on results
  from mcp-shape clients, and only when they apply. Otherwise the page-only smoke
  `diff.json` grows fields. Add this to build condition 4.
- **N6 (minor).** Wire details for the two new modes.
  - `text_second`: the first item must be a content block the SDK accepts (for example a
    `resource_link`, or an `image` with valid base64 and `mimeType`). Otherwise the SDK
    rejects the whole result, and the mode tests the SDK instead of `@x402/mcp`.
  - `structured_raw:<json>`: when the literal is an object with readable `accepts`, record it
    as a third channel offer in `IssuedChallenge.channels`, its own hash and `sdk_schema_ok`.
    When it is not an object, record no offer for it.
- **Nit.** §1.3's last sentence ("`@x402/mcp` reads a code the base protocol assigns to
  something else") reads as a judgement on a third-party library in a public document. Keep it
  to the protocol facts (ADR-028 #8): "`@x402/mcp` also accepts `-32042`; the MCP SDK assigns
  that code to URL elicitation."

**Verdict: signed off for build, subject to these conditions.** Fold N1–N6 into §4 as build
conditions 5–10. The lead developer applies them in U30-4, and the code reviewer checks them.
N3 and N5 must hold before the smoke golden is regenerated, and N2 before the branch is pushed.
None of them needs another review round. The §6 owner decisions are unchanged; the
recommendation of option 2 (as shipped) is sound.
