import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getTransactionDecoder,
} from "@solana/kit";
import { assetInfo, FIXED_BLOCKHASH, usdToAtomic, walletBalanceUsd } from "@x402-redteam/schema";
import type { Hono } from "hono";
import { knownSvmMints, knownTokenAccountsFor } from "./known-token-accounts.js";
import { recordDecodedLegs } from "./record.js";
import type { Shared } from "./shared.js";

/**
 * Fixed values used by every mock RPC response - never wall-clock, per
 * functional-design.md §5. The blockhash is shared with @x402-redteam/schema
 * so the mock RPC and the shim/capture side agree on it.
 */
export const SOLANA_LAST_VALID_BLOCK_HEIGHT = 1000;
const SOLANA_SLOT = 1;
const SOLANA_MIN_RENT_EXEMPT_LAMPORTS = 1461600;
/** v2 (ADR-013): a fixed 1 SOL balance for `getBalance` - never wall-clock/random. */
const SOLANA_FIXED_LAMPORTS_BALANCE = 1_000_000_000;

/** The SPL Token program - the mint account's `owner` field must be this address. */
const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * A minimal, valid legacy SPL Mint account layout (mintAuthorityOption(4) +
 * mintAuthority(32) + supply(8) + decimals(1) + isInitialized(1) + freezeAuthorityOption(4) +
 * freezeAuthority(32)), base64-encoded, per functional-design.md §3 "Solana RPC mock".
 * v2 (ADR-013): `decimals` comes from `assetInfo()` rather than a hardcoded 6, so an
 * asset_swap scenario's own-decimals mint is served correctly.
 */
function mintAccountDataBase64(decimals: number): string {
  const buf = Buffer.alloc(82);
  buf.writeUInt8(decimals, 44); // decimals
  buf.writeUInt8(1, 45); // isInitialized
  return buf.toString("base64");
}

type EncodedBytes = ReturnType<ReturnType<typeof getBase64Encoder>["encode"]>;

/** Extracts the first non-null signature from a decoded wire transaction, base58-encoded. */
function firstSignatureBase58(bytes: EncodedBytes): string | undefined {
  const tx = getTransactionDecoder().decode(bytes);
  for (const sig of Object.values(tx.signatures)) {
    if (sig) return getBase58Decoder().decode(sig);
  }
  return undefined;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown[];
}

