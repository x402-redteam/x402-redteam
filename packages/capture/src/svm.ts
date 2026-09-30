import { createHash } from "node:crypto";
import {
  type Address,
  address,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isSome,
  verifySignature,
} from "@solana/kit";
import {
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
  TRANSFER_SOL_DISCRIMINATOR,
} from "@solana-program/system";
import {
  APPROVE_CHECKED_DISCRIMINATOR,
  APPROVE_DISCRIMINATOR,
  findAssociatedTokenPda,
  getApproveCheckedInstructionDataDecoder,
  getApproveInstructionDataDecoder,
  getSetAuthorityInstructionDataDecoder,
  getTransferCheckedInstructionDataDecoder,
  getTransferInstructionDataDecoder,
  SET_AUTHORITY_DISCRIMINATOR,
  TOKEN_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
  TRANSFER_DISCRIMINATOR,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { DecodedPayment, DecodeHints } from "@x402-redteam/schema";
import { CHAIN_DEFAULTS, NATIVE_ASSET } from "@x402-redteam/schema";

/** See the identical helper in evm.ts - kept local to avoid a cross-decoder import. */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

interface DecodeSvmOpts {
  network?: string;
  scheme?: string;
}

/** A raw (pre-decompile) instruction, with accounts resolved by static index only - see
 * `decodeSvmTransaction`'s module docstring for why decompileTransactionMessage isn't used. */
interface RawInstruction {
  ixIndex: number;
  programAddress: Address | undefined;
  /** Resolved account addresses in order; `undefined` at a position whose index falls in an
   * address-lookup-table range this offline harness cannot resolve (see H1/ALT handling). */
  accountAddresses: (Address | undefined)[];
  data: Uint8Array;
}

function isTokenProgram(programAddress: Address | undefined): boolean {
  return programAddress === TOKEN_PROGRAM_ADDRESS || programAddress === TOKEN_2022_PROGRAM_ADDRESS;
}

/**
 * Verifies `signerAddress`'s ed25519 signature over `messageBytes` using the transaction's
 * signature dictionary. Returns `false` (not an error) when the address never signed at all.
 */
async function verifySignerAddress(
  signerAddress: Address | undefined,
  signatures: Record<string, Uint8Array | null>,
  messageBytes: Uint8Array,
): Promise<boolean> {
  if (!signerAddress) return false;
  const sigBytes = signatures[signerAddress];
  if (!sigBytes) return false;
  try {
    const publicKey = await getPublicKeyFromAddress(signerAddress);
    // biome-ignore lint/suspicious/noExplicitAny: SignatureBytes brand vs plain Uint8Array.
    return await verifySignature(publicKey, sigBytes as any, messageBytes);
  } catch {
    return false;
  }
}

/** Resolves a TransferChecked/ApproveChecked destination-or-delegate token account back to an
 * owner address by testing every hinted owner's ATA for the given mint. */
async function resolveOwnerFromTokenAccount(
  tokenAccount: Address,
  mint: Address,
  tokenProgram: Address,
  hints: DecodeHints | undefined,
): Promise<string | undefined> {
  for (const owner of hints?.knownOwners ?? []) {
    try {
      const [ata] = await findAssociatedTokenPda({ mint, owner: address(owner), tokenProgram });
      if (ata === tokenAccount) return owner;
    } catch {
      // Malformed hint address; skip it.
    }
  }
  return undefined;
}

interface LegContext {
  network: string;
  scheme: string;
  dedupeBase: string;
  messageBytes: Uint8Array;
  signatures: Record<string, Uint8Array | null>;
  hints: DecodeHints | undefined;
  raw: string;
}

/**
 * Decodes one recognized instruction into a Payment "leg", or returns `undefined` if the
 * instruction isn't one of the value-moving/authority-granting kinds this harness tracks
 * (H1/M2, code review). Every leg gets its own `dedupe_key` (`svm:<msghash>#<ixIndex>`), so
 * multiple legs in one transaction are recorded as separate Payments (H1).
 *
 * When any account this instruction needs falls outside the static account list (i.e. it
 * would require resolving a Solana address-lookup table, which this offline harness has no
 * way to do), the leg is still recorded - with whatever accounts *are* resolvable, and the
 * amount (always decodable from instruction data, never from an ALT-resolved account) - but
 * marked `valid: false, invalid_reason: "alt_unsupported"` rather than silently dropped or
 * counted as $0 (H1).
 */
async function decodeInstructionLeg(
  ix: RawInstruction,
  ctx: LegContext,
): Promise<DecodedPayment | undefined> {
  const dedupe_key = `${ctx.dedupeBase}#${ix.ixIndex}`;
  const accountsAlt = ix.accountAddresses;
  const anyAltAccount = (indices: number[]) => indices.some((i) => accountsAlt[i] === undefined);

  const base = {
    chain: "svm" as const,
    network: ctx.network,
    dedupe_key,
    raw: ctx.raw,
  };

  // --- SPL Token / Token-2022 ---
  if (isTokenProgram(ix.programAddress)) {
    const tokenProgram = ix.programAddress as Address;
    const disc = ix.data[0];

    if (disc === TRANSFER_CHECKED_DISCRIMINATOR && ix.data.length >= 10) {
      // accounts: source(0), mint(1), destination(2), authority(3)
      if (anyAltAccount([0, 1, 2, 3])) {
        const amount = getTransferCheckedInstructionDataDecoder().decode(ix.data).amount.toString();
        return {
          ...base,
          scheme: ctx.scheme,
          asset: accountsAlt[1] ?? "",
          from: accountsAlt[3] ?? "",
          to: accountsAlt[2] ?? "",
          amount_atomic: amount,
          valid: false,
          invalid_reason: "alt_unsupported",
        };
      }
      const mint = accountsAlt[1] as Address;
      const destination = accountsAlt[2] as Address;
      const authority = accountsAlt[3] as Address;
      const amount_atomic = getTransferCheckedInstructionDataDecoder()
        .decode(ix.data)
        .amount.toString();
      if (!isNonNegativeIntegerString(amount_atomic)) {
        return {
          ...base,
          scheme: ctx.scheme,
          asset: mint,
          from: authority,
          to: destination,
          amount_atomic,
          valid: false,
          invalid_reason: "negative_amount",
        };
      }
      const valid = await verifySignerAddress(authority, ctx.signatures, ctx.messageBytes);
      const owner = await resolveOwnerFromTokenAccount(destination, mint, tokenProgram, ctx.hints);
      return {
        ...base,
        scheme: ctx.scheme,
        asset: mint,
        from: authority,
        to: owner ?? destination,
        amount_atomic,
        valid,
        invalid_reason:
          owner === undefined ? "unresolved_owner" : valid ? undefined : "bad_signature",
        to_token_account: destination,
      };
    }

    if (disc === TRANSFER_DISCRIMINATOR && ix.data.length >= 9) {
      // accounts: source(0), destination(1), authority(2). No mint in this legacy
      // instruction, so the destination token account can't be resolved to an owner
      // (findAssociatedTokenPda needs the mint) - `to` stays the raw token account,
      // asset is unknown ("" -> assetInfo's 6-decimals/$1 fallback).
      const amount_atomic = getTransferInstructionDataDecoder().decode(ix.data).amount.toString();
      if (anyAltAccount([0, 1, 2])) {
        return {
          ...base,
          scheme: "transfer",
          asset: "",
          from: accountsAlt[2] ?? "",
          to: accountsAlt[1] ?? "",
          amount_atomic,
          valid: false,
          invalid_reason: "alt_unsupported",
        };
      }
      const destination = accountsAlt[1] as Address;
      const authority = accountsAlt[2] as Address;
      if (!isNonNegativeIntegerString(amount_atomic)) {
        return {
          ...base,
          scheme: "transfer",
          asset: "",
          from: authority,
          to: destination,
          amount_atomic,
          valid: false,
          invalid_reason: "negative_amount",
        };
      }
      const valid = await verifySignerAddress(authority, ctx.signatures, ctx.messageBytes);
      return {
        ...base,
        scheme: "transfer",
        asset: "",
        from: authority,
        to: destination,
        amount_atomic,
        valid,
        invalid_reason: "unresolved_owner",
        to_token_account: destination,
      };
    }

    if (disc === APPROVE_CHECKED_DISCRIMINATOR && ix.data.length >= 10) {
      // accounts: source(0), mint(1), delegate(2), owner(3). `delegate`/`owner` are
      // already wallet-level addresses (not token accounts), so no ATA resolution is
      // needed - unlike TransferChecked's destination.
      const amount_atomic = getApproveCheckedInstructionDataDecoder()
        .decode(ix.data)
        .amount.toString();
      if (anyAltAccount([1, 2, 3])) {
        return {
          ...base,
          scheme: "approve",
          asset: accountsAlt[1] ?? "",
          from: accountsAlt[3] ?? "",
          to: accountsAlt[2] ?? "",
          amount_atomic,
          valid: false,
          invalid_reason: "alt_unsupported",
        };
      }
      const mint = accountsAlt[1] as Address;
      const delegate = accountsAlt[2] as Address;
      const owner = accountsAlt[3] as Address;
      if (!isNonNegativeIntegerString(amount_atomic)) {
        return {
          ...base,
          scheme: "approve",
          asset: mint,
          from: owner,
          to: delegate,
          amount_atomic,
          valid: false,
          invalid_reason: "negative_amount",
        };
      }
      const valid = await verifySignerAddress(owner, ctx.signatures, ctx.messageBytes);
      return {
        ...base,
        scheme: "approve",
        asset: mint,
        from: owner,
        to: delegate,
        amount_atomic,
        valid,
        invalid_reason: valid ? undefined : "bad_signature",
      };
    }

    if (disc === APPROVE_DISCRIMINATOR && ix.data.length >= 9) {
      // accounts: source(0), delegate(1), owner(2). No mint - asset unknown, same
      // fallback as legacy Transfer. The exposure cap (ADR-015) bounds the effect of
      // treating an unknown-decimals allowance as if it were a 6-decimal $1 asset.
      const amount_atomic = getApproveInstructionDataDecoder().decode(ix.data).amount.toString();
      if (anyAltAccount([1, 2])) {
        return {
          ...base,
          scheme: "approve",
          asset: "",
          from: accountsAlt[2] ?? "",
          to: accountsAlt[1] ?? "",
          amount_atomic,
          valid: false,
          invalid_reason: "alt_unsupported",
        };
      }
      const delegate = accountsAlt[1] as Address;
      const owner = accountsAlt[2] as Address;
      if (!isNonNegativeIntegerString(amount_atomic)) {
        return {
          ...base,
          scheme: "approve",
          asset: "",
          from: owner,
          to: delegate,
          amount_atomic,
          valid: false,
          invalid_reason: "negative_amount",
        };
      }
      const valid = await verifySignerAddress(owner, ctx.signatures, ctx.messageBytes);
      return {
        ...base,
        scheme: "approve",
        asset: "",
        from: owner,
        to: delegate,
        amount_atomic,
        valid,
        invalid_reason: valid ? undefined : "bad_signature",
      };
    }

    if (disc === SET_AUTHORITY_DISCRIMINATOR && ix.data.length >= 3) {
      // accounts: owned(0), owner(1). `newAuthority` (the account being handed
      // control) comes from instruction *data*, not an account index, so it's always
      // resolvable regardless of ALT. There's no "amount" for a pure authority grant;
      // this is reported with amount_atomic "0" (so it never inflates unauthorized_usd)
      // but is still visible in the ledger by its `scheme:"approve"`/`to` fields, since
      // handing over account control is itself a value-moving-adjacent event worth
      // recording (code review M2).
      const decoded = getSetAuthorityInstructionDataDecoder().decode(ix.data);
      const newAuthority = isSome(decoded.newAuthority) ? decoded.newAuthority.value : undefined;
      if (anyAltAccount([1])) {
        return {
          ...base,
          scheme: "approve",
          asset: "",
          from: accountsAlt[1] ?? "",
          to: newAuthority ?? "",
          amount_atomic: "0",
          valid: false,
          invalid_reason: "alt_unsupported",
        };
      }
      const owner = accountsAlt[1] as Address;
      const valid = await verifySignerAddress(owner, ctx.signatures, ctx.messageBytes);
      return {
        ...base,
        scheme: "approve",
        asset: "",
        from: owner,
        to: newAuthority ?? "",
        amount_atomic: "0",
        valid,
        invalid_reason: valid ? undefined : "bad_signature",
      };
    }

    return undefined;
  }

  // --- System Program: native SOL transfer ---
  if (ix.programAddress === SYSTEM_PROGRAM_ADDRESS) {
    const discriminant =
      ix.data.length >= 4
        ? (ix.data[0] ?? 0) |
          ((ix.data[1] ?? 0) << 8) |
          ((ix.data[2] ?? 0) << 16) |
          ((ix.data[3] ?? 0) << 24)
        : -1;
    if (discriminant === TRANSFER_SOL_DISCRIMINATOR && ix.data.length >= 12) {
      // accounts: source(0, signer), destination(1)
      const amount_atomic = getTransferSolInstructionDataDecoder()
        .decode(ix.data)
        .amount.toString();
      if (anyAltAccount([0, 1])) {
        return {
          ...base,
          scheme: "transfer",
          asset: NATIVE_ASSET,
          from: accountsAlt[0] ?? "",
          to: accountsAlt[1] ?? "",
          amount_atomic,
          valid: false,
          invalid_reason: "alt_unsupported",
        };
      }
      const source = accountsAlt[0] as Address;
      const destination = accountsAlt[1] as Address;
      if (!isNonNegativeIntegerString(amount_atomic)) {
        return {
          ...base,
          scheme: "transfer",
          asset: NATIVE_ASSET,
          from: source,
          to: destination,
          amount_atomic,
          valid: false,
          invalid_reason: "negative_amount",
        };
      }
      const valid = await verifySignerAddress(source, ctx.signatures, ctx.messageBytes);
      return {
        ...base,
        scheme: "transfer",
        asset: NATIVE_ASSET,
        from: source,
        to: destination,
        amount_atomic,
        valid,
        invalid_reason: valid ? undefined : "bad_signature",
      };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Decodes a base64-encoded Solana wire transaction, per U10 functional-design.md §0/§2 and
 * the code review's H1 fix: every value-moving (or authority-granting) instruction in the
 * transaction is recorded as its own Payment "leg" (`DecodedPayment.legs`), not just the
 * first one found. Recognises SPL Token / Token-2022 `Transfer`, `TransferChecked`,
 * `Approve`, `ApproveChecked`, `SetAuthority`, and the System Program's native `Transfer`.
 *
 * This works off the *raw compiled* instruction list (`getCompiledTransactionMessageDecoder`)
 * rather than `decompileTransactionMessage`, because the latter requires supplying the
 * concrete addresses behind any address-lookup-table (ALT) reference to fully resolve a v0
 * message - which an offline harness fundamentally cannot do (that data only exists on
 * chain). Instead, every account is resolved by index against the message's *static*
 * account list; an index beyond it (i.e. one that would require an ALT) is left
 * unresolved, and the leg is still recorded (amount included) with
 * `invalid_reason: "alt_unsupported"` rather than silently dropped.
 *
 * The top-level `DecodedPayment` fields returned mirror the first leg (for callers that
 * only look at one payment); `legs` carries every leg found, in instruction order. When no
 * instruction is recognised at all, `legs` is a single `invalid_reason: "no_transfer_instruction"`
 * entry, matching the pre-H1 behaviour.
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
  const dedupeBase = `svm:${getBase58Decoder().decode(createHash("sha256").update(messageBytes).digest())}`;

  const empty: DecodedPayment = {
    chain: "svm",
    network,
    scheme,
    asset: "",
    from: "",
    to: "",
    amount_atomic: "0",
    dedupe_key: dedupeBase,
    valid: false,
    invalid_reason: "no_transfer_instruction",
    raw: base64,
  };

  // biome-ignore lint/suspicious/noExplicitAny: compiled message shape varies by version (legacy/v0/v1).
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as any;
  const staticAccounts = compiled.staticAccounts as Address[];
  const staticCount = staticAccounts.length;
  const resolveIdx = (idx: number | undefined): Address | undefined =>
    idx !== undefined && idx < staticCount ? staticAccounts[idx] : undefined;

  const rawInstructions: RawInstruction[] = (compiled.instructions as unknown[]).map(
    (raw, ixIndex) => {
      // biome-ignore lint/suspicious/noExplicitAny: raw compiled instruction shape.
      const i = raw as any;
      const accountIndices: number[] = i.accountIndices ?? [];
      return {
        ixIndex,
        programAddress: resolveIdx(i.programAddressIndex),
        accountAddresses: accountIndices.map((idx) => resolveIdx(idx)),
        data: (i.data ?? new Uint8Array(0)) as Uint8Array,
      };
    },
  );

  const signatures = tx.signatures as Record<string, Uint8Array | null>;
  const ctx: LegContext = {
    network,
    scheme,
    dedupeBase,
    messageBytes,
    signatures,
    hints,
    raw: base64,
  };

  const legs: DecodedPayment[] = [];
  for (const ix of rawInstructions) {
    try {
      const leg = await decodeInstructionLeg(ix, ctx);
      if (leg) legs.push(leg);
    } catch {
      // A malformed instruction that matched a program/discriminator we recognise but
      // whose data doesn't actually decode (e.g. truncated) is skipped, not fatal to the
      // rest of the transaction's legs.
    }
  }

  if (legs.length === 0) {
    return { ...empty, legs: [empty] };
  }

  const [first, ...rest] = legs;
  return { ...(first as DecodedPayment), legs: [first as DecodedPayment, ...rest] };
}
