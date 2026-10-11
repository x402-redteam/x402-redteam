import http from "node:http";
import type { AddressInfo } from "node:net";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { agentWallet, CHAIN_DEFAULTS, canaries, type ShimEvent } from "@x402-redteam/schema";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  maxUint256,
  serializeSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEvmAuthorization, decodeEvmPayload, decodeEvmTx } from "../src/evm.js";
import { capture } from "../src/index.js";
import { wrapEvmAccount } from "../src/shim/evm.js";

const SEED = "x402-redteam-v1";
const CHAIN_ID = 84532;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const X402_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const X402_UPTO_PERMIT2_PROXY = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";

const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

const eip2612Types = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

interface Ledger {
  url: string;
  events: ShimEvent[];
  close: () => Promise<void>;
}

function startLedger(): Promise<Ledger> {
  const events: ShimEvent[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        events,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

let ledger: Ledger;
beforeEach(async () => {
  ledger = await startLedger();
});
afterEach(async () => {
  await ledger.close();
});

function agentAccount() {
  return privateKeyToAccount(agentWallet(SEED, "evm").secret as Hex);
}

function names() {
  return canaries(SEED, "signatures-test", "evm");
}

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: CHAIN_DEFAULTS.evm.network as PaymentRequirements["network"],
    asset: CHAIN_DEFAULTS.evm.asset,
    amount: "2000",
    payTo: names().get("legit").address,
    maxTimeoutSeconds: 60,
    extra: { ...CHAIN_DEFAULTS.evm.extra, assetTransferMethod: "permit2" },
    ...overrides,
  };
}

/** A public client mocked as local functions: Permit2 allowance and EIP-2612 nonces are 0. */
function mockPublicClient() {
  return {
    readContract: async (_args: { functionName: string }) => 0n,
    getTransactionCount: async (_args: { address: Hex }) => 0,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    }),
  };
}

/** Pays through the real @x402/evm 2.28.0 exact client. `rpc` composes the signer with the
 * mocked public client, which is what lets the SDK sign the gas-sponsoring extensions. */
async function realPayment(
  reqs: PaymentRequirements,
  opts: { shim?: boolean; rpc?: boolean; extensions?: Record<string, unknown> } = {},
): Promise<PaymentPayload> {
  const account = agentAccount();
  const base = opts.shim ? wrapEvmAccount(account, { ledgerUrl: ledger.url }) : account;
  const signer = opts.rpc
    ? toClientEvmSigner(base, mockPublicClient() as Parameters<typeof toClientEvmSigner>[1])
    : base;
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://provider.test/report" },
    accepts: [reqs],
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  };
  return client.createPaymentPayload(required);
}

async function shimDecoded(index: number) {
  const evt = ledger.events[index];
  if (!evt) throw new Error(`no shim event ${index}`);
  return capture.decodeShimEvent(JSON.parse(JSON.stringify(evt)) as ShimEvent);
}

