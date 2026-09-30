import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { agentWallet, CHAIN_DEFAULTS, canaries } from "@x402-redteam/schema";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decodeEvmPayload, decodeEvmTx, decodeEvmTypedData } from "../src/evm.js";

const SEED = "x402-redteam-v1";
const chainId = 84532;

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: CHAIN_DEFAULTS.evm.network as PaymentRequirements["network"],
    asset: CHAIN_DEFAULTS.evm.asset,
    amount: "1000",
    payTo: canaries(SEED, "evm-test", "evm").get("legit").address,
    maxTimeoutSeconds: 60,
    extra: CHAIN_DEFAULTS.evm.extra,
    ...overrides,
  };
}

function paymentRequired(reqs: PaymentRequirements): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "http://provider.test/weather/today" },
    accepts: [reqs],
  };
}

async function buildRealPayment(reqs: PaymentRequirements): Promise<PaymentPayload> {
  const wallet = agentWallet(SEED, "evm");
  const account = privateKeyToAccount(wallet.secret as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return client.createPaymentPayload(paymentRequired(reqs));
}

describe("decodeEvmPayload (real @x402/evm exact client)", () => {
  it("decodes a real EIP-3009 header payment with matching from/to/amount and valid: true", async () => {
    const reqs = requirements();
    const payload = await buildRealPayment(reqs);

    const decoded = await decodeEvmPayload(payload);

    expect(decoded.chain).toBe("evm");
    expect(decoded.valid).toBe(true);
    expect(decoded.network).toBe(reqs.network);
    expect(decoded.asset.toLowerCase()).toBe(reqs.asset.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(reqs.payTo.toLowerCase());
    expect(decoded.from.toLowerCase()).toBe(agentWallet(SEED, "evm").address.toLowerCase());
    expect(decoded.amount_atomic).toBe(reqs.amount);
    expect(decoded.dedupe_key).toMatch(/^evm:0x/);
  });

  it("becomes invalid when the signed value is tampered with", async () => {
    const reqs = requirements();
    const payload = await buildRealPayment(reqs);

    const tampered = structuredClone(payload) as PaymentPayload & {
      payload: { authorization: { value: string } };
    };
    tampered.payload.authorization.value = (BigInt(reqs.amount) + 1n).toString();

    const decoded = await decodeEvmPayload(tampered);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
    // Fields are still filled in even though the signature no longer verifies.
    expect(decoded.amount_atomic).toBe(tampered.payload.authorization.value);
  });

  it("flags a negative authorization.value as negative_amount, without attempting signature verification", async () => {
    const reqs = requirements();
    const payload = await buildRealPayment(reqs);

    const tampered = structuredClone(payload) as PaymentPayload & {
      payload: { authorization: { value: string } };
    };
    tampered.payload.authorization.value = "-100";

    const decoded = await decodeEvmPayload(tampered);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("negative_amount");
    expect(decoded.amount_atomic).toBe("-100");
  });

  it("flags a non-integer authorization.value (e.g. a decimal) as negative_amount", async () => {
    const reqs = requirements();
    const payload = await buildRealPayment(reqs);

    const tampered = structuredClone(payload) as PaymentPayload & {
      payload: { authorization: { value: string } };
    };
    tampered.payload.authorization.value = "12.5";

    const decoded = await decodeEvmPayload(tampered);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("negative_amount");
  });

  it("flags a Permit2-shaped payload as unsupported_transfer_method", async () => {
    const reqs = requirements();
    const from = canaries(SEED, "evm-test", "evm").get("attacker").address;
    const permit2Payload: PaymentPayload = {
      x402Version: 2,
      accepted: reqs,
      payload: {
        signature: "0xdeadbeef",
        permit2Authorization: {
          from,
          permitted: { token: reqs.asset, amount: reqs.amount },
          spender: "0x0000000000000000000000000000000000000000",
          nonce: "1",
          deadline: "9999999999",
          witness: { to: reqs.payTo, validAfter: "0" },
        },
      },
    };

    const decoded = await decodeEvmPayload(permit2Payload);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("unsupported_transfer_method");
    expect(decoded.from.toLowerCase()).toBe(from.toLowerCase());
  });

  it("handles a v1 payload best-effort by mapping the v1 network name", async () => {
    const wallet = agentWallet(SEED, "evm");
    const account = privateKeyToAccount(wallet.secret as `0x${string}`);
    const to = canaries(SEED, "evm-test", "evm").get("legit").address as `0x${string}`;
    const authorization = {
      from: account.address,
      to,
      value: "500",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
    };
    const signature = await account.signTypedData({
      domain: {
        name: CHAIN_DEFAULTS.evm.extra.name as string,
        version: CHAIN_DEFAULTS.evm.extra.version as string,
        chainId,
        verifyingContract: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
    });

    const v1Payload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { authorization, signature },
    };

    const decoded = await decodeEvmPayload(v1Payload);
    expect(decoded.network).toBe(CHAIN_DEFAULTS.evm.network);
    expect(decoded.valid).toBe(true);
    expect(decoded.from.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe("decodeEvmTypedData (shim)", () => {
  it("decodes a signed evm_typed_data event to the same dedupe_key as the equivalent header payment", async () => {
    const reqs = requirements();
    const wallet = agentWallet(SEED, "evm");
    const account = privateKeyToAccount(wallet.secret as `0x${string}`);
    const payload = await buildRealPayment(reqs);
    const headerDecoded = await decodeEvmPayload(payload);

    const authorization = (
      payload as unknown as { payload: { authorization: Record<string, unknown> } }
    ).payload.authorization;
    const signature = (payload as unknown as { payload: { signature: string } }).payload.signature;

    const shimDecoded = await decodeEvmTypedData({
      domain: {
        name: reqs.extra.name,
        version: reqs.extra.version,
        chainId,
        verifyingContract: reqs.asset,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: authorization,
      signature,
      address: account.address,
    });

    expect(shimDecoded.valid).toBe(true);
    expect(shimDecoded.dedupe_key).toBe(headerDecoded.dedupe_key);
    expect(shimDecoded.from.toLowerCase()).toBe(headerDecoded.from.toLowerCase());
    expect(shimDecoded.to.toLowerCase()).toBe(headerDecoded.to.toLowerCase());
    expect(shimDecoded.amount_atomic).toBe(headerDecoded.amount_atomic);
  });

  it("is invalid when the recovered signer does not match payload.address", async () => {
    const attacker = canaries(SEED, "evm-test", "evm").get("attacker");
    const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
    const domain = {
      name: "USDC",
      version: "2",
      chainId,
      verifyingContract: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
    };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    const message = {
      from: account.address,
      to: attacker.address,
      value: 1000n,
      validAfter: 0n,
      validBefore: 9999999999n,
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000002",
    };
    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
    });

    const decoded = await decodeEvmTypedData({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
      signature,
      address: attacker.address, // wrong address on purpose
    });

    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
  });
});

describe("decodeEvmTx (shim, direct transfer)", () => {
  it("decodes a signed ERC-20 transfer transaction", async () => {
    const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
    const to = canaries(SEED, "evm-test", "evm").get("attacker").address as `0x${string}`;
    const { encodeFunctionData, erc20Abi } = await import("viem");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, 12345n],
    });
    const serialized = await account.signTransaction({
      chainId,
      nonce: 0,
      to: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
      data,
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    const decoded = await decodeEvmTx({ serialized });
    expect(decoded.valid).toBe(true);
    expect(decoded.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(decoded.asset.toLowerCase()).toBe(CHAIN_DEFAULTS.evm.asset.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount_atomic).toBe("12345");
    expect(decoded.dedupe_key).toBe(`evmtx:${keccak256(serialized as `0x${string}`)}`);
  });

  it("decodes a signed native-value transaction", async () => {
    const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
    const to = canaries(SEED, "evm-test", "evm").get("attacker").address as `0x${string}`;
    const serialized = await account.signTransaction({
      chainId,
      nonce: 0,
      to,
      value: 777n,
      gas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    const decoded = await decodeEvmTx({ serialized });
    expect(decoded.valid).toBe(true);
    expect(decoded.asset).toBe("native");
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount_atomic).toBe("777");
  });

  it("decodes a signed ERC-20 transferFrom transaction, using the named owner (not the tx signer) as `from`", async () => {
    const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
    const owner = canaries(SEED, "evm-test", "evm").get("legit").address as `0x${string}`;
    const to = canaries(SEED, "evm-test", "evm").get("attacker").address as `0x${string}`;
    const { encodeFunctionData, erc20Abi } = await import("viem");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [owner, to, 999n],
    });
    const serialized = await account.signTransaction({
      chainId,
      nonce: 0,
      to: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
      data,
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    const decoded = await decodeEvmTx({ serialized });
    expect(decoded.valid).toBe(true);
    expect(decoded.from.toLowerCase()).toBe(owner.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount_atomic).toBe("999");
    expect(decoded.asset.toLowerCase()).toBe(CHAIN_DEFAULTS.evm.asset.toLowerCase());
  });

  it("decodes a signed EIP-3009 transferWithAuthorization transaction and sets authorization_seconds", async () => {
    const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
    const owner = canaries(SEED, "evm-test", "evm").get("legit").address as `0x${string}`;
    const to = canaries(SEED, "evm-test", "evm").get("attacker").address as `0x${string}`;
    const { encodeFunctionData } = await import("viem");
    const transferWithAuthorizationAbi = [
      {
        type: "function",
        name: "transferWithAuthorization",
        stateMutability: "nonpayable",
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
        outputs: [],
      },
    ] as const;
    const nonce = `0x${"03".padStart(64, "0")}` as `0x${string}`;
    const r = `0x${"11".repeat(32)}` as `0x${string}`;
    const s = `0x${"22".repeat(32)}` as `0x${string}`;
    // Realistic epoch-relative values (not arbitrary small numbers): validAfter is
    // already in the past, validBefore is 590s in the future, so the remaining window
    // at receipt (validBefore - max(validAfter, now)) is ~590s - see authorizationSeconds().
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = nowSeconds - 10n;
    const validBefore = nowSeconds + 590n;
    const data = encodeFunctionData({
      abi: transferWithAuthorizationAbi,
      functionName: "transferWithAuthorization",
      args: [owner, to, 555n, validAfter, validBefore, nonce, 27, r, s],
    });
    const serialized = await account.signTransaction({
      chainId,
      nonce: 0,
      to: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
      data,
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    const decoded = await decodeEvmTx({ serialized });
    expect(decoded.valid).toBe(true);
    expect(decoded.from.toLowerCase()).toBe(owner.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount_atomic).toBe("555");
    // validAfter is already in the past, so the effective floor is "now": the remaining
    // window is validBefore - now, which is ~590s (allow a couple of seconds of test slop).
    expect(decoded.authorization_seconds).toBeGreaterThan(585);
    expect(decoded.authorization_seconds).toBeLessThanOrEqual(590);
  });

  it("authorization_seconds is the remaining window at receipt, not validBefore - validAfter, when validAfter is already in the past", async () => {
    // Regression for the orchestrator's U11-finding fix: the real @x402/evm client sets
    // validAfter to a constant "0" (far in the past) and validBefore to a wall-clock-relative
    // future timestamp, so a naive `validBefore - validAfter` would report a huge, ever-
    // growing number instead of a stable "seconds remaining" value.
    const reqs = requirements();
    const payload = await buildRealPayment(reqs);
    const decoded = await decodeEvmPayload(payload);
    expect(decoded.authorization_seconds).toBeDefined();
    // requirements()'s maxTimeoutSeconds defaults to 60 (see PaymentRequirements above);
    // validAfter is "0" for the real client, so effectiveAfter = now, and the remaining
    // window is ~maxTimeoutSeconds.
    expect(decoded.authorization_seconds as number).toBeGreaterThan(0);
    expect(decoded.authorization_seconds as number).toBeLessThanOrEqual(60);
  });
});
