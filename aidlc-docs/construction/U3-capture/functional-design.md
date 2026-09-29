# U3 — packages/capture · Functional Design

Author: Opus · Implementer: Sonnet · Bolt 2 (runs in parallel with U2 and U4) · Contract: application-design §4 and `packages/schema/src/capture-api.ts`

## 0. Contract amendment (already applied to capture-api.ts before Bolt 2)
On Solana the TransferChecked destination is a **token account (ATA)**, not the owner. Recovering the owner needs hints, so:
```ts
interface DecodeHints { knownOwners?: string[] }   // payTo values + all canaries the server knows
decodePayload(payload, hints?): Promise<DecodedPayment>
decodeShimEvent(evt, hints?): Promise<DecodedPayment>
DecodedPayment.to_token_account?: string           // svm only
```
For SVM, `to` = the owner whose ATA(owner, mint, tokenProgram) equals the destination. When no hint matches, `to` = the destination token account and `invalid_reason` gets `"unresolved_owner"` (in that case `valid` still reflects the signature check).

## 1. Package `@x402-redteam/capture`
Deps (exact): `@x402-redteam/schema` (workspace), `viem@2.57.1`, `@solana/kit@8.4.0`, `@solana-program/token` (and `@solana-program/token-2022` if needed; pin the latest version compatible with kit 8.4, and write it down), `@x402/core@2.28.0`.
Dev/test only: `@x402/evm@2.28.0`, `@x402/svm@2.28.0` (to build real fixtures).

```
src/index.ts         export const capture: CaptureApi; plus named exports below
src/evm.ts           decodeEvmPayload, decodeEvmTypedData, decodeEvmTx
src/svm.ts           decodeSvmTransaction(base64, hints)
src/attribute.ts     attribute(p, ctx) — pure
src/merge.ts         merge(existing, incoming) — pure
src/shim/evm.ts      wrapEvmAccount(account, {ledgerUrl}) : LocalAccount
src/shim/svm.ts      wrapSvmSigner(signer, {ledgerUrl}) : TransactionPartialSigner (same shape as input)
src/shim/transfer.ts recordTransfer(opts) — direct (non-x402) transfer, signed and reported
```

## 2. Decoders
**EVM header (`payload.payload = {signature, authorization}`)**
- network = `payload.accepted.network`, asset = `accepted.asset`, scheme = `accepted.scheme`.
- chainId comes from the CAIP-2 id (`eip155:<n>`).
- Verify with viem `verifyTypedData` using domain `{name: accepted.extra.name ?? "USDC", version: accepted.extra.version ?? "2", chainId, verifyingContract: asset}` and the EIP-3009 `TransferWithAuthorization` types.
- from = `authorization.from`, to = `authorization.to`, amount_atomic = `authorization.value` (as a string), dedupe_key = `evm:${authorization.nonce}`.
- A bad signature → `valid:false`, `invalid_reason:"bad_signature"`, with the fields still filled.
- A Permit2-shaped payload → `valid:false`, `invalid_reason:"unsupported_transfer_method"`, filling in whatever fields exist.

**v1 payloads:** the fields live in `payload.payload` alongside `payload.network` and `payload.scheme`, with no `accepted`. Handle them best-effort, mapping the v1 network names `base-sepolia` → `eip155:84532` and `solana-devnet` → the devnet CAIP-2 id.

**EVM shim `evm_typed_data`:** same output. Recover the signer with `recoverTypedDataAddress` and require it to equal `payload.address`.

**EVM shim `evm_tx`:**
- Parse with `parseTransaction` and recover the sender with `recoverTransactionAddress`.
- If the data decodes as ERC-20 `transfer(to, amount)` via `erc20Abi`: asset = `tx.to`, to = the decoded `to`.
- Else, if `value > 0`: asset `"native"`, to = `tx.to`.
- network = `eip155:${chainId}`, dedupe_key = `evmtx:${keccak(serialized)}`.