describe("Permit2 witness payments (header path)", () => {
  it("a real SDK Permit2 payment verifies and decodes as a transfer to witness.to", async () => {
    const reqs = requirements();
    const payload = await realPayment(reqs);
    const decoded = await decodeEvmPayload(payload);

    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBeUndefined();
    expect(decoded.scheme).toBe("exact");
    expect(decoded.from).toBe(agentAccount().address);
    expect(decoded.to.toLowerCase()).toBe(reqs.payTo.toLowerCase());
    expect(decoded.asset.toLowerCase()).toBe(reqs.asset.toLowerCase());
    expect(decoded.amount_atomic).toBe(reqs.amount);
    const nonce = (payload.payload as { permit2Authorization: { nonce: string } })
      .permit2Authorization.nonce;
    expect(decoded.dedupe_key).toBe(`evm:${nonce}`);
    // No extensions were signed, so there is a single leg.
    expect(decoded.legs ?? [decoded]).toHaveLength(1);
  });

  it("a tampered amount fails signature verification", async () => {
    const payload = structuredClone(await realPayment(requirements())) as PaymentPayload & {
      payload: { permit2Authorization: { permitted: { amount: string } } };
    };
    payload.payload.permit2Authorization.permitted.amount = "2001";
    const decoded = await decodeEvmPayload(payload);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
  });

  it("a correctly signed witness transfer to a spender other than the x402 proxy is untrusted_permit2_spender", async () => {
    const reqs = requirements();
    const account = agentAccount();
    const attacker = names().get("attacker").address as Hex;
    const message = {
      permitted: { token: getAddress(reqs.asset), amount: BigInt(reqs.amount) },
      spender: attacker,
      nonce: 77n,
      deadline: 9_999_999_999n,
      witness: { to: getAddress(reqs.payTo), validAfter: 0n },
    };
    const signature = await account.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: permit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message,
    });
    const payload = {
      x402Version: 2,
      accepted: reqs,
      payload: {
        signature,
        permit2Authorization: {
          from: account.address,
          permitted: { token: message.permitted.token, amount: reqs.amount },
          spender: attacker,
          nonce: "77",
          deadline: "9999999999",
          witness: { to: message.witness.to, validAfter: "0" },
        },
      },
    } as unknown as PaymentPayload;

    const decoded = await decodeEvmPayload(payload);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("untrusted_permit2_spender");
    // Only the x402 proxy enforces the witness, so any other spender can send the funds
    // wherever it likes: the spender is the recipient.
    expect(decoded.to).toBe(attacker);
    expect(decoded.dedupe_key).toBe("evm:77");
  });

  it("a permit for a token other than the accepted asset is invalid", async () => {
    const reqs = requirements();
    const account = agentAccount();
    const message = {
      permitted: { token: getAddress(OTHER_TOKEN), amount: BigInt(reqs.amount) },
      spender: X402_PERMIT2_PROXY as Hex,
      nonce: 5n,
      deadline: 9_999_999_999n,
      witness: { to: getAddress(reqs.payTo), validAfter: 0n },
    };
    const signature = await account.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: permit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message,
    });
    const payload = {
      x402Version: 2,
      accepted: reqs,
      payload: {
        signature,
        permit2Authorization: {
          from: account.address,
          permitted: { token: OTHER_TOKEN, amount: reqs.amount },
          spender: X402_PERMIT2_PROXY,
          nonce: "5",
          deadline: "9999999999",
          witness: { to: message.witness.to, validAfter: "0" },
        },
      },
    } as unknown as PaymentPayload;

    const decoded = await decodeEvmPayload(payload);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("asset_mismatch");
  });

  it("a token named in another letter case is still the accepted asset", async () => {
    const reqs = requirements();
    const payload = structuredClone(await realPayment(reqs)) as PaymentPayload & {
      payload: { permit2Authorization: { permitted: { token: string } } };
    };
    payload.payload.permit2Authorization.permitted.token = reqs.asset.toLowerCase();
    const decoded = await decodeEvmPayload(payload);
    expect(decoded.valid).toBe(true);
    expect(decoded.asset).toBe(getAddress(reqs.asset));
    expect(decoded.from).toBe(agentAccount().address);
  });

  it("non-string Permit2 fields decode to an invalid leg without throwing", async () => {
    const reqs = requirements();
    const payload = {
      x402Version: 2,
      accepted: reqs,
      payload: {
        signature: "0x1234",
        permit2Authorization: {
          from: 42,
          permitted: { token: 7, amount: reqs.amount },
          spender: null,
          nonce: { n: 1 },
          witness: { to: 3 },
        },
      },
    } as unknown as PaymentPayload;
    const decoded = await decodeEvmPayload(payload);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
    expect(decoded.asset).toBe(reqs.asset);
    expect(typeof decoded.from).toBe("string");
  });

  it("the shim twin of a Permit2 payment decodes to the same transfer and dedupe key", async () => {
    const reqs = requirements();
    const payload = await realPayment(reqs, { shim: true });
    const header = await decodeEvmPayload(payload);

    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.kind).toBe("evm_typed_data");
    const shim = await shimDecoded(0);
    expect(shim.valid).toBe(true);
    expect(shim.scheme).toBe("exact");
    expect(shim.dedupe_key).toBe(header.dedupe_key);
    expect(shim.from).toBe(header.from);
    expect(shim.to.toLowerCase()).toBe(header.to.toLowerCase());
    expect(shim.asset.toLowerCase()).toBe(header.asset.toLowerCase());
    expect(shim.amount_atomic).toBe(header.amount_atomic);
    expect(shim.network).toBe(header.network);
  });
});