export function registerSolanaRpcRoutes(app: Hono, shared: Shared): void {
  app.post("/solana-rpc", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state, rendered } = loaded;

    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      parsed = null;
    }

    const requests = Array.isArray(parsed) ? parsed : [parsed as JsonRpcRequest];

    // Serve a mint for the chain USDC and for every asset the loaded challenges name
    // (e.g. rail-switch's mainnet mint, or an asset_swap scenario's own asset), so the
    // agent's policy is what decides - not an SDK failure to fetch an unknown mint.
    // U20 code review (knownTokenAccounts wiring): shared with `knownTokenAccountsFor`
    // below, so this set and the ATAs derived from it never drift apart.
    const knownMints =
      state.chain === "svm"
        ? new Set(knownSvmMints(rendered, state.scenario.assets))
        : new Set<string>();
    // U20 code review (knownTokenAccounts wiring): the same svm-only ATA map every
    // other capture path (routes.ts, facilitator.ts, ledger-endpoint.ts) passes as
    // `DecodeHints.knownTokenAccounts` - built once per loaded run and memoized, so a
    // plain SPL `Transfer`/`SetAuthority` resolves identically regardless of which path
    // observes it first.
    const knownTokenAccounts = await knownTokenAccountsFor(
      rendered,
      state.chain,
      shared.seed,
      state.scenario.assets,
    );

    const results = await Promise.all(
      requests.map(async (one) => {
        const req = (one ?? {}) as JsonRpcRequest;
        const method = req.method ?? "";
        const id = req.id ?? null;
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
        const err = (code: number, message: string) => ({
          jsonrpc: "2.0",
          id,
          error: { code, message },
        });

        let body: unknown;
        switch (method) {
          case "getLatestBlockhash":
            body = ok({
              context: { slot: SOLANA_SLOT },
              value: {
                blockhash: FIXED_BLOCKHASH,
                lastValidBlockHeight: SOLANA_LAST_VALID_BLOCK_HEIGHT,
              },
            });
            break;
          case "isBlockhashValid":
            body = ok({ context: { slot: SOLANA_SLOT }, value: true });
            break;
          case "getAccountInfo": {
            const address = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
            if (address !== undefined && knownMints.has(address)) {
              const decimals = assetInfo("svm", address, state.scenario.assets).decimals;
              body = ok({
                context: { slot: SOLANA_SLOT },
                value: {
                  data: [mintAccountDataBase64(decimals), "base64"],
                  executable: false,
                  lamports: SOLANA_MIN_RENT_EXEMPT_LAMPORTS,
                  owner: TOKEN_PROGRAM_ADDRESS,
                  rentEpoch: 0,
                  space: 82,
                },
              });
            } else {
              body = ok({ context: { slot: SOLANA_SLOT }, value: null });
            }
            break;
          }
          case "getSlot":
            body = ok(SOLANA_SLOT);
            break;
          case "getMinimumBalanceForRentExemption":
            body = ok(SOLANA_MIN_RENT_EXEMPT_LAMPORTS);
            break;
          case "getBalance":
            body = ok({ context: { slot: SOLANA_SLOT }, value: SOLANA_FIXED_LAMPORTS_BALANCE });
            break;
          case "getTokenAccountBalance": {
            // v2 (ADR-013): the wallet's modelled balance for a known mint. There's no
            // per-account bookkeeping (one wallet per run), but L3 (code review) asks
            // that the *mint* used still matches the queried account where we can tell.
            // U20 code review (knownTokenAccounts wiring): looked up directly in the
            // same ATA map every capture path shares, instead of a second, independent
            // (and classic-token-program-only) PDA-derivation loop - that map already
            // covers every known (owner, mint) pair under both token programs.
            const queried = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
            const mint =
              (queried !== undefined ? knownTokenAccounts[queried]?.mint : undefined) ??
              [...knownMints][0];
            if (mint === undefined) {
              body = err(-32602, "unknown token account");
              break;
            }
            const info = assetInfo("svm", mint, state.scenario.assets);
            const atomic = usdToAtomic(
              walletBalanceUsd(state.scenario.task) / info.usd_price,
              info.decimals,
            );
            body = ok({
              context: { slot: SOLANA_SLOT },
              value: {
                amount: atomic,
                decimals: info.decimals,
                uiAmount: Number(atomic) / 10 ** info.decimals,
                uiAmountString: String(Number(atomic) / 10 ** info.decimals),
              },
            });
            break;
          }
          case "getSignatureStatuses": {
            const sigs = Array.isArray(req.params?.[0]) ? (req.params[0] as unknown[]) : [];
            const value = sigs.map((sig) =>
              typeof sig === "string" && state.seenSvmSigs.has(sig)
                ? { confirmationStatus: "finalized", err: null, slot: SOLANA_SLOT }
                : null,
            );
            body = ok({ context: { slot: SOLANA_SLOT }, value });
            break;
          }
          case "simulateTransaction":
            body = ok({
              context: { slot: SOLANA_SLOT },
              value: { err: null, logs: [], unitsConsumed: 1000 },
            });
            break;
          case "sendTransaction": {
            const raw = req.params?.[0];
            const opts = req.params?.[1] as { encoding?: string } | undefined;
            if (typeof raw !== "string") {
              body = err(-32602, "invalid transaction");
              break;
            }
            let transactionBase64: string;
            try {
              if (opts?.encoding === "base64") {
                transactionBase64 = raw;
              } else {
                transactionBase64 = Buffer.from(getBase58Encoder().encode(raw)).toString("base64");
              }
            } catch {
              body = err(-32602, "invalid transaction");
              break;
            }
            let signature: string | undefined;
            try {
              signature = firstSignatureBase58(getBase64Encoder().encode(transactionBase64));
            } catch {
              signature = undefined;
            }
            if (!signature) {
              body = err(-32602, "invalid transaction");
              break;
            }
            try {
              const decoded = await shared.capture.decodeShimEvent(
                { kind: "svm_tx", payload: { transaction_base64: transactionBase64 } },
                { knownOwners: rendered.knownOwners, knownTokenAccounts },
              );
              // H1 (code review): a single transaction can carry more than one leg
              // (see DecodedPayment.legs) - record every one.
              recordDecodedLegs(state, shared.capture, decoded, { capture: "rpc" });
              state.seenSvmSigs.add(signature);
              body = ok(signature);
            } catch {
              body = err(-32602, "invalid transaction");
            }
            break;
          }
          default:
            body = err(-32601, `method not found: ${method}`);
        }

        state.requests.push({
          seq: state.nextSeq(),
          method: "POST",
          host: "solana-rpc",
          path: method,
          status: 200,
          paid: false,
        });
        return body;
      }),
    );

    return c.json(Array.isArray(parsed) ? results : results[0]);
  });
}
