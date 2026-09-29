# U2 — packages/adversary · Functional Design

Author: Opus · Implementer: Sonnet · Bolt 2 (parallel with U3 and U4) · Contract: application-design §5, plus §4 for the ledger

## 1. Package `@x402-redteam/adversary`
Deps (exact): `@x402-redteam/schema` (workspace), `hono@4.13.11`, `@hono/node-server@2.1.3`, `@x402/core@2.28.0`, `@solana/kit@8.4.0`, `@solana-program/token` (version aligned with capture).
Dev/test: `@x402/fetch@2.28.0`, `@x402/evm@2.28.0`, `@x402/svm@2.28.0`, `viem@2.57.1`.

**Capture is injected.** U3 is being built in parallel, so:
```ts
createAdversary(opts: { seed: string; port?: number; capture: CaptureApi; host?: "127.0.0.1" })
```
Tests use `test/stub-capture.ts`, a minimal CaptureApi:
- It reads `payload.accepted` plus `payload.payload.authorization` for EVM, and for SVM sets to = `accepted.payTo`.
- Its attribution matches on payTo and amount.
- Its merge appends.

At Gate G2, Opus swaps the stub for the real `capture` and reruns your integration tests. Write the tests so that swap is a one-line change: export a `makeCapture()` from a test helper.

## 2. Files
```
src/index.ts            createAdversary
src/state.ts            RunState: scenario, chain, run_id, seq counter, requests[], challenges[], payments[], pageBodies[], paidChallenges, deliveredFlag, per-route counters
src/render.ts           builds RenderContext for (scenario, chain, baseUrl, seed) → renders routes once at load()
src/routes.ts           scenario route handler (virtual hosts, redirect, page, paywall + behaviours)
src/challenge.ts        buildRequirements(spec, chainDefaults, ctx) → PaymentRequirements; buildPaymentRequired(url, desc, reqs) ; encode via @x402/core/http
src/facilitator.ts      /facilitator/{supported,verify,settle}
src/solana-rpc.ts       /solana-rpc JSON-RPC mock
src/ledger-endpoint.ts  /__harness/ledger, /__harness/health
test/…
```

## 3. Behaviour details
**Route resolution**
- `/_host/:host/<rest>` → (host, `/<rest>`); anything else → (`provider.test`, path). Match on method and exact path.
- Log every request, including 404s, as a `RequestLog`.

**Pages**
- A page returns 200 with `content_type` and the rendered page.
- Push every page body the server sends into `pageBodies`, and delivered bodies too.
- A redirect returns 302 with the rendered `Location`.

**Challenge**
Build `PaymentRequirements` from the scenario:
- `scheme` defaults to `exact`, `network` to the chain default, `amount` to `amount_atomic ?? usdToAtomic(amount_usd, 6)`, `asset` to the chain USDC, `payTo` to the rendered `pay_to`, and `maxTimeoutSeconds` to 60.
- `extra` = the chain default extra merged with `spec.extra`.
- On SVM, `extra.feePayer` = the canary `facilitator` address (scope `"harness"`).

Build `PaymentRequired{x402Version:2, resource:{url: absolute request URL, description, mimeType}, accepts:[req]}` and send it:
- as a 402 with the `PAYMENT-REQUIRED` header (use the `@x402/core/http` encode helper), and
- with JSON body `{x402Version:2, error:"payment_required", accepts:[req]}` for v1-style clients.

Record an `IssuedChallenge` with `challenge_id = ${route_key}#${n}`.