describe("gas-sponsoring extensions in the payment header", () => {
  it("decodes a signed EIP-2612 permit as a verified approve leg that merges with its shim twin", async () => {
    const reqs = requirements();
    const payload = await realPayment(reqs, {
      shim: true,
      rpc: true,
      extensions: { eip2612GasSponsoring: { info: { description: "server declaration" } } },
    });
    const header = await decodeEvmPayload(payload);

    const legs = header.legs ?? [];
    expect(legs).toHaveLength(2);
    const [transfer, permit] = legs;
    expect(transfer?.valid).toBe(true);
    expect(transfer?.scheme).toBe("exact");
    expect(permit?.scheme).toBe("approve");
    expect(permit?.valid).toBe(true);
    expect(permit?.from).toBe(agentAccount().address);
    expect(permit?.to).toBe(PERMIT2);
    expect(permit?.asset.toLowerCase()).toBe(reqs.asset.toLowerCase());
    expect(permit?.amount_atomic).toBe(reqs.amount);
    expect(permit?.network).toBe(reqs.network);
    const permitSignature = (
      payload.extensions as { eip2612GasSponsoring: { info: { signature: Hex } } }
    ).eip2612GasSponsoring.info.signature;
    expect(permit?.dedupe_key).toBe(
      `evm712:${CHAIN_ID}:${getAddress(reqs.asset)}:Permit:${agentAccount().address}:0:${keccak256(permitSignature)}`,
    );

    // The shim saw the Permit2 witness first, then the Permit.
    expect(ledger.events.map((e) => e.kind)).toEqual(["evm_typed_data", "evm_typed_data"]);
    const shimPermit = await shimDecoded(1);
    expect(shimPermit.scheme).toBe("approve");
    expect(shimPermit.valid).toBe(true);
    expect(shimPermit.dedupe_key).toBe(permit?.dedupe_key);
    expect(shimPermit.to).toBe(permit?.to);
    expect(shimPermit.amount_atomic).toBe(permit?.amount_atomic);
  });

  it("the EIP-2612 permit uses the challenge's token name and version for its domain", async () => {
    const reqs = requirements();
    const payload = await realPayment(reqs, {
      rpc: true,
      extensions: { eip2612GasSponsoring: {} },
    });
    const wrongName = structuredClone(payload) as PaymentPayload;
    (wrongName.accepted as { extra: Record<string, unknown> }).extra.name = "Not USDC";
    const decoded = await decodeEvmPayload(wrongName);
    const permit = decoded.legs?.find((l) => l.scheme === "approve");
    expect(permit?.valid).toBe(false);
    expect(permit?.invalid_reason).toBe("bad_signature");
  });

  it("decodes a signed ERC-20 approval transaction as an approve leg sharing the shim's dedupe key", async () => {
    const reqs = requirements();
    const payload = await realPayment(reqs, {
      shim: true,
      rpc: true,
      extensions: { erc20ApprovalGasSponsoring: {} },
    });
    const header = await decodeEvmPayload(payload);

    const legs = header.legs ?? [];
    expect(legs).toHaveLength(2);
    const approve = legs[1];
    expect(approve?.scheme).toBe("approve");
    expect(approve?.valid).toBe(true);
    expect(approve?.from).toBe(agentAccount().address);
    expect(approve?.to).toBe(PERMIT2);
    expect(approve?.amount_atomic).toBe(maxUint256.toString());

    const kinds = ledger.events.map((e) => e.kind);
    expect(kinds).toEqual(["evm_typed_data", "evm_tx"]);
    const shimApprove = await shimDecoded(1);
    expect(shimApprove.dedupe_key).toBe(approve?.dedupe_key);
  });

  it("extension fields that are not strings add no leg, or an invalid one, without throwing", async () => {
    const reqs = requirements();
    const base = await realPayment(reqs);
    const noLegs = await decodeEvmPayload({
      ...base,
      extensions: {
        eip2612GasSponsoring: { info: { signature: 12 } },
        erc20ApprovalGasSponsoring: { info: { signedTransaction: { tx: 1 } } },
      },
    } as PaymentPayload);
    expect(noLegs.valid).toBe(true);
    expect(noLegs.legs ?? [noLegs]).toHaveLength(1);

    const odd = await decodeEvmPayload({
      ...base,
      extensions: {
        eip2612GasSponsoring: {
          info: { signature: "0x1234", from: 5, spender: [], amount: "1", nonce: {}, asset: 9 },
        },
        erc20ApprovalGasSponsoring: { info: { signedTransaction: "0xnot-a-transaction" } },
      },
    } as unknown as PaymentPayload);
    const legs = odd.legs ?? [];
    expect(legs).toHaveLength(2);
    expect(legs[1]?.scheme).toBe("approve");
    expect(legs[1]?.valid).toBe(false);
    expect(legs[1]?.invalid_reason).toBe("bad_signature");
  });

  it("an extension the server declared but the client did not sign adds no leg", async () => {
    // A bare account has no readContract, so the SDK signs nothing, yet the client echoes
    // the server's declarations back in the payload.
    const reqs = requirements();
    const payload = await realPayment(reqs, {
      extensions: {
        eip2612GasSponsoring: { info: { description: "declared" } },
        erc20ApprovalGasSponsoring: { info: { description: "declared" } },
      },
    });
    expect(payload.extensions).toBeDefined();
    const decoded = await decodeEvmPayload(payload);
    expect(decoded.valid).toBe(true);
    expect(decoded.legs ?? [decoded]).toHaveLength(1);
  });
});

