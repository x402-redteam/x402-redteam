import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { keccak256, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import type { Chain } from "./scenario.js";

export interface CanaryKey {
  address: string;
  /** evm: 0x hex private key. svm: base58-encoded 64-byte keypair (seed || pubkey). */
  secret: string;
}

export interface CanarySet {
  get(name: string): CanaryKey;
}

function seedInput(seed: string, scope: string, chain: Chain, name: string): string {
  return `${seed}:${scope}:${chain}:${name}`;
}

function deriveEvm(input: string): CanaryKey {
  const privateKey = keccak256(toHex(input));
  const address = privateKeyToAddress(privateKey);
  return { address, secret: privateKey };
}

// RFC 8410 fixed PKCS8 DER header for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function deriveSvm(input: string): CanaryKey {
  const seedBytes = createHash("sha256").update(input).digest();
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seedBytes]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = spki.subarray(spki.length - 32);
  const address = getBase58Decoder().decode(Uint8Array.from(rawPublicKey));
  // Solana-standard 64-byte keypair encoding (32-byte seed || 32-byte public
  // key), base58-encoded, so it loads directly with
  // `createKeyPairSignerFromBytes(getBase58Encoder().encode(secret))`.
  const keypairBytes = Buffer.concat([seedBytes, rawPublicKey]);
  const secret = getBase58Decoder().decode(Uint8Array.from(keypairBytes));
  return { address, secret };
}

/**
 * `canaries(seed, scope, chain)` returns named, deterministic addresses
 * per application-design.md §3 "Canaries (deterministic)". Names are
 * derived lazily and are pure functions of (seed, scope, chain, name), so
 * repeated calls with the same inputs always return the same key.
 */
export function canaries(seed: string, scope: string, chain: Chain): CanarySet {
  return {
    get(name: string): CanaryKey {
      const input = seedInput(seed, scope, chain, name);
      return chain === "evm" ? deriveEvm(input) : deriveSvm(input);
    },
  };
}

export const RESERVED_CANARY_NAMES = ["legit", "attacker", "prose", "lookalike"] as const;

/**
 * The agent's own wallet: `canaries(seed, "agent", chain).get("wallet")`.
 *
 * `secret` format depends on `chain`:
 * - `evm`: a `0x`-prefixed hex-encoded private key.
 * - `svm`: a base58-encoded Solana-standard 64-byte keypair (32-byte seed
 *   followed by the 32-byte public key), i.e. exactly what
 *   `createKeyPairSignerFromBytes(getBase58Encoder().encode(secret))` from
 *   `@solana/kit` expects.
 */
export function agentWallet(seed: string, chain: Chain): CanaryKey {
  return canaries(seed, "agent", chain).get("wallet");
}
