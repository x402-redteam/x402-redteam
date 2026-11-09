import { createHash } from "node:crypto";
import {
  compactSignatureToSignature,
  getAddress,
  type Hex,
  isHex,
  keccak256,
  parseCompactSignature,
  parseSignature,
  serializeSignature,
} from "viem";

/**
 * True iff `value` is a valid non-negative decimal integer string (digits only - no
 * sign, no fractional part, no leading/trailing whitespace, no hex/scientific
 * notation). A decoded on-chain amount (ERC-20 `uint256` via `decodeFunctionData`, a
 * native tx's `value`) is always shaped like this by construction - the EVM has no
 * negative integers - but a header/shim payload's amount is an untyped string an agent
 * (or attacker) controls directly, so it must be checked before use.
 */
export function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Parses a value that may arrive as a `bigint` (an in-process real client
 * call), a numeric string (JSON-decoded, e.g. a shim event posted over
 * HTTP), or a plain number, into a `bigint`. Returns `undefined` when the
 * value can't be parsed, so callers can leave optional fields unset rather
 * than throw.
 */
export function toBigIntOrUndefined(value: unknown): bigint | undefined {
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

/** An amount as a decimal string, whether it arrived as a bigint, number or string. A value
 * that is not an integer is returned as-is so the negative-amount check can reject it. */
export function amountString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || value === null) return "0";
  return String(value);
}

/** A nonce in one canonical form for dedupe keys: decimal when it parses as an integer
 * (a JSON-decoded shim event and a header payload then agree), else the raw string. */
export function nonceString(value: unknown): string {
  const parsed = toBigIntOrUndefined(value);
  if (parsed !== undefined) return parsed.toString();
  return value === undefined || value === null ? "unknown" : String(value);
}

/** The checksummed form of an address, or the raw string when it is not an address. */
export function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") return value === undefined || value === null ? "" : String(value);
  try {
    return getAddress(value);
  } catch {
    return value;
  }
}

/**
 * The remaining authorization window at the harness's receipt time:
 * `validBefore - max(validAfter, nowSeconds)`, where `nowSeconds` is the harness's own
 * wall clock at decode time. The real @x402/evm client sets `validAfter` to "0" and
 * `validBefore` to the signer's clock plus `maxTimeoutSeconds`, so a plain difference
 * would not be a stable window. Can be negative (already expired). Wall-clock dependent
 * by design: callers keep it out of `report.json` and only persist it in the per-run
 * ledger.
 */
export function authorizationSeconds(
  validAfter: unknown,
  validBefore: unknown,
): number | undefined {
  const after = toBigIntOrUndefined(validAfter);
  const before = toBigIntOrUndefined(validBefore);
  if (after === undefined || before === undefined) return undefined;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const effectiveAfter = after > nowSeconds ? after : nowSeconds;
  return Number(before - effectiveAfter);
}

/**
 * A canonical hash of a signature, used by every EVM dedupe key of a signed authorization
 * (U37). A 65-byte `r||s||v` (v 0/1/27/28) and a 64-byte EIP-2098 compact signature are
 * parsed, re-serialised as `r||s||(27 + yParity)` and hashed, so one signature carried by
 * the header, the shim, the RPC calldata `(v, r, s)` or a transaction's authorization list
 * has one key whatever form it arrived in. Hex that does not parse (ERC-1271 / ERC-6492
 * smart-wallet bytes) hashes as lowercased bytes; a missing signature is `nosig` and a
 * non-hex one `badsig`.
 */
export function sigKey(signature: unknown): string {
  if (signature === undefined || signature === null || signature === "") return "nosig";
  if (typeof signature !== "string" || !isHex(signature)) return "badsig";
  try {
    // viem's parseSignature does not read a 64-byte EIP-2098 compact signature, so that form
    // goes through compactSignatureToSignature.
    const parsed =
      signature.length === 130
        ? compactSignatureToSignature(parseCompactSignature(signature))
        : parseSignature(signature);
    return keccak256(serializeSignature(parsed).toLowerCase() as Hex);
  } catch {
    return keccak256(signature.toLowerCase() as Hex);
  }
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : value == null ? "" : String(value);
}

/** An unsigned integer in decimal when it parses (hex and decimal then agree), else the
 * raw string lowercased. */
function uintKey(value: unknown): string {
  const parsed = toBigIntOrUndefined(value);
  return parsed !== undefined ? parsed.toString() : lower(value);
}

export interface Eip3009KeyInput {
  from: unknown;
  to: unknown;
  value: unknown;
  nonce: unknown;
  signature: unknown;
}

/** The one dedupe-key builder for an EIP-3009 authorization (header, shim, RPC calldata). */
export function eip3009Key(input: Eip3009KeyInput): string {
  return [
    "eip3009",
    lower(input.from),
    lower(input.to),
    uintKey(input.value),
    lower(input.nonce),
    sigKey(input.signature),
  ].join(":");
}

export interface Permit2KeyInput {
  from: unknown;
  token: unknown;
  spender: unknown;
  /** The leg's recipient as `permit2TransferLeg` computes it. */
  to: unknown;
  amount: unknown;
  nonce: unknown;
  signature: unknown;
}

/** The one dedupe-key builder for a Permit2 SignatureTransfer (header and shim). */
export function permit2Key(input: Permit2KeyInput): string {
  return [
    "permit2",
    lower(input.from),
    lower(input.token),
    lower(input.spender),
    lower(input.to),
    uintKey(input.amount),
    input.nonce === undefined || input.nonce === null ? "unknown" : uintKey(input.nonce),
    sigKey(input.signature),
  ].join(":");
}

export interface Evm7702KeyInput {
  chainId: number | undefined;
  authority: unknown;
  delegate: unknown;
  nonce: unknown;
  signature: unknown;
}

/** The one dedupe-key builder for an EIP-7702 authorization (shim and transaction-embedded). */
export function evm7702Key(input: Evm7702KeyInput): string {
  return [
    "evm7702",
    input.chainId ?? "",
    lower(input.authority),
    lower(input.delegate),
    input.nonce === undefined || input.nonce === null ? "unknown" : uintKey(input.nonce),
    sigKey(input.signature),
  ].join(":");
}

/** A sha256 digest (32 hex chars) of a payload's JSON, so distinct undecodable payloads do
 * not share a key. Total: a payload JSON cannot serialise falls back to its type. */
export function payloadDigest(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload) ?? String(payload);
  } catch {
    text = String(typeof payload);
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
