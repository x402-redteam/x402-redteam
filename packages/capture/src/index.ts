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
import { decodeEvmPayload, decodeEvmTx, decodeEvmTypedData, V1_NETWORK_MAP } from "./evm.js";
import { merge as mergeImpl } from "./merge.js";
import { decodeSvmTransaction } from "./svm.js";

function chainForNetwork(network: string): "evm" | "svm" {
  return network.startsWith("solana:") ? "svm" : "evm";
}

async function decodePayload(
  payload: PaymentPayload,
  hints?: DecodeHints,
): Promise<DecodedPayment> {
  const anyPayload = payload as unknown as Record<string, unknown>;
  const isV1 = !("accepted" in anyPayload);

  const network = isV1
    ? (V1_NETWORK_MAP[anyPayload.network as string] ?? (anyPayload.network as string))
    : (anyPayload.accepted as { network: string }).network;

  if (chainForNetwork(network) === "svm") {
    const inner = anyPayload.payload as { transaction: string };
    const scheme = isV1
      ? (anyPayload.scheme as string)
      : (anyPayload.accepted as { scheme: string }).scheme;
    return decodeSvmTransaction(inner.transaction, hints, { network, scheme });
  }
  return decodeEvmPayload(payload);
}

async function decodeShimEvent(evt: ShimEvent, hints?: DecodeHints): Promise<DecodedPayment> {
  switch (evt.kind) {
    case "evm_typed_data":
      return decodeEvmTypedData(evt.payload);
    case "evm_tx":
      return decodeEvmTx(evt.payload);
    case "svm_tx":
      return decodeSvmTransaction(evt.payload.transaction_base64, hints, {
        network: CHAIN_DEFAULTS.svm.network,
        scheme: "exact",
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
export { decodeEvmPayload, decodeEvmTx, decodeEvmTypedData } from "./evm.js";
export { merge } from "./merge.js";
export { type WrapEvmAccountOptions, wrapEvmAccount } from "./shim/evm.js";
export { type WrapSvmSignerOptions, wrapSvmSigner } from "./shim/svm.js";
export { type RecordTransferOptions, recordTransfer } from "./shim/transfer.js";
export { decodeSvmTransaction } from "./svm.js";
export type { AttributionContext, DecodedPayment, DecodeHints, Payment, PaymentPayload, ShimEvent };
