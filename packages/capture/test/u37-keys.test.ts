import type { PaymentPayload } from "@x402/core/types";
import {
  agentWallet,
  CHAIN_DEFAULTS,
  canaries,
  type DecodedPayment,
  type OfferedTerms,
  type Payment,
} from "@x402-redteam/schema";
import { getAddress, type Hex, keccak256, parseSignature, serializeSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  decodeEvmAuthorization,
  decodeEvmPayload,
  decodeEvmTx,
  decodeEvmTypedData,
} from "../src/evm.js";
import { eip3009Key, evm7702Key, payloadDigest, permit2Key, sigKey } from "../src/evm-util.js";
import { capture } from "../src/index.js";
import { merge } from "../src/merge.js";

// U37: full EVM dedupe key, layer parity, Permit2 offered-terms reading. Seed-derived keys and
// public ids only, no network.
const SEED = "x402-redteam-v1";
const CHAIN_ID = 84532;
const NETWORK = CHAIN_DEFAULTS.evm.network;
const ASSET = CHAIN_DEFAULTS.evm.asset as Hex;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as Hex;
const names = () => canaries(SEED, "u37-keys", "evm");
const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as Hex);
const legit = names().get("legit").address as Hex;
const other = names().get("attacker").address as Hex;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const PERMIT2_TYPES = {
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

const NONCE = `0x${"ab".repeat(32)}` as Hex;

interface Auth3009 {
  to: Hex;
  value: bigint;
  nonce: Hex;
}

async function sign3009(a: Auth3009, chainId = CHAIN_ID) {
  const message = {
    from: account.address,
    to: a.to,
    value: a.value,
    validAfter: 0n,
    validBefore: 9_999_999_999n,
    nonce: a.nonce,
  };
  const domain = { name: "USDC", version: "2", chainId, verifyingContract: ASSET };
  const signature = await account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  return { message, domain, signature };
}

function accepted(amount: string, payTo: string = legit) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount,
    payTo,
    extra: CHAIN_DEFAULTS.evm.extra,
  };
}

async function header3009(a: Auth3009, hints?: Parameters<typeof decodeEvmPayload>[1]) {
  const { message, signature } = await sign3009(a);
  const payload = {
    x402Version: 2,
    accepted: accepted(a.value.toString(), a.to),
    payload: {
      signature,
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: "0",
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
    },
  } as unknown as PaymentPayload;
  return decodeEvmPayload(payload, hints);
}

async function shim3009(a: Auth3009) {
  const { message, domain, signature } = await sign3009(a);
  return decodeEvmTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
    signature,
    address: account.address,
  });
}

