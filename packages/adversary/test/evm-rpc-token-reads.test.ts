import { capture } from "@x402-redteam/capture";
import { agentWallet, CHAIN_DEFAULTS } from "@x402-redteam/schema";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";

/**
 * Token-detail reads a viem-based wallet makes before an ERC-20 transfer: `eth_getCode`
 * (is this address a contract?) and Multicall3 `aggregate3` batching name/symbol/
 * decimals/balanceOf. The multicall answers must match the mock's direct `eth_call`
 * answers for the same selectors.
 */

const SEED = "x402-redteam-v1";
const AGENT_ADDRESS = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`).address;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ASSET = CHAIN_DEFAULTS.evm.asset as `0x${string}`;
const EOA = "0x0000000000000000000000000000000000000002";

const aggregate3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

interface JsonRpcResponse {
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

describe("mock EVM JSON-RPC: token-detail reads", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });

  afterAll(async () => {
    await adversary.close();
  });

  function load(run_id: string): void {
    adversary.load({
      scenario: buildFixtureScenario(),
      chain: "evm",
      run_id: `evm-rpc-token-${run_id}`,
    });
  }

  it("eth_getCode returns bytecode for the asset and Multicall3, and 0x for an EOA", async () => {
    load("get-code");
    const asset = await jsonRpc(adversary.baseUrl, "eth_getCode", [ASSET, "latest"]);
    expect(asset.result).toMatch(/^0x[0-9a-f]{2,}$/);

    const multicall = await jsonRpc(adversary.baseUrl, "eth_getCode", [
      MULTICALL3.toLowerCase(),
      "latest",
    ]);
    expect(multicall.result).toMatch(/^0x[0-9a-f]{2,}$/);

    const eoa = await jsonRpc(adversary.baseUrl, "eth_getCode", [EOA, "latest"]);
    expect(eoa.result).toBe("0x");
    const agent = await jsonRpc(adversary.baseUrl, "eth_getCode", [AGENT_ADDRESS, "latest"]);
    expect(agent.result).toBe("0x");
  });

  it("Multicall3 aggregate3 returns the same encoded results as direct eth_call", async () => {
    load("aggregate3");
    const subCalls: Hex[] = [
      encodeFunctionData({ abi: erc20Abi, functionName: "name" }),
      encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }),
      encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [AGENT_ADDRESS] }),
    ];
    const data = encodeFunctionData({
      abi: aggregate3Abi,
      functionName: "aggregate3",
      args: [
        [
          ...subCalls.map((callData) => ({ target: ASSET, allowFailure: true, callData })),
          { target: EOA, allowFailure: true, callData: subCalls[2] as Hex },
        ],
      ],
    });
    const res = await jsonRpc(adversary.baseUrl, "eth_call", [{ to: MULTICALL3, data }, "latest"]);
    expect(res.error).toBeUndefined();
    const results = decodeFunctionResult({
      abi: aggregate3Abi,
      functionName: "aggregate3",
      data: res.result,
    });
    expect(results).toHaveLength(5);

    for (const [i, callData] of subCalls.entries()) {
      const direct = await jsonRpc(adversary.baseUrl, "eth_call", [{ to: ASSET, data: callData }]);
      expect(results[i]?.success).toBe(true);
      expect(results[i]?.returnData).toBe(direct.result);
    }
    expect(results[4]?.success).toBe(false);
    expect(results[4]?.returnData).toBe("0x");

    const decimals = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      data: results[2]?.returnData as Hex,
    });
    expect(decimals).toBe(6);
  });

  it("aggregate3 reverts when a failing sub-call does not allow failure", async () => {
    load("aggregate3-strict");
    const data = encodeFunctionData({
      abi: aggregate3Abi,
      functionName: "aggregate3",
      args: [[{ target: EOA, allowFailure: false, callData: "0x313ce567" }]],
    });
    const res = await jsonRpc(adversary.baseUrl, "eth_call", [{ to: MULTICALL3, data }]);
    expect(res.error?.code).toBe(-32000);
  });

  it("answers malformed calls with a JSON-RPC error instead of failing", async () => {
    load("malformed");
    for (const data of ["0x82ad56cb", "0xzz", `0x82ad56cb${"f".repeat(64)}`]) {
      const res = await jsonRpc(adversary.baseUrl, "eth_call", [{ to: MULTICALL3, data }]);
      expect(res.error?.code).toBe(-32000);
    }
    const badTo = await jsonRpc(adversary.baseUrl, "eth_call", [{ to: 5, data: "0x313ce567" }]);
    expect(badTo.error?.code).toBe(-32000);
    const badData = await jsonRpc(adversary.baseUrl, "eth_call", [{ to: MULTICALL3, data: 7 }]);
    expect(badData.error?.code).toBe(-32000);
    for (const params of [[], [5], [null]]) {
      const res = await jsonRpc(adversary.baseUrl, "eth_getCode", params);
      expect(res.result).toBe("0x");
    }
  });

  it("viem readContract and multicall read the token's decimals and symbol", async () => {
    load("viem");
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(`${adversary.baseUrl}/evm-rpc`),
    });
    expect(
      await client.readContract({ address: ASSET, abi: erc20Abi, functionName: "decimals" }),
    ).toBe(6);

    const [decimals, symbol, balance] = await client.multicall({
      contracts: [
        { address: ASSET, abi: erc20Abi, functionName: "decimals" },
        { address: ASSET, abi: erc20Abi, functionName: "symbol" },
        { address: ASSET, abi: erc20Abi, functionName: "balanceOf", args: [AGENT_ADDRESS] },
      ],
    });
    expect(decimals).toEqual({ status: "success", result: 6 });
    expect(symbol).toEqual({ status: "success", result: "USDC" });
    expect(balance).toEqual({ status: "success", result: 100_000_000n });

    expect(await client.getCode({ address: EOA })).toBeUndefined();
  });
});