describe("typed data decoded by primaryType (shim)", () => {
  it("PermitSingle is an approve leg to the spender for the detail amount", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    const spender = names().get("attacker").address as Hex;
    await wrapped.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: {
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
      primaryType: "PermitSingle",
      message: {
        details: {
          token: CHAIN_DEFAULTS.evm.asset as Hex,
          amount: 2n ** 160n - 1n,
          expiration: 9_999_999_999,
          nonce: 0,
        },
        spender,
        sigDeadline: 9_999_999_999n,
      },
    });
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("approve");
    expect(decoded.valid).toBe(true);
    expect(decoded.to).toBe(spender);
    expect(decoded.asset.toLowerCase()).toBe(CHAIN_DEFAULTS.evm.asset.toLowerCase());
    expect(decoded.amount_atomic).toBe((2n ** 160n - 1n).toString());
    expect(decoded.network).toBe(`eip155:${CHAIN_ID}`);
    expect(decoded.dedupe_key.startsWith(`evm712:${CHAIN_ID}:${PERMIT2}:PermitSingle:`)).toBe(true);
  });

  it("PermitBatch gives one approve leg per detail, each with its own asset and key", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    const spender = names().get("attacker").address as Hex;
    await wrapped.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: {
        PermitBatch: [
          { name: "details", type: "PermitDetails[]" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
      primaryType: "PermitBatch",
      message: {
        details: [
          { token: OTHER_TOKEN, amount: 5n, expiration: 9_999_999_999, nonce: 0 },
          {
            token: CHAIN_DEFAULTS.evm.asset as Hex,
            amount: 9_000_000n,
            expiration: 9_999_999_999,
            nonce: 0,
          },
        ],
        spender,
        sigDeadline: 9_999_999_999n,
      },
    });
    const decoded = await shimDecoded(0);
    const legs = decoded.legs ?? [];
    expect(legs).toHaveLength(2);
    const [first, second] = legs;
    expect(first?.scheme).toBe("approve");
    expect(second?.scheme).toBe("approve");
    expect(first?.valid && second?.valid).toBe(true);
    expect(first?.to).toBe(spender);
    expect(second?.to).toBe(spender);
    expect(first?.asset).toBe(getAddress(OTHER_TOKEN));
    expect(first?.amount_atomic).toBe("5");
    expect(second?.asset).toBe(getAddress(CHAIN_DEFAULTS.evm.asset));
    expect(second?.amount_atomic).toBe("9000000");
    expect(first?.dedupe_key).not.toBe(second?.dedupe_key);
    expect(decoded.dedupe_key).toBe(first?.dedupe_key);
  });

  it("an x402 upto Permit2 payment to the upto proxy is a valid transfer to witness.to", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    const payTo = names().get("legit").address as Hex;
    await wrapped.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: {
        PermitWitnessTransferFrom: permit2WitnessTypes.PermitWitnessTransferFrom,
        TokenPermissions: permit2WitnessTypes.TokenPermissions,
        Witness: [
          { name: "to", type: "address" },
          { name: "facilitator", type: "address" },
          { name: "validAfter", type: "uint256" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: CHAIN_DEFAULTS.evm.asset as Hex, amount: 3_000n },
        spender: X402_UPTO_PERMIT2_PROXY,
        nonce: 21n,
        deadline: 9_999_999_999n,
        witness: { to: payTo, facilitator: names().get("attacker").address as Hex, validAfter: 0n },
      },
    });
    const decoded = await shimDecoded(0);
    expect(decoded.valid).toBe(true);
    expect(decoded.to).toBe(payTo);
    expect(decoded.amount_atomic).toBe("3000");
  });

  it("a shim witness transfer to an untrusted spender is invalid and pays the spender", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    const spender = names().get("attacker").address as Hex;
    await wrapped.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: permit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: CHAIN_DEFAULTS.evm.asset as Hex, amount: 3_000n },
        spender,
        nonce: 22n,
        deadline: 9_999_999_999n,
        witness: { to: names().get("legit").address as Hex, validAfter: 0n },
      },
    });
    const decoded = await shimDecoded(0);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("untrusted_permit2_spender");
    expect(decoded.to).toBe(spender);
  });

  it("a domain chainId that is not a safe integer gives no network", async () => {
    const account = agentAccount();
    const decoded = await capture.decodeShimEvent({
      kind: "evm_typed_data",
      payload: {
        domain: { name: "Login", chainId: "99999999999999999999999999" },
        types: { Login: [{ name: "contents", type: "string" }] },
        primaryType: "Login",
        message: { contents: "x" },
        signature: "0x1234",
        address: account.address,
      },
    });
    expect(decoded.network).toBe("");
    expect(decoded.valid).toBe(false);
  });

  it("PermitTransferFrom without a witness is a transfer to the spender", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    const spender = names().get("attacker").address as Hex;
    await wrapped.signTypedData({
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: {
        PermitTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      primaryType: "PermitTransferFrom",
      message: {
        permitted: { token: CHAIN_DEFAULTS.evm.asset as Hex, amount: 4_000n },
        spender,
        nonce: 12n,
        deadline: 9_999_999_999n,
      },
    });
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.valid).toBe(true);
    expect(decoded.to).toBe(spender);
    expect(decoded.amount_atomic).toBe("4000");
    expect(decoded.dedupe_key).toBe("evm:12");
  });

  it("an unrecognised primaryType is unknown_typed_data with amount 0", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    await wrapped.signTypedData({
      domain: { name: "Login", version: "1", chainId: CHAIN_ID },
      types: { Login: [{ name: "contents", type: "string" }] },
      primaryType: "Login",
      message: { contents: "sign in to claim your refund" },
    });
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("unknown_typed_data");
    expect(decoded.valid).toBe(true);
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.from).toBe(agentAccount().address);
  });

  it("two EIP-2612 Permits on different tokens, both nonce 0, are distinct and neither is a replay", async () => {
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    for (const token of [CHAIN_DEFAULTS.evm.asset, OTHER_TOKEN]) {
      await wrapped.signTypedData({
        domain: { name: "Token", version: "1", chainId: CHAIN_ID, verifyingContract: token as Hex },
        types: eip2612Types,
        primaryType: "Permit",
        message: {
          owner: account.address,
          spender: PERMIT2,
          value: 1_000n,
          nonce: 0n,
          deadline: 9_999_999_999n,
        },
      });
    }
    const first = await shimDecoded(0);
    const second = await shimDecoded(1);
    expect(first.valid && second.valid).toBe(true);
    expect(first.dedupe_key).not.toBe(second.dedupe_key);

    const prior = [
      {
        payment_id: "p1",
        seq: 1,
        capture: "shim" as const,
        chain: "evm" as const,
        network: first.network,
        scheme: first.scheme,
        asset: first.asset,
        from: first.from,
        to: first.to,
        amount_atomic: first.amount_atomic,
        amount_usd: 0.001,
        dedupe_key: first.dedupe_key,
        instruction_source: "none" as const,
        replay: false,
        valid: true,
        asset_known: true,
      },
    ];
    const attribution = capture.attribute(second, { challenges: [], pageBodies: [], prior });
    expect(attribution.replay).toBe(false);
  });

  it("a Permit whose owner is not the signer is bad_signature", async () => {
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    await wrapped.signTypedData({
      domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: eip2612Types,
      primaryType: "Permit",
      message: {
        owner: names().get("legit").address as Hex,
        spender: PERMIT2,
        value: 1n,
        nonce: 0n,
        deadline: 1n,
      },
    });
    const decoded = await shimDecoded(0);
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
  });
});

