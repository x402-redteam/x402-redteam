import type { DecodedPayment, PaymentPayload } from "@x402-redteam/schema";
import { CHAIN_DEFAULTS, NATIVE_ASSET } from "@x402-redteam/schema";
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
 * True iff `value` is a valid non-negative decimal integer string (digits only - no
 * sign, no fractional part, no leading/trailing whitespace, no hex/scientific
 * notation). A decoded on-chain amount (ERC-20 `uint256` via `decodeFunctionData`, a
 * native tx's `value`) is always shaped like this by construction - the EVM has no
 * negative integers - but a header/shim payload's `authorization.value` is an
 * untyped string an agent (or attacker) controls directly, so it must be checked
 * before use (orchestrator addition, U9-B review: "negative_amount").
 */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

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

/**
 * Parses a value that may arrive as a `bigint` (an in-process real client
 * call), a numeric string (JSON-decoded, e.g. a shim event posted over
 * HTTP), or a plain number, into a `bigint`. Returns `undefined` when the
 * value can't be parsed, so callers can leave `authorization_seconds` unset
 * rather than throw.
 */
function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value !== "") {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * v2 (authorization_lifetime, application-design.md §4 "v2" `Payment.authorization_seconds`).
 *
 * Orchestrator decision (U11 finding, post-review): the real @x402/evm@2.28.0 exact-EVM
 * client sets `validAfter: "0"` (a constant) and `validBefore: now + maxTimeoutSeconds`
 * (`now` = the *signer's* wall clock), so a plain `validBefore - validAfter` difference is
 * not a stable "window duration" at all - it's dominated by whichever epoch `validAfter`
 * happens to be. Instead this reports *the remaining authorization window at the harness's
 * receipt time*: `validBefore - max(validAfter, nowSeconds)`, where `nowSeconds` is the
 * harness's own wall clock (in whole seconds) at decode time. Can be negative (an already-
 * expired authorization, itself a signal). This is inherently wall-clock-dependent by
 * design - callers must keep it out of `report.json` (see `packages/scorer/src/score-suite.ts`,
 * which strips it the same way it strips `raw`/`dedupe_key`) and only persist it in the
 * full per-run ledger (`out/runs/*.json`).
 */
function authorizationSeconds(validAfter: unknown, validBefore: unknown): number | undefined {
  const after = toBigIntOrUndefined(validAfter);
  const before = toBigIntOrUndefined(validBefore);
  if (after === undefined || before === undefined) return undefined;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const effectiveAfter = after > nowSeconds ? after : nowSeconds;
  return Number(before - effectiveAfter);
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

function decodePermit2(accepted: EvmAccepted, inner: Permit2Inner, raw: unknown): DecodedPayment {
  const { permit2Authorization } = inner;
  const amount_atomic = permit2Authorization.permitted?.amount ?? "0";
  // M3 (code review): an amount that isn't even a valid non-negative integer is a more
  // specific, more useful signal than the generic "we don't support Permit2" reason.
  const invalid_reason = isNonNegativeIntegerString(amount_atomic)
    ? "unsupported_transfer_method"
    : "negative_amount";
  return {
    chain: "evm",
    network: accepted.network,
    scheme: accepted.scheme,
    asset: accepted.asset,
    from: permit2Authorization.from ?? "",
    to: permit2Authorization.witness?.to ?? "",
    amount_atomic,
    dedupe_key: `evm:${permit2Authorization.nonce ?? "unknown"}`,
    valid: false,
    invalid_reason,
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
    authorization_seconds: authorizationSeconds(message.validAfter, message.validBefore),
    raw: payload,
  };

  // M3 (code review): check before attempting signature verification, same as decodeEip3009.
  if (!isNonNegativeIntegerString(amount_atomic)) {
    return { ...base, invalid_reason: "negative_amount" };
  }

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
 * - An EIP-7702 `authorizationList` entry is its own leg (`invalid_reason:
 *   "unsupported_authority_grant"`, `to` = the delegated-to contract), independent of any
 *   calldata/value leg in the same tx.
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

  // EIP-7702: hands control of the signer's EOA to another address - independent of, and
  // in addition to, any calldata/value leg below.
  const authorizationList = (tx as { authorizationList?: readonly { address?: string }[] })
    .authorizationList;
  if (authorizationList && authorizationList.length > 0) {
    rawLegs.push({
      scheme: "approve",
      asset: "",
      from: signer,
      to: authorizationList[0]?.address ?? "",
      amount_atomic: "0",
      dedupe_key: `evmtx:${hash}#7702`,
      invalid_reason: "unsupported_authority_grant",
    });
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

  const legs = rawLegs.map((leg) => finalizeLeg(leg, network, signerValid, payload));
  const [first, ...rest] = legs;
  return { ...(first as DecodedPayment), legs: [first as DecodedPayment, ...rest] };
}
