import { FIXED_BLOCKHASH } from "@x402-redteam/schema";
import type { Hono } from "hono";
import type { RunHolder } from "./shared.js";

/**
 * Fixed values used by every mock RPC response - never wall-clock, per
 * functional-design.md §5. The blockhash is shared with @x402-redteam/schema
 * so the mock RPC and the shim/capture side agree on it.
 */
export const SOLANA_LAST_VALID_BLOCK_HEIGHT = 1000;
const SOLANA_SLOT = 1;
const SOLANA_MIN_RENT_EXEMPT_LAMPORTS = 1461600;

/** The SPL Token program - the mint account's `owner` field must be this address. */
const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * A minimal, valid 82-byte legacy SPL Mint account layout (mintAuthorityOption(4) +
 * mintAuthority(32) + supply(8) + decimals(1) + isInitialized(1) + freezeAuthorityOption(4) +
 * freezeAuthority(32)), base64-encoded, per functional-design.md §3 "Solana RPC mock".
 */
function mintAccountDataBase64(): string {
  const buf = Buffer.alloc(82);
  buf.writeUInt8(6, 44); // decimals
  buf.writeUInt8(1, 45); // isInitialized
  return buf.toString("base64");
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown[];
}

/**
 * Handles one JSON-RPC request against the mock. `usdcMint` is the loaded run's
 * svm USDC asset address (the only account `getAccountInfo` knows about).
 */
function handleOne(
  req: JsonRpcRequest,
  usdcMint: string | undefined,
): { httpMethod: string; body: unknown } {
  const method = req.method ?? "";
  const id = req.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "getLatestBlockhash":
      return {
        httpMethod: method,
        body: ok({
          context: { slot: SOLANA_SLOT },
          value: {
            blockhash: FIXED_BLOCKHASH,
            lastValidBlockHeight: SOLANA_LAST_VALID_BLOCK_HEIGHT,
          },
        }),
      };
    case "isBlockhashValid":
      return { httpMethod: method, body: ok({ context: { slot: SOLANA_SLOT }, value: true }) };
    case "getAccountInfo": {
      const address = typeof req.params?.[0] === "string" ? req.params[0] : undefined;
      if (address !== undefined && address === usdcMint) {
        return {
          httpMethod: method,
          body: ok({
            context: { slot: SOLANA_SLOT },
            value: {
              data: [mintAccountDataBase64(), "base64"],
              executable: false,
              lamports: SOLANA_MIN_RENT_EXEMPT_LAMPORTS,
              owner: TOKEN_PROGRAM_ADDRESS,
              rentEpoch: 0,
              space: 82,
            },
          }),
        };
      }
      return { httpMethod: method, body: ok({ context: { slot: SOLANA_SLOT }, value: null }) };
    }
    case "getSlot":
      return { httpMethod: method, body: ok(SOLANA_SLOT) };
    case "getMinimumBalanceForRentExemption":
      return { httpMethod: method, body: ok(SOLANA_MIN_RENT_EXEMPT_LAMPORTS) };
    case "simulateTransaction":
      return {
        httpMethod: method,
        body: ok({
          context: { slot: SOLANA_SLOT },
          value: { err: null, logs: [], unitsConsumed: 1000 },
        }),
      };
    case "sendTransaction":
      return { httpMethod: method, body: err(-32000, "x402-redteam: broadcasting disabled") };
    default:
      return { httpMethod: method || "unknown", body: err(-32601, `method not found: ${method}`) };
  }
}

export function registerSolanaRpcRoutes(app: Hono, holder: RunHolder): void {
  app.post("/solana-rpc", async (c) => {
    const loaded = holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state } = loaded;

    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      parsed = null;
    }

    const requests = Array.isArray(parsed) ? parsed : [parsed as JsonRpcRequest];
    const usdcMint = loaded.rendered.ctx.chain === "svm" ? loaded.rendered.ctx.usdc : undefined;
    const results = requests.map((one) => {
      const { httpMethod, body } = handleOne((one ?? {}) as JsonRpcRequest, usdcMint);
      state.requests.push({
        seq: state.nextSeq(),
        method: "POST",
        host: "",
        path: `/solana-rpc#${httpMethod}`,
        status: 200,
        paid: false,
      });
      return body;
    });

    return c.json(Array.isArray(parsed) ? results : results[0]);
  });
}
