import type { DecodedPayment, PaymentPayload } from "@x402-redteam/schema";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type TransactionSerialized,
  verifyTypedData,
} from "viem";

/**
 * EIP-712 type definition for EIP-3009 `transferWithAuthorization`, per
 * functional-design.md §2. Hardcoded here (rather than imported from
 * `@x402/evm`) because `@x402/evm` is a dev/test-only dependency of this
 * package - see functional-design.md §1.
 */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** v1 network name -> v2 CAIP-2 network id, per functional-design.md §2. */
export const V1_NETWORK_MAP: Record<string, string> = {
  "base-sepolia": CHAIN_DEFAULTS.evm.network,
  "solana-devnet": CHAIN_DEFAULTS.svm.network,
};

interface EvmAccepted {
  network: string;
  asset: string;
  scheme: string;
  extra?: Record<string, unknown>;
}

interface Eip3009Inner {
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
  signature?: string;
}

interface Permit2Inner {
  signature: string;
  permit2Authorization: {
    from: string;
    nonce: string;
    permitted: { token: string; amount: string };
    witness?: { to?: string };
  };
}

function isPermit2Shaped(payload: Record<string, unknown>): boolean {
  return typeof payload === "object" && payload !== null && "permit2Authorization" in payload;
}

function isEip3009Shaped(payload: Record<string, unknown>): boolean {
  return typeof payload === "object" && payload !== null && "authorization" in payload;
}

function evmChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) {
    throw new Error(`decodeEvmPayload: unsupported network ${network} (expected eip155:CHAIN_ID)`);
  }
  return Number(match[1]);
}

async function decodeEip3009(
  accepted: EvmAccepted,
  inner: Eip3009Inner,
  raw: unknown,
): Promise<DecodedPayment> {
  const { authorization } = inner;
  const base: DecodedPayment = {
    chain: "evm",
    network: accepted.network,
    scheme: accepted.scheme,
    asset: accepted.asset,
    from: authorization.from,
    to: authorization.to,
    amount_atomic: String(authorization.value),
    dedupe_key: `evm:${authorization.nonce}`,
    valid: false,
    raw,
  };
  if (!inner.signature) {
    return { ...base, invalid_reason: "bad_signature" };
  }
  try {
    const chainId = evmChainId(accepted.network);
    const domain = {
      name: (accepted.extra?.name as string | undefined) ?? "USDC",
      version: (accepted.extra?.version as string | undefined) ?? "2",
      chainId,
      verifyingContract: getAddress(accepted.asset),
    };
    const valid = await verifyTypedData({
      address: getAddress(authorization.from),
      domain,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(authorization.from),
        to: getAddress(authorization.to),
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      },
      signature: inner.signature as Hex,
    });
    return valid ? { ...base, valid: true } : { ...base, invalid_reason: "bad_signature" };
  } catch {
    return { ...base, invalid_reason: "bad_signature" };
  }
}

function decodePermit2(accepted: EvmAccepted, inner: Permit2Inner, raw: unknown): DecodedPayment {
  const { permit2Authorization } = inner;
  return {
    chain: "evm",
    network: accepted.network,
    scheme: accepted.scheme,
    asset: accepted.asset,
    from: permit2Authorization.from ?? "",
    to: permit2Authorization.witness?.to ?? "",
    amount_atomic: permit2Authorization.permitted?.amount ?? "0",
    dedupe_key: `evm:${permit2Authorization.nonce ?? "unknown"}`,
    valid: false,
    invalid_reason: "unsupported_transfer_method",
    raw,
  };
}

/**
 * Decodes an EVM header payload (`payload.payload = {signature, authorization}`
 * for v2, or the equivalent v1 shape), per functional-design.md §2.
 */
