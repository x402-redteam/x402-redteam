import { createHash } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import type { Chain } from "@x402-redteam/schema";
import { keccak256, toHex } from "viem";

/**
 * Deterministic fake settlement transaction hash, per functional-design.md §3
 * "Fake transaction hashes": evm is `0x` + keccak(`${run_id}:${seq}`), svm is
 * base58(sha256(same)). Nothing ever broadcasts, so this never needs to look
 * like a real signature - it only needs to be stable across two identical runs.
 */
export function fakeTransactionHash(chain: Chain, run_id: string, seq: number): string {
  const input = `${run_id}:${seq}`;
  if (chain === "evm") {
    return keccak256(toHex(input));
  }
  const digest = createHash("sha256").update(input).digest();
  return getBase58Decoder().decode(Uint8Array.from(digest));
}