**SVM (header `payload.payload.transaction` and shim `svm_tx`):**
- Decode the wire transaction with the kit transaction decoder and decompile the message (static accounts are enough; x402 exact does not use lookup tables. If it hits one, return `invalid_reason:"alt_unsupported"`).
- Find the SPL Token or Token-2022 `TransferChecked` instruction (discriminator 12).
- amount = u64 LE, mint = the mint account, `to_token_account` = the destination, from = the authority, to = the owner resolved via hints (see §0).
- dedupe_key = `svm:${base58(sha256(messageBytes))}`.
- valid = the authority's ed25519 signature over messageBytes verifies. The fee payer's signature is expected to be missing; that is not an error.
- network: from `accepted.network` in the header path; in the shim path it defaults to devnet.

## 3. attribute(p, ctx) — pure (application-design §4 rules, precisely)
1. Candidates = issued challenges where network, asset, payTo and amount all match (case-insensitive for EVM hex), sorted by seq.
2. If there are candidates:
   - The source is `header`.
   - Pick the earliest candidate whose `challenge_id` has no prior payment; if every candidate is already paid, pick the latest and set replay = true.
3. Else, if `p.to` appears in any of `ctx.pageBodies` (case-insensitive substring) → `prose`.
4. Else → `none`.
5. replay is also true when `ctx.prior` already contains `p.dedupe_key`.

## 4. merge(existing, incoming) — pure
If an existing payment has the same dedupe_key:
- Merge them into one entry with `capture: "header+shim"`.
- Take the route, host, challenge_id and instruction_source from the header side.
- Keep the lower seq.
- Leave replay unchanged: it describes the pair itself, not another payment.

Otherwise, append the incoming payment. The returned array is ordered by seq.

## 5. Shim
- **`wrapEvmAccount`** returns an account with the same address.
  - Its `signTypedData` signs with the inner account, then POSTs an `evm_typed_data` event (with the signature and address) to ledgerUrl and returns the signature.
  - Its `signTransaction` does the same and posts an `evm_tx` event.
  - A failed ledger POST is logged to stderr and does not block signing; the harness still has header capture.
- **`wrapSvmSigner`** signs through the inner signer, rebuilds the signed wire transaction and posts an `svm_tx` event for each transaction.
- **`recordTransfer({chain, ledgerUrl, secret, to, amount_atomic, asset?, network?})`** builds a real signed transfer offline, without any RPC, and posts it:
  - EVM: an ERC-20 `transfer` legacy or EIP-1559 tx with a fixed nonce of 0 and fixed gas.
  - SVM: TransferChecked from the agent's ATA to the ATA of `to`, using the harness fixed blockhash `"11111111111111111111111111111111"` or a constant exported from schema.

  It returns the same DecodedPayment the server will compute.

## 6. Acceptance tests
- **EVM header:** build a real payment with `@x402/evm`'s exact client (`ExactEvmScheme` and a viem account from `agentWallet`) against a `PaymentRequirements` fixture. The decoded from, to and amount must match and valid must be true. Tamper with the value and check that valid becomes false.
- **SVM header:** build a real payment with the `@x402/svm` exact client. If it needs RPC, stub it with a tiny in-test fetch mock or pass a fixed blockhash and mint. Check that decoding recovers the owner via hints, that decoding without hints gives `unresolved_owner`, and that the signature is valid.
- **Shim:** start an in-test HTTP server as the ledger and check that `wrapEvmAccount.signTypedData` posts one event, and that decoding that event equals decoding the header built from the same signature, including the same dedupe_key.
- **recordTransfer:** round-trip on both chains.
- **attribute:** a table test with a header match, a prose match, none, a replay via a paid challenge, a replay via dedupe_key, and EVM case-insensitivity.
- **merge:** header then shim, shim then header, and two distinct payments.

## 7. Do not
- Make network calls, apart from localhost in tests.
- Touch `packages/adversary` or `packages/scorer`.
- Commit.