export async function decodeEvmPayload(
  payload: PaymentPayload | Record<string, unknown>,
): Promise<DecodedPayment> {
  const anyPayload = payload as Record<string, unknown>;
  let accepted: EvmAccepted;
  let inner: Record<string, unknown>;

  if (anyPayload.accepted) {
    const acceptedRaw = anyPayload.accepted as EvmAccepted;
    accepted = acceptedRaw;
    inner = anyPayload.payload as Record<string, unknown>;
  } else {
    // v1: fields live in payload.payload alongside payload.network and
    // payload.scheme, with no `accepted`. There is no asset in the v1
    // envelope at all, so we fall back to this chain's default asset/extra
    // for signature verification (best-effort, per functional-design.md §2).
    const v1Network = anyPayload.network as string;
    accepted = {
      network: V1_NETWORK_MAP[v1Network] ?? v1Network,
      asset: CHAIN_DEFAULTS.evm.asset,
      scheme: anyPayload.scheme as string,
      extra: CHAIN_DEFAULTS.evm.extra,
    };
    inner = anyPayload.payload as Record<string, unknown>;
  }

  if (isPermit2Shaped(inner)) {
    return decodePermit2(accepted, inner as unknown as Permit2Inner, payload);
  }
  if (isEip3009Shaped(inner)) {
    return decodeEip3009(accepted, inner as unknown as Eip3009Inner, payload);
  }
  return {
    chain: "evm",
    network: accepted.network,
    scheme: accepted.scheme,
    asset: accepted.asset,
    from: "",
    to: "",
    amount_atomic: "0",
    dedupe_key: "evm:unknown",
    valid: false,
    invalid_reason: "unsupported_transfer_method",
    raw: payload,
  };
}

interface EvmTypedDataShimPayload {
  domain: unknown;
  types: unknown;
  primaryType: string;
  message: unknown;
  signature: string;
  address: string;
}

/**
 * Decodes an `evm_typed_data` shim event, per functional-design.md §2.
 * Recovers the signer with `recoverTypedDataAddress` and requires it to
 * equal `payload.address`.
 */
export async function decodeEvmTypedData(
  payload: EvmTypedDataShimPayload,
): Promise<DecodedPayment> {
  const domain = payload.domain as {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: string;
  };
  const message = payload.message as Record<string, unknown>;
  const network = domain.chainId != null ? `eip155:${domain.chainId}` : "";
  const from = String(message.from ?? "");
  const to = String(message.to ?? "");
  const value = message.value;
  const amount_atomic = typeof value === "bigint" ? value.toString() : String(value ?? "0");
  const nonce = String(message.nonce ?? "");

  const base: DecodedPayment = {
    chain: "evm",
    network,
    scheme: "exact",
    asset: String(domain.verifyingContract ?? ""),
    from,
    to,
    amount_atomic,
    dedupe_key: `evm:${nonce}`,
    valid: false,
    raw: payload,
  };

  try {
    const recovered = await recoverTypedDataAddress({
      // biome-ignore lint/suspicious/noExplicitAny: shim events carry untyped EIP-712 params over the wire.
      domain: domain as any,
      // biome-ignore lint/suspicious/noExplicitAny: <see above>
      types: payload.types as any,
      primaryType: payload.primaryType,
      // biome-ignore lint/suspicious/noExplicitAny: <see above>
      message: message as any,
      signature: payload.signature as Hex,
    });
    const valid = isAddressEqual(recovered, getAddress(payload.address));
    return valid ? { ...base, valid: true } : { ...base, invalid_reason: "bad_signature" };
  } catch {
    return { ...base, invalid_reason: "bad_signature" };
  }
}

interface EvmTxShimPayload {
  serialized: string;
}

/**
 * Decodes an `evm_tx` shim event (a direct, non-x402 transfer), per
 * functional-design.md §2.
 */
export async function decodeEvmTx(payload: EvmTxShimPayload): Promise<DecodedPayment> {
  const serialized = payload.serialized as TransactionSerialized;
  const tx = parseTransaction(serialized);
  let from = "";
  try {
    from = await recoverTransactionAddress({ serializedTransaction: serialized });
  } catch {
    from = "";
  }
  const dedupe_key = `evmtx:${keccak256(serialized)}`;
  const network = tx.chainId != null ? `eip155:${tx.chainId}` : "";

  let asset = "native";
  let to = tx.to ?? "";
  let amount_atomic = (tx.value ?? 0n).toString();

  if (tx.to && tx.data && tx.data !== "0x") {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (decoded.functionName === "transfer") {
        const [decodedTo, decodedAmount] = decoded.args as readonly [string, bigint];
        asset = tx.to;
        to = decodedTo;
        amount_atomic = decodedAmount.toString();
      }
    } catch {
      // Not an ERC-20 `transfer` call; fall through to native-value handling.
    }
  }

  const valid = from !== "";
  return {
    chain: "evm",
    network,
    scheme: "transfer",
    asset,
    from,
    to,
    amount_atomic,
    dedupe_key,
    valid,
    invalid_reason: valid ? undefined : "bad_signature",
    raw: payload,
  };
}
