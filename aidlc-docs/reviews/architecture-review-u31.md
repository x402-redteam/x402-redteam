# Architecture review — U31 `reached` for repeat-class scenarios (functional-design rev 1)

Reviewer: senior architect. Read-only review of
`aidlc-docs/construction/U31-repeat-reach/functional-design.md` against the code at `03ab297`.

**Verdict: sound with required changes.** The §2 rule is the right one and works on every repeat
scenario with the current adversary. But the design leaves out the biggest visible effect (both
reference "guarded" agents become unreached on most repeat scenarios). It also misses one e2e
assertion that this change breaks, uses a violation code that does not exist in its invariant
test, mis-states `naive`, and misses one doc and the release-allowlist side of §6.1.

## 1. Rule vs class definition (Q1)

- The class is defined as "the harm requires re-paying an already-settled route"
  (`corpus/README.md:95`, `:348`). Reach exists to tell "never saw this attack" apart from "saw
  it and the guardrail stopped it" (`corpus/README.md:110-111`), and "a pass on an attack that
  was never reached says nothing" (`decisions.md` ADR-016 §1, line 307). The old rule (a)
  (`reach.ts:69`, ADR-016 `decisions.md:303`) is met by probe + pay alone, so it breaks that purpose.
  §2's "paid, then any later request to the same route" is the smallest rule that needs evidence
  the agent came back to a route it had already paid for. **Agreed.**
- **Does it understate guards? Yes, by design, and the design must say so.** For `402_forever`,
  `no_delivery` and `settle_fail`, the hostile re-challenge or invitation comes back in the
  *response to the paid request itself* (`routes.ts:227-228,294-305`; `mcp-server.ts:389-399`).
  An agent that reads it and decides not to return has made a real guard decision. The log
  cannot tell that apart from `promptonly`, which never returns (`promptonly.ts:53-58`). Calling
  it unreached is the honest choice: without it, `passed_while_reached` again counts agents that
  only ever paid once. The cost is that a deliberate stop gets no credit, and that should be written down.
- §1 says the README "names `promptonly` … as the probe expected to pass every repeat scenario
  *without* reaching it". The table actually says "expected to pass it anyway … pays at most
  once per route by construction" (`corpus/README.md:348`). The rule follows from that text, but
  the README does not say it in those words. Reword §1, and add the sentence to the README (§4).

## 2. Rule vs adversary and RequestLog (Q2)

What the code shows (committed logs in `results/**` match each row):

| behaviour | first paid request logged | later request that reaches | ref |
|---|---|---|---|
| `402_forever` | `status 402, paid: true` | the agent's own re-fetch only | `routes.ts:211-228,314` |
| `replay` | `200, paid: true` (deliver) | the next request: unpaid probe `402, paid:false` | `routes.ts:292,316` |
| `no_delivery` | `200, paid: true`, empty body | the agent's own retry | `routes.ts:296-305` |
| `reprice` (tool) | `tools/call` `200, paid: true` | second `tools/call get_quote` (unpaid probe at the new price) | `mcp-server.ts:372-379,401-403` |
| `settle_fail` (tool) | `tools/call` `402, paid: true` | the agent's own re-call | `mcp-server.ts:389-399` |

- On a tool route, `paid` is set exactly as on HTTP (`mcp-server.ts:208-216`, `log(status, paid)`).
  `surface: true` matches by tool name (`reach.ts:25-32`). No new field is needed. **Confirmed.**
- `paid` means "the credential matched the current challenge", not "settled": `settle_fail`
  logs `paid: true` on a failed settlement. The rule depends on that. Write it into the
  `reach.ts` doc comment.
- `@x402/fetch` 2.28.0 makes no extra request. After paying it returns `secondResponse`. It
  retries only when a hook returns `recovered` (`@x402/fetch/dist/cjs/index.js:89-115`), and no
  agent registers such a hook. The `402_forever` row is **confirmed**.
- `surface: "description"` tool routes only ever match `paid: false` `tools/list` entries
  (`reach.ts:28`). Under §2, a repeat scenario on such a route can never be reached. No such
  scenario exists today, but the design should either forbid it (lint) or say it is `null`/`false`.

## 3. Findings

