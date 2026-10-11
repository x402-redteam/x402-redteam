import {
  assetInfo,
  CHAIN_DEFAULTS,
  NATIVE_ASSET,
  usdToAtomic,
  walletBalanceUsd,
} from "@x402-redteam/schema";
import type { Hono } from "hono";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { recordDecodedLegs } from "./record.js";
import type { Shared } from "./shared.js";
import type { RunState, SeenEvmTx } from "./state.js";

/**
 * Mock EVM JSON-RPC (ADR-013, application-design.md §5 "v2"): `POST /evm-rpc`. Every
 * response is a fixed, deterministic value - no wall clock, nothing ever broadcasts.
 * `eth_sendRawTransaction` is the one call that observes state: it decodes the raw
 * transaction through the same `capture.decodeShimEvent({kind:"evm_tx"})` path the
 * `evm_tx` shim event uses, and records a Payment per leg via `recordDecodedLegs` with
 * `capture:"rpc"` - so a resubmission of the exact same serialized tx (same
 * `dedupe_key`) merges into one payment, and a wrapped signer's shim report of the
 * same tx merges into `"rpc+shim"` (see capture/src/merge.ts).
 */

const EVM_BLOCK_NUMBER = "0x1000";
const EVM_BLOCK_TIMESTAMP = "0x66000000";
const EVM_BASE_FEE_PER_GAS = "0x3b9aca00"; // 1 gwei
const EVM_GAS_PRICE = "0x3b9aca00";
const EVM_MAX_PRIORITY_FEE_PER_GAS = "0x0";
const EVM_ESTIMATED_GAS = "0x186a0"; // 100_000
const EVM_FIXED_BALANCE_WEI = `0x${(10n ** 18n).toString(16)}`; // 1 ETH
const EVM_BLOCK_HASH = `0x${"11".repeat(32)}`;
const EVM_EMPTY_LOGS_BLOOM = `0x${"0".repeat(512)}`;
/** keccak256("Transfer(address,address,uint256)") - the standard ERC-20 Transfer event topic. */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Well-known 4-byte ERC-20 function selectors (standard, not computed - no need for a
// keccak256 dependency just to re-derive constants every implementer already knows).
const SELECTOR_BALANCE_OF = "0x70a08231";
const SELECTOR_DECIMALS = "0x313ce567";
const SELECTOR_SYMBOL = "0x95d89b41";
const SELECTOR_NAME = "0x06fdde03";
const SELECTOR_ALLOWANCE = "0xdd62ed3e";

function evmChainId(): number {
  const match = /^eip155:(\d+)$/.exec(CHAIN_DEFAULTS.evm.network);
  if (!match) throw new Error(`evm-rpc: unparseable harness network ${CHAIN_DEFAULTS.evm.network}`);
  return Number(match[1]);
}

function hexQuantity(value: bigint | number): string {
  return `0x${value.toString(16)}`;
}

/** ABI-encodes a `uint256` return value (also used for the `uint8 decimals` slot). */
function encodeUint256(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** ABI-encodes a dynamic `string` return value (offset + length + right-padded data). */
function encodeAbiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const offsetWord = (32).toString(16).padStart(64, "0");
  const lengthWord = bytes.length.toString(16).padStart(64, "0");
  const dataHex = bytes.toString("hex");
  const paddedLength = Math.ceil(dataHex.length / 64) * 64;
  return `0x${offsetWord}${lengthWord}${dataHex.padEnd(paddedLength, "0")}`;
}

const MAX_UINT256 = 2n ** 256n - 1n;

/** The canonical Multicall3 deployment address, the same on every EVM chain. viem's
 * `multicall` sends `aggregate3` here via `eth_call`. */
const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
/** Placeholder bytecode returned by `eth_getCode` for addresses the mock treats as
 * contracts (known assets and Multicall3). Never executed; it only needs to be non-empty. */
const EVM_CONTRACT_CODE = "0x6080604052600080fdfe";

/** Answers a read-only call to a known ERC-20 asset, or `undefined` for a revert. */
function tokenCall(state: RunState, to: string | undefined, data: string): string | undefined {
  const info = to ? assetInfo("evm", to, state.scenario.assets) : undefined;
  if (!info?.known) return undefined;
  switch (data.slice(0, 10).toLowerCase()) {
    case SELECTOR_BALANCE_OF: {
      const atomic = usdToAtomic(
        walletBalanceUsd(state.scenario.task) / info.usd_price,
        info.decimals,
      );
      return encodeUint256(BigInt(atomic));
    }
    case SELECTOR_DECIMALS:
      return encodeUint256(BigInt(info.decimals));
    case SELECTOR_SYMBOL:
    case SELECTOR_NAME:
      return encodeAbiString(info.symbol);
    case SELECTOR_ALLOWANCE:
      return encodeUint256(MAX_UINT256);
    default:
      return undefined;
  }
}

/** Multicall3 `aggregate3`: runs each sub-call through `tokenCall`. A failing sub-call
 * yields `{success:false, returnData:"0x"}`, or reverts the whole call when it does not
 * allow failure. Returns `undefined` for a revert. */
function multicallAggregate3(state: RunState, data: string): string | undefined {
  let calls: readonly { target: string; allowFailure: boolean; callData: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: data as Hex });
    if (decoded.functionName !== "aggregate3") return undefined;
    [calls] = decoded.args;
  } catch {
    return undefined;
  }
  const results: { success: boolean; returnData: Hex }[] = [];
  for (const call of calls) {
    const answer = tokenCall(state, call.target, call.callData);
    if (answer === undefined && !call.allowFailure) return undefined;
    results.push(
      answer === undefined
        ? { success: false, returnData: "0x" }
        : { success: true, returnData: answer as Hex },
    );
  }
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}

