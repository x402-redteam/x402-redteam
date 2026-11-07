# Architecture review — U38 functional design rev 1 (adversary resource limits, M9)

Reviewer: senior architect (read-only). Inputs: `construction/U38-adversary-limits/functional-design.md`
(rev 1, 336 lines), `reviews/consulting-architecture-review.md` M9, `packages/adversary/src/*`,
`packages/cli/src/{run,spawn,main}.ts`, `packages/scorer/src/{score-run,score-suite,types}.ts`,
`packages/driver/src/{main,crawl,pay,gdp}.ts`, `packages/capture/src/shim`, `packages/leaderboard` re-score,
hono 4.13.11 `bodyLimit`, `@hono/node-server` 2.1.3. Two Node 24 micro-benchmarks (scratchpad, no
harness run). Checkout: main e3e16b2.

## Verdict: NOT READY (rev 2 for C1-C5, then a delta check). 1 Blocking, 3 Major, 9 Minor. Detail at the end.

## 1. Verified facts
- Evidence correction holds. `routes.ts:120` is the only `bodyLimit` (submit path, 16 KiB,
  413 logged, not scored). `ledger-endpoint.ts:13` is a plain `c.req.json()`. `/mcp`
  (`mcp-server.ts:100-105`) checks the declared `content-length`, then buffers the whole
  body with `c.req.text()` and compares `text.length` (UTF-16 units). Unbounded
  `c.req.json()` also at `facilitator.ts:48,93` (design says 44/89: drift only),
  `evm-rpc.ts:352`, `solana-rpc.ts:67`, `routes.ts:146` (inside the 16 KiB limit). OK.
- §3 numbers reproduce (scripted scan of the 7 results): 1,131 runs, max 82 requests and 20
  payment legs per run (budget-split), max 40 RPC elements per run (allow-all budget-split),
  statuses {200, 302, 402, 404}. OK, with the caveat in m1 (the measured count excludes
  facilitator, ledger and `/mcp` 405 traffic, which the cap counts).
- Batch elements each append a RequestLog (`evm-rpc.ts:531`, `solana-rpc.ts:245`); facilitator
  and ledger append none (only `evm-rpc`, `solana-rpc`, `routes`, `mcp-server`, `proxy` push
  to `requests`). OK.
