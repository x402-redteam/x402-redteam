import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Encoder,
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
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { agentWallet, CHAIN_DEFAULTS, canaries } from "@x402-redteam/schema";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEvmPayload, decodeEvmTx, decodeEvmTypedData } from "../src/evm.js";
import { wrapEvmAccount } from "../src/shim/evm.js";
import { wrapSvmSigner } from "../src/shim/svm.js";
import { recordTransfer } from "../src/shim/transfer.js";
import { decodeSvmTransaction } from "../src/svm.js";

const SEED = "x402-redteam-v1";

interface Ledger {
  url: string;
  events: Array<{ kind: string; payload: unknown }>;
  close: () => Promise<void>;
}

function startLedger(): Promise<Ledger> {
  const events: Array<{ kind: string; payload: unknown }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        events,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

let ledger: Ledger;

beforeEach(async () => {
  ledger = await startLedger();
});

afterEach(async () => {
  await ledger.close();
});

describe("wrapEvmAccount", () => {
  it("signTypedData posts one evm_typed_data event that decodes to the same dedupe_key as the header payment", async () => {
    const wallet = agentWallet(SEED, "evm");
    const account = privateKeyToAccount(wallet.secret as `0x${string}`);
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: CHAIN_DEFAULTS.evm.network as PaymentRequirements["network"],
      asset: CHAIN_DEFAULTS.evm.asset,
      amount: "2000",
      payTo: canaries(SEED, "shim-test", "evm").get("legit").address,
      maxTimeoutSeconds: 60,
      extra: CHAIN_DEFAULTS.evm.extra,
    };
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: "http://provider.test/weather/today" },
      accepts: [requirements],
    };

    const client = new x402Client();
    registerExactEvmScheme(client, { signer: wrapped });
    const headerPayload: PaymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.kind).toBe("evm_typed_data");

    const headerDecoded = await decodeEvmPayload(headerPayload);
    // biome-ignore lint/suspicious/noExplicitAny: shim event payload shape asserted by decodeEvmTypedData.
    const shimDecoded = await decodeEvmTypedData(ledger.events[0]?.payload as any);

    expect(headerDecoded.valid).toBe(true);
    expect(shimDecoded.valid).toBe(true);
    expect(shimDecoded.dedupe_key).toBe(headerDecoded.dedupe_key);
    expect(shimDecoded.from.toLowerCase()).toBe(headerDecoded.from.toLowerCase());
    expect(shimDecoded.to.toLowerCase()).toBe(headerDecoded.to.toLowerCase());
    expect(shimDecoded.amount_atomic).toBe(headerDecoded.amount_atomic);
  });

  it("signTransaction posts one evm_tx event that decodes with the same signer and amount", async () => {
    const wallet = agentWallet(SEED, "evm");
    const account = privateKeyToAccount(wallet.secret as `0x${string}`);
    const wrapped = wrapEvmAccount(account, { ledgerUrl: ledger.url });
    const to = canaries(SEED, "shim-test", "evm").get("attacker").address as `0x${string}`;

    const { encodeFunctionData, erc20Abi } = await import("viem");
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 999n] });
    await wrapped.signTransaction({
      chainId: 84532,
      nonce: 0,
      to: CHAIN_DEFAULTS.evm.asset as `0x${string}`,
      data,
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      type: "eip1559",
    });

    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.kind).toBe("evm_tx");
    // biome-ignore lint/suspicious/noExplicitAny: shim event payload shape asserted by decodeEvmTx.
    const decoded = await decodeEvmTx(ledger.events[0]?.payload as any);
    expect(decoded.valid).toBe(true);
    expect(decoded.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount_atomic).toBe("999");
  });
});

describe("wrapSvmSigner", () => {
  it("signTransactions posts one svm_tx event per transaction, decodable with a valid signature", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const wrapped = wrapSvmSigner(signer, { ledgerUrl: ledger.url });

    const owner = canaries(SEED, "shim-test", "svm").get("legit").address;
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: wrapped.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destinationAta] = await findAssociatedTokenPda({
      mint,
      owner: address(owner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const transferIx = getTransferCheckedInstruction(
      {
        source: sourceAta,
        mint,
        destination: destinationAta,
        authority: wrapped,
        amount: 42n,
        decimals: 6,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    );

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(wrapped.address, tx),
      (tx) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n },
          tx,
        ),
      (tx) => appendTransactionMessageInstruction(transferIx, tx),
    );
    await partiallySignTransactionMessageWithSigners(message);

    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.kind).toBe("svm_tx");
    const payload = ledger.events[0]?.payload as { transaction_base64: string };
    const decoded = await decodeSvmTransaction(payload.transaction_base64, {
      knownOwners: [owner],
    });
    expect(decoded.valid).toBe(true);
    expect(decoded.from).toBe(wallet.address);
    expect(decoded.to).toBe(owner);
    expect(decoded.amount_atomic).toBe("42");
  });
});

describe("recordTransfer", () => {
  it("round-trips a direct EVM transfer", async () => {
    const wallet = agentWallet(SEED, "evm");
    const to = canaries(SEED, "shim-test", "evm").get("attacker").address;

    const decoded = await recordTransfer({
      chain: "evm",
      ledgerUrl: ledger.url,
      secret: wallet.secret,
      to,
      amount_atomic: "555",
    });

    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.kind).toBe("evm_tx");
    expect(decoded.valid).toBe(true);
    expect(decoded.from.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount_atomic).toBe("555");
  });

  it("round-trips a direct SVM transfer", async () => {
    const wallet = agentWallet(SEED, "svm");
    const to = canaries(SEED, "shim-test", "svm").get("attacker").address;

    const decoded = await recordTransfer({
      chain: "svm",
      ledgerUrl: ledger.url,
      secret: wallet.secret,
      to,
      amount_atomic: "321",
    });

    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.kind).toBe("svm_tx");
    expect(decoded.valid).toBe(true);
    expect(decoded.from).toBe(wallet.address);
    expect(decoded.to).toBe(to);
    expect(decoded.amount_atomic).toBe("321");
  });
});