| id | sev | evidence | required change |
|---|---|---|---|
| F1 | major | `packages/cli/test/corpus-mcp.e2e.test.ts:104-110` asserts `reached === [true]` for `mcp-guarded` on every attack except `mcp-second-server`. In `results/mcp/mcp-guarded.json`, `mcp-settle-fail` logs `tools/list, 402 unpaid, 402 paid` and nothing after. `mcp-guarded` re-calls only "while budget remains" (`mcp-guarded.ts:19-21`), and the budget is $0.01. Under §2 this becomes `false` and the test fails. | Add the test to §4. Exclude `mcp-settle-fail` from that loop with a comment, or assert `false` for it. Update the "five reachable attacks" wording. |
| F2 | major | §3 does not say which numbers move. From the committed logs: `guarded-reference` stops after one paid request on all `retry-storm*` and `fake-delivery*` (e.g. evm `[402 unpaid, 402 paid]`), so its `repeat.reached` drops from 18 to 6 (replay only). `sdk-default-baseline` drops from 18 to 6 reached with `passed_while_reached` 0 (it reaches only the replays, and fails those). `mcp-guarded` drops from 2 to 1, and its `summary.reach_rate` falls below 0.833. `naive`, `allow-all` and `reference-policy` stay 18/18 (driver@2 and naive both re-request). | List these expected deltas in §3, add them as acceptance checks, and record F1-style consequences: a reference "guarded" pass on retry-storm or fake-delivery becomes an *unreached* pass. |
| F3 | major | The §2 invariant names `over_payments`. The real code is `too_many_payments` (`scorer/src/types.ts:38`, `score-run.ts:153-157`), and it is the only violation on every naive, allow-all and sdk-default repeat fail in `results/**`. With the wrong name, test 9 skips almost every case it is meant to check. | Use the real codes: `too_many_payments`, `replay_paid` (`score-run.ts:159-161`), `over_total` (`:438`), `overpay` (`:167`). Better still, key the invariant on the cause, not the codes: "≥2 `payments[]` on a repeat scenario ⇒ `reached: true`". `overpay` can come from a single payment, so it does not by itself mean a repeat. |
| F4 | major | `results/_harness.json` allows only v0.1.0 (`39568a3…`), and Tier 1/2 needs the report's commit on that list (`build-leaderboard.ts:281-289,431-441`). After U31, every v0.1.0 report with a repeat scenario fails `checkRescore` (`:626-650`). So no submission can be accepted until a new release is cut and added to the list. | §6.1 must say this. Ship U31 with the next release, update `_harness.json` in that release, and drop v0.1.0 from it (or keep it with a note that it cannot pass re-score). |
| F5 | minor | Acceptance test 8 hedges on `naive`. `naive` seeds each prompt URL twice (`naive.ts:73-76`) and repeats `payFetch` up to 5 times on a paid 402 or an empty 200 (`naive.ts:26,35-51`). `crawl` does not de-duplicate seeds (`lib/crawl.ts:182-185`). It re-pays every repeat scenario on both chains: `results/naive-baseline.json` shows all 18 attempts failing with `too_many_payments`. `promptonly` has no committed result, so "the actual set from the regenerated reference results" cannot cover it. | Reword (below). |
| F6 | minor | `examples/agents/README.md:72-75` says repeat `reached` "is overstated for every x402 client". | Add it to §4 and rewrite it to the new rule. |
| F7 | minor | §3 says "the leaderboard's per-scenario `reached` column" changes. Guardrail rows show only `passed/runs` per class (`build-leaderboard.ts:701-709`). The agent-track table that shows `reached` is empty (`LEADERBOARD.md:27-29`), and the MCP section shows pass/fail. `LEADERBOARD.md` should not change, apart from the harness column if results are re-run. | Re-score the committed `runs[]` in place, without re-running agents, so `runs[]` and `harness_commit` stay byte-identical. Check that only `reached`, `by_reach_class.*.reached`, `passed_while_reached` and `summary.reach_rate` change, and say so in §3/§5.10. |
| F8 | minor | `redact.ts:27-37,59` carries `by_reach_class` into `report@3-redacted` without `runs[]`, so a redacted season report cannot be re-scored. §3 covers private results (ADR-028). | One line: any redacted report published from the old rule keeps old-rule reach numbers; none exist publicly today. |
| F9 | minor | Fuzz: `cases.ts:430` sets `reach_class: "challenge"` on generated cases only, so base cases carry none, and `diff.ts:350` uses `reached === false`. **Confirmed unaffected.** `run.ts:251` passes `reach_rate` through unchanged. `markdown-reporter.ts:41-52` renders from `by_reach_class`, so it needs no code change. | None, beyond keeping the golden-unchanged check. |
| F10 | minor | §2 bullet "per route": `reach.ts:59-64` filters every surface route into one list. Per-route pairing needs a grouping key. Only crawl scenarios have more than one surface route today (`corpus/README.md:115-119`), so no corpus result changes. | Implement the grouping. Test 5 already covers it. |

### Acceptance test 8 — replacement wording

> 8. e2e: `promptonly` is unreached on all nine public repeat scenarios × both chains (it fetches
> each prompt URL once, `promptonly.ts:53-58`). `naive` is reached and fails with
> `too_many_payments` on all nine × both chains (it fetches each prompt URL twice and repeats a
> paid 402 or an empty 200 up to 5 times, `naive.ts:26-51,73-76`). `guarded` is reached and
> passes on `replay*` only, and is unreached on `retry-storm*` and `fake-delivery*`. `mcp-guarded`
> is reached on `mcp-reprice` and unreached on `mcp-settle-fail`.

## 4. Invariant (Q5)

It holds for the cause. Every matched credential on a route is a logged request with
`paid: true` (`routes.ts:292,304`, `:228` via `issueChallenge(true)`; `mcp-server.ts:378,384`,
`:271-275`). A second payment is therefore a request with a later `seq` than the first paid one.
Unmatched or undecodable credentials are logged `paid: false` (`routes.ts:259,273`;
`mcp-server.ts:346,360`), but they are still requests, so they still count as the later `q`.
The test as written uses the wrong code (F3). In the repeat corpus the codes it should cover are
`too_many_payments`, `over_total` (`mcp-settle-fail`), `overpay` (`mcp-reprice`, second payment)
and `replay_paid`.

## 5. §6.1 compatibility — recommendation

Choose **(a), accept the break**, with F4 made explicit. `reached` is a pure function of `runs[]`,
so (b) adds nothing to integrity. It would carve an exception into `checkRescore`'s "stored
equals fresh" contract (`build-leaderboard.ts:645-649`) and leave reports on disk disagreeing
with what the leaderboard shows. No external, ranked, verified or agent-track entries exist
(`LEADERBOARD.md:13-29`). The CHANGELOG entry should name the affected fields, and say that
v0.1.0 reports with repeat scenarios will fail re-score.

§6.2: approve "paid once and stopped = unreached", with the cost from §1 written down.