async function rpc3009(a: Auth3009, yParityAsV: "legacy" | "zero") {
  const { signature } = await sign3009(a);
  const sig = parseSignature(signature);
  const { encodeFunctionData } = await import("viem");
  const abi = [
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
  const y = sig.yParity ?? 0;
  const data = encodeFunctionData({
    abi,
    functionName: "transferWithAuthorization",
    args: [
      account.address,
      a.to,
      a.value,
      0n,
      9_999_999_999n,
      a.nonce,
      yParityAsV === "legacy" ? 27 + y : y,
      sig.r,
      sig.s,
    ],
  });
  const relayer = privateKeyToAccount(names().get("attacker").secret as Hex);
  const serialized = await relayer.signTransaction({
    chainId: CHAIN_ID,
    nonce: 0,
    to: ASSET,
    data,
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    type: "eip1559",
  });
  return decodeEvmTx({ serialized });
}

let seq = 0;
function asPayment(d: DecodedPayment, capture: Payment["capture"]): Payment {
  seq += 1;
  return {
    payment_id: `p${seq}`,
    seq,
    capture,
    chain: "evm",
    network: d.network,
    scheme: d.scheme,
    asset: d.asset,
    from: d.from,
    to: d.to,
    amount_atomic: d.amount_atomic,
    amount_usd: 0,
    dedupe_key: d.dedupe_key,
    instruction_source: "none",
    replay: false,
    valid: d.valid,
    ...(d.terms_verified ? { terms_verified: d.terms_verified } : {}),
  } as Payment;
}

function ledgerOf(legs: [DecodedPayment, Payment["capture"]][]): Payment[] {
  return legs.reduce<Payment[]>((acc, [d, c]) => merge(acc, asPayment(d, c)), []);
}

describe("AC-1: two authorizations that share a nonce are two payments", () => {
  it("EIP-3009 with a different payee", async () => {
    const a = await header3009({ to: legit, value: 1000n, nonce: NONCE });
    const b = await header3009({ to: other, value: 1000n, nonce: NONCE });
    expect(a.valid && b.valid).toBe(true);
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
    expect(
      ledgerOf([
        [a, "header"],
        [b, "header"],
      ]),
    ).toHaveLength(2);
  });

  it("EIP-3009 with a different amount", async () => {
    const a = await header3009({ to: legit, value: 1000n, nonce: NONCE });
    const b = await header3009({ to: legit, value: 2000n, nonce: NONCE });
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
    expect(
      ledgerOf([
        [a, "header"],
        [b, "header"],
      ]),
    ).toHaveLength(2);
  });

  it("Permit2 SignatureTransfers sharing a nonce", async () => {
    const a = await permit2Decoded({ to: legit, amount: 1000n });
    const b = await permit2Decoded({ to: other, amount: 1000n });
    const c = await permit2Decoded({ to: legit, amount: 3000n });
    expect(new Set([a.dedupe_key, b.dedupe_key, c.dedupe_key]).size).toBe(3);
    expect(
      ledgerOf([
        [a, "header"],
        [b, "header"],
        [c, "header"],
      ]),
    ).toHaveLength(3);
  });
});

describe("AC-2: one authorization seen by every layer is one entry", () => {
  const a: Auth3009 = { to: legit, value: 1000n, nonce: NONCE };

  it("EIP-3009 header + shim + RPC calldata share a key, in every arrival order", async () => {
    const header = await header3009(a);
    const shim = await shim3009(a);
    const rpcLegacy = await rpc3009(a, "legacy");
    const rpcZero = await rpc3009(a, "zero");
    for (const rpc of [rpcLegacy, rpcZero]) {
      expect(rpc.dedupe_key).toBe(header.dedupe_key);
    }
    expect(shim.dedupe_key).toBe(header.dedupe_key);
    const layers: [DecodedPayment, Payment["capture"]][] = [
      [header, "header"],
      [shim, "shim"],
      [rpcLegacy, "rpc"],
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [1, 0, 2],
    ]) {
      const ledger = ledgerOf(order.map((i) => layers[i] as [DecodedPayment, Payment["capture"]]));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.capture).toBe("header+rpc+shim");
    }
  });

  it("typed data shim + submitted share a key", async () => {
    const shim = await shim3009(a);
    const submitted = await shim3009(a);
    const ledger = ledgerOf([
      [shim, "shim"],
      [submitted, "submitted"],
    ]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.capture).toBe("shim+submitted");
  });

  it("Permit2 header + shim share a key", async () => {
    const header = await permit2Decoded({ to: legit, amount: 1000n });
    const shim = await permit2Shim({ to: legit, amount: 1000n });
    expect(shim.dedupe_key).toBe(header.dedupe_key);
    expect(
      ledgerOf([
        [shim, "shim"],
        [header, "header"],
      ]),
    ).toHaveLength(1);
  });

  it("a signature in 65-byte (v 0/1/27/28) and EIP-2098 compact form has one sigKey", async () => {
    const { signature } = await sign3009(a);
    const sig = parseSignature(signature);
    const y = sig.yParity ?? 0;
    const zeroV = `0x${signature.slice(2, 130)}${y.toString(16).padStart(2, "0")}` as Hex;
    const legacyV = `0x${signature.slice(2, 130)}${(27 + y).toString(16)}` as Hex;
    const yS = (BigInt(sig.s) | (BigInt(y) << 255n)).toString(16).padStart(64, "0");
    const compact = `${sig.r}${yS}` as Hex;
    const key = sigKey(signature);
    expect(sigKey(zeroV)).toBe(key);
    expect(sigKey(legacyV)).toBe(key);
    expect(sigKey(compact)).toBe(key);
    expect(sigKey(signature.toUpperCase().replace("0X", "0x"))).toBe(key);
  });

  it("builders agree across hex and decimal forms and address case", () => {
    const base = {
      from: "0xAbC0000000000000000000000000000000000001",
      to: legit,
      nonce: NONCE,
      signature: undefined,
    };
    expect(eip3009Key({ ...base, value: "0x0f4240" })).toBe(
      eip3009Key({ ...base, value: 1000000n }),
    );
    expect(eip3009Key({ ...base, value: "1000000", from: base.from.toLowerCase() })).toBe(
      eip3009Key({ ...base, value: "1000000" }),
    );
    expect(eip3009Key({ ...base, value: 1n })).toMatch(/:nosig$/);
    expect(eip3009Key({ ...base, value: 1n, signature: "not hex" })).toMatch(/:badsig$/);
    expect(sigKey("0xdeadbeef")).toBe(keccak256("0xdeadbeef"));
  });

  it("7702: the shim authorization and the transaction-embedded copy share a key", async () => {
    const authorization = await account.signAuthorization({
      address: other,
      chainId: CHAIN_ID,
      nonce: 5,
    });
    const shimSig = serializeSignature({
      r: authorization.r,
      s: authorization.s,
      yParity: authorization.yParity ?? 0,
    });
    const shim = await decodeEvmAuthorization(
      { chainId: CHAIN_ID, address: other, nonce: 5, signature: shimSig, signer: account.address },
      {},
    );
    const shimZeroV = await decodeEvmAuthorization(
      {
        chainId: CHAIN_ID,
        address: other,
        nonce: 5,
        signature: `0x${shimSig.slice(2, 130)}0${authorization.yParity ?? 0}` as Hex,
        signer: account.address,
      },
      {},
    );
    const relayer = privateKeyToAccount(names().get("attacker").secret as Hex);
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
    const tx = await decodeEvmTx({ serialized });
    const embedded = (tx.legs ?? []).find((l) => l.scheme === "delegate");
    expect(shim.valid).toBe(true);
    expect(embedded?.dedupe_key).toBe(shim.dedupe_key);
    expect(shimZeroV.dedupe_key).toBe(shim.dedupe_key);
    expect(
      ledgerOf([
        [shim, "shim"],
        [embedded as DecodedPayment, "rpc"],
      ]),
    ).toHaveLength(1);
  });
});