**Incoming payment**
- Read `PAYMENT-SIGNATURE`, falling back to `X-PAYMENT`, and decode it with `@x402/core/http`'s `decodePaymentSignatureHeader`.
- Call `capture.decodePayload(payload, {knownOwners})`, where knownOwners = every rendered payTo plus the canaries referenced by the scenario.
- `attribute` it, build the Payment (seq, route_key, host, capture `"header"`), `merge` it, then apply the route behaviour:
  - `normal`: 200 with `delivered_body ?? page ?? "ok"`, a `PAYMENT-RESPONSE` header (encoded `{success:true, transaction:<fake>, network, payer:from}`), and delivered = true.
  - `402_forever`: a new 402 (new challenge_id, identical requirements) on every paid attempt.
  - `no_delivery`: 200 with an empty body and a success `PAYMENT-RESPONSE`; delivered stays false.
  - `replay`: the first paid request behaves like `normal`. Every later request, paid or unpaid, gets a 402 whose challenge is **byte-identical** to the first one. It is still recorded as a new IssuedChallenge whose `requirements` equal the first.
- A malformed header gives 400 `{error:"invalid_payment"}`, and the request is logged with paid=false.

**Fake transaction hashes** are deterministic: evm `0x` + keccak(`${run_id}:${seq}`), svm base58(sha256(same)).

**Facilitator**
- `/supported` → `{kinds:[{x402Version:2, scheme:"exact", network}], extensions:[], signers:{…}}`, listing every network used by the loaded challenges plus both test networks.
- `/verify` → decode, record a Payment (capture "header", route_key `facilitator`), then respond `{isValid: valid, invalidReason?, payer}`.
- `/settle` → `{success:true, transaction:fakeHash, network, payer}`.

**Solana RPC mock**
Implement every method the real `@x402/svm@2.28.0` exact client calls when it creates a payment. Find them by running the real client against the mock in a test and logging unknown methods. Expect at least:
- `getLatestBlockhash`: a fixed blockhash constant, with lastValidBlockHeight 1000.
- `getAccountInfo` for the USDC mint: a valid 82-byte SPL mint layout, decimals 6, initialized, owner = the Token program, base64 encoded. For any other account, return null.
- `getSlot`: 1.
- `getMinimumBalanceForRentExemption`: a constant.
- `simulateTransaction`: `{err:null, logs:[], unitsConsumed:1000}`.
- `sendTransaction`: a JSON-RPC error `-32000 "x402-redteam: broadcasting disabled"`.

Log every call, including unknown ones.

**Ledger endpoint**
- POST a `ShimEvent` → `capture.decodeShimEvent(evt, hints)` → attribute → Payment (capture "shim") → merge → `{ok:true, payment_id}`.
- If no run is loaded → 409.

**API**
- `load({scenario, chain, run_id})` resets the state and renders the routes.
- `drain()` returns `{run_id, scenario_id, chain, requests, challenges, payments, delivered}` sorted by seq.
- `close()` stops the server.

The server binds only to 127.0.0.1, uses an ephemeral port when none is given, and emits no wall-clock values into state.

## 4. Acceptance tests (integration, offline)
Use a hand-written scenario fixture with one free page, one paywalled route per behaviour, a redirect and a virtual host. On **both** chains:
1. The real `wrapFetchWithPayment(fetch, client)` with `registerExactEvmScheme` or `registerExactSvmScheme` (signer from `agentWallet`, SVM rpcUrl = `${baseUrl}/solana-rpc`) pays the `normal` route. Expect a 200 with the delivered body, 1 challenge, 1 payment with source `header`, and delivered = true.
2. `402_forever`: the client ends with a 402, and there are ≥ 1 payments and ≥ 2 challenges.
3. `no_delivery`: delivered = false.
4. `replay`: after the first paid GET, a second plain GET gets a 402 with identical requirements, and paying again gives replay = true.
5. A request under `/_host/evil.test/...` is logged with host `evil.test`.
6. `/facilitator/supported`, `/verify` and `/settle` return the expected shapes.
7. An unknown RPC method returns a JSON-RPC error and is logged.
8. Two identical load-run-drain sequences give deep-equal drains (determinism).

## 5. Do not
- Import from `packages/capture` (inject it instead).
- Call out to the network.
- Commit.
