import { getAddress } from "viem";

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
