import type { DecodedPayment } from "@x402-redteam/schema";
import {
  getAddress,
  type Hex,
  isAddressEqual,
  isHex,
  keccak256,
  recoverAddress,
  recoverTypedDataAddress,
  verifyMessage,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import {
  amountString,
  authorizationSeconds,
  isNonNegativeIntegerString,
  nonceString,
  normalizeAddress,
  toBigIntOrUndefined,
} from "./evm-util.js";

/**
 * Every signature the wallet produces decodes here, whichever layer saw it (payment
 * header, wallet shim, or a later submission route), so one artifact always yields the
 * same `DecodedPayment` and the same `dedupe_key`.
 *
 * Dedupe keys:
 * - EIP-3009 and Permit2 SignatureTransfer keep `evm:${nonce}` (their nonces are random
 *   and unique per owner), so header, shim and on-chain captures merge.
 * - Allowances (EIP-2612 `Permit`, Permit2 `PermitSingle`, `PermitBatch`):
 *   `evm712:${chainId}:${verifyingContract}:${primaryType}:${owner}:${nonce}:${keccak256(signature)}`.
 *   The signature hash keeps two different permits that share a nonce apart (a token that
 *   has not used its permit nonce yet signs every permit with nonce 0); the header and shim
 *   captures of one permit carry the same signature bytes, so they still merge. Permit2
 *   allowance nonces are per (owner, token, spender), so for `PermitSingle` and each
 *   `PermitBatch` detail the nonce part is `${token}:${spender}:${nonce}`.
 * - Other typed data with a `nonce`: `evm712:${chainId}:${verifyingContract}:${primaryType}:${owner}:${nonce}`;
 *   without one, the signature key below.
 * - EIP-7702 authorizations: `evm7702:${chainId}:${authority}:${nonce}`.
 * - Messages and raw digests: `evmsig:${signer}:${keccak256(signature)}`. Signing is
 *   deterministic, so this is equivalent to keying on the signed digest.
 */

/** Canonical Permit2 contract (same address on every chain). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** The x402 exact-scheme Permit2 proxy, the only spender an x402 exact Permit2 payment may name. */
export const X402_EXACT_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
/** The x402 upto-scheme Permit2 proxy. Its witness adds a `facilitator` field. */
export const X402_UPTO_PERMIT2_PROXY = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";

export const PERMIT2_WITNESS_TYPES = {
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

export const EIP2612_PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface TypedDataDomainInput {
  name?: string;
  version?: string;
  chainId?: number | string | bigint;
  verifyingContract?: string;
  salt?: string;
}

/** One signed EIP-712 artifact and the address that claims to have signed it. */
export interface TypedDataInput {
  domain: TypedDataDomainInput;
  types: unknown;
  primaryType: string;
  message: Record<string, unknown>;
  signature: string;
  signer: string;
}

/** The part of a leg every typed-data kind fills in; validity is decided afterwards. */
interface TypedLeg {
  scheme: string;
  asset: string;
  from: string;
  to: string;
  amount_atomic: string;
  dedupe_key: string;
  authorization_seconds?: number;
  authority_grant?: boolean;
  /** Checked after the signature verifies, e.g. the payer named in the message. */
  postCheck?: (recovered: string) => string | undefined;
}

/** A chain id as a safe integer, or undefined when it is absent or not one. */
function safeIntegerOf(value: unknown): number | undefined {
  const parsed = toBigIntOrUndefined(value);
  if (parsed === undefined) return undefined;
  const asNumber = Number(parsed);
  return Number.isSafeInteger(asNumber) && asNumber >= 0 ? asNumber : undefined;
}

function chainIdOf(domain: TypedDataDomainInput): number | undefined {
  return safeIntegerOf(domain.chainId);
}

function signatureKey(signer: string, signature: string): string {
  return `evmsig:${normalizeAddress(signer)}:${isHex(signature) ? keccak256(signature) : "invalid"}`;
}

function typedKey(
  chainId: number | undefined,
  verifyingContract: string,
  primaryType: string,
  owner: string,
  nonce: string,
): string {
  return `evm712:${chainId ?? ""}:${verifyingContract}:${primaryType}:${normalizeAddress(owner)}:${nonce}`;
}

export function sameAddress(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    return isAddressEqual(getAddress(a), getAddress(b));
  } catch {
    return false;
  }
}

/** The allowance key: the typed-data key with the signature hash appended. */
function allowanceKey(
  chainId: number | undefined,
  verifyingContract: string,
  primaryType: string,
  owner: string,
  nonce: string,
  signature: string,
): string {
  const sigHash = isHex(signature) ? keccak256(signature) : "invalid";
  return `${typedKey(chainId, verifyingContract, primaryType, owner, nonce)}:${sigHash}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** EIP-3009 `TransferWithAuthorization` / `ReceiveWithAuthorization`: a transfer of `value`
 * from `from` to `to`, keyed by its random nonce. */
function eip3009Leg(input: TypedDataInput): TypedLeg {
  const { message } = input;
  return {
    scheme: "exact",
    asset: String(input.domain.verifyingContract ?? ""),
    from: String(message.from ?? ""),
    to: String(message.to ?? ""),
    amount_atomic: amountString(message.value),
    dedupe_key: `evm:${String(message.nonce ?? "")}`,
    authorization_seconds: authorizationSeconds(message.validAfter, message.validBefore),
  };
}

/**
 * Permit2 SignatureTransfer: a transfer of `permitted.amount` of `permitted.token`. Only an
 * x402 proxy enforces the witness, so the funds go to `witness.to` only when the spender is
 * the x402 exact proxy, or the x402 upto proxy with its upto witness (which names a
 * facilitator; its amount is the most the facilitator may settle). Any other spender can
 * send the funds anywhere, so it is the recipient, and a witness transfer naming it is
 * `untrusted_permit2_spender`.
 */
function permit2TransferLeg(input: TypedDataInput): TypedLeg {
  const { message } = input;
  const permitted = asRecord(message.permitted);
  const witness = message.witness === undefined ? undefined : asRecord(message.witness);
  const spender = normalizeAddress(message.spender);
  const withWitness = input.primaryType === "PermitWitnessTransferFrom";
  const trustedProxy =
    sameAddress(spender, X402_EXACT_PERMIT2_PROXY) ||
    (sameAddress(spender, X402_UPTO_PERMIT2_PROXY) && witness?.facilitator !== undefined);
  const enforcedWitness = withWitness && trustedProxy && witness?.to !== undefined;
  return {
    scheme: "exact",
    asset: normalizeAddress(permitted.token),
    from: normalizeAddress(input.signer),
    to: enforcedWitness ? normalizeAddress(witness?.to) : spender,
    amount_atomic: amountString(permitted.amount),
    dedupe_key: `evm:${nonceString(message.nonce)}`,
    authorization_seconds: authorizationSeconds(witness?.validAfter ?? 0, message.deadline),
    postCheck: () => (withWitness && !trustedProxy ? "untrusted_permit2_spender" : undefined),
  };
}

/** EIP-2612 `Permit`: an allowance of `value` to `spender` on the token that verifies it. */
function eip2612Leg(input: TypedDataInput, chainId: number | undefined): TypedLeg {
  const { message } = input;
  const token = normalizeAddress(input.domain.verifyingContract);
  const owner = normalizeAddress(message.owner);
  return {
    scheme: "approve",
    asset: token,
    from: owner,
    to: normalizeAddress(message.spender),
    amount_atomic: amountString(message.value),
    dedupe_key: allowanceKey(
      chainId,
      token,
      "Permit",
      owner,
      nonceString(message.nonce),
      input.signature,
    ),
    postCheck: (recovered) => (sameAddress(recovered, owner) ? undefined : "bad_signature"),
  };
}

/** Permit2 AllowanceTransfer `PermitSingle` / `PermitBatch`: one allowance leg to
 * `spender` per detail, each for that detail's token and amount. */
function permit2AllowanceLegs(input: TypedDataInput, chainId: number | undefined): TypedLeg[] {
  const { message } = input;
  const spender = normalizeAddress(message.spender);
  const listed = Array.isArray(message.details) ? message.details : [message.details];
  // An empty batch still records one (zero) allowance, so the signature is not lost.
  const details = (listed.length > 0 ? listed : [{}]).map(asRecord);
  const verifyingContract = normalizeAddress(input.domain.verifyingContract);
  return details.map((detail) => {
    const token = normalizeAddress(detail.token);
    return {
      scheme: "approve",
      asset: token,
      from: normalizeAddress(input.signer),
      to: spender,
      amount_atomic: amountString(detail.amount),
      dedupe_key: allowanceKey(
        chainId,
        verifyingContract,
        input.primaryType,
        input.signer,
        `${token}:${spender}:${nonceString(detail.nonce)}`,
        input.signature,
      ),
    };
  });
}

/** Any other typed data: recorded as a signature with no value attached. */
function unknownTypedDataLeg(input: TypedDataInput, chainId: number | undefined): TypedLeg {
  const { message } = input;
  const verifyingContract = normalizeAddress(input.domain.verifyingContract);
  return {
    scheme: "unknown_typed_data",
    asset: verifyingContract,
    from: normalizeAddress(input.signer),
    to: "",
    amount_atomic: "0",
    dedupe_key:
      message.nonce === undefined
        ? signatureKey(input.signer, input.signature)
        : typedKey(
            chainId,
            verifyingContract,
            input.primaryType,
            input.signer,
            nonceString(message.nonce),
          ),
  };
}

/**
 * Decodes one signed EIP-712 artifact by its primaryType and verifies it: the signature
 * must recover to `input.signer`, plus the per-kind check (`postCheck`). A malformed
 * artifact is `bad_signature`; an amount that is not a non-negative integer is
 * `negative_amount`, checked before any signature work.
 */
export async function decodeTypedData(
  input: TypedDataInput,
  raw: unknown,
): Promise<DecodedPayment> {
  const chainId = chainIdOf(input.domain);
  const message = asRecord(input.message);
  const normalized: TypedDataInput = { ...input, message };
  let typedLegs: TypedLeg[];
  switch (input.primaryType) {
    case "TransferWithAuthorization":
    case "ReceiveWithAuthorization":
      typedLegs = [eip3009Leg(normalized)];
      break;
    case "PermitWitnessTransferFrom":
    case "PermitTransferFrom":
      typedLegs = [permit2TransferLeg(normalized)];
      break;
    case "Permit":
      typedLegs = [eip2612Leg(normalized, chainId)];
      break;
    case "PermitSingle":
    case "PermitBatch":
      typedLegs = permit2AllowanceLegs(normalized, chainId);
      break;
    default:
      typedLegs = [unknownTypedDataLeg(normalized, chainId)];
  }

  // One signature: recover it once, then judge every leg it carries.
  let recovered: string | undefined;
  try {
    recovered = await recoverTypedDataAddress({
      // biome-ignore lint/suspicious/noExplicitAny: typed data arrives untyped over the wire.
      domain: input.domain as any,
      // biome-ignore lint/suspicious/noExplicitAny: <see above>
      types: input.types as any,
      primaryType: input.primaryType,
      // biome-ignore lint/suspicious/noExplicitAny: <see above>
      message: message as any,
      signature: input.signature as Hex,
    });
  } catch {
    recovered = undefined;
  }

  const legs = typedLegs.map((leg) => finishTypedLeg(leg, chainId, recovered, input.signer, raw));
  const [first, ...rest] = legs as [DecodedPayment, ...DecodedPayment[]];
  return rest.length === 0 ? first : { ...first, legs };
}

function finishTypedLeg(
  leg: TypedLeg,
  chainId: number | undefined,
  recovered: string | undefined,
  signer: string,
  raw: unknown,
): DecodedPayment {
  const base: DecodedPayment = {
    chain: "evm",
    network: chainId !== undefined ? `eip155:${chainId}` : "",
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
  if (!isNonNegativeIntegerString(base.amount_atomic)) {
    return { ...base, invalid_reason: "negative_amount" };
  }
  if (recovered === undefined || !sameAddress(recovered, signer)) {
    return { ...base, invalid_reason: "bad_signature" };
  }
  const reason = leg.postCheck?.(recovered);
  return reason ? { ...base, invalid_reason: reason } : { ...base, valid: true };
}

export interface MessageInput {
  /** A text message, or `{raw}` hex bytes, as viem's `signMessage` takes it. */
  message: unknown;
  signature: string;
  signer: string;
}

function signatureOnlyLeg(signer: string, signature: string, raw: unknown): DecodedPayment {
  return {
    chain: "evm",
    network: "",
    scheme: "message",
    asset: "",
    from: normalizeAddress(signer),
    to: "",
    amount_atomic: "0",
    dedupe_key: signatureKey(signer, signature),
    valid: false,
    raw,
  };
}

/** An EIP-191 message signature (`signMessage`): a `message` leg worth nothing by itself. */
export async function decodeEvmMessage(input: MessageInput, raw: unknown): Promise<DecodedPayment> {
  const base = signatureOnlyLeg(input.signer, input.signature, raw);
  try {
    const message =
      typeof input.message === "string"
        ? input.message
        : { raw: String(asRecord(input.message).raw) as Hex };
    const ok = await verifyMessage({
      address: getAddress(input.signer),
      message,
      signature: input.signature as Hex,
    });
    return ok ? { ...base, valid: true } : { ...base, invalid_reason: "bad_signature" };
  } catch {
    return { ...base, invalid_reason: "bad_signature" };
  }
}

export interface RawSignInput {
  hash: string;
  signature: string;
  signer: string;
}

/** A raw digest signature (`sign({hash})`), which can authorise anything the digest
 * stands for: a `message` leg worth nothing by itself. */
export async function decodeEvmRawSign(input: RawSignInput, raw: unknown): Promise<DecodedPayment> {
  const base = signatureOnlyLeg(input.signer, input.signature, raw);
  try {
    const recovered = await recoverAddress({
      hash: input.hash as Hex,
      signature: input.signature as Hex,
    });
    return sameAddress(recovered, input.signer)
      ? { ...base, valid: true }
      : { ...base, invalid_reason: "bad_signature" };
  } catch {
    return { ...base, invalid_reason: "bad_signature" };
  }
}

export interface AuthorizationInput {
  chainId: number | string | bigint;
  /** The contract the account delegates its code to. */
  address: string;
  nonce: number | string | bigint;
  signature: string;
  /** The claimed authority; absent when the authority is only known by recovery (a
   * transaction's authorization list). */
  signer?: string;
}

/**
 * An EIP-7702 authorization: the authority hands its account's code to `address`, which
 * can then move everything the account holds. Scheme `delegate`, `to` = the delegate,
 * network `eip155:<chainId>`, or `eip155:*` for chainId 0 (valid on every chain).
 * `authority_grant` makes the recorder value it at the wallet balance.
 */
export async function decodeEvmAuthorization(
  input: AuthorizationInput,
  raw: unknown,
): Promise<DecodedPayment> {
  const chainId = safeIntegerOf(input.chainId);
  const nonceNumber = safeIntegerOf(input.nonce);
  const nonce = nonceString(input.nonce);
  const malformed = chainId === undefined || nonceNumber === undefined;
  let recovered = "";
  if (!malformed) {
    try {
      recovered = await recoverAuthorizationAddress({
        authorization: { address: getAddress(input.address), chainId, nonce: nonceNumber },
        signature: input.signature as Hex,
      });
    } catch {
      recovered = "";
    }
  }
  const verified =
    recovered !== "" && (input.signer === undefined || sameAddress(recovered, input.signer));
  const authority = normalizeAddress(input.signer ?? recovered);
  const base: DecodedPayment = {
    chain: "evm",
    network: chainId === undefined ? "" : chainId === 0 ? "eip155:*" : `eip155:${chainId}`,
    scheme: "delegate",
    asset: "",
    from: authority,
    to: normalizeAddress(input.address),
    amount_atomic: "0",
    dedupe_key: `evm7702:${chainId ?? ""}:${authority}:${nonce}`,
    valid: verified,
    authority_grant: true,
    raw,
  };
  if (malformed) return { ...base, valid: false, invalid_reason: "malformed_authorization" };
  return verified ? base : { ...base, invalid_reason: "bad_signature" };
}
