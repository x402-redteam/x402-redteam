import { createHash } from "node:crypto";
import {
  type Address,
  address,
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { DecodedPayment, DecodeHints } from "@x402-redteam/schema";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";

const TRANSFER_CHECKED_DISCRIMINATOR = 12;

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
  }
  return value;
}

/** See the identical helper in evm.ts - kept local to avoid a cross-decoder import. */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

interface DecodeSvmOpts {
  network?: string;
  scheme?: string;
}

/**
 * Decodes a base64-encoded Solana wire transaction carrying a
 * `TransferChecked` instruction (SPL Token or Token-2022), per
 * functional-design.md §0 and §2.
 */
export async function decodeSvmTransaction(
  base64: string,
  hints?: DecodeHints,
  opts?: DecodeSvmOpts,
): Promise<DecodedPayment> {
  const network = opts?.network ?? CHAIN_DEFAULTS.svm.network;
  const scheme = opts?.scheme ?? "exact";

  const bytes = getBase64Encoder().encode(base64);
  const tx = getTransactionDecoder().decode(bytes);
  const messageBytes = Uint8Array.from(tx.messageBytes);
  const dedupe_key = `svm:${getBase58Decoder().decode(createHash("sha256").update(messageBytes).digest())}`;

  const empty: DecodedPayment = {
    chain: "svm",
    network,
    scheme,
    asset: "",
    from: "",
    to: "",
    amount_atomic: "0",
    dedupe_key,
    valid: false,
    raw: base64,
  };

  // biome-ignore lint/suspicious/noExplicitAny: compiled message shape varies by version (legacy/v0/v1).
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as any;
  if (compiled.version !== "legacy" && (compiled.addressTableLookups?.length ?? 0) > 0) {
    return { ...empty, invalid_reason: "alt_unsupported" };
  }

  // biome-ignore lint/suspicious/noExplicitAny: decompiled message instruction shape.
  const message = decompileTransactionMessage(compiled) as any;
  const transferIx = (message.instructions as unknown[]).find((ix) => {
    // biome-ignore lint/suspicious/noExplicitAny: instruction accounts/data are loosely typed here.
    const i = ix as any;
    return (
      (i.programAddress === TOKEN_PROGRAM_ADDRESS ||
        i.programAddress === TOKEN_2022_PROGRAM_ADDRESS) &&
      i.data instanceof Uint8Array &&
      i.data.length >= 9 &&
      i.data[0] === TRANSFER_CHECKED_DISCRIMINATOR
    );
    // biome-ignore lint/suspicious/noExplicitAny: see above.
  }) as any;

  if (!transferIx) {
    return { ...empty, invalid_reason: "no_transfer_instruction" };
  }

  const accounts = transferIx.accounts as { address: Address }[];
  const mint = accounts[1]?.address;
  const destination = accounts[2]?.address;
  const authority = accounts[3]?.address;
  const data = transferIx.data as Uint8Array;
  const amount = readU64LE(data, 1);

  if (!mint || !destination || !authority) {
    return { ...empty, invalid_reason: "no_transfer_instruction" };
  }

  let valid = false;
  const sigBytes = (tx.signatures as Record<string, Uint8Array | null>)[authority];
  if (sigBytes) {
    try {
      const publicKey = await getPublicKeyFromAddress(authority);
      // biome-ignore lint/suspicious/noExplicitAny: SignatureBytes brand vs plain Uint8Array.
      valid = await verifySignature(publicKey, sigBytes as any, tx.messageBytes);
    } catch {
      valid = false;
    }
  }

  let to: string = destination;
  let invalid_reason: string | undefined;
  let resolved = false;
  for (const owner of hints?.knownOwners ?? []) {
    try {
      const [ata] = await findAssociatedTokenPda({
        mint,
        owner: address(owner),
        tokenProgram: transferIx.programAddress,
      });
      if (ata === destination) {
        to = owner;
        resolved = true;
        break;
      }
    } catch {
      // Malformed hint address; skip it.
    }
  }
  if (!resolved) {
    invalid_reason = "unresolved_owner";
  }

  // Defensive check (orchestrator addition, U9-B review): `amount` is read via
  // `readU64LE` from the instruction's raw bytes (bit-shifted into a BigInt), so it
  // can't actually be negative - unlike the EVM header path's untyped
  // `authorization.value` string - but the same non-negative-integer check is applied
  // here too, uniformly, rather than relying on that invariant forever.
  const amount_atomic = amount.toString();
  if (!isNonNegativeIntegerString(amount_atomic)) {
    return { ...empty, asset: mint, from: authority, invalid_reason: "negative_amount" };
  }

  return {
    chain: "svm",
    network,
    scheme,
    asset: mint,
    from: authority,
    to,
    amount_atomic,
    dedupe_key,
    valid,
    invalid_reason: invalid_reason ?? (valid ? undefined : "bad_signature"),
    to_token_account: destination,
    raw: base64,
  };
}
