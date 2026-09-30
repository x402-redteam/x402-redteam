/**
 * U10 (ADR-013): sends a real, signed, direct (non-x402) transfer to the harness's
 * mock chain RPC (`task.evm_rpc_url` / `task.solana_rpc_url`), rather than
 * self-reporting it to `/__harness/ledger` via `@x402-redteam/capture`'s
 * `recordTransfer` - so the payment is observed at the chain boundary even when the
 * caller passes `noShim: true` (no shim event at all), proving the mock RPC alone is
 * sufficient. Nothing is ever broadcast to a real chain: both RPC URLs point at the
 * harness's own adversary server.
 */
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createSolanaRpc,
  createTransactionMessage,
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
import { CHAIN_DEFAULTS, FIXED_BLOCKHASH, usdToAtomic } from "@x402-redteam/schema";
import { createWalletClient, erc20Abi, http, publicActions } from "viem";
import type { TaskFile } from "./wallet.js";
import { walletSigner } from "./wallet.js";

export interface SendDirectTransferOptions {
  to: string;
  amountUsd: number;
  /** v2 (NAIVE_NO_SHIM): see `walletSigner`. */
  noShim?: boolean;
}

function evmChainIdFromNetwork(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`sendDirectTransfer: unsupported evm network ${network}`);
  return Number(match[1]);
}

async function sendEvmDirectTransfer(
  task: TaskFile,
  opts: SendDirectTransferOptions,
): Promise<string> {
  const signer = await walletSigner(task, { noShim: opts.noShim });
  if (signer.chain !== "evm") throw new Error("sendDirectTransfer: task.chain is not evm");
  if (!task.evm_rpc_url) throw new Error("sendDirectTransfer: task.evm_rpc_url is not set");

  const defaults = CHAIN_DEFAULTS.evm;
  const chainId = evmChainIdFromNetwork(task.network);
  const walletClient = createWalletClient({
    account: signer.account,
    chain: {
      id: chainId,
      name: "x402-redteam",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [task.evm_rpc_url] } },
    },
    transport: http(task.evm_rpc_url),
  }).extend(publicActions);

  const amountAtomic = BigInt(usdToAtomic(opts.amountUsd, defaults.decimals));
  const hash = await walletClient.writeContract({
    address: defaults.asset as `0x${string}`,
    abi: erc20Abi,
    functionName: "transfer",
    args: [opts.to as `0x${string}`, amountAtomic],
  });
  await walletClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function sendSvmDirectTransfer(
  task: TaskFile,
  opts: SendDirectTransferOptions,
): Promise<string> {
  const signer = await walletSigner(task, { noShim: opts.noShim });
  if (signer.chain !== "svm") throw new Error("sendDirectTransfer: task.chain is not svm");
  if (!task.solana_rpc_url) throw new Error("sendDirectTransfer: task.solana_rpc_url is not set");

  const defaults = CHAIN_DEFAULTS.svm;
  const mint = address(defaults.asset);
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const [sourceAta] = await findAssociatedTokenPda({
    mint,
    owner: signer.signer.address,
    tokenProgram,
  });
  const [destinationAta] = await findAssociatedTokenPda({
    mint,
    owner: address(opts.to),
    tokenProgram,
  });

  const amountAtomic = BigInt(usdToAtomic(opts.amountUsd, defaults.decimals));
  const transferIx = getTransferCheckedInstruction(
    {
      source: sourceAta,
      mint,
      destination: destinationAta,
      authority: signer.signer,
      amount: amountAtomic,
      decimals: defaults.decimals,
    },
    { programAddress: tokenProgram },
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.signer.address, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(FIXED_BLOCKHASH), lastValidBlockHeight: 0n },
        tx,
      ),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
  );

  const signedTransaction = await partiallySignTransactionMessageWithSigners(message);
  const transactionBase64 = getBase64EncodedWireTransaction(signedTransaction);

  const rpc = createSolanaRpc(task.solana_rpc_url);
  const signature = await rpc.sendTransaction(transactionBase64, { encoding: "base64" }).send();
  return signature;
}

/**
 * Sends a real signed transfer of `amountUsd` (this chain's USDC) to `to`, submitted
 * directly to the harness's mock chain RPC. Returns the tx hash (evm) / signature
 * (svm). See the module docstring - this is the RPC chain-boundary capture path, not
 * `@x402-redteam/capture`'s `recordTransfer` self-report.
 */
export async function sendDirectTransfer(
  task: TaskFile,
  opts: SendDirectTransferOptions,
): Promise<string> {
  return task.chain === "evm"
    ? sendEvmDirectTransfer(task, opts)
    : sendSvmDirectTransfer(task, opts);
}
