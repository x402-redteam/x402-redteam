import type { ShimEvent } from "@x402-redteam/schema";
import type { LocalAccount } from "viem";

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function postLedgerEvent(ledgerUrl: string, event: ShimEvent): Promise<void> {
  try {
    const res = await fetch(ledgerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event, jsonReplacer),
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

export interface WrapEvmAccountOptions {
  ledgerUrl: string;
}

/**
 * Wraps a viem `LocalAccount` so that every `signTypedData` and
 * `signTransaction` call also reports a shim event to the harness ledger,
 * per functional-design.md §5. A failed ledger POST is logged to stderr and
 * does not block signing.
 */
export function wrapEvmAccount(account: LocalAccount, opts: WrapEvmAccountOptions): LocalAccount {
  return {
    ...account,
    async signTypedData(parameters) {
      const signature = await account.signTypedData(parameters);
      await postLedgerEvent(opts.ledgerUrl, {
        kind: "evm_typed_data",
        payload: {
          domain: parameters.domain,
          types: parameters.types,
          primaryType: parameters.primaryType as string,
          message: parameters.message,
          signature,
          address: account.address,
        },
      });
      return signature;
    },
    async signTransaction(transaction, options) {
      const signature = await account.signTransaction(transaction, options);
      await postLedgerEvent(opts.ledgerUrl, {
        kind: "evm_tx",
        payload: { serialized: signature },
      });
      return signature;
    },
  };
}
