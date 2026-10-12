import type { DecodedPayment, PaymentPayload } from "@x402-redteam/schema";
import { CHAIN_DEFAULTS, NATIVE_ASSET } from "@x402-redteam/schema";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeSignature,
  type TransactionSerialized,
  verifyTypedData,
} from "viem";
import {
  decodeEvmAuthorization,
  decodeEvmMessage,
  decodeEvmRawSign,
  decodeTypedData,
  EIP2612_PERMIT_TYPES,
  PERMIT2_ADDRESS,
  PERMIT2_WITNESS_TYPES,
  sameAddress,
} from "./evm-signatures.js";
import { authorizationSeconds, isNonNegativeIntegerString, normalizeAddress } from "./evm-util.js";

export { decodeEvmAuthorization, decodeEvmMessage, decodeEvmRawSign };

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

/**
 * EIP-3009 `transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)`
 * calldata shape, per U10 functional-design.md §3 (ADR-013): a direct, non-x402
 * submission of a signed authorization straight to the token contract (rather than
 * through the facilitator's header path). Not part of viem's `erc20Abi` (that ABI is
 * the plain ERC-20 standard, not the EIP-3009 extension USDC and similar tokens add).
 */
const TRANSFER_WITH_AUTHORIZATION_ABI = [
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

/**
 * OpenZeppelin's `increaseAllowance` extension (not part of the ERC-20 standard, so not in
 * viem's `erc20Abi`), and EIP-2612 `permit` (a gasless, off-chain-signed approval). Both are
 * authority-granting calls a direct tx can submit, per code review M2.
 */
const APPROVAL_EXTENSION_ABI = [
  {
    type: "function",
    name: "increaseAllowance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "addedValue", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** `decodeEvmTx`'s calldata ABI: standard ERC-20 (transfer/transferFrom/approve), EIP-3009,
 * increaseAllowance and EIP-2612 permit. */
const DIRECT_TRANSFER_ABI = [
  ...erc20Abi,
  ...TRANSFER_WITH_AUTHORIZATION_ABI,
  ...APPROVAL_EXTENSION_ABI,
] as const;

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
    spender?: string;
    deadline?: string;
    permitted: { token: string; amount: string };
    witness?: { to?: string; validAfter?: string };
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
    authorization_seconds: authorizationSeconds(
      authorization.validAfter,
      authorization.validBefore,
    ),
    raw,
  };
  if (!isNonNegativeIntegerString(base.amount_atomic)) {
    return { ...base, invalid_reason: "negative_amount" };
  }
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

/**
 * A Permit2 witness transfer from the payment header, verified as the x402 exact scheme
 * defines it: domain `{name: "Permit2", chainId, verifyingContract: PERMIT2}`, the
 * `PermitWitnessTransferFrom` types, signed by `from`, for the accepted asset, with the
 * x402 Permit2 proxy as spender (any other spender is `untrusted_permit2_spender`). A
 * correct one is valid and delivers like an EIP-3009 payment. It shares its decoder (and
 * so its `evm:${nonce}` dedupe key) with the shim capture of the same signature.
 */
async function decodePermit2(
  accepted: EvmAccepted,
  inner: Permit2Inner,
  raw: unknown,
): Promise<DecodedPayment> {
  const auth = inner.permit2Authorization ?? ({} as Permit2Inner["permit2Authorization"]);
  const decoded = await decodeTypedData(
    {
      domain: {
        name: "Permit2",
        chainId: optionalChainId(accepted.network),
        verifyingContract: PERMIT2_ADDRESS,
      },
      types: PERMIT2_WITNESS_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: auth.permitted,
        spender: auth.spender,
        nonce: auth.nonce,
        deadline: auth.deadline,
        witness: auth.witness,
      },
      signature: inner.signature,
      signer: auth.from,
    },
    raw,
  );
  const result: DecodedPayment = {
    ...decoded,
    network: accepted.network,
    scheme: accepted.scheme,
    asset: typeof auth.permitted?.token === "string" ? decoded.asset : accepted.asset,
  };
  if (result.valid && !sameAddress(result.asset, accepted.asset)) {
    return { ...result, valid: false, invalid_reason: "asset_mismatch" };
  }
  return result;
}

function optionalChainId(network: string): number | undefined {
  try {
    return evmChainId(network);
  } catch {
    return undefined;
  }
}

/**
 * The legs a payment header's `extensions` carry, beside the payment itself. The client
 * echoes the server's declarations back even when it signed nothing, so a leg is decoded
 * only when a signed artifact is present, never because the extension key is:
 * - `erc20ApprovalGasSponsoring.info.signedTransaction`: a signed approve transaction,
 *   decoded like any other transaction (same dedupe key as its shim and RPC captures).
 * - `eip2612GasSponsoring.info.signature`: an EIP-2612 `Permit`, verified against the
 *   accepted token with the domain name and version from the challenge's `extra`, as the
 *   SDK signs it.
 */
async function decodeExtensionLegs(
  accepted: EvmAccepted,
  extensions: unknown,
): Promise<DecodedPayment[]> {
  if (extensions === null || typeof extensions !== "object") return [];
  const ext = extensions as Record<string, { info?: Record<string, unknown> } | undefined>;
  const legs: DecodedPayment[] = [];

  const permitInfo = ext.eip2612GasSponsoring?.info;
  if (permitInfo && typeof permitInfo.signature === "string") {
    const token = typeof permitInfo.asset === "string" ? permitInfo.asset : accepted.asset;
    const permit = await decodeTypedData(
      {
        domain: {
          name: accepted.extra?.name as string | undefined,
          version: accepted.extra?.version as string | undefined,
          chainId: optionalChainId(accepted.network),
          verifyingContract: normalizeAddress(token),
        },
        types: EIP2612_PERMIT_TYPES,
        primaryType: "Permit",
        message: {
          owner: permitInfo.from,
          spender: permitInfo.spender,
          value: permitInfo.amount,
          nonce: permitInfo.nonce,
          deadline: permitInfo.deadline,
        },
        signature: permitInfo.signature,
        signer: String(permitInfo.from ?? ""),
      },
      { eip2612GasSponsoring: { info: permitInfo } },
    );
    legs.push({ ...permit, network: accepted.network });
  }

  const approvalInfo = ext.erc20ApprovalGasSponsoring?.info;
  if (approvalInfo && typeof approvalInfo.signedTransaction === "string") {
    try {
      const tx = await decodeEvmTx({ serialized: approvalInfo.signedTransaction });
      legs.push(...(tx.legs ?? [tx]));
    } catch {
      // Not a parseable transaction, so nothing was signed that could be submitted.
    }
  }
  return legs;
}

/**
 * Decodes an EVM header payload (`payload.payload = {signature, authorization}` or
 * `{signature, permit2Authorization}` for v2, or the equivalent v1 shape), per
 * functional-design.md §2. Signed gas-sponsoring extensions add further legs
 * (`DecodedPayment.legs`, payment first).
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

  let primary: DecodedPayment | undefined;
  if (isPermit2Shaped(inner)) {
    primary = await decodePermit2(accepted, inner as unknown as Permit2Inner, payload);
  } else if (isEip3009Shaped(inner)) {
    primary = await decodeEip3009(accepted, inner as unknown as Eip3009Inner, payload);
  }
  if (primary) {
    const extensionLegs = await decodeExtensionLegs(accepted, anyPayload.extensions);
    return extensionLegs.length === 0 ? primary : { ...primary, legs: [primary, ...extensionLegs] };
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
 * Decodes an `evm_typed_data` shim event by its primaryType, with signature verification
 * against `payload.address`:
 * - `TransferWithAuthorization`, `ReceiveWithAuthorization` (EIP-3009): a transfer.
 * - `PermitWitnessTransferFrom`, `PermitTransferFrom` (Permit2): a transfer of
 *   `permitted.amount` to `witness.to`, else to the spender.
 * - `Permit` (EIP-2612), `PermitSingle`, `PermitBatch` (Permit2 allowances): scheme
 *   `approve`, `to` = spender, amount = value (or the largest detail).
 * - anything else: scheme `unknown_typed_data`, amount 0.
 */
export async function decodeEvmTypedData(
  payload: EvmTypedDataShimPayload,
): Promise<DecodedPayment> {
  return decodeTypedData(
    {
      domain: (payload.domain ?? {}) as Parameters<typeof decodeTypedData>[0]["domain"],
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message as Record<string, unknown>,
      signature: payload.signature,
      signer: payload.address,
    },
    payload,
  );
}

interface EvmTxShimPayload {
  serialized: string;
}

/** One value-moving or authority-granting leg decoded out of a raw EVM transaction, before
 * the shared validity/negative-amount checks are applied (see `finalizeLeg`). */
interface RawEvmLeg {
  scheme: string;
  asset: string;
  from: string;
  to: string;
  amount_atomic: string;
  dedupe_key: string;
  /** Pre-determined invalid reason (e.g. an unsupported authority grant) that overrides the
   * generic signature-based valid/bad_signature determination. */
  invalid_reason?: string;
  authorization_seconds?: number;
  /** True only for a leg the decoder recognises as withdrawing an allowance. */
  revocation?: boolean;
}

function finalizeLeg(
  leg: RawEvmLeg,
  network: string,
  signerValid: boolean,
  raw: unknown,
): DecodedPayment {
  const base: DecodedPayment = {
    chain: "evm",
    network,
    scheme: leg.scheme,
    asset: leg.asset,
    from: leg.from,
    to: leg.to,
    amount_atomic: leg.amount_atomic,
    dedupe_key: leg.dedupe_key,
    valid: false,
    ...(leg.authorization_seconds !== undefined
      ? { authorization_seconds: leg.authorization_seconds }
      : {}),
    ...(leg.revocation ? { revocation: true } : {}),
    raw,
  };
  if (!isNonNegativeIntegerString(leg.amount_atomic)) {
    return { ...base, invalid_reason: "negative_amount" };
  }
  if (leg.invalid_reason) {
    return { ...base, invalid_reason: leg.invalid_reason };
  }
  return signerValid ? { ...base, valid: true } : { ...base, invalid_reason: "bad_signature" };
}

/** Decodes the calldata leg of a direct tx (transfer/transferFrom/transferWithAuthorization/
 * approve/increaseAllowance/permit), or returns `undefined` for unrecognised/absent calldata. */
function decodeCalldataLeg(
  to: string,
  data: Hex | undefined,
  signer: string,
  hash: string,
): RawEvmLeg | undefined {
  if (!to || !data || data === "0x") return undefined;
  try {
    const decoded = decodeFunctionData({ abi: DIRECT_TRANSFER_ABI, data });
    switch (decoded.functionName) {
      case "transfer": {
        const [decodedTo, decodedAmount] = decoded.args as readonly [string, bigint];
        return {
          scheme: "transfer",
          asset: to,
          from: signer,
          to: decodedTo,
          amount_atomic: decodedAmount.toString(),
          dedupe_key: `evmtx:${hash}`,
        };
      }
      case "transferFrom": {
        const [decodedFrom, decodedTo, decodedAmount] = decoded.args as readonly [
          string,
          string,
          bigint,
        ];
        return {
          scheme: "transfer",
          asset: to,
          from: decodedFrom,
          to: decodedTo,
          amount_atomic: decodedAmount.toString(),
          dedupe_key: `evmtx:${hash}`,
        };
      }
      case "transferWithAuthorization": {
        const [decodedFrom, decodedTo, decodedValue, validAfter, validBefore, nonce] =
          decoded.args as readonly [string, string, bigint, bigint, bigint, Hex, number, Hex, Hex];
        return {
          scheme: "transfer",
          asset: to,
          from: decodedFrom,
          to: decodedTo,
          amount_atomic: decodedValue.toString(),
          // M4 (code review): the same nonce a header-path submission of this exact
          // authorization would use, so a re-issued copy sent directly on-chain merges
          // with the header capture as "header+rpc" (capture/src/merge.ts).
          dedupe_key: `evm:${nonce}`,
          authorization_seconds: authorizationSeconds(validAfter, validBefore),
        };
      }
      case "approve": {
        const [spender, amount] = decoded.args as readonly [string, bigint];
        return {
          scheme: "approve",
          asset: to,
          from: signer,
          to: spender,
          amount_atomic: amount.toString(),
          dedupe_key: `evmtx:${hash}#approve`,
          // approve(spender, 0) withdraws the allowance. increaseAllowance(spender, 0)
          // is a no-op, not a revocation.
          ...(amount === 0n ? { revocation: true } : {}),
        };
      }
      case "increaseAllowance": {
        const [spender, addedValue] = decoded.args as readonly [string, bigint];
        return {
          scheme: "approve",
          asset: to,
          from: signer,
          to: spender,
          amount_atomic: addedValue.toString(),
          dedupe_key: `evmtx:${hash}#approve`,
        };
      }
      case "permit": {
        const [owner, spender] = decoded.args as readonly [
          string,
          string,
          bigint,
          bigint,
          number,
          Hex,
          Hex,
        ];
        return {
          scheme: "approve",
          asset: to,
          from: owner,
          to: spender,
          amount_atomic: "0",
          dedupe_key: `evmtx:${hash}#permit`,
          invalid_reason: "unsupported_authority_grant",
        };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Decodes an `evm_tx` shim event (a direct, non-x402 transfer), per
 * functional-design.md §2. Also submitted verbatim to the mock EVM RPC's
 * `eth_sendRawTransaction` (ADR-013), so this is the one decoder for both the shim
 * and RPC chain-boundary capture layers - see U10 functional-design.md §2/§3.
 *
 * Code review H1/M2: a single transaction can carry more than one value-moving or
 * authority-granting leg, and every one is recorded (`DecodedPayment.legs`):
 * - Calldata decodes to ERC-20 `transfer`/`transferFrom`, EIP-3009
 *   `transferWithAuthorization`, `approve`/`increaseAllowance` (scheme "approve", `to` =
 *   spender), or EIP-2612 `permit` (`invalid_reason: "unsupported_authority_grant"`).
 * - When calldata decodes into one of the above *and* the tx also carries non-zero native
 *   `value`, a second, independent native-value leg is recorded alongside it.
 * - A tx with no recognised calldata (or none at all) is a single native-value leg -
 *   `asset: NATIVE_ASSET` (plain value transfers, including value 0).
 * - Each EIP-7702 `authorizationList` entry is its own leg (scheme `delegate`, `to` = the
 *   delegate, `from` = the recovered authority, valued at the wallet balance), independent
 *   of any calldata/value leg in the same tx.
 * The top-level `DecodedPayment` fields mirror the first leg, for callers that only look at
 * one payment.
 */
export async function decodeEvmTx(payload: EvmTxShimPayload): Promise<DecodedPayment> {
  const serialized = payload.serialized as TransactionSerialized;
  const tx = parseTransaction(serialized);
  let signer = "";
  try {
    signer = await recoverTransactionAddress({ serializedTransaction: serialized });
  } catch {
    signer = "";
  }
  const signerValid = signer !== "";
  const hash = keccak256(serialized);
  const network = tx.chainId != null ? `eip155:${tx.chainId}` : "";

  const rawLegs: RawEvmLeg[] = [];

  // EIP-7702: each authorization hands control of its authority's account to another
  // address - independent of, and in addition to, any calldata/value leg below. Decoded
  // like a wallet's own authorization signature, so the two captures share a dedupe key.
  const authorizationList =
    (
      tx as {
        authorizationList?: readonly {
          address?: string;
          chainId?: number;
          nonce?: number;
          r?: Hex;
          s?: Hex;
          yParity?: number;
        }[];
      }
    ).authorizationList ?? [];
  const delegateLegs: DecodedPayment[] = [];
  for (const [i, entry] of authorizationList.entries()) {
    let signature = "";
    try {
      signature = serializeSignature({
        r: entry.r as Hex,
        s: entry.s as Hex,
        yParity: entry.yParity ?? 0,
      });
    } catch {
      signature = "";
    }
    const leg = await decodeEvmAuthorization(
      {
        chainId: entry.chainId ?? 0,
        address: entry.address ?? "",
        nonce: entry.nonce ?? 0,
        signature,
      },
      payload,
    );
    delegateLegs.push(leg.valid ? leg : { ...leg, dedupe_key: `evmtx:${hash}#7702:${i}` });
  }

  const nativeValue = tx.value ?? 0n;
  const calldataLeg = decodeCalldataLeg(tx.to ?? "", tx.data, signer, hash);
  if (calldataLeg) {
    rawLegs.push(calldataLeg);
    if (nativeValue > 0n) {
      // H1 (code review): calldata AND non-zero native value in the same tx is two
      // distinct legs, not one.
      rawLegs.push({
        scheme: "transfer",
        asset: NATIVE_ASSET,
        from: signer,
        to: tx.to ?? "",
        amount_atomic: nativeValue.toString(),
        dedupe_key: `evmtx:${hash}#value`,
      });
    }
  } else {
    rawLegs.push({
      scheme: "transfer",
      asset: NATIVE_ASSET,
      from: signer,
      to: tx.to ?? "",
      amount_atomic: nativeValue.toString(),
      dedupe_key: `evmtx:${hash}`,
    });
  }

  const legs = [
    ...delegateLegs,
    ...rawLegs.map((leg) => finalizeLeg(leg, network, signerValid, payload)),
  ];
  const [first, ...rest] = legs;
  return { ...(first as DecodedPayment), legs: [first as DecodedPayment, ...rest] };
}