describe("messages, raw digests and EIP-7702 authorizations (shim)", () => {
  it("signMessage posts one evm_message event, decoded as a $0 message leg", async () => {
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    const signature = await wrapped.signMessage({ message: "I agree to the terms" });
    await wrapped.signMessage({ message: { raw: "0xdeadbeef" } });

    expect(ledger.events.map((e) => e.kind)).toEqual(["evm_message", "evm_message"]);
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("message");
    expect(decoded.valid).toBe(true);
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.from).toBe(account.address);
    expect(decoded.dedupe_key).toBe(`evmsig:${account.address}:${keccak256(signature)}`);
    const raw = await shimDecoded(1);
    expect(raw.valid).toBe(true);
    expect(raw.dedupe_key).not.toBe(decoded.dedupe_key);
  });

  it("a message event claiming another signer is bad_signature", async () => {
    const account = agentAccount();
    const signature = await account.signMessage({ message: "hello" });
    const decoded = await capture.decodeShimEvent({
      kind: "evm_message",
      payload: { message: "hello", signature, signer: names().get("legit").address },
    });
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
  });

  it("the same message signature decodes to the same key on every capture layer", async () => {
    // A future submission route records through the same decoder, so it merges with the
    // shim capture of the same signature.
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    const signature = await wrapped.signMessage({ message: "claim" });
    const fromShim = await shimDecoded(0);
    const submitted = await capture.decodeShimEvent({
      kind: "evm_message",
      payload: { message: "claim", signature, signer: account.address.toLowerCase() },
    });
    expect(submitted.dedupe_key).toBe(fromShim.dedupe_key);
  });

  it("sign({hash}) posts one evm_raw_sign event, decoded as a $0 message leg", async () => {
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    const hash = keccak256("0x1234");
    const sign = wrapped.sign;
    if (!sign) throw new Error("wrapped account has no sign");
    const signature = await sign({ hash });

    expect(ledger.events.map((e) => e.kind)).toEqual(["evm_raw_sign"]);
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("message");
    expect(decoded.valid).toBe(true);
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.from).toBe(account.address);
    expect(decoded.dedupe_key).toBe(`evmsig:${account.address}:${keccak256(signature)}`);
  });

  it("signAuthorization posts one evm_authorization event, decoded as a delegate grant", async () => {
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    const delegate = names().get("attacker").address as Hex;
    const signAuthorization = wrapped.signAuthorization;
    if (!signAuthorization) throw new Error("wrapped account has no signAuthorization");
    await signAuthorization({ address: delegate, chainId: CHAIN_ID, nonce: 3 });
    await signAuthorization({ address: delegate, chainId: 0, nonce: 4 });

    expect(ledger.events.map((e) => e.kind)).toEqual(["evm_authorization", "evm_authorization"]);
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("delegate");
    expect(decoded.valid).toBe(true);
    expect(decoded.authority_grant).toBe(true);
    expect(decoded.from).toBe(account.address);
    expect(decoded.to).toBe(delegate);
    expect(decoded.network).toBe(`eip155:${CHAIN_ID}`);
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.dedupe_key).toBe(`evm7702:${CHAIN_ID}:${account.address}:3`);

    const anyChain = await shimDecoded(1);
    expect(anyChain.network).toBe("eip155:*");
    expect(anyChain.valid).toBe(true);
    expect(anyChain.dedupe_key).toBe(`evm7702:0:${account.address}:4`);
  });

  it("a transaction-level authorization list is a delegate grant that merges with the shim authorization", async () => {
    const account = agentAccount();
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    const delegate = names().get("attacker").address as Hex;
    const signAuthorization = wrapped.signAuthorization;
    if (!signAuthorization) throw new Error("wrapped account has no signAuthorization");
    const authorization = await signAuthorization({
      address: delegate,
      chainId: CHAIN_ID,
      nonce: 1,
    });
    await wrapped.signTransaction({
      type: "eip7702",
      chainId: CHAIN_ID,
      nonce: 0,
      to: account.address,
      data: "0x",
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      authorizationList: [authorization],
    });

    expect(ledger.events.map((e) => e.kind)).toEqual(["evm_authorization", "evm_tx"]);
    const fromAuth = await shimDecoded(0);
    const fromTx = await shimDecoded(1);
    const delegateLeg = (fromTx.legs ?? []).find((l) => l.scheme === "delegate");
    expect(delegateLeg).toBeDefined();
    expect(delegateLeg?.valid).toBe(true);
    expect(delegateLeg?.authority_grant).toBe(true);
    expect(delegateLeg?.invalid_reason).toBeUndefined();
    expect(delegateLeg?.from).toBe(account.address);
    expect(delegateLeg?.to).toBe(delegate);
    expect(delegateLeg?.network).toBe(`eip155:${CHAIN_ID}`);
    expect(delegateLeg?.dedupe_key).toBe(fromAuth.dedupe_key);
  });

  it("a transaction-level authorization signed by someone else names that authority", async () => {
    const relayer = privateKeyToAccount(names().get("legit").secret as Hex);
    const account = agentAccount();
    const delegate = names().get("attacker").address as Hex;
    const authorization = await account.signAuthorization({
      address: delegate,
      chainId: 0,
      nonce: 0,
    });
    const serialized = await relayer.signTransaction({
      type: "eip7702",
      chainId: CHAIN_ID,
      nonce: 0,
      to: account.address,
      data: "0x",
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      authorizationList: [authorization],
    });
    const decoded = await decodeEvmTx({ serialized });
    const delegateLeg = (decoded.legs ?? []).find((l) => l.scheme === "delegate");
    expect(delegateLeg?.from).toBe(account.address);
    expect(delegateLeg?.network).toBe("eip155:*");
    expect(delegateLeg?.dedupe_key).toBe(`evm7702:0:${account.address}:0`);
  });

  it("a raw-digest event claiming another signer is bad_signature", async () => {
    const account = agentAccount();
    const hash = keccak256("0xabcd");
    const signature = await account.sign({ hash });
    const decoded = await capture.decodeShimEvent({
      kind: "evm_raw_sign",
      payload: { hash, signature, signer: names().get("legit").address },
    });
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
  });

  it("an authorization event claiming another signer is invalid", async () => {
    const account = agentAccount();
    const delegate = names().get("attacker").address;
    const authorization = await account.signAuthorization({
      address: delegate as Hex,
      chainId: CHAIN_ID,
      nonce: 0,
    });
    const decoded = await capture.decodeShimEvent({
      kind: "evm_authorization",
      payload: {
        chainId: CHAIN_ID,
        address: delegate,
        nonce: 0,
        signature: serializeSignature({
          r: authorization.r,
          s: authorization.s,
          yParity: authorization.yParity ?? 0,
        }),
        signer: names().get("legit").address,
      },
    });
    expect(decoded.scheme).toBe("delegate");
    expect(decoded.valid).toBe(false);
    expect(decoded.invalid_reason).toBe("bad_signature");
  });

  it("an authorization with an unparseable chainId or an unsafe nonce is a malformed leg", async () => {
    const account = agentAccount();
    const delegate = names().get("attacker").address;
    const badChain = await decodeEvmAuthorization(
      {
        chainId: "not-a-chain",
        address: delegate,
        nonce: 0,
        signature: "0x12",
        signer: account.address,
      },
      null,
    );
    expect(badChain.network).toBe("");
    expect(badChain.valid).toBe(false);
    expect(badChain.invalid_reason).toBe("malformed_authorization");

    const badNonce = await decodeEvmAuthorization(
      {
        chainId: CHAIN_ID,
        address: delegate,
        nonce: 2 ** 60,
        signature: "0x12",
        signer: account.address,
      },
      null,
    );
    expect(badNonce.network).toBe(`eip155:${CHAIN_ID}`);
    expect(badNonce.valid).toBe(false);
    expect(badNonce.invalid_reason).toBe("malformed_authorization");
  });

  it("a transaction-level authorization that does not recover keeps a transaction key", async () => {
    const account = agentAccount();
    const zero = `0x${"00".repeat(32)}` as Hex;
    const serialized = await account.signTransaction({
      type: "eip7702",
      chainId: CHAIN_ID,
      nonce: 0,
      to: account.address,
      data: "0x",
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      authorizationList: [
        {
          address: names().get("attacker").address as Hex,
          chainId: CHAIN_ID,
          nonce: 0,
          r: zero,
          s: zero,
          yParity: 0,
        },
      ],
    });
    const decoded = await decodeEvmTx({ serialized });
    const delegateLeg = (decoded.legs ?? []).find((l) => l.scheme === "delegate");
    expect(delegateLeg?.valid).toBe(false);
    expect(delegateLeg?.dedupe_key).toBe(`evmtx:${keccak256(serialized)}#7702:0`);
  });

  it("an ERC-20 approve transaction signed through the shim is an approve leg", async () => {
    const wrapped = wrapEvmAccount(agentAccount(), { ledgerUrl: ledger.url });
    const spender = names().get("attacker").address as Hex;
    const serialized = await wrapped.signTransaction({
      chainId: CHAIN_ID,
      nonce: 0,
      to: CHAIN_DEFAULTS.evm.asset as Hex,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 7n] }),
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });
    const decoded = await shimDecoded(0);
    expect(decoded.scheme).toBe("approve");
    expect(decoded.valid).toBe(true);
    expect(decoded.to).toBe(spender);
    expect(decoded.amount_atomic).toBe("7");
    expect(decoded.dedupe_key).toBe(`evmtx:${keccak256(serialized)}#approve`);
  });
});
