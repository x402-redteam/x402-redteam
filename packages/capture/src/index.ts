import { createHash } from "node:crypto";
import type {
  AttributionContext,
  CaptureApi,
  DecodedPayment,
  DecodeHints,
  Payment,
  PaymentPayload,
  ShimEvent,
} from "@x402-redteam/schema";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { attribute as attributeImpl } from "./attribute.js";
import {
  decodeEvmAuthorization,
  decodeEvmMessage,
  decodeEvmPayload,
  decodeEvmRawSign,
  decodeEvmTx,
  decodeEvmTypedData,
  V1_NETWORK_MAP,
} from "./evm.js";
import { merge as mergeImpl } from "./merge.js";
import { decodeSvmTransaction } from "./svm.js";

function chainForNetwork(network: string): "evm" | "svm" {
  return network.startsWith("solana:") ? "svm" : "evm";
}

async function decodePayloadUnchecked(
  payload: PaymentPayload,
  hints?: DecodeHints,
): Promise<DecodedPayment> {
  const anyPayload = payload as unknown as Record<string, unknown>;
  const isV1 = !("accepted" in anyPayload);

  const network = isV1
    ? (V1_NETWORK_MAP[anyPayload.network as string] ?? (anyPayload.network as string))
    : (anyPayload.accepted as { network: string }).network;

  if (typeof network !== "string") {
    throw new TypeError("decodePayload: network is not a string");
  }
  if (chainForNetwork(network) === "svm") {
    const inner = anyPayload.payload as { transaction: string };
    const scheme = isV1
      ? (anyPayload.scheme as string)
      : (anyPayload.accepted as { scheme: string }).scheme;
    return decodeSvmTransaction(inner.transaction, hints, { network, scheme });
  }
  return decodeEvmPayload(payload, hints);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The stand-in leg for a payload the decoder could not read (U29-0). Never throws: a
 * received payload always becomes a ledger leg, `valid: false`, with a `decode_error`.
 * Its `dedupe_key` is a digest of the payload so distinct garbage doesn't merge.
 */
function decodeErrorLeg(payload: unknown, code: string, network: string): DecodedPayment {
  let digest: string;
  try {
    digest = createHash("sha256")
      .update(JSON.stringify(payload) ?? String(payload))
      .digest("hex")
      .slice(0, 32);
  } catch {
    digest = createHash("sha256")
      .update(String(typeof payload))
      .digest("hex")
      .slice(0, 32);
  }
  return {
    chain: chainForNetwork(network),
    network,
    scheme: "",
    asset: "",
    from: "",
    to: "",
    amount_atomic: "0",
    dedupe_key: `decode_error:${digest}`,
    valid: false,
    invalid_reason: "decode_error",
    decode_error: code,
    raw: payload,
  };
}

/** Decodes a payment payload. Total: it never throws and never drops (U29-0). */
async function decodePayload(
  payload: PaymentPayload | unknown,
  hints?: DecodeHints,
): Promise<DecodedPayment> {
  try {
    return await decodePayloadUnchecked(payload as PaymentPayload, hints);
  } catch {
    const record =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const accepted = record.accepted;
    const rawNetwork =
      typeof accepted === "object" && accepted !== null
        ? (accepted as Record<string, unknown>).network
        : record.network;
    const network = asString(rawNetwork);
    const code =
      typeof payload === "string"
        ? "undecodable_header"
        : typeof rawNetwork !== "string"
          ? "malformed_network"
          : "malformed_payload";
    return decodeErrorLeg(payload, code, network);
  }
}

async function decodeShimEvent(evt: ShimEvent, hints?: DecodeHints): Promise<DecodedPayment> {
  switch (evt.kind) {
    case "evm_typed_data":
      return decodeEvmTypedData(evt.payload);
    case "evm_tx":
      return decodeEvmTx(evt.payload);
    case "evm_message":
      return decodeEvmMessage(evt.payload, evt.payload);
    case "evm_raw_sign":
      return decodeEvmRawSign(evt.payload, evt.payload);
    case "evm_authorization":
      return decodeEvmAuthorization(evt.payload, evt.payload);
    case "svm_tx":
      // L5 (code review): a direct (non-x402) SVM transfer uses scheme "transfer", same
      // convention as decodeEvmTx - "exact" is reserved for an actual x402 payment
      // (decodePayload's header path, which passes the real `accepted.scheme`).
      return decodeSvmTransaction(evt.payload.transaction_base64, hints, {
        network: CHAIN_DEFAULTS.svm.network,
        scheme: "transfer",
      });
    default:
      throw new Error(`decodeShimEvent: unknown shim event kind ${(evt as { kind: string }).kind}`);
  }
}

/** Implements `CaptureApi` from `@x402-redteam/schema`, per functional-design.md §1. */
export const capture: CaptureApi = {
  decodePayload,
  decodeShimEvent,
  attribute: attributeImpl,
  merge: mergeImpl,
};

export { attribute } from "./attribute.js";
export {
  decodeEvmAuthorization,
  decodeEvmMessage,
  decodeEvmPayload,
  decodeEvmRawSign,
  decodeEvmTx,
  decodeEvmTypedData,
} from "./evm.js";
export { merge } from "./merge.js";
export { type WrapEvmAccountOptions, wrapEvmAccount } from "./shim/evm.js";
export { type WrapSvmSignerOptions, wrapSvmSigner } from "./shim/svm.js";
export { type RecordTransferOptions, recordTransfer } from "./shim/transfer.js";
export { decodeSvmTransaction } from "./svm.js";
export type { AttributionContext, DecodedPayment, DecodeHints, Payment, PaymentPayload, ShimEvent };
