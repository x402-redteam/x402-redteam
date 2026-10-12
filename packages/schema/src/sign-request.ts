/**
 * v4 (U26-2, M2, ADR-030): the sign request a `collect_signature` route serves, and the
 * signature an agent POSTs back. One module owns the wire shape, so the adversary, the
 * guardrail-track driver and the example agents agree on it.
 *
 * Served body (JSON, `content-type: application/json`, status 200 or 402 with no x402
 * challenge header):
 *
 *   { "error"?: "signature_required",      // 402 only
 *     "text"?: "<prose>",
 *     "sign_request": SignRequestWire }
 *
 * Submission: `POST sign_request.submit_url` with JSON `{ "signature": "0x…", "address"?:
 * "0x…" }`. For an EIP-7702 authorization the signature is the 65-byte serialized
 * (r, s, yParity). `address` is the signer the agent claims; the adversary recovers the
 * signer from the signature and what it served, and records a mismatch as an invalid
 * signature.
 */
import {
  type Hex,
  type LocalAccount,
  recoverAddress,
  recoverMessageAddress,
  recoverTypedDataAddress,
  serializeSignature,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import type { ShimEvent } from "./capture-api.js";

export interface SignRequestTypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignRequestAuthorization {
  chainId: number;
  /** The delegate contract the authority's account would run. */
  address: string;
  nonce: number;
}

export type SignRequestWire =
  | { kind: "typed_data"; typed_data: SignRequestTypedData; submit_url: string }
  | { kind: "digest"; digest: string; submit_url: string }
  | { kind: "message"; message: string; submit_url: string }
  | { kind: "authorization"; authorization: SignRequestAuthorization; submit_url: string };

export interface SignRequestBody {
  error?: "signature_required";
  text?: string;
  sign_request: SignRequestWire;
}

export interface SignatureSubmission {
  signature: string;
  address?: string;
}

/**
 * The GDP `sign` payload variant for a sign request (application-design.md v4 GDP):
 * `{typed_data}`, `{digest}`, `{message}` or `{authorization}`.
 */
export type SignRequestPayload =
  | { typed_data: SignRequestTypedData }
  | { digest: string }
  | { message: string }
  | { authorization: SignRequestAuthorization };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Checks one `sign_request` object; returns it typed, or undefined when malformed. */
function asSignRequest(value: unknown): SignRequestWire | undefined {
  if (!isRecord(value) || typeof value.submit_url !== "string") return undefined;
  const submit_url = value.submit_url;
  switch (value.kind) {
    case "typed_data": {
      const td = value.typed_data;
      if (
        !isRecord(td) ||
        !isRecord(td.domain) ||
        !isRecord(td.types) ||
        typeof td.primaryType !== "string" ||
        !isRecord(td.message)
      ) {
        return undefined;
      }
      return {
        kind: "typed_data",
        typed_data: {
          domain: td.domain,
          types: td.types,
          primaryType: td.primaryType,
          message: td.message,
        },
        submit_url,
      };
    }
    case "digest":
      return typeof value.digest === "string" && HEX_32_RE.test(value.digest)
        ? { kind: "digest", digest: value.digest, submit_url }
        : undefined;
    case "message":
      return typeof value.message === "string"
        ? { kind: "message", message: value.message, submit_url }
        : undefined;
    case "authorization": {
      const auth = value.authorization;
      if (
        !isRecord(auth) ||
        !Number.isSafeInteger(auth.chainId) ||
        (auth.chainId as number) < 0 ||
        typeof auth.address !== "string" ||
        !EVM_ADDRESS_RE.test(auth.address) ||
        !Number.isSafeInteger(auth.nonce) ||
        (auth.nonce as number) < 0
      ) {
        return undefined;
      }
      return {
        kind: "authorization",
        authorization: {
          chainId: auth.chainId as number,
          address: auth.address,
          nonce: auth.nonce as number,
        },
        submit_url,
      };
    }
    default:
      return undefined;
  }
}

/** The sign request in a response body, or undefined when the body is not one. */
export function parseSignRequest(text: string): SignRequestWire | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? asSignRequest(parsed.sign_request) : undefined;
}

/** The GDP `sign` payload for a sign request. */
export function signRequestPayload(req: SignRequestWire): SignRequestPayload {
  switch (req.kind) {
    case "typed_data":
      return { typed_data: req.typed_data };
    case "digest":
      return { digest: req.digest };
    case "message":
      return { message: req.message };
    case "authorization":
      return { authorization: req.authorization };
  }
}

/** Signs a sign request with `account` and returns the signature to submit. */
export async function signSignRequest(account: LocalAccount, req: SignRequestWire): Promise<Hex> {
  switch (req.kind) {
    case "typed_data":
      return account.signTypedData(req.typed_data as Parameters<LocalAccount["signTypedData"]>[0]);
    case "digest":
      if (!account.sign) throw new Error("signSignRequest: account cannot sign a raw digest");
      return account.sign({ hash: req.digest as Hex });
    case "message":
      return account.signMessage({ message: req.message });
    case "authorization": {
      if (!account.signAuthorization) {
        throw new Error("signSignRequest: account cannot sign an EIP-7702 authorization");
      }
      const signed = await account.signAuthorization({
        chainId: req.authorization.chainId,
        address: req.authorization.address as Hex,
        nonce: req.authorization.nonce,
      });
      return serializeSignature({ r: signed.r, s: signed.s, yParity: signed.yParity ?? 0 });
    }
  }
}

/** The address that signed `signature` over `req`. Throws on a malformed signature. */
export async function recoverSignRequestSigner(
  req: SignRequestWire,
  signature: string,
): Promise<string> {
  const sig = signature as Hex;
  switch (req.kind) {
    case "typed_data":
      return recoverTypedDataAddress({
        ...(req.typed_data as Parameters<typeof recoverTypedDataAddress>[0]),
        signature: sig,
      });
    case "digest":
      return recoverAddress({ hash: req.digest as Hex, signature: sig });
    case "message":
      return recoverMessageAddress({ message: req.message, signature: sig });
    case "authorization":
      return recoverAuthorizationAddress({
        authorization: {
          chainId: req.authorization.chainId,
          address: req.authorization.address as Hex,
          nonce: req.authorization.nonce,
        },
        signature: sig,
      });
  }
}

/**
 * The capture event for a submitted signature: the same shape the EVM shim reports for
 * the same signing call, so it goes through the same decoder and merges with a shim
 * capture of the same signature (one dedupe key across layers).
 */
export function signRequestEvent(
  req: SignRequestWire,
  signature: string,
  signer: string,
): ShimEvent {
  switch (req.kind) {
    case "typed_data":
      return {
        kind: "evm_typed_data",
        payload: { ...req.typed_data, signature, address: signer },
      };
    case "digest":
      return { kind: "evm_raw_sign", payload: { hash: req.digest, signature, signer } };
    case "message":
      return { kind: "evm_message", payload: { message: req.message, signature, signer } };
    case "authorization":
      return {
        kind: "evm_authorization",
        payload: { ...req.authorization, signature, signer },
      };
  }
}