describe("AC-4: other keys", () => {
  it("two unsupported EVM payloads are two entries", async () => {
    const mk = (n: number) => ({ x402Version: 2, accepted: accepted("1"), payload: { weird: n } });
    const a = await decodeEvmPayload(mk(1) as unknown as PaymentPayload);
    const b = await decodeEvmPayload(mk(2) as unknown as PaymentPayload);
    expect(a.dedupe_key).toBe(`evm:unknown:${payloadDigest(mk(1))}`);
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
    expect(
      ledgerOf([
        [a, "header"],
        [b, "header"],
      ]),
    ).toHaveLength(2);
  });

  it("two 7702 authorizations with one nonce and different delegates are two entries", async () => {
    const mk = async (delegate: Hex) => {
      const auth = await account.signAuthorization({
        address: delegate,
        chainId: CHAIN_ID,
        nonce: 9,
      });
      return decodeEvmAuthorization(
        {
          chainId: CHAIN_ID,
          address: delegate,
          nonce: 9,
          signature: serializeSignature({ r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 }),
          signer: account.address,
        },
        {},
      );
    };
    const a = await mk(other);
    const b = await mk(legit);
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
    expect(
      ledgerOf([
        [a, "shim"],
        [b, "shim"],
      ]),
    ).toHaveLength(2);
  });

  it("unknown typed data with one nonce and different content are two entries", async () => {
    const mk = async (contents: string) => {
      const types = {
        Vote: [
          { name: "nonce", type: "uint256" },
          { name: "contents", type: "string" },
        ],
      } as const;
      const domain = { name: "Dao", chainId: CHAIN_ID, verifyingContract: other };
      const message = { nonce: 3n, contents };
      const signature = await account.signTypedData({
        domain,
        types,
        primaryType: "Vote",
        message,
      });
      return decodeEvmTypedData({
        domain,
        types,
        primaryType: "Vote",
        message,
        signature,
        address: account.address,
      });
    };
    const a = await mk("yes");
    const b = await mk("no");
    expect(a.scheme).toBe("unknown_typed_data");
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
    expect(
      ledgerOf([
        [a, "shim"],
        [b, "shim"],
      ]),
    ).toHaveLength(2);
  });

  it("message, raw-sign and tx keys keep their shapes", async () => {
    const msgSig = await account.signMessage({ message: "hi" });
    const msg = await capture.decodeShimEvent({
      kind: "evm_message",
      payload: { message: "hi", signature: msgSig, signer: account.address },
    } as never);
    expect(msg.dedupe_key).toBe(`evmsig:${getAddress(account.address)}:${keccak256(msgSig)}`);
    const relayer = privateKeyToAccount(names().get("attacker").secret as Hex);
    const serialized = await relayer.signTransaction({
      chainId: CHAIN_ID,
      nonce: 0,
      to: other,
      value: 5n,
      gas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });
    expect((await decodeEvmTx({ serialized })).dedupe_key).toBe(`evmtx:${keccak256(serialized)}`);
    const k7702 = evm7702Key({
      chainId: 1,
      authority: "0xAA",
      delegate: "0xBB",
      nonce: "0x2",
      signature: undefined,
    });
    expect(k7702).toBe("evm7702:1:0xaa:0xbb:2:nosig");
    expect(
      permit2Key({
        from: "0xA",
        token: "0xB",
        spender: "0xC",
        to: "0xD",
        amount: "0x10",
        nonce: 7,
        signature: undefined,
      }),
    ).toBe("permit2:0xa:0xb:0xc:0xd:16:7:nosig");
  });
});

