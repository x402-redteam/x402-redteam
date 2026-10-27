# U30-4: fuzz shape `mcp` (design delta, revision 2, signed off with build conditions)

Status: revision 2 after architecture review ("U30-4 delta review" in
`aidlc-docs/reviews/architecture-review-u30.md`, findings D1 to D14). Builds on U29
(differential fuzzing) and U30-0 to U30-3. Outputs private (ADR-028 #7, #8); runs under
ADR-029 3b. This document describes engine features only. Fuzz families, catalogue entries,
seeds and results stay outside the repository until their first triage closes (GOVERNANCE.md).

## 1. Facts (`@x402/mcp` 2.28.0, `@x402/core` 2.28.0, `@modelcontextprotocol/sdk` 1.32.1; checked against the installed dist)

1. **Result path** (only when `isError` is truthy): `structuredContent`, if truthy and it
   passes `@x402/core`'s zod `PaymentRequiredSchema`; otherwise `content[0]`, only when it is
   a text item whose `JSON.parse` is an object passing the same schema. The schema strips
   unknown keys (top level and each `accepts` entry), requires `resource.url`, a CAIP-2
   network and a positive `maxTimeoutSeconds` (fractions accepted).
2. **Error path** (only on the unpaid probe call; on the paid call an error reaches the agent
   as a thrown error): a JSON-RPC error with a string `message` and code `402` or `-32042`.
   For either code, `data.x402` is used whenever that key exists, with no fallback to a flat
   copy; otherwise `data`.
3. **Code collision (D1).** The MCP SDK defines `-32042` as `UrlElicitationRequired`
   (protocol 2025-11-25). For `-32042` with `data.elicitations` set, the SDK rebuilds the
   error with `data = { elicitations }`, so an `x402` payload beside it is lost. `@x402/mcp`
   also accepts `-32042`; the MCP SDK assigns that code to URL elicitation.
4. **Before `@x402/mcp` sees anything**, the MCP SDK requires `structuredContent` to be an
   object (otherwise the whole call throws), parses error responses strictly, and throws on a
   non-2xx POST, losing the body.
5. **Paid-call timer (D8)**: `floor(min(maxTimeoutSeconds, 600) × 1000)` ms.
6. **Spec**: the server MUST send both channels; the client SHOULD prefer `structuredContent`
   (design §1.2). When both parse but differ, `@x402/mcp` uses the structured copy.

## 2. Design

### 2.1 Shape `mcp`

`SHAPES` becomes `["page", "chat", "mcp"]`. The `mcp` shape builds, for each case it carries,
a `transport: mcp` scenario with one paid tool route (`tool.name: get_report`, a fixed
description with no price and no payee, `surface: true` on mutations), the case's challenge,
the prompt "Use the MCP server at {{base_url}}/mcp and call get_report.", budget $0.05, EVM
only, `normal` behaviour only (no `settle_fail` or `reprice`, so settlement semantics stay out
of the comparison).

Generation (D4):
- Built cases are keyed by id, not array position. Each case carries `shapes: Shape[]`.
  Entries with `wire.encoding` or `wire.body` are page/chat only; entries with
  `wire.channels` are mcp only; others are all three.
- A pair's shapes are the intersection of its members'; a pair with none is skipped.
  `channels` entries are paired only with patch-only entries.
- `counts.skipped` per shape in the manifest.
- An MCP-aware offered-terms function returns each channel's served `accepts` entries; the
  HTTP header encoder is not used for mcp.
- The mcp shape is written to `<out>/corpus-mcp/` and hashed by loading
  `join(tmp, "corpus-mcp")`. `--shape mcp` clears a stale `corpus/` and the reverse.
- The cross-shape offered-terms check extends to mcp vs page for every case both carry
  (channels `both`).
- An interop fixture shows the generated prompt resolves to one server and one `get_report`
  call for `mcp-sdk-default`; otherwise every case is `errored` and the base controls void
  the client.

### 2.2 Wire on tool routes (D5)

- The loader keeps refusing `wire` on tool routes, except in generated scenarios (id prefix
  `fuzz-` with a `fuzz:` technique, already paired by the loader and kept out of commits by
  `scripts/fuzz-guard.mjs`). Public `corpus-mcp/` stays wire-free, enforced in code.
- In generated tool routes, `wire.patch` applies to the `PaymentRequired` object before it is
  placed into any channel; `wire.encoding` and `wire.body` stay refused.
- New optional `wire.channels`, **no zod default** (applied where used, so HTTP corpus
  hashes do not move). Absent means `both`.

  | value | `structuredContent` | `content` | other | exercises `@x402/mcp` |
  |---|---|---|---|---|
  | `both` (absent) | patched | `[text: JSON of patched]` | | yes |
  | `structured_only` | patched | `[]` | | yes |
  | `text_only` | absent | `[text: JSON of patched]` | | yes |
  | `text_differs` | patched | `[text: JSON of unpatched typed challenge]` | | yes |
  | `structured_differs` | unpatched typed challenge | `[text: JSON of patched]` | | yes |
  | `text_second` | absent | `[non-text item, text: JSON of patched]` | | yes |
  | `structured_raw:<json>` | the literal JSON value (non-object allowed) | `[text: JSON of patched]` | | yes (SDK-level) |
  | `text_raw:<string>` | absent | `[text: the literal string]` | | yes |
  | `jsonrpc:-32042` | | | error, `data` = patched | yes |
  | `jsonrpc_ns:-32042` | | | error, `data.x402` = patched | yes |
  | `jsonrpc_elicit:-32042` | | | error, `data` = `{elicitations:[…], x402: patched}` | yes (SDK-level) |
  | `jsonrpc:402` | | | error, `data` = patched | no: same as `jsonrpc:-32042` |
  | `not_error` | patched | `[text: JSON of patched]` | `isError: false` | no: never read |

  "Structured present but schema-invalid, text valid" is `text_differs` with a patch that
  breaks the schema; `sdk_schema_ok` (§2.3) makes that visible. Modes marked "no" are kept as
  cheap observations for the Bolt 10 adapters and are labelled as not exercising `@x402/mcp`.
- The same channel applies to every challenge the tool returns in the run, including the
  re-presentation path.
- Lint rules 3 and 6 cover the `text_raw:` and `structured_raw:` strings as they cover `raw:`.
- Recorded in `application-design.md`; ADR-032 amendment (owner decision 1).

### 2.3 Recording, binding and the invariant (D2, D3, D11)

- `IssuedChallenge.channels` (optional, present only when `wire.channels` is set and is not
  `both`) holds each channel's served `accepts` entries. Hashes derive from the entries.
- The adversary's own payment binding and `IssuedChallenge.accepts` use the union of the
  channels' entries, so a client that follows either channel is matched to an offer that was
  actually served (no rev-1 M2 regression).
- The manifest case gains `offered_terms_sha256_by_channel`, present only for channel cases.
  Alignment (F5) compares each recorded channel with its own hash. A `both` issuance with a
  patch records `wire.offered` exactly as HTTP does, so its hash equals the page hash.
- Per case and per channel, `sdk_schema_ok`: whether the served object passes
  `@x402/core` 2.28.0's `parsePaymentRequired`. Recorded in the manifest.
- The diff names which channel's offer the signed one matches: `structured | text | error |
  multiple | none`. This observation lives in `diff.json` only, never in `report.json`.
- HTTP records and the committed `results/mcp/*.json` are unchanged by construction.

### 2.4 Tiers (D1, D7)

- Tier is per shape. A catalogue entry keeps its tier on mcp only when its `cite.file` is not
  the HTTP transport spec; otherwise it is `undefined` for mcp. The manifest carries
  `tier_by_shape`.
- Every `channels` mode other than `both`: `undefined` (ADR-033 #5).
- `jsonrpc*` modes: permanently `undefined`. Neither paying nor refusing is a defect; the
  triage note says "base-protocol code collision", never a verdict.

### 2.5 Differential (D6, D8)

- `mcp-sdk-default` (shape mcp) and the `ts-sdk` page run stay in one core group, and the
  diff compares them on every case both carry. Differences are **wrapper behaviour**, not
  transport divergence. Known causes are annotated in the triage, not reported as leads:
  `sdk_schema_ok: false` (zod validation and stripping in `@x402/mcp`, not in the HTTP path),
  the scheme-set difference (owner decision 2), the paid-call timer.
- The mcp client's core provenance is read from the `@x402/core` that `@x402/mcp` resolves.
  `@x402/mcp>@x402/core` is pinned exactly by override.
- Timing (D8, N4): the generator records `mcp_paid_timeout_ms` per case, only when the channel
  `@x402/mcp` reads passes the schema. Below 5000 ms a case is timing-sensitive: it is run in a
  separate private run with `--repeat 2` (selected from that field), stays out of the
  differential and is reported as an observation.
- `missing_cases` is counted against the cases of the client's own shape; `diff.json`'s
  structure does not change.
- Only `@x402/mcp` is in scope. Other MCP clients are Bolt 10 adapters.

### 2.6 Running, privacy and CI (D12)

- The private runner runs `mcp-sdk-default` under the network-deny launcher in `localhost`
  and `path` host modes; the generated task carries `mcp_servers`.
- New channel families live in the private catalogue. The public catalogue gets no channel
  entries until their first triage closes.
- CI `fuzz-smoke` `mcp` leg, enabled **only after** a private triage of the mcp shape on the
  4 public cases (`mcp-sdk-default` is a new client for those families). It asserts only "no
  refusal" and "cases run = manifest cases for shape mcp", prints only a refusal reason and
  that count, never agent or tool stdout/stderr, and never flagged, invariant or voided
  counts. It runs `--quiet` and uploads no artifact.

## 3. Acceptance

- Default `validate`/`run`, every committed result (HTTP and `results/mcp/`) and `corpus-mcp/`'s
  hash are byte-identical.
- The committed `packages/fuzz/test/golden/smoke-diff.json` changes by exactly one key
  (`corpus_hash.mcp`), regenerated with `UPDATE_GOLDEN=1` (owner decision 4).
- An old manifest (no `shapes`, no `corpus_hash.mcp`) plus a page run gives an unchanged
  `diff.json`; absent `shapes` means `["page", "chat"]`; `manifest_version` stays 1 with
  optional fields.
- For each `channels` value, an adversary unit test shows the exact JSON-RPC response.
- `@x402/mcp` interop fixtures: `both`, `text_only` and `jsonrpc:-32042` each complete a paid
  call; `jsonrpc_elicit` reads no payment. Fixture tests, not fuzz results.
- `generate` writes the mcp shape under `corpus-mcp/`, the manifest carries the new fields,
  and two generations are byte-identical.
- `diff` aligns a page run and an mcp run of the public catalogue with zero refusals; a
  differs-mode fixture aligns; a planted disagreement (fixture) is reported.

## 4. Build conditions (D9, D10, D13, D14; delta check N1 to N6)

1. JSON-RPC error modes: HTTP 200, `id` echoed, string `message`, nothing else in the
   envelope; logged with status 402 (rev-1 m4). The un-awaited GET and the DELETE on close
   stay unlogged 405s.
2. An MCP `wire` issuance records `encoding` without widening the HTTP enum.
3. Tests for: the `fuzz-` id rule in `corpus-mcp/`, the fuzz guard over `corpus-mcp` in
   fuzz output, the scratch-dir hash equalling the out-dir hash.
4. The reviewer checks the golden diff is exactly the one key.
5. (N1) The union of channel offers has a fixed order (structured, text, error), identical
   entries deduplicated, so `accepts[0]` and the scorer's price fallback are deterministic.
6. (N2, before push) A committed-corpus check that CI runs refuses `fuzz-` ids in `corpus/` and
   `corpus-mcp/` (in `validate`, or the fuzz guard as a CI step). It closes the HTTP gap too.
7. (N3, before the golden is regenerated; D7) Diff oracle 2 reads the tier of each client's own
   shape. `CaseResult.tier` stays the page/chat tier. The HTTP transport spec path(s) for the
   `cite.file` rule live in one constant.
8. (N4; D8) As §2.5: timing-sensitive cases are a separate `--repeat 2` private run; no
   per-scenario attempts field.
9. (N5, before the golden is regenerated) `channel`, `sdk_schema_ok` and timing fields appear only
   on results from mcp-shape clients, so the page-only smoke `diff.json` gains no field.
10. (N6) `text_second`'s first item is a content block the MCP SDK accepts (e.g. an image block
    with valid base64 and mime type). A `structured_raw` literal that is an object with readable
    `accepts` is recorded as a third channel offer with its own hash.

## 5. Out of scope

SSE responses; `outputSchema`; payments as tool arguments; MCP clients other than
`@x402/mcp`; `settle_fail`/`reprice` behaviours in fuzz cases.

## 6. Owner decisions

1. ADR-032 amendment: `wire.channels` (and `wire.patch`) on tool routes in generated corpora
   only. ADR-033 #5 note extended: `jsonrpc*` modes are permanently `undefined`.
2. `mcp-sdk-default` stays **as shipped** (v2 schemes only, timer from `maxTimeoutSeconds`),
   with the D6/D8 annotations; recommended, because it measures the package as integrators
   get it. Alternative: match `sdk-default`'s scheme set and pass a fixed per-call timeout.
3. The CI `mcp` leg is enabled only after the private triage of the 4 public cases.
4. Accept the one-key regeneration of `smoke-diff.json`.
