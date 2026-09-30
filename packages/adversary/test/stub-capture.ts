import { createHash } from "node:crypto";
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { PaymentPayload } from "@x402/core/types";
import {
  type AttributionContext,
  type CaptureApi,
  CHAIN_DEFAULTS,
  type DecodedPayment,
  type DecodeHints,
  type Payment,
  type ShimEvent,
} from "@x402-redteam/schema";

/**
 * Minimal `CaptureApi` stub used by U2's own integration tests, per
 * functional-design.md §1 "Capture is injected." It deliberately does the
 * least amount of decoding needed to drive the real @x402/evm and @x402/svm
 * clients end to end:
 *  - reads `payload.accepted` plus `payload.payload.authorization` for EVM
 *  - for SVM, trusts `accepted.payTo` / `accepted.amount` and only decodes
 *    the transaction far enough to recover the payer address and a stable
 *    dedupe key
 *  - attribution matches on `payTo` and `amount`
 *  - merge appends
 *
 * At Gate G2, Opus swaps `makeCapture()` for the real `capture` package and
 * reruns these same tests.
 */

const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function decodeSvmTransferFrom(base64Tx: string): { from: string; dedupe_key: string } {
  const bytes = getBase64Encoder().encode(base64Tx);
  const tx = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (compiled.version !== 0 && compiled.version !== "legacy") {
    throw new Error(`stub-capture: unexpected transaction message version "${compiled.version}"`);
  }
  const staticAccounts = compiled.staticAccounts;
  const dedupe_key = sha256Hex(Buffer.from(tx.messageBytes));
  for (const ix of compiled.instructions) {
    const programAddress = staticAccounts[ix.programAddressIndex];
    if (programAddress !== TOKEN_PROGRAM_ADDRESS) continue;
    const ownerIndex = ix.accountIndices?.[3];
    if (ownerIndex === undefined) continue;
    const owner = staticAccounts[ownerIndex];
    if (owner) return { from: owner, dedupe_key };
  }
  throw new Error("stub-capture: no SPL TransferChecked instruction found in transaction");
}

async function decodePayload(
  payload: PaymentPayload,
  _hints?: DecodeHints,
): Promise<DecodedPayment> {
  const accepted = payload.accepted;
  const inner = payload.payload as Record<string, unknown>;

  if (inner.authorization && typeof inner.authorization === "object") {
    const auth = inner.authorization as { from: string; to: string; value: string; nonce: string };
    return {
      chain: "evm",
      network: accepted.network,
      scheme: accepted.scheme,
      asset: accepted.asset,
      from: auth.from,
      to: auth.to,
      amount_atomic: auth.value,
      dedupe_key: auth.nonce,
      valid: true,
      raw: payload,
    };
  }

  if (typeof inner.transaction === "string") {
    const { from, dedupe_key } = decodeSvmTransferFrom(inner.transaction);
    return {
      chain: "svm",
      network: accepted.network,
      scheme: accepted.scheme,
      asset: accepted.asset,
      from,
      to: accepted.payTo,
      amount_atomic: accepted.amount,
      dedupe_key,
      valid: true,
      raw: payload,
    };
  }

  throw new Error("stub-capture: unrecognized payload shape");
}

async function decodeShimEvent(evt: ShimEvent, _hints?: DecodeHints): Promise<DecodedPayment> {
  if (evt.kind === "evm_typed_data") {
    const domain = evt.payload.domain as { chainId?: number; verifyingContract?: string };
    const message = evt.payload.message as {
      from?: string;
      to?: string;
      value?: string;
      nonce?: string;
    };
    const network =
      domain.chainId !== undefined ? `eip155:${domain.chainId}` : CHAIN_DEFAULTS.evm.network;
    return {
      chain: "evm",
      network,
      scheme: "exact",
      asset: domain.verifyingContract ?? CHAIN_DEFAULTS.evm.asset,
      from: message.from ?? evt.payload.address,
      to: message.to ?? "",
      amount_atomic: message.value ?? "0",
      dedupe_key: message.nonce ?? evt.payload.signature,
      valid: true,
      raw: evt,
    };
  }
  if (evt.kind === "svm_tx") {
    const { from, dedupe_key } = decodeSvmTransferFrom(evt.payload.transaction_base64);
    return {
      chain: "svm",
      network: CHAIN_DEFAULTS.svm.network,
      scheme: "exact",
      asset: CHAIN_DEFAULTS.svm.asset,
      from,
      to: "",
      amount_atomic: "0",
      dedupe_key,
      valid: true,
      raw: evt,
    };
  }
  throw new Error(`stub-capture: shim kind "${evt.kind}" not implemented`);
}

function attribute(
  p: DecodedPayment,
  ctx: AttributionContext,
): Pick<Payment, "instruction_source" | "challenge_id" | "replay"> {
  const dedupeSeenBefore = ctx.prior.some((prior) => prior.dedupe_key === p.dedupe_key);
  const matches = ctx.challenges.filter(
    (challenge) =>
      challenge.requirements.payTo === p.to && challenge.requirements.amount === p.amount_atomic,
  );
  const claimedChallengeIds = new Set(ctx.prior.map((prior) => prior.challenge_id).filter(Boolean));

  if (matches.length > 0) {
    const unpaid = matches.find((m) => !claimedChallengeIds.has(m.challenge_id));
    if (unpaid) {
      return {
        instruction_source: "header",
        challenge_id: unpaid.challenge_id,
        replay: dedupeSeenBefore,
      };
    }
    const latest = matches[matches.length - 1] as (typeof matches)[number];
    return { instruction_source: "header", challenge_id: latest.challenge_id, replay: true };
  }

  const mentionedInProse = ctx.pageBodies.some(
    (body) => body.includes(p.to) || body.includes(p.amount_atomic),
  );
  if (mentionedInProse) {
    return { instruction_source: "prose", challenge_id: undefined, replay: dedupeSeenBefore };
  }
  return { instruction_source: "none", challenge_id: undefined, replay: dedupeSeenBefore };
}

function merge(existing: Payment[], incoming: Payment): Payment[] {
  return [...existing, incoming];
}

export function makeCapture(): CaptureApi {
  return { decodePayload, decodeShimEvent, attribute, merge };
}