- hono 4.13.11 `bodyLimit`: with `content-length` and no `transfer-encoding` it trusts the
  declared length (safe: Node's parser enforces the framing); otherwise it reads the stream
  and calls `onError` as soon as the running count passes `maxSize`, so at most
  `maxSize` + one chunk is buffered. A null body (GET/HEAD) skips it. OK.
- Unread bodies after a 413/429: `@hono/node-server` 2.1.3 `drainIncoming` reads and discards
  for at most 500 ms or 64 MiB, then destroys the socket. So "without reading the body"
  costs at most that per refused request; bounded. OK (the design should cite it).
- One adversary per run on a fresh ephemeral port (`run.ts:384-396`, closed in `finally`),
  so `load()` resets nothing that outlives a run, and R6's cross-run case cannot occur
  (see m6).
- The run timer, its SIGKILL follow-up and the `hasStarted` poll are all `setTimeout` /
  `setInterval` on the harness loop (`spawn.ts:178-196`): a stalled loop delays the kill.
  The design's premise is right; its bound is not (B1).
- `scoreRun` status (`score-run.ts:515-523`): attacks fail on any violation, else
  `error` when `!agent_ok`; controls fail on any non-exempt violation. Reproducibility
  exclusion is `status === "error" || !agent_ok` (`score-suite.ts:147`). Leaderboard
  re-score parses `runs[]` through `RunRecordSchema` (`build-leaderboard.ts:896`), a
  non-strict `z.object` that strips unknown keys, so the field must be in the schema, as
  the design says. `...rest` copy at `score-suite.ts:526`. OK.

## 2. Findings

### Blocking

**B1. The §6 "caps suffice" conclusion is false: one admitted request under 256 KiB can
stall the harness loop for tens of seconds.** `solana-rpc.ts:210` decodes a non-base64
`sendTransaction` parameter with `getBase58Encoder().encode(raw)`, which is quadratic in
the string length. Measured here (Node 24, `@solana/kit` as installed): 2,000 chars 5 ms,
8,000 chars 49 ms, 32,000 chars 788 ms, 64,000 chars 3,085 ms. Extrapolated to the 256 KiB
body cap, one element is ~50 s of synchronous CPU, inside a single JSON-RPC request well
within `MAX_RPC_BATCH` and `MAX_RUN_REQUESTS`. The run timer and its SIGKILL follow-up are on
the same loop, so they cannot fire; 1,000 such requests is hours. The §6 table assumes
"≤ 256 KiB: a few ms" and "~3 ms per element" without measuring the costliest decoder.
The EVM path is linear and roughly as claimed for small transactions (measured
`recoverTransactionAddress` + `keccak256` + `parseTransaction`: 1.8 ms with empty data,
17.8 ms with 120 KB of calldata), so the per-element figure is right only for small bodies.

Fix (small): bound every agent-supplied field before any super-linear decode. A Solana
transaction is at most 1,232 bytes (base58 ≤ ~1,700 chars, base64 1,644), so a per-param
bound of e.g. 4 KiB on `sendTransaction`/`simulateTransaction` (and any other base58 input
not already length-checked; addresses are bounded by `SVM_ADDRESS_RE` and `assertIsAddress`)
answers `-32602` before decoding. Then restate §6 on measured worst cases per surface, and
add an AC that times the costliest admitted request per surface at the cap (fixed upper
bound, e.g. < 50 ms). This is the one place where the design's choice not to move the
adversary off the loop depends entirely on a number that was not measured.

### Major

**M1. The stall and memory arithmetic in §6 is per request, but the loop is shared by every
open connection.** Even with B1 fixed:
- *Per turn.* Requests whose bytes are already in the socket buffers are all handled in one
  libuv poll phase, each run to completion through microtasks, before the timers phase. With
  up to 128 connections per listener (and three listeners: 127.0.0.1, ::1, proxy), the
  single-turn stall is bounded by the total CPU of all in-flight admitted work, not by
  "one batch, ~0.3 s".
- *Per run.* The cost of one request is bounded by its bytes, not by its element count:
  measured 17.8 ms for one 120 KB-calldata EVM transaction (before capture's own decode).
  1,000 admitted requests × ~20-40 ms is 20-40 s of harness CPU per run, against the
  stated "~3 s". That is the same order as the 60 s timeout, and AC-12's
  timeout + 2 s + 3 s window would fail against a worst-case fixture (or pass only because
  the fixture is mild).
- *Memory.* AC-12's "RSS growth < 64 MiB" has no derivation. In-flight body memory is up to
  listeners × `MAX_CONNECTIONS` × `MAX_BODY_BYTES` × copies (bodyLimit's `chunks`, the
  rebuilt `Request` stream, `text`, the parsed JSON): 3 × 128 × 256 KiB = 96 MiB of raw
  bytes before any copy.

Fix: add one cumulative cap, admitted body bytes per run (`MAX_RUN_BODY_BYTES`, e.g. 8-16
MiB; the reference maximum is roughly 82 requests × a few KiB, well under 1 MiB). It makes
total decode CPU and the worst single turn linear in a small constant, and is the same
mechanism as the request counter. Then restate §6 with measured per-surface costs (B1's
AC), derive AC-12's time and RSS bounds from the constants, and say in R1 what the real
worst-case delay is. A worker thread is still not needed once the bound is honest.

**M2. Non-HTTP channels from the run's subject into the harness are not in the 12 rows.**
- *Agent log.* `spawn.ts` pipes the agent's stdout and stderr (and, on the guardrail track,
  the guardrail's stderr, inherited through the driver: `gdp.ts:108`) into
  `out/logs/<run_id>.log` with no bound. A hostile agent can write gigabytes per run
  (disk-full ends the suite, unrecorded: the same harm class as M9). Worse,
  `scrubSecretsFromLog` (`spawn.ts:260-278`) then `readFileSync`s the whole file into a string
  and `split/join`s it per secret: harness memory proportional to the log, and above V8's
  maximum string length the read throws, the `catch` returns, and the `--pass-env` secret is
  left unscrubbed in a log the Action uploads. That is a fail-open on a security control.
- *GDP record.* The guardrail's `hello.name` and `hello.version` are unbounded strings
  (`gdp.ts:241-246`), written to `gdp.json`, read whole by the harness
  (`guardrail-track.ts:104-116`), copied to `out/runs/<run_id>.gdp.json` and kept in memory
  for every run (`gdpRecords`, `run.ts`). A guardrail can make each record arbitrarily large.
- *Driver-side.* The guardrail's stdout lines are unbounded in the driver's `readline`
  (`gdp.ts:124`) and malformed lines are echoed whole into the log (`gdp.ts:153`). That is the
  driver's (agent-side) memory, not the harness's, and its worst outcome (driver crash,
  run `error`, existing capped exclusion) is already reachable because the guardrail runs
  under the driver's uid and can kill it. No change needed beyond the log bound; say so.
- Per-run HOME/TMPDIR writes are the container's job (R7): say so explicitly.

Fix: a byte cap on the log writer (e.g. 8 MiB, then one truncation marker and the rest
dropped; not scored, since logs are not report input), a streamed scrub (or scrub only the
retained, bounded log), and a bound on `name`/`version` in the driver (e.g. 256 chars,
truncated) plus a size check in `readGdpRecordFromDir`. Add the rows to §2 and AC lines.

**M3. On the guardrail track the caps can be hit by the harness's own driver, and the
honest guardrail would be failed for it. R5's premise is wrong.** The driver does not send
"one request per scripted step". Its own designed bounds are: crawl `MAX_DISCOVERY_FETCHES`
200, counted per redirect hop (`crawl.ts:141-142`), each fetch wrapped by `withRetries`
(`main.ts:136-142`, up to 4 attempts, retried on any 402 *and on any 200 with an empty
body*), each attempt a 402 plus a paid retry when allowed (`pay.ts:366`). That is up to
200 × 4 × 2 = 1,600 HTTP requests and 800 payment legs, plus transfer intents (deduped only by
source/to/amount, each a viem `sendTransaction` of several RPC calls) and sign intents. A
link-farm page set of free pages with empty bodies drives 800 requests with **no GDP decision
at all**. The busiest measured run (82 requests, 20 legs) is the driver itself
(`allow-all`, `track: guardrail`, `driver@2`), so the driver is the party closest to the caps
today. The public corpus is far below, but a held-out or future scenario shaped as a link
farm, or with many `402_forever` links, would fail every guardrail (and, on a control, make
`summary.valid` false) for traffic the guardrail did not choose. That breaks §5.2's
"a limit hit is always attributed to the agent", the property the fail-closed rule rests on.

Fix, either: (a) a driver-side hard budget strictly below the caps (e.g. ≤ 400 HTTP
requests and ≤ 100 legs per run in total), so a guardrail-track hit can only be guardrail
traffic (the guardrail learns the base URL from GDP payloads and can call the adversary
directly; that is correctly its fault) or a driver bug; or (b) caps above the driver's
worst case (≥ 2,000 / ≥ 1,000), with the margin argument rewritten. Recommend (a). It
changes driver behaviour only past limits no committed run reaches, but the owner must
rule whether that needs a `driver@3` tag (which would change `config.driver` in two
reference reports and so the §8 byte-identical prediction). State the driver's worst case in
§3 either way and rewrite R5.

### Minor

- **m1. The measured headroom leaves out traffic the cap counts, and leaves out LLM agents.**
  The 82-request maximum is `requests[]`, which excludes facilitator and ledger calls (no
  RequestLog) and `/mcp` GET/DELETE 405s, all of which §3 counts. Shim events alone add about
  one call per signature (up to 20 per run). All 7 references are scripted agents; the LLM
  example scripts run at `--timeout 180` (`examples/agents/scripts/run-llm.sh:31`) and 240
  (`examples/third-party/clawrouter/README.md:139`), and request volume grows with the
  timeout while the cap does not. 1,000 is still very likely enough (tool-call cadence is
  seconds; viem receipt polling is 4 s), but the claim should be measured, not asserted. Fix:
  the §8 regeneration prints (env-gated, stderr, not in report) each run's peak `inbound`,
  largest body, cumulative body bytes and peak connections, and the audit records the
  observed maxima and margins. Say in R3 that the caps do not scale with `--timeout`.
- **m2. Proxy double-count marker must be unforgeable.** §4.6 offers "a request-scoped marker
  header stripped from agent input, or an internal flag". A header is forgeable on the main
  listeners unless every listener strips it; a missed strip is a full bypass of the request
  cap. Pick the internal channel: pass a binding through `app.fetch(forwarded, env)` (read as
  `c.env`, unreachable from the network) or a module-level `WeakSet<Request>`.
- **m3. A `clientError` listener replaces Node's default handling for every error, not only
  header overflow.** With a listener attached, Node no longer writes the 400/431 response
  (and 408 for `ERR_HTTP_REQUEST_TIMEOUT`); the handler must do it itself, skip writing when
  the socket is not writable or the code is `ECONNRESET`, and destroy the socket. §4.7 reads as
  if Node keeps its 400. AC-7: add the 408 case.
- **m4. `recordDecoded` refusal mechanics.** Check the cap before `captureApi.attribute(...)` and
  before `nextSeq()` (attribution walks `payments` and `challenges`), skip the
  `headerSubmissions` push in `recordDecodedLegs` when every leg is refused, and say what is
  returned (the unrecorded `Payment`, so `payments[0]?.payment_id` call sites keep working).
  §2 S12 should also name `challenges[]`, `pageBodies` and `headerSubmissions`, which are
  bounded only by the request cap.
- **m5. Under-count past the payment cap is a small fail-open on the exposure metric (R2).**
  The decoded leg is already in hand at the refusal point. Accumulate `refused_usd` (or count
  the run's remaining wallet balance as exposed) when the payment limit is hit, so a run with
  a large wallet and a dust price is not shown as having lost less than it did. Cheap; your
  call whether in U38 or a residual with this fix named.
- **m6. R6 cannot occur.** `run.ts:384-396` makes one adversary per run on a fresh ephemeral
  port, closed in `finally`; a leftover process cannot reach the next run's listener. Rewrite
  R6 (and drop "`load()` resets the counter" as a meaningful AC, or keep it as a unit fact).
- **m7. Refusals should close the connection.** A 413/429 on an unread body leaves
  `@hono/node-server` to drain up to 64 MiB / 500 ms per request (verified, §1). Set
  `connection: close` on refusals (and in the proxy's 413 path, which already destroys the
  request) so a flood of large refused bodies costs no drain reads.
- **m8. AC-9 should pin the wording of §5.3.** "Some attempt is (error or `!agent_ok`) and
  carries no `resource_limit`" binds to the same attempt, so [limit-hit, plain crash] is
  still excluded (through the existing capped route, as the design intends). Add that case,
  and [limit-hit with `agent_ok`, pass] → compared, inconsistent.
- **m9. `refused` and the message's `(<n> refused)` are timing-dependent** for a concurrent
  flood. Harmless for the verdict (reproducibility compares codes only) but they are the only
  new wall-clock-dependent values in `report.json` (cf. the NFR1 note at
  `score-suite.ts:510`). Keep `refused` in `out/runs/*.json`; persist only `limit`, `surface`
  and `first_seq` in `report.runs[]`, or accept and say so.

## 3. Focus areas not raising findings

- **Enforcement mechanics.** Global `app.use("*")` before the five `register*` calls covers
  S1-S8 (the catch-all scenario route is registered last). Chunked bodies without
  `content-length` are counted while streaming (§1); `content-length` with
  `transfer-encoding` is rejected by llhttp or counted. Proxy: `readBody` counting plus the
  forwarded `Request` passing through the same middleware again (bytes re-checked, request
  not re-counted per m2) is sound; CONNECT stays a flat 405 and an unhandled `upgrade`
  destroys the socket. `maxConnections` 128: concurrent-spend fans out ≤ 5, Node's
  `keepAliveTimeout` (5 s) reaps idle keep-alive sockets, the driver is sequential, and common
  client pools (httpx, aiohttp) default to ≤ 100; no legitimate run is near it.
- **Fail-closed scoring.** `resource_limit` before the status rule fails attacks and
  controls; it is not in the control exemption list; `utility.reasons` gains it. Correct,
  given M3 (attribution) is fixed. A guardrail can reach the adversary directly (GDP payloads
  carry its URLs), and that hit is rightly the guardrail's. The shim posts once per signature
  with no retry (`capture/src/shim/evm.ts:8-23`), so harness instrumentation cannot amplify
  traffic into a hit.
- **Reproducibility.** The new rule removes the one new way a flood could buy an exclusion
  (killed by the timer after a hit). Exclusion is still purchasable by exiting non-zero or
  sleeping into a plain timeout, but that route exists today and is bounded by the
  `max(1, ceil(5%))` cap. An honest deterministic guardrail cannot become inconsistent
  through a cap once M3 holds: the driver's traffic is a deterministic function of the
  scenario and the decisions, and only the connection cap is timing-dependent, which a
  sequential driver never approaches.
- **Recording and Tier 2.** `limit_hit` rides `...rest` into `report.runs[]`, must be in
  `RunRecordSchema` (non-strict; the design says so), and is submitter-editable on a Tier 2
  re-score like `terms_verified` and every other `runs[]` fact (R4). Tier 1 carries no
  `runs[]`. AC-10 covers the round trip. OK.
- **Predicted byte-identical references.** Holds, and survives the fixes asked for here: a
  4 KiB SVM per-param bound is far above a 1,644-char legal transaction, a cumulative body-byte
  cap of 8-16 MiB is far above any reference run, the log cap does not touch `results/`, and a
  driver budget at ≤ 400 requests / ≤ 100 legs is above the 82/20 maximum. The only
  exception is a `driver@3` tag if the owner rules that M3(a) needs one; that changes
  `config.driver` in `allow-all` and `reference-policy` and must then be stated as the
  expected diff.

## 4. Residuals

R1 restate with M1's real bound. R2 add m5's fix or name it. R3 add "do not scale with
`--timeout`". R4 OK. R5 rewrite per M3. R6 delete (m6). R7 OK; name disk (HOME/TMPDIR,
cwd) explicitly as the container's job.

## 5. Owner questions

- **Q1 (A) harness constants.** Endorse. Comparable across submissions, no fingerprint field.
- **Q2 (A) refuse cheaply, no kill.** Endorse, with m7 (close the connection on a refusal)
  and M1's cumulative byte cap, so the cost of refusing is bounded too.
- **Q3 (A) `resource_limit` fails attacks and controls.** Endorse. Note the design's case
  against (B) ("an `error` attempt is excluded") no longer holds once §5.3 compares limit-hit
  attempts. (A) is still better: one explicit code, one rule for both kinds. It is sound only
  once M3 ensures a hit is the subject's.
- **Q4 (A) connection cap and header recording in U38.** Endorse, with m3.
- **Q5 (A) submit 413 is a limit hit.** Endorse; a real submission is ~200 bytes against
  16 KiB.
- **Q6 (A) values as proposed.** Endorse 256 KiB / 100 / 1,000 / 200 / 128, plus the two new
  bounds this review asks for: a per-param SVM transaction bound (B1) and a cumulative
  admitted-body-bytes cap per run (M1). The tighter (B) set buys nothing once the byte cap
  exists and costs LLM-agent margin (m1).
- **New, Q7 (from M3).** Does a driver-side budget that no committed run reaches need a
  `driver@3` tag? Recommend no tag, because no reference changes; if yes, the expected diff is
  `config.driver` in two reports.
- **New, Q8 (from M2).** Log overflow: truncate and not score (recommended; logs are not
  report input), or record as `resource_limit`.

## 6. Conditions (rev 2, then a delta check before build)

- **C1 (B1).** Bound every agent-supplied field before a super-linear decode (SVM
  `sendTransaction`/`simulateTransaction` ≤ 4 KiB, answered `-32602`); audit the other
  decoders for super-linear cost; add an AC timing the costliest admitted request per surface
  at the cap against a fixed bound.
- **C2 (M1).** Add `MAX_RUN_BODY_BYTES` (cumulative admitted body bytes per run); rewrite §6
  with measured per-surface costs and the multi-connection, single-poll-phase bound; derive
  AC-12's time and RSS bounds from the constants; restate R1.
- **C3 (M2).** Add the log channel (byte cap on the writer, streamed or bounded scrub that
  cannot silently skip), and the GDP record channel (`name`/`version` bounded in the driver,
  size check in `readGdpRecordFromDir`) to §2, §4 and §9; state the driver-side readline
  and per-run disk writes as residuals with the reason.
- **C4 (M3).** State the driver's worst-case request and leg budget in §3, add a driver-side
  hard budget below the caps (or raise the caps above it), rewrite R5, and settle Q7.
- **C5 (minors).** m2 (unforgeable proxy marker), m3 (`clientError` replicates Node's
  defaults), m4 (`recordDecoded` refusal order and return), m6 (R6), m8 (AC-9 cases) in the
  text; m1 (measured maxima incl. unlogged traffic, printed by the §8 regeneration), m5, m7,
  m9 decided by the designer and recorded.

## Verdict: NOT READY. 1 Blocking, 3 Major, 9 Minor. Rev 2 for C1-C5, then a delta check.

The diagnosis is right, the evidence correction holds, and the mechanism (one limits module,
global streamed body limit, counters, one fail-closed violation, compared-not-excluded
limit-hit attempts) is the right shape. It is not ready because its central decision, no
worker thread, rests on a stall bound that a single in-cap request breaks (B1, a quadratic
base58 decode measured at 3 s per 64,000 chars), and the per-run arithmetic understates the
CPU and memory an agent can buy by an order of magnitude (M1). Both fixes are small, and with
them the "caps suffice" conclusion should hold. Two Majors widen scope a little: non-HTTP
channels into the harness (logs, GDP record) are unbounded (M2), and on the guardrail track the
harness's own driver can exceed the caps and get an honest guardrail failed (M3). The
byte-identical prediction survives every fix asked for here. All six owner recommendations are
endorsed.

## Delta check rev 2

Read-only check of rev 2 (576 lines, §13 mapping) against C1-C5, plus spot checks of
`credential.ts`, `routes.ts:264`, `mcp-server.ts:373`, `action.yml:292-335`, the corpus
`signature_request/*` typed data and the scenario schema (`schema/src/scenario.ts:205-220`).

**Conditions.** C1 met (base58 bound before decode, EVM 32 KiB, the typed-data finding from
the audit is real and well bounded, JSON depth is justified by the `JSON.stringify` throw,
regexes listed). C2 met in intent, mechanism wrong as written (DM1). C3 met except at the
upload boundary (DM2). C4 met, with one fail-open (DM3). C5 met; the m4 departure
(`undefined`, refused credential unmatched, nothing delivered) is accepted as more
fail-closed than my suggestion, but its "every call site tolerates an empty list" is not true
(D4).

**Bounds vs legitimate use.** No committed scenario comes near the new field bounds: legal
SVM transactions ≤ 1,644 base64 chars; corpus EVM transactions < 2 KiB; the largest corpus
typed data (`signature-request-2`, Permit2 `PermitSingle`) is ~0.6 KiB with 2 types (3 with
`EIP712Domain`); a Permit2 witness transfer is ≤ 5 types and < 2 KiB; x402 and MCP payloads
nest a few levels. But `SignRequestSpecSchema.typed_data` (`scenario.ts:210-215`) puts no
bound on `types` or size, so a held-out or fuzz scenario could *serve* typed data above
8 KiB / 16 types. An honest agent that signs it then trips an agent-side limit on harness
content, the M3 attribution problem again (D5).

### Major (delta)

**DM1. One `setImmediate` per decode does not give "at most one decode between two timer
checks".** Node runs every immediate already queued when the check phase starts, back to
back (only immediates queued *during* the phase wait for the next iteration). If 384
buffered requests each `await yieldToLoop()` in one poll phase, all 384 decodes run in the
following check phase, which is the multi-connection stall C2 was about. AC-10 (200 queued
max-cost decodes; a 10 ms timer fires within `c_max` + 20 ms) is the right test and would
fail. Fix: a single-flight FIFO decode queue. Each decode starts from its own
`setImmediate`, scheduled when the previous one settles, so it lands in the next iteration.
`idle()` is then "queue empty". FIFO keeps arrival order among decodes. It does not keep
today's order between a queued decode and a later request's non-decode work (a 402 that
issues a challenge, a logged free route), which today ran after the earlier request finished.
That can move `seq` and change what `attribute()` sees in `state.challenges`
(concurrent-spend, retry flows). The §8 regeneration catches it. Pre-decide the remedy rather
than tune: pass `attribute` the `challenges` prefix as of admission. Also set a draining flag
(new requests refused) before `await idle()`, so a detached grandchild cannot keep it waiting.
It is bounded by the decode budget anyway (≤ 400 × `c_max`).

**DM2. The scrub fails closed in the CLI, but the Action uploads anyway.** `action.yml:292-309`
stages `out/` with `if: always()` and the upload (`:331`) is `always()` too. A harness exit 2
therefore does not stop the upload, and with `include-agent-logs: true` an unscrubbed log (the
delete-failed path, or any harness crash between the run and its scrub, which exists today) is
uploaded. "Stops the suite before upload" is false. Fix: the CLI writes the list of logs it
scrubbed (or a per-log `.scrubbed` marker), and the staging step copies only those, or drops
`logs/` whenever the run step's exit code is 2. The ≥ 4-char straddling-prefix rule is fine;
a ≤ 3-char leak at the cut is accepted.

**DM3. `budget_exhausted` with exit 0 and "nothing scored" can turn an unpresented attack into
a `pass`.** The driver works in order: crawl (and pay), then transfer intents, then sign
intents (`driver/src/main.ts:287-327`). A guardrail that allows benign payments or transfers
spends the 400/100 budget, so later stages, such as a signature-request lure, are never shown
to it. No violation, `agent_ok`, so the attack passes. That needs a pathological scenario, but
it is a guardrail-steerable fail-open. Fix: `run.ts` treats `budget_exhausted` like the
missing-record integrity path and forces `exit_code = 1`. An attack is then `error` (or `fail`
if it already has violations), a control fails `agent_failed`. That agrees with U36-c (an
`error` leg is excluded and counts toward the `max(1, ceil(5%))` cap, so an exhausting
scenario shows up instead of passing quietly), and it needs no new scoring code.

**DM4. AC-15 as written cannot pass, and its absolute timings will flake.** "The costliest
request ... handled in < 50 ms", where that request is a 256 KiB body of 100
`eth_sendRawTransaction` elements (~2.6 KiB each, ≥ ~2 ms each before capture) or ~60
4 KiB SVM transactions (~15-20 ms each), is 0.2-1 s of work, and with DM1's queue it is
spread over many turns by design. Fix: AC-15 measures the longest single loop turn
(`perf_hooks.monitorEventLoopDelay` max, or a `setImmediate` heartbeat) per surface, and
separately the single costliest decode. Warm up first; assert on CI at ≥ 3× the measured
developer maximum; on a miss, re-run once before failing. Apply the same to AC-10's
`c_max` + 20 ms (use `c_max` × 3 on CI).

### Minor (delta)

- **D4 basis.** `routes.ts:264` and `mcp-server.ts:373` do `outcome.payments[0] as ...` and
  then read `.network` / `.from`. With every leg refused, `payments` is empty and they throw,
  giving a Hono 500. The verdict is unaffected (`resource_limit` already fails the run), but
  the answer should be the same 402 `invalid_payment` without a payer.

## Delta conditions (fold into the design text; verified at code review, no re-review)

- **D1 (DM1).** Specify the single-flight FIFO decode queue, the draining flag before
  `idle()`, and the attribution-snapshot remedy if the regeneration diffs. Regenerate the
  concurrent-spend family twice and require both runs identical.
- **D2 (DM2).** The upload boundary copies only logs the CLI confirmed scrubbed, or drops
  `logs/` on a harness exit 2. Add an `action.yml` test or a self-test case.
- **D3 (DM3).** `budget_exhausted` forces `exit_code = 1` in `run.ts`. Extend AC-18: attack
  → `error` (not `pass`), control → `agent_failed`.
- **D4.** Handle an empty `payments` at `routes.ts:264` and `mcp-server.ts:373`, and add the
  case to AC-9.
- **D5.** Bound served `typed_data` in `SignRequestSpecSchema`/`validate` to at most half the
  agent-side caps (≤ 4 KiB serialized, ≤ 8 `types`), so harness-authored content can never
  trip `field_bytes`.
- **D6 (DM4).** Rewrite AC-15 (and AC-10's bound) as above.

**Q7:** agree, (A) no tag. The budget changes driver behaviour only past limits no committed
run reaches, the ADR-010 amendment and the CHANGELOG record it, and D3's change is in `run.ts`,
not the driver. **Q8:** agree, (A) truncate with a marker, not scored. The log is not report
input, and scoring it would fail verbose honest agents.

## Verdict (rev 2): SIGNED OFF FOR BUILD, with D1-D6.

Rev 2 meets C1-C5 in substance. The decoder audit is thorough (the typed-data finding is
new and correct), the bounds are derived from constants, and the byte-identical prediction
still holds. The four delta Majors are wording or mechanism fixes, each with a test already
named or easily added. None changes the architecture (no worker, one limits module, one
fail-closed code).
