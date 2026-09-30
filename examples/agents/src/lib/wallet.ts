import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { wrapEvmAccount, wrapSvmSigner } from "@x402-redteam/capture";
import { privateKeyToAccount } from "viem/accounts";
import type { FetchLike } from "./crawl.js";

/** The harness's task.json (version 1), per application-design.md §6. Kept local (rather
 * than importing `@x402-redteam/cli`) so the example agents don't depend on the CLI. */
export interface TaskFile {
  version: 1;
  run_id: string;
  prompt: string;
  base_url: string;
  chain: "evm" | "svm";
  network: string;
  budget_usd: number;
  allowed_hosts: string[];
  wallet: { address: string; private_key: string } | { address: string; secret_key_base58: string };
  facilitator_url: string;
  solana_rpc_url: string;
  ledger_url: string;
  notice: string;
}

/** Reads and parses `task.json` from `X402_REDTEAM_TASK`. */
export function readTask(): TaskFile {
  const path = process.env.X402_REDTEAM_TASK;
  if (!path) throw new Error("X402_REDTEAM_TASK is not set");
  return JSON.parse(readFileSync(path, "utf8")) as TaskFile;
}

/** The agent's raw secret, chain-appropriate. */
export function walletSecret(task: TaskFile): string {
  return "private_key" in task.wallet ? task.wallet.private_key : task.wallet.secret_key_base58;
}

export interface BuiltClient {
  client: x402Client;
  payFetch: FetchLike;
}

export interface BuildClientOptions {
  /**
   * `@x402/core`'s `x402Client` applies its own default spend control
   * (`spendControls.maxAmountPerPayment`, currently "$1") independently of
   * anything either reference agent does - so by default even `naive` would
   * be silently protected from a large overpay (e.g. corpus/unit-confusion.yaml's
   * ~$1,000,000 decimal-confusion challenge) by the SDK itself, not by any
   * judgment naive makes. Since naive is meant to model a maximally gullible
   * payer with no spend awareness at all, it disables this cap; guarded
   * leaves it in place (irrelevant in practice, since guarded's own
   * `onBeforePaymentCreation` budget check is always stricter and runs first).
   */
  unlimitedSpend?: boolean;
}

/**
 * Builds the real x402 client for `task.chain`, per functional-design.md §5:
 * the wallet/signer is wrapped (`wrapEvmAccount`/`wrapSvmSigner`) so every
 * header-path payment also reports a shim event - `capture` then merges the
 * two into a single "header+shim" payment. SVM registers `ExactSvmScheme`
 * directly (not `registerExactSvmScheme`, which drops `rpcUrl` in
 * @x402/svm@2.28.0 and would fall back to the public devnet - see
 * functional-design.md §5 and the U3 audit note).
 */
export async function buildClient(
  task: TaskFile,
  opts: BuildClientOptions = {},
): Promise<BuiltClient> {
  const client = new x402Client();
  if (opts.unlimitedSpend) {
    client.setSpendControls({ maxAmountPerPayment: false });
  }

  if (task.chain === "evm") {
    const wallet = task.wallet as { address: string; private_key: string };
    const account = privateKeyToAccount(wallet.private_key as `0x${string}`);
    const wrapped = wrapEvmAccount(account, { ledgerUrl: task.ledger_url });
    registerExactEvmScheme(client, { signer: wrapped });
  } else {
    const wallet = task.wallet as { address: string; secret_key_base58: string };
    const signer = await createKeyPairSignerFromBytes(
      getBase58Encoder().encode(wallet.secret_key_base58),
    );
    const wrapped = wrapSvmSigner(signer, { ledgerUrl: task.ledger_url });
    // Registered against the "solana:*" wildcard (per functional-design.md §5), not just
    // `task.network`: a rail-switch challenge legitimately names a different solana:* network
    // (e.g. mainnet) than the task's test network, and the agent still needs a scheme able to
    // sign for it so that its own policy (guarded) or lack thereof (naive) is what decides,
    // rather than the client silently having no scheme registered for that network at all.
    client.register(
      "solana:*" as Network,
      new ExactSvmScheme(wrapped, { rpcUrl: task.solana_rpc_url }),
    );
  }

  const payFetch = wrapFetchWithPayment(fetch, client) as FetchLike;
  return { client, payFetch };
}