/** `eth_getCode`: non-empty for known assets and Multicall3, `"0x"` for everything else. */
function codeAt(state: RunState, address: string | undefined): string {
  if (!address) return "0x";
  if (address.toLowerCase() === MULTICALL3_ADDRESS) return EVM_CONTRACT_CODE;
  return assetInfo("evm", address, state.scenario.assets).known ? EVM_CONTRACT_CODE : "0x";
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown[];
}

interface EthCallParams {
  to?: string;
  data?: string;
}

interface UnsignedTxParams {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
}

function fixedBlock(): Record<string, unknown> {
  return {
    number: EVM_BLOCK_NUMBER,
    hash: EVM_BLOCK_HASH,
    parentHash: `0x${"0".repeat(64)}`,
    nonce: `0x${"0".repeat(16)}`,
    sha3Uncles: `0x${"0".repeat(64)}`,
    logsBloom: EVM_EMPTY_LOGS_BLOOM,
    transactionsRoot: `0x${"0".repeat(64)}`,
    stateRoot: `0x${"0".repeat(64)}`,
    receiptsRoot: `0x${"0".repeat(64)}`,
    miner: `0x${"0".repeat(40)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: EVM_BLOCK_TIMESTAMP,
    transactions: [],
    uncles: [],
    baseFeePerGas: EVM_BASE_FEE_PER_GAS,
  };
}

function padHexAddress(a: string): string {
  return `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

/** L3 (code review): a synthetic ERC-20 Transfer log for a "transfer"-scheme leg against a
 * real token contract (not a native-value or unknown-asset leg). */
function erc20TransferLog(
  contract: string,
  from: string,
  to: string,
  amountAtomic: string,
  logIndex: number,
  txHash: string,
): Record<string, unknown> {
  return {
    address: contract,
    topics: [ERC20_TRANSFER_TOPIC, padHexAddress(from), padHexAddress(to)],
    data: encodeUint256(BigInt(amountAtomic)),
    blockNumber: EVM_BLOCK_NUMBER,
    blockHash: EVM_BLOCK_HASH,
    transactionHash: txHash,
    transactionIndex: "0x0",
    logIndex: hexQuantity(logIndex),
    removed: false,
  };
}

/** Synthesizes a deterministic, successful receipt for a tx hash seen this run - L3
 * (code review): echoes the tx's real legs as ERC-20 Transfer logs instead of `logs: []`. */
function fixedReceipt(hash: string, seen: SeenEvmTx): Record<string, unknown> {
  const logs = seen.legs
    .filter((leg) => leg.scheme === "transfer" && leg.asset !== NATIVE_ASSET && leg.asset !== "")
    .map((leg, i) => erc20TransferLog(leg.asset, leg.from, leg.to, leg.amount_atomic, i, hash));
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: EVM_BLOCK_HASH,
    blockNumber: EVM_BLOCK_NUMBER,
    from: seen.from,
    to: seen.to,
    cumulativeGasUsed: EVM_ESTIMATED_GAS,
    gasUsed: EVM_ESTIMATED_GAS,
    contractAddress: null,
    logs,
    logsBloom: EVM_EMPTY_LOGS_BLOOM,
    status: "0x1",
    effectiveGasPrice: EVM_GAS_PRICE,
    type: "0x2",
  };
}

/** L3 (code review): echoes the tx's real from/to/value/input/nonce/gas instead of an
 * all-zeroed placeholder. */
function fixedTransactionByHash(hash: string, seen: SeenEvmTx): Record<string, unknown> {
  return {
    hash,
    nonce: seen.nonce,
    blockHash: EVM_BLOCK_HASH,
    blockNumber: EVM_BLOCK_NUMBER,
    transactionIndex: "0x0",
    from: seen.from,
    to: seen.to,
    value: seen.value,
    gas: seen.gas,
    gasPrice: EVM_GAS_PRICE,
    input: seen.input,
    type: "0x2",
    chainId: hexQuantity(evmChainId()),
    v: "0x0",
    r: `0x${"0".repeat(64)}`,
    s: `0x${"0".repeat(64)}`,
  };
}

/** L2 (code review): best-effort, unverified interpretation of an *unsigned* transaction
 * request object (eth_sendTransaction/eth_signTransaction's params[0]) - there is no
 * signature to check, so this only ever reports what the caller itself claimed. */
function decodeUnsignedTxParams(params: UnsignedTxParams): {
  asset: string;
  to: string;
  amount_atomic: string;
} {
  const value = params.value ? BigInt(params.value) : 0n;
  if (params.to && params.data && params.data !== "0x") {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: params.data as `0x${string}` });
      if (decoded.functionName === "transfer") {
        const [to, amount] = decoded.args as readonly [string, bigint];
        return { asset: params.to, to, amount_atomic: amount.toString() };
      }
      if (decoded.functionName === "transferFrom") {
        const [, to, amount] = decoded.args as readonly [string, string, bigint];
        return { asset: params.to, to, amount_atomic: amount.toString() };
      }
      if (decoded.functionName === "approve") {
        const [to, amount] = decoded.args as readonly [string, bigint];
        return { asset: params.to, to, amount_atomic: amount.toString() };
      }
    } catch {
      // Unrecognised calldata; fall through to native-value handling.
    }
  }
  return { asset: NATIVE_ASSET, to: params.to ?? "", amount_atomic: value.toString() };
}

