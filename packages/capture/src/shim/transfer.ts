import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { Chain, DecodedPayment } from "@x402-redteam/schema";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeEvmTx } from "../evm.js";
import { decodeSvmTransaction } from "../svm.js";

/**
 * All-1s base58 string (32 zero bytes), used as a deterministic, offline
 * transaction lifetime constraint for `recordTransfer`'s SVM path, per
 * functional-design.md §5 ("the harness fixed blockhash
 * `11111111111111111111111111111111` or a constant exported from schema").
 * `@x402-redteam/schema` does not currently export such a constant - see
 * this unit's report for a note to the architect.
 */
const FIXED_BLOCKHASH = "11111111111111111111111111111111";

async function postLedgerEvent(ledgerUrl: string, event: unknown): Promise<void> {
  try {
    const res = await fetch(ledgerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      console.error(
        `x402-redteam/capture: ledger POST to ${ledgerUrl} failed with status ${res.status}`,
      );
    }
  } catch (err) {
    console.error(`x402-redteam/capture: ledger POST to ${ledgerUrl} failed`, err);
  }
}

export interface RecordTransferOptions {
  chain: Chain;
  ledgerUrl: string;
  /** evm: 0x-prefixed hex private key. svm: base58-encoded 64-byte keypair. */
  secret: string;
  to: string;
  amount_atomic: string;
  asset?: string;
  network?: string;
}

async function recordEvmTransfer(opts: RecordTransferOptions): Promise<DecodedPayment> {
  const asset = opts.asset ?? CHAIN_DEFAULTS.evm.asset;
  const network = opts.network ?? CHAIN_DEFAULTS.evm.network;
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) {
    throw new Error(
      `recordTransfer: unsupported evm network ${network} (expected eip155:CHAIN_ID)`,
    );
  }
  const chainId = Number(match[1]);

  const account = privateKeyToAccount(opts.secret as Hex);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [opts.to as Hex, BigInt(opts.amount_atomic)],
  });

  const serialized = await account.signTransaction({
    chainId,
    nonce: 0,
    to: asset as Hex,
    data,
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    type: "eip1559",
  });

  await postLedgerEvent(opts.ledgerUrl, { kind: "evm_tx", payload: { serialized } });
  return decodeEvmTx({ serialized });
}

async function recordSvmTransfer(opts: RecordTransferOptions): Promise<DecodedPayment> {
  const mint = address(opts.asset ?? CHAIN_DEFAULTS.svm.asset);
  const network = opts.network ?? CHAIN_DEFAULTS.svm.network;
  const decimals = CHAIN_DEFAULTS.svm.decimals;
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;

  const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(opts.secret));
  const [sourceAta] = await findAssociatedTokenPda({ mint, owner: signer.address, tokenProgram });
  const [destinationAta] = await findAssociatedTokenPda({
    mint,
    owner: address(opts.to),
    tokenProgram,
  });

  const transferIx = getTransferCheckedInstruction(
    {
      source: sourceAta,
      mint,
      destination: destinationAta,
      authority: signer,
      amount: BigInt(opts.amount_atomic),
      decimals,
    },
    { programAddress: tokenProgram },
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(FIXED_BLOCKHASH), lastValidBlockHeight: 0n },
        tx,
      ),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
  );

  const signedTransaction = await partiallySignTransactionMessageWithSigners(message);
  const transactionBase64 = getBase64EncodedWireTransaction(signedTransaction);

  await postLedgerEvent(opts.ledgerUrl, {
    kind: "svm_tx",
    payload: { transaction_base64: transactionBase64 },
  });
  return decodeSvmTransaction(transactionBase64, { knownOwners: [opts.to] }, { network });
}

/**
 * Builds a real signed direct (non-x402) transfer offline - no RPC - and
 * reports it to the harness ledger, per functional-design.md §5. Returns the
 * same `DecodedPayment` the server will compute from the reported event.
 */
export async function recordTransfer(opts: RecordTransferOptions): Promise<DecodedPayment> {
  return opts.chain === "evm" ? recordEvmTransfer(opts) : recordSvmTransfer(opts);
}
