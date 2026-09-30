import { capture } from "@x402-redteam/capture";
import { agentWallet, CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";

/**
 * Uses the real `@x402-redteam/capture` package (not `test/stub-capture.ts`): the
 * stub's `decodeShimEvent` only implements `evm_typed_data`/`svm_tx`, not `evm_tx` -
 * the mock EVM RPC's `eth_sendRawTransaction` needs the real `decodeEvmTx`. Same
 * pattern as `test/real-capture.test.ts`.
 */
function makeCapture() {
  return capture;
}

const SEED = "x402-redteam-v1";
const AGENT_SECRET = agentWallet(SEED, "evm").secret as `0x${string}`;

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC `result` is intentionally untyped here - each test narrows what it needs.
  result?: any;
  error?: { code: number; message: string };
}

async function jsonRpc(
  baseUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<JsonRpcResponse> {
  const res = await fetch(`${baseUrl}/evm-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json() as Promise<JsonRpcResponse>;
}

describe("mock EVM JSON-RPC (ADR-013)", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  function load(run_id: string): void {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: `evm-rpc-${run_id}` });
  }

  it("eth_chainId / net_version report the harness's fixed evm network", async () => {
    load("chain-id");
    const chainIdMatch = /^eip155:(\d+)$/.exec(CHAIN_DEFAULTS.evm.network);
    const chainId = Number(chainIdMatch?.[1]);

    const chainIdRes = await jsonRpc(adversary.baseUrl, "eth_chainId");
    expect(chainIdRes.result).toBe(`0x${chainId.toString(16)}`);

    const netVersionRes = await jsonRpc(adversary.baseUrl, "net_version");
    expect(netVersionRes.result).toBe(String(chainId));
  });

  it("eth_blockNumber / eth_getBlockByNumber return a fixed block with baseFeePerGas", async () => {
    load("block");
    const blockNumberRes = await jsonRpc(adversary.baseUrl, "eth_blockNumber");
    expect(blockNumberRes.result).toBe("0x1000");

    const blockRes = await jsonRpc(adversary.baseUrl, "eth_getBlockByNumber", ["latest", false]);
    expect(blockRes.result.number).toBe("0x1000");
    expect(blockRes.result.baseFeePerGas).toBe("0x3b9aca00");
    expect(blockRes.result.timestamp).toBe("0x66000000");
  });

  it("eth_gasPrice, eth_maxPriorityFeePerGas and eth_estimateGas return fixed values", async () => {
    load("fees");
    const gasPrice = await jsonRpc(adversary.baseUrl, "eth_gasPrice");
    expect(gasPrice.result).toBe("0x3b9aca00");

    const maxPriority = await jsonRpc(adversary.baseUrl, "eth_maxPriorityFeePerGas");
    expect(maxPriority.result).toBe("0x0");

    const estimateGas = await jsonRpc(adversary.baseUrl, "eth_estimateGas", [{}]);
    expect(estimateGas.result).toBe("0x186a0");
  });

  it("eth_getBalance returns a fixed 1 ETH", async () => {
    load("balance");
    const res = await jsonRpc(adversary.baseUrl, "eth_getBalance", ["0xabc"]);
    expect(BigInt(res.result)).toBe(10n ** 18n);
  });

  it("eth_getTransactionCount increments only after an accepted eth_sendRawTransaction from that address", async () => {
    load("nonce");
    const account = privateKeyToAccount(AGENT_SECRET);
    const before = await jsonRpc(adversary.baseUrl, "eth_getTransactionCount", [
      account.address,
      "pending",
    ]);
    expect(before.result).toBe("0x0");

    const serialized = await account.signTransaction({
      chainId: 84532,
      nonce: 0,
      to: "0x0000000000000000000000000000000000000001",
      value: 1n,
      gas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });
    await jsonRpc(adversary.baseUrl, "eth_sendRawTransaction", [serialized]);

    const after = await jsonRpc(adversary.baseUrl, "eth_getTransactionCount", [
      account.address,
      "pending",
    ]);
    expect(after.result).toBe("0x1");
  });

  it("eth_call answers balanceOf/decimals/symbol/name/allowance for a known asset, and reverts otherwise", async () => {
    load("eth-call");
    const asset = CHAIN_DEFAULTS.evm.asset;
    const balanceOfData = `0x70a08231${"0".repeat(64)}`; // selector + a throwaway address arg
    const balanceOf = await jsonRpc(adversary.baseUrl, "eth_call", [
      { to: asset, data: balanceOfData },
    ]);
    expect(BigInt(balanceOf.result)).toBe(100_000_000n); // $100 at 6 decimals

    const decimals = await jsonRpc(adversary.baseUrl, "eth_call", [
      { to: asset, data: "0x313ce567" },
    ]);
    expect(BigInt(decimals.result)).toBe(6n);

    const symbol = await jsonRpc(adversary.baseUrl, "eth_call", [
      { to: asset, data: "0x95d89b41" },
    ]);
    expect(symbol.error).toBeUndefined();

    const allowance = await jsonRpc(adversary.baseUrl, "eth_call", [
      { to: asset, data: `0xdd62ed3e${"0".repeat(128)}` },
    ]);
    expect(BigInt(allowance.result)).toBe(2n ** 256n - 1n);

    const unknownAsset = await jsonRpc(adversary.baseUrl, "eth_call", [
      { to: "0x0000000000000000000000000000000000009999", data: "0x70a08231" },
    ]);
    expect(unknownAsset.error?.code).toBe(-32000);

    const unknownSelector = await jsonRpc(adversary.baseUrl, "eth_call", [
      { to: asset, data: "0xdeadbeef" },
    ]);
    expect(unknownSelector.error?.code).toBe(-32000);
  });

  it("eth_sendRawTransaction records a Payment (capture: rpc), returns keccak256(serialized), rejects malformed input, and merges a resubmission", async () => {
    load("send-raw");
    const account = privateKeyToAccount(AGENT_SECRET);
    const to = "0x0000000000000000000000000000000000000002";
    const serialized = await account.signTransaction({
      chainId: 84532,
      nonce: 0,
      to,
      value: 777n,
      gas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    const malformed = await jsonRpc(adversary.baseUrl, "eth_sendRawTransaction", ["0xnotarealtx"]);
    expect(malformed.error?.code).toBe(-32602);

    const sent = await jsonRpc(adversary.baseUrl, "eth_sendRawTransaction", [serialized]);
    expect(typeof sent.result).toBe("string");
    expect(sent.result).toMatch(/^0x[0-9a-f]{64}$/);

    // Resubmitting the exact same serialized tx merges (same dedupe_key) into one payment.
    await jsonRpc(adversary.baseUrl, "eth_sendRawTransaction", [serialized]);

    const drain = adversary.drain();
    const payments = drain.payments.filter((p) => p.to?.toLowerCase() === to.toLowerCase());
    expect(payments).toHaveLength(1);
    expect(payments[0]?.capture).toBe("rpc");
    expect(payments[0]?.amount_atomic).toBe("777");
    expect(drain.requests.some((r) => r.host === "evm-rpc" && !r.paid)).toBe(true);
  });

  it("eth_getTransactionReceipt / eth_getTransactionByHash: null before seen, a synthetic successful record after", async () => {
    load("receipt");
    const account = privateKeyToAccount(AGENT_SECRET);
    const serialized = await account.signTransaction({
      chainId: 84532,
      nonce: 0,
      to: "0x0000000000000000000000000000000000000003",
      value: 1n,
      gas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    const before = await jsonRpc(adversary.baseUrl, "eth_getTransactionReceipt", ["0xdeadbeef"]);
    expect(before.result).toBeNull();

    const sent = await jsonRpc(adversary.baseUrl, "eth_sendRawTransaction", [serialized]);
    const hash = sent.result as string;

    const receipt = await jsonRpc(adversary.baseUrl, "eth_getTransactionReceipt", [hash]);
    expect(receipt.result.status).toBe("0x1");
    expect(receipt.result.transactionHash).toBe(hash);

    const tx = await jsonRpc(adversary.baseUrl, "eth_getTransactionByHash", [hash]);
    expect(tx.result.hash).toBe(hash);
  });

  it("an unknown method returns -32601 and is logged", async () => {
    load("unknown");
    const res = await jsonRpc(adversary.baseUrl, "eth_totallyUnknown");
    expect(res.error?.code).toBe(-32601);
    const drain = adversary.drain();
    expect(
      drain.requests.some((r) => r.host === "evm-rpc" && r.path === "eth_totallyUnknown"),
    ).toBe(true);
  });

  it("a real viem walletClient.writeContract against /evm-rpc succeeds end to end (nonce, gas, send, waitForTransactionReceipt terminates)", async () => {
    load("real-viem");
    const account = privateKeyToAccount(AGENT_SECRET);
    const chainIdMatch = /^eip155:(\d+)$/.exec(CHAIN_DEFAULTS.evm.network);
    const chainId = Number(chainIdMatch?.[1]);
    const viemChain = {
      id: chainId,
      name: "x402-redteam-test",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [`${adversary.baseUrl}/evm-rpc`] } },
    };

    const walletClient = createWalletClient({
      account,
      chain: viemChain,
      transport: http(`${adversary.baseUrl}/evm-rpc`),
    });
    const publicClient = createPublicClient({
      chain: viemChain,
      transport: http(`${adversary.baseUrl}/evm-rpc`),
    });

    const to = "0x0000000000000000000000000000000000000004" as const;
    const hash = await walletClient.writeContract({
      address: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, 4242n],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    const drain = adversary.drain();
    const payment = drain.payments.find((p) => p.to?.toLowerCase() === to.toLowerCase());
    expect(payment).toBeDefined();
    expect(payment?.capture).toBe("rpc");
    expect(payment?.amount_atomic).toBe("4242");
  });
});
