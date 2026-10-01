/**
 * GDP-gated direct (non-x402) transfers, per functional-design.md §2/§5 (`src/transfer.ts`,
 * "direct transfer via harness RPC; reuse logic of examples/agents/src/lib/transfer.ts;
 * copy, don't import examples"). Builds and signs the transfer exactly as that reference
 * logic does, then - same reasoning as `pay.ts` - decodes the already-signed
 * material with `@x402-redteam/capture`, asks the GDP `sign` hook, and only submits to
 * the harness's mock chain RPC (ADR-013) when it allows. Signing alone never reaches the
 * RPC, so a deny here means the harness's capture layer never sees this transfer at all.
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
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { capture } from "@x402-redteam/capture";
import { CHAIN_DEFAULTS, FIXED_BLOCKHASH, usdToAtomic } from "@x402-redteam/schema";
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type LocalAccount,
  publicActions,
} from "viem";
import type { GdpClient } from "./gdp.js";
import type { TransferIntent } from "./intent.js";
import type { GdpHook, GdpSignPayload, GdpSignResponse } from "./protocol.js";

export interface TransferWallet {
  evmAccount?: LocalAccount;
  svmSigner?: TransactionPartialSigner;
}

export interface TransferContext {
  gdp: GdpClient;
  hooks: Set<GdpHook>;
  wallet: TransferWallet;
  evmRpcUrl: string;
  solanaRpcUrl: string;
  network: string;
  log: (message: string) => void;
}

async function gdpSignAllows(
  ctx: TransferContext,
  chain: "evm" | "svm",
  payload: GdpSignPayload,
  decoded_legs: unknown[],
): Promise<boolean> {
  if (!ctx.hooks.has("sign")) return true;
  const decision = await ctx.gdp.request<GdpSignResponse>((id) => ({
    id,
    type: "sign",
    chain,
    payload,
    decoded_legs,
  }));
  // GdpClient already normalizes any non-conforming response (wrong case, missing
  // field, garbage) to a clean `{decision:"deny"}` - only a literal "allow" proceeds.
  if (decision.decision !== "allow") {
    ctx.log(
      `sign denied for direct transfer to ${JSON.stringify(decoded_legs)}: ${"reason" in decision ? decision.reason : "denied"}`,
    );
    return false;
  }
  return true;
}

function evmChainIdFromNetwork(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`transfer: unsupported evm network ${network}`);
  return Number(match[1]);
}

async function sendEvmTransfer(ctx: TransferContext, intent: TransferIntent): Promise<void> {
  if (!ctx.wallet.evmAccount) throw new Error("transfer: missing evm account");
  const defaults = CHAIN_DEFAULTS.evm;
  const chainId = evmChainIdFromNetwork(ctx.network);
  const walletClient = createWalletClient({
    account: ctx.wallet.evmAccount,
    chain: {
      id: chainId,
      name: "x402-redteam-driver",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [ctx.evmRpcUrl] } },
    },
    transport: http(ctx.evmRpcUrl),
  }).extend(publicActions);

  const amountAtomic = BigInt(usdToAtomic(intent.amount_usd, defaults.decimals));
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [intent.to as `0x${string}`, amountAtomic],
  });

  const request = await walletClient.prepareTransactionRequest({
    account: ctx.wallet.evmAccount,
    chain: walletClient.chain,
    to: defaults.asset as `0x${string}`,
    data,
    value: 0n,
  });
  const serialized = await walletClient.signTransaction(request);

  const decoded = await capture.decodeShimEvent({ kind: "evm_tx", payload: { serialized } });
  const allowed = await gdpSignAllows(
    ctx,
    "evm",
    { serialized_tx: serialized },
    decoded.legs ?? [decoded],
  );
  if (!allowed) return;

  const hash = await walletClient.sendRawTransaction({ serializedTransaction: serialized });
  await walletClient.waitForTransactionReceipt({ hash }).catch(() => undefined);
}

async function sendSvmTransfer(ctx: TransferContext, intent: TransferIntent): Promise<void> {
  if (!ctx.wallet.svmSigner) throw new Error("transfer: missing svm signer");
  const defaults = CHAIN_DEFAULTS.svm;
  const signer = ctx.wallet.svmSigner;
  const mint = address(defaults.asset);
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const [sourceAta] = await findAssociatedTokenPda({ mint, owner: signer.address, tokenProgram });
  const [destinationAta] = await findAssociatedTokenPda({
    mint,
    owner: address(intent.to),
    tokenProgram,
  });

  const amountAtomic = BigInt(usdToAtomic(intent.amount_usd, defaults.decimals));
  const transferIx = getTransferCheckedInstruction(
    {
      source: sourceAta,
      mint,
      destination: destinationAta,
      authority: signer,
      amount: amountAtomic,
      decimals: defaults.decimals,
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

  const decoded = await capture.decodeShimEvent({
    kind: "svm_tx",
    payload: { transaction_base64: transactionBase64 },
  });
  const allowed = await gdpSignAllows(
    ctx,
    "svm",
    { serialized_tx: transactionBase64 },
    decoded.legs ?? [decoded],
  );
  if (!allowed) return;

  const rpc = createSolanaRpc(ctx.solanaRpcUrl);
  await rpc.sendTransaction(transactionBase64, { encoding: "base64" }).send();
}

/**
 * Sends `intent` as a real signed direct transfer to the harness's mock chain RPC, iff
 * the GDP `sign` hook (when implemented) allows it. A deny or an unimplemented wallet
 * for `intent.chain` is a silent no-op - a transfer intent for the wrong chain (the
 * address shape matched the other chain's canary format by coincidence) is simply not
 * actionable by this wallet.
 */
export async function sendDirectTransfer(
  ctx: TransferContext,
  intent: TransferIntent,
): Promise<void> {
  if (intent.chain === "evm") {
    await sendEvmTransfer(ctx, intent);
  } else {
    await sendSvmTransfer(ctx, intent);
  }
}