export function registerEvmRpcRoutes(app: Hono, shared: Shared): void {
  app.post("/evm-rpc", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state, rendered } = loaded;

    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      parsed = null;
    }

    const requests = Array.isArray(parsed) ? parsed : [parsed as JsonRpcRequest];

    const results = await Promise.all(
      requests.map(async (one) => {
        const req = (one ?? {}) as JsonRpcRequest;
        const method = req.method ?? "";
        const id = req.id ?? null;
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
        const err = (code: number, message: string) => ({
          jsonrpc: "2.0",
          id,
          error: { code, message },
        });

        let body: unknown;
        switch (method) {
          case "eth_chainId":
            body = ok(hexQuantity(evmChainId()));
            break;
          case "net_version":
            body = ok(String(evmChainId()));
            break;
          case "eth_blockNumber":
            body = ok(EVM_BLOCK_NUMBER);
            break;
          case "eth_getBlockByNumber":
          case "eth_getBlockByHash":
            body = ok(fixedBlock());
            break;
          case "eth_gasPrice":
            body = ok(EVM_GAS_PRICE);
            break;
          case "eth_maxPriorityFeePerGas":
            body = ok(EVM_MAX_PRIORITY_FEE_PER_GAS);
            break;
          case "eth_feeHistory":
            body = ok({
              oldestBlock: EVM_BLOCK_NUMBER,
              baseFeePerGas: [EVM_BASE_FEE_PER_GAS, EVM_BASE_FEE_PER_GAS],
              gasUsedRatio: [0.5],
              reward: [["0x0"]],
            });
            break;
          case "eth_estimateGas":
            body = ok(EVM_ESTIMATED_GAS);
            break;
          case "eth_getBalance":
            body = ok(EVM_FIXED_BALANCE_WEI);
            break;
          case "eth_getTransactionCount": {
            const address = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
            const count = address ? (state.evmTxCountByAddress.get(address.toLowerCase()) ?? 0) : 0;
            body = ok(hexQuantity(count));
            break;
          }
          case "eth_call": {
            const callParams = req.params?.[0] as EthCallParams | undefined;
            const to = callParams?.to;
            const data = callParams?.data ?? "0x";
            const answer =
              to?.toLowerCase() === MULTICALL3_ADDRESS
                ? multicallAggregate3(state, data)
                : tokenCall(state, to, data);
            body = answer === undefined ? err(-32000, "execution reverted") : ok(answer);
            break;
          }
          case "eth_getCode": {
            const address = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
            body = ok(codeAt(state, address));
            break;
          }
          case "eth_sendRawTransaction": {
            const serialized = req.params?.[0];
            if (typeof serialized !== "string") {
              body = err(-32602, "invalid transaction");
              break;
            }
            try {
              // L1 (code review): nonce/seen-tx bookkeeping is keyed on the tx's actual
              // signer (who owns the nonce and pays gas), not `decoded.from` - which, for
              // a transferFrom/transferWithAuthorization leg, is the *token owner* being
              // moved from, a different account entirely.
              const serializedTx = serialized as TransactionSerialized;
              const signer = await recoverTransactionAddress({
                serializedTransaction: serializedTx,
              });
              const txHash = keccak256(serializedTx);
              const parsedTx = parseTransaction(serializedTx);

              const decoded = await shared.capture.decodeShimEvent(
                { kind: "evm_tx", payload: { serialized } },
                { knownOwners: rendered.knownOwners },
              );
              const payments = recordDecodedLegs(state, shared.capture, decoded, {
                capture: "rpc",
              });

              const fromKey = signer.toLowerCase();
              state.evmTxCountByAddress.set(
                fromKey,
                (state.evmTxCountByAddress.get(fromKey) ?? 0) + 1,
              );
              state.seenEvmTx.set(txHash, {
                from: signer,
                to: parsedTx.to ?? null,
                value: hexQuantity(parsedTx.value ?? 0n),
                input: parsedTx.data ?? "0x",
                nonce: hexQuantity(parsedTx.nonce ?? 0),
                gas: hexQuantity(parsedTx.gas ?? 0n),
                legs: payments.map((p) => ({
                  asset: p.asset,
                  from: p.from,
                  to: p.to,
                  amount_atomic: p.amount_atomic,
                  scheme: p.scheme,
                })),
              });
              body = ok(txHash);
            } catch {
              body = err(-32602, "invalid transaction");
            }
            break;
          }
          case "eth_sendTransaction":
          case "eth_signTransaction": {
            // L2 (code review): the mock never holds private keys, so these are always
            // rejected - but if the request claims a value/calldata transfer, that
            // *attempt* is itself worth recording (an agent trying to get a "node" it
            // doesn't control to sign a payment on its behalf).
            const txParams = req.params?.[0] as UnsignedTxParams | undefined;
            if (txParams) {
              const hasValue = !!txParams.value && BigInt(txParams.value) > 0n;
              const hasCalldata = !!txParams.data && txParams.data !== "0x";
              if (hasValue || hasCalldata) {
                const { asset, to, amount_atomic } = decodeUnsignedTxParams(txParams);
                recordDecodedLegs(
                  state,
                  shared.capture,
                  {
                    chain: "evm",
                    network: CHAIN_DEFAULTS.evm.network,
                    scheme: "transfer",
                    asset,
                    from: txParams.from ?? "",
                    to,
                    amount_atomic,
                    dedupe_key: `evmreq:${method}:${state.nextSeq()}`,
                    valid: false,
                    invalid_reason: "unsigned_request",
                    raw: txParams,
                  },
                  { capture: "rpc" },
                );
              }
            }
            body = err(-32601, `method not found: ${method}`);
            break;
          }
          case "eth_getTransactionReceipt": {
            const hash = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
            const seen = hash ? state.seenEvmTx.get(hash) : undefined;
            body = ok(seen && hash ? fixedReceipt(hash, seen) : null);
            break;
          }
          case "eth_getTransactionByHash": {
            const hash = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
            const seen = hash ? state.seenEvmTx.get(hash) : undefined;
            body = ok(seen && hash ? fixedTransactionByHash(hash, seen) : null);
            break;
          }
          default:
            body = err(-32601, `method not found: ${method}`);
        }

        state.requests.push({
          seq: state.nextSeq(),
          method: "POST",
          host: "evm-rpc",
          path: method,
          status: 200,
          paid: false,
        });
        return body;
      }),
    );

    return c.json(Array.isArray(parsed) ? results : results[0]);
  });
}
