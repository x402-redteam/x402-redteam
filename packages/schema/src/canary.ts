import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { getAddress, keccak256, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import type { Chain } from "./scenario.js";

export interface CanaryKey {
  address: string;
  /** evm: 0x hex private key. svm: base58-encoded 64-byte keypair (seed || pubkey). */
  secret: string;
}

export interface CanarySet {
  get(name: string): CanaryKey;
  /** v4 (U26-2, M4): the poisoned lookalike of canary `name` (see `poisonAddress`). */
  poison(name: string): string;
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
    poison(name: string): string {
      return poisonAddress(seed, scope, chain, name, this.get(name).address);
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

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** How many middles the SVM search tries before giving up. In practice the first or
 * second candidate decodes to 32 bytes. */
const MAX_SVM_POISON_ATTEMPTS = 1000;

/**
 * v4 (U26-2, M4): an address-poisoning lookalike of `legit`, the canary `name` in
 * `scope`. It keeps legit's first 4 and last 4 characters (after `0x` on EVM) and puts a
 * middle derived from (seed, scope, chain, name) between them, so it is deterministic
 * and looks the same as legit in a truncated wallet display.
 *
 * - EVM: the middle is 32 hex characters of a keccak hash; the result is checksummed with
 *   `getAddress`, so its letter case can differ from legit's.
 * - SVM: the middle is drawn from the base58 alphabet, and candidates are tried in a fixed
 *   order until one decodes to a 32-byte public key.
 *
 * Nobody holds a key for it. The adversary adds it to `DecodeHints.knownOwners` so an SVM
 * transfer to its token account resolves back to it.
 */
export function poisonAddress(
  seed: string,
  scope: string,
  chain: Chain,
  name: string,
  legit: string,
): string {
  const base = `${seedInput(seed, scope, chain, name)}:poison`;
  if (chain === "evm") {
    const hex = legit.slice(2).toLowerCase();
    for (let i = 0; ; i++) {
      const middle = keccak256(toHex(`${base}:${i}`)).slice(2, 34);
      const candidate = `0x${hex.slice(0, 4)}${middle}${hex.slice(-4)}`;
      if (candidate !== `0x${hex}`) return getAddress(candidate);
    }
  }
  const middleLength = legit.length - 8;
  const encoder = getBase58Encoder();
  for (let i = 0; i < MAX_SVM_POISON_ATTEMPTS; i++) {
    const bytes = createHash("sha512").update(`${base}:${i}`).digest();
    let middle = "";
    for (let j = 0; j < middleLength; j++) {
      middle += BASE58_ALPHABET[(bytes[j % bytes.length] as number) % 58];
    }
    const candidate = `${legit.slice(0, 4)}${middle}${legit.slice(-4)}`;
    if (candidate === legit) continue;
    try {
      if (encoder.encode(candidate).length === 32) return candidate;
    } catch {
      // Not valid base58 for some reason; try the next candidate.
    }
  }
  throw new Error(`poisonAddress: no 32-byte lookalike found for ${legit}`);
}

/**
 * v4 (U26-2): the truncated form wallets show, `0xAbCd…1234` on EVM and `9xQe…VFin` on
 * SVM. Pages use it to show an address without containing the full address, so lint
 * rule 3 (a payTo canary never appears in page text) still holds.
 */
export function displayAddress(address: string): string {
  const head = address.startsWith("0x") ? address.slice(0, 6) : address.slice(0, 4);
  return `${head}\u2026${address.slice(-4)}`;
}