// ---- Permit2 -------------------------------------------------------------------------

interface P2 {
  to: Hex;
  amount: bigint;
  spender?: Hex;
  chainId?: number;
  nonce?: bigint;
}

async function permit2Sign(p: P2) {
  const message = {
    permitted: { token: ASSET, amount: p.amount },
    spender: p.spender ?? PROXY,
    nonce: p.nonce ?? 31n,
    deadline: 9_999_999_999n,
    witness: { to: p.to, validAfter: 0n },
  };
  const domain = {
    name: "Permit2",
    chainId: p.chainId ?? CHAIN_ID,
    verifyingContract: PERMIT2 as Hex,
  };
  const signature = await account.signTypedData({
    domain,
    types: PERMIT2_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message,
  });
  return { message, domain, signature };
}

async function permit2Decoded(p: P2, hints?: Parameters<typeof decodeEvmPayload>[1]) {
  const { message, signature } = await permit2Sign(p);
  const payload = {
    x402Version: 2,
    accepted: { ...accepted(p.amount.toString(), p.to), extra: { assetTransferMethod: "permit2" } },
    payload: {
      signature,
      permit2Authorization: {
        from: account.address,
        permitted: { token: ASSET, amount: p.amount.toString() },
        spender: message.spender,
        nonce: message.nonce.toString(),
        deadline: message.deadline.toString(),
        witness: { to: p.to, validAfter: "0" },
      },
    },
  } as unknown as PaymentPayload;
  return decodeEvmPayload(payload, hints);
}

async function permit2Shim(p: P2) {
  const { message, domain, signature } = await permit2Sign(p);
  return decodeEvmTypedData({
    domain,
    types: PERMIT2_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message,
    signature,
    address: account.address,
  });
}

const term = (over: Partial<OfferedTerms> = {}): OfferedTerms => ({
  network: NETWORK,
  asset: ASSET,
  payTo: legit,
  amount: "2000",
  ...over,
});

describe("AC-8: Permit2 offered-terms reading", () => {
  const hints = (t: OfferedTerms) => ({ offeredTerms: [t] });

  it("an honest transfer reads offered", async () => {
    const d = await permit2Decoded({ to: legit, amount: 2000n }, hints(term()));
    expect(d.valid).toBe(true);
    expect(d.terms_verified).toBe("offered");
  });

  it("no offered terms: no reading", async () => {
    const d = await permit2Decoded({ to: legit, amount: 2000n });
    expect(d.terms_verified).toBeUndefined();
  });

  it("an offered network the signature was not made for gives client_copy", async () => {
    const d = await permit2Decoded(
      { to: legit, amount: 2000n },
      hints(term({ network: "eip155:8453" })),
    );
    expect(d.valid).toBe(true);
    expect(d.terms_verified).toBe("client_copy");
  });

  it("a different witness recipient or amount is domain-only, valid unchanged", async () => {
    const to = await permit2Decoded({ to: other, amount: 2000n }, hints(term()));
    const amount = await permit2Decoded({ to: legit, amount: 2001n }, hints(term()));
    for (const d of [to, amount]) {
      expect(d.valid).toBe(true);
      expect(d.terms_verified).toBe("offered_domain_only");
    }
  });

  it("an untrusted spender is never offered", async () => {
    const d = await permit2Decoded({ to: legit, amount: 2000n, spender: other }, hints(term()));
    expect(d.valid).toBe(false);
    expect(d.invalid_reason).toBe("untrusted_permit2_spender");
    expect(d.terms_verified).toBe("offered_domain_only");
  });

  it("a bad signature reads none", async () => {
    const good = await permit2Sign({ to: legit, amount: 2000n });
    const payload = {
      x402Version: 2,
      accepted: accepted("2000"),
      payload: {
        signature: good.signature,
        permit2Authorization: {
          from: account.address,
          permitted: { token: ASSET, amount: "2001" },
          spender: PROXY,
          nonce: "31",
          deadline: "9999999999",
          witness: { to: legit, validAfter: "0" },
        },
      },
    } as unknown as PaymentPayload;
    const d = await decodeEvmPayload(payload, hints(term()));
    expect(d.valid).toBe(false);
    expect(d.terms_verified).toBe("none");
  });
});
