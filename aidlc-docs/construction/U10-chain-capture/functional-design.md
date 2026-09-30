# U10 — Chain-boundary capture (mock EVM RPC, Solana sendTransaction) · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 5 · Contract: application-design §4, §5, §8 "(v2, Bolt 5)", ADR-013
Starts after U9 Part A merges. Runs in parallel with U9 Part B and U11.

## 1. Goal
A direct (non-x402) transfer is recorded as a Payment when the agent submits it to the harness's chain RPC, **whether or not** the agent uses the TypeScript shim. This removes the self-reporting dependency behind prose_payment (Review 1, B4).

## 2. Files (U10 owns these in Bolt 5)
```
packages/adversary/src/record.ts        NEW  recordDecoded(state, rendered, capture, decoded, {capture, host?, route_key?}) -> Payment
                                             (the common payment-recording block, factored out of ledger-endpoint.ts;
                                             uses schema amountUsd(chain, asset, atomic, scenario.assets) and sets asset_known)
packages/adversary/src/ledger-endpoint.ts    switch to recordDecoded (behaviour unchanged apart from asset-aware USD)
packages/adversary/src/evm-rpc.ts       NEW  POST /evm-rpc per application-design §5 v2
packages/adversary/src/solana-rpc.ts         sendTransaction decode+record, getSignatureStatuses, getBalance, getTokenAccountBalance,
                                             getAccountInfo mint decimals from assetInfo (scenario.assets aware)
packages/adversary/src/state.ts              + evmTxCountByAddress, seenEvmTx (hash -> receipt data), seenSvmSigs
packages/adversary/src/index.ts              register evm-rpc routes
packages/capture/src/evm.ts                  decodeEvmTx: also decode ERC-20 transferFrom and USDC transferWithAuthorization calldata
                                             (a direct submission of an EIP-3009 auth); EIP-3009 typed data sets authorization_seconds
                                             = validBefore - validAfter
packages/capture/src/merge.ts                label = sorted union of layers ("header+shim", "rpc+shim")
packages/capture/test/*, packages/adversary/test/evm-rpc.test.ts, solana-rpc tests
examples/agents/src/lib/transfer.ts     NEW  sendDirectTransfer(task, {to, amountUsd}) -> tx id: evm = viem walletClient (http transport
                                             = task.evm_rpc_url) ERC-20 transfer of chain USDC; svm = @solana/kit TransferChecked from the
                                             wallet ATA, sendTransaction to task.solana_rpc_url
examples/agents/src/lib/wallet.ts            buildClient({noShim}) option; walletSigner(task, {noShim}) helper used by transfer.ts
examples/agents/src/naive.ts                 prose transfer via sendDirectTransfer (not recordTransfer); honours NAIVE_NO_SHIM=1
packages/cli/test/rpc-capture.e2e.test.ts NEW
```
`packages/capture/src/shim/transfer.ts` (`recordTransfer`) stays exported for shim users. Only naive stops using it.

## 3. EVM RPC details
- Chain id comes from the loaded run's task network (`eip155:84532` → `0x14a34`).
- Fixed block: number `0x1000`, timestamp `0x66000000`, `baseFeePerGas 0x3b9aca00`. No wall clock anywhere.
- `eth_estimateGas` → `0x186a0`. `eth_gasPrice` → `0x3b9aca00`. `eth_maxPriorityFeePerGas` → `0x0`.
- `eth_getTransactionCount(addr, *)` → the number of accepted `eth_sendRawTransaction` calls from `addr` in this run, so a second transfer gets the next nonce.
- `eth_call` recognises the ERC-20 selectors `balanceOf`, `decimals`, `symbol`, `name` and `allowance`, for known assets only. `balanceOf(agent)` = `wallet_balance_usd / usd_price` in atomic units. Anything else reverts (`-32000 execution reverted`), and it is logged.
- `eth_sendRawTransaction`: decode through `capture.decodeShimEvent({kind:"evm_tx", payload:{serialized}})`, run the same attribution as the ledger endpoint, and call `recordDecoded(... {capture:"rpc"})`.
  - The return value is `keccak256(serialized)`. Reject malformed input with -32602 and record nothing.
  - A resubmission of the same raw tx merges (same `dedupe_key`), so it is one payment.
- Log every RPC call to `state.requests` as `{method:"POST", host:"evm-rpc", path:<rpc method>, status, paid:false}`. The Solana RPC logs the same way, with host `"solana-rpc"`. `delivered` and `loop_count` must not be affected (RPC payments have no `route_key` → the scorer buckets them as "direct").

## 4. Solana RPC details
- `sendTransaction`: `params[0]` is the wire tx, in base64 if `params[1].encoding === "base64"`, else base58. Decode through `{kind:"svm_tx", payload:{transaction_base64}}` with `knownOwners` hints, record with `capture:"rpc"`, and return the first signature (base58).
- `simulateTransaction` stays ok. `getSignatureStatuses` → `{confirmationStatus:"finalized", err:null, slot}` for known signatures, `null` otherwise.
- `getLatestBlockhash` is unchanged (`FIXED_BLOCKHASH`).
- `getAccountInfo` for the agent's USDC ATA: return a valid token account holding the wallet balance, if the kit transfer path needs it. Verify against the real `@solana-program/token` helpers; don't guess.

## 5. Shim + RPC merge
The naive agent with its wrapped signer produces an `evm_tx` shim event *and* an RPC submission of the same serialized tx. Both have `dedupe_key = evmtx:keccak(serialized)`, so they must merge into **one** Payment, `capture:"rpc+shim"`, not replay-flagged. Apply the same self-twin exclusion that `attribute.ts` already applies to header+shim. On SVM, the shim's rebuilt wire tx and the submitted tx must produce the same `dedupe_key`. If they don't, fix the SVM `dedupe_key` derivation to use the message hash, **not** a hash of the full signed bytes. Verify this; don't assume it.

## 6. Acceptance tests
- Unit: every RPC method listed, on both chains.
  - A viem `walletClient.writeContract(transfer)` against `/evm-rpc` succeeds end to end (nonce, gas, send, `waitForTransactionReceipt` terminates).
  - A kit `sendAndConfirmTransaction`-style flow against `/solana-rpc` terminates.
- Unit: `transferWithAuthorization` calldata decodes to from/to/value. `authorization_seconds` is set on EIP-3009 header payments.
- E2E (`rpc-capture.e2e.test.ts`, real `corpus/prose-payment.yaml`):
  - `NAIVE_NO_SHIM=1 tsx examples/agents/src/naive.ts` **fails** prose-payment on **both** chains, with a payment where `instruction_source:"prose"` and `capture:"rpc"`.
  - Default naive gives `capture:"rpc+shim"` (one payment per chain, not two).
  - guarded is unchanged (0 RPC payments).
- The full-corpus naive and guarded E2E behave as before. Determinism: naive twice → identical report minus timing. The tx hash is deterministic only if the signed tx is; viem signing is deterministic (RFC 6979) when nonce and gas are fixed, so assert it.
- No outbound network: the tests run with the harness RPC URLs only (no public endpoints in any config).

## 7. Do not
- Edit `packages/schema/**` (U9 Part A owns it), `packages/scorer/**` (U9), `packages/adversary/src/routes.ts`, `challenge.ts` or `render.ts` (U11), `packages/capture/src/attribute.ts` (U11), `examples/agents/src/guarded.ts` (U11), or `corpus/**`.
- Broadcast anything or add a real RPC URL anywhere.
- Add dependencies. viem, @solana/kit and the @solana-program packages are already present; if one is truly missing, stop and report.
- Commit, except the single worktree commit.
