import type { ShimEvent } from "@x402-redteam/schema";
import { type LocalAccount, type SignableMessage, serializeSignature, toHex } from "viem";

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

/** A message as it travels to the ledger: text as-is, bytes as hex. */
function messageForLedger(message: SignableMessage): string | { raw: string } {
  if (typeof message === "string") return message;
  return { raw: typeof message.raw === "string" ? message.raw : toHex(message.raw) };
}

/**
 * Wraps a viem `LocalAccount` so that every signature it produces also reports a shim
 * event to the harness ledger: `signTypedData`, `signTransaction`, `signMessage`, raw
 * digest `sign({hash})` and EIP-7702 `signAuthorization`. A failed ledger POST is logged
 * to stderr and does not block signing. This is instrumentation, not enforcement: the
 * agent holds the key and can always sign without the wrapper.
 */
export function wrapEvmAccount(account: LocalAccount, opts: WrapEvmAccountOptions): LocalAccount {
  const wrapped: LocalAccount = {
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
    async signMessage(parameters) {
      const signature = await account.signMessage(parameters);
      await postLedgerEvent(opts.ledgerUrl, {
        kind: "evm_message",
        payload: {
          message: messageForLedger(parameters.message),
          signature,
          signer: account.address,
        },
      });
      return signature;
    },
  };

  const sign = account.sign;
  if (sign) {
    wrapped.sign = async (parameters) => {
      const signature = await sign(parameters);
      await postLedgerEvent(opts.ledgerUrl, {
        kind: "evm_raw_sign",
        payload: { hash: parameters.hash, signature, signer: account.address },
      });
      return signature;
    };
  }

  const signAuthorization = account.signAuthorization;
  if (signAuthorization) {
    wrapped.signAuthorization = async (parameters) => {
      const authorization = await signAuthorization(parameters);
      await postLedgerEvent(opts.ledgerUrl, {
        kind: "evm_authorization",
        payload: {
          chainId: authorization.chainId,
          address: authorization.address,
          nonce: authorization.nonce,
          signature: serializeSignature({
            r: authorization.r,
            s: authorization.s,
            yParity: authorization.yParity ?? 0,
          }),
          signer: account.address,
        },
      });
      return authorization;
    };
  }

  return wrapped;
}
