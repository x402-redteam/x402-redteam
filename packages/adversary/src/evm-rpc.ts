import { assetInfo, CHAIN_DEFAULTS, usdToAtomic, walletBalanceUsd } from "@x402-redteam/schema";
import type { Hono } from "hono";
import { recordDecoded } from "./record.js";
import type { Shared } from "./shared.js";

/**
 * Mock EVM JSON-RPC (ADR-013, application-design.md §5 "v2"): `POST /evm-rpc`. Every
 * response is a fixed, deterministic value - no wall clock, nothing ever broadcasts.
 * `eth_sendRawTransaction` is the one call that observes state: it decodes the raw
 * transaction through the same `capture.decodeShimEvent({kind:"evm_tx"})` path the
 * `evm_tx` shim event uses, and records a Payment via `recordDecoded` with
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

/** Synthesizes a deterministic, successful receipt for a tx hash seen this run. */
function fixedReceipt(
  hash: string,
  seen: { from: string; to: string | null },
): Record<string, unknown> {
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
    logs: [],
    logsBloom: EVM_EMPTY_LOGS_BLOOM,
    status: "0x1",
    effectiveGasPrice: EVM_GAS_PRICE,
    type: "0x2",
  };
}

function fixedTransactionByHash(
  hash: string,
  seen: { from: string; to: string | null },
): Record<string, unknown> {
  return {
    hash,
    nonce: "0x0",
    blockHash: EVM_BLOCK_HASH,
    blockNumber: EVM_BLOCK_NUMBER,
    transactionIndex: "0x0",
    from: seen.from,
    to: seen.to,
    value: "0x0",
    gas: EVM_ESTIMATED_GAS,
    gasPrice: EVM_GAS_PRICE,
    input: "0x",
    type: "0x2",
    chainId: hexQuantity(evmChainId()),
    v: "0x0",
    r: `0x${"0".repeat(64)}`,
    s: `0x${"0".repeat(64)}`,
  };
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
            const info = to ? assetInfo("evm", to, state.scenario.assets) : undefined;
            const selector = data.slice(0, 10).toLowerCase();
            if (!info?.known) {
              body = err(-32000, "execution reverted");
              break;
            }
            switch (selector) {
              case SELECTOR_BALANCE_OF: {
                const atomic = usdToAtomic(
                  walletBalanceUsd(state.scenario.task) / info.usd_price,
                  info.decimals,
                );
                body = ok(encodeUint256(BigInt(atomic)));
                break;
              }
              case SELECTOR_DECIMALS:
                body = ok(encodeUint256(BigInt(info.decimals)));
                break;
              case SELECTOR_SYMBOL:
              case SELECTOR_NAME:
                body = ok(encodeAbiString(info.symbol));
                break;
              case SELECTOR_ALLOWANCE:
                body = ok(encodeUint256(MAX_UINT256));
                break;
              default:
                body = err(-32000, "execution reverted");
            }
            break;
          }
          case "eth_sendRawTransaction": {
            const serialized = req.params?.[0];
            if (typeof serialized !== "string") {
              body = err(-32602, "invalid transaction");
              break;
            }
            try {
              const decoded = await shared.capture.decodeShimEvent(
                { kind: "evm_tx", payload: { serialized } },
                { knownOwners: rendered.knownOwners },
              );
              const match = /^evmtx:(0x[0-9a-fA-F]+)$/.exec(decoded.dedupe_key);
              const txHash: string = match?.[1] ?? decoded.dedupe_key;
              recordDecoded(state, shared.capture, decoded, { capture: "rpc" });
              const fromKey = decoded.from.toLowerCase();
              state.evmTxCountByAddress.set(
                fromKey,
                (state.evmTxCountByAddress.get(fromKey) ?? 0) + 1,
              );
              state.seenEvmTx.set(txHash, {
                from: decoded.from,
                to: decoded.asset === "native" ? decoded.to || null : decoded.asset,
              });
              body = ok(txHash);
            } catch {
              body = err(-32602, "invalid transaction");
            }
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
