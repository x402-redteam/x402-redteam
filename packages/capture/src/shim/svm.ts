import {
  getBase64EncodedWireTransaction,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import type { ShimEvent } from "@x402-redteam/schema";

async function postLedgerEvent(ledgerUrl: string, event: ShimEvent): Promise<void> {
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

export interface WrapSvmSignerOptions {
  ledgerUrl: string;
}

/**
 * Wraps a kit `TransactionPartialSigner` (same shape as the input signer)
 * so that every `signTransactions` call also rebuilds the signed wire
 * transaction and reports an `svm_tx` shim event per transaction, per
 * functional-design.md §5. A failed ledger POST is logged to stderr and
 * does not block signing.
 */
export function wrapSvmSigner<TAddress extends string = string>(
  signer: TransactionPartialSigner<TAddress>,
  opts: WrapSvmSignerOptions,
): TransactionPartialSigner<TAddress> {
  return {
    address: signer.address,
    async signTransactions(transactions, config) {
      const signatureDictionaries = await signer.signTransactions(transactions, config);
      for (let i = 0; i < transactions.length; i++) {
        const transaction = transactions[i] as Transaction;
        const signatureDictionary = signatureDictionaries[i];
        const merged: Transaction = {
          ...transaction,
          signatures: { ...transaction.signatures, ...signatureDictionary },
        };
        const transactionBase64 = getBase64EncodedWireTransaction(merged);
        await postLedgerEvent(opts.ledgerUrl, {
          kind: "svm_tx",
          payload: { transaction_base64: transactionBase64 },
        });
      }
      return signatureDictionaries;
    },
  };
}
