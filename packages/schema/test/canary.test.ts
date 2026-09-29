import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import { agentWallet, canaries } from "../src/canary.js";

describe("canaries", () => {
  it("is deterministic across calls (evm)", () => {
    const a = canaries("x402-redteam-v1", "ghost-paywall", "evm").get("attacker");
    const b = canaries("x402-redteam-v1", "ghost-paywall", "evm").get("attacker");
    expect(a).toEqual(b);
  });

  it("gives a checksummed EVM address", () => {
    const { address } = canaries("x402-redteam-v1", "ghost-paywall", "evm").get("attacker");
    expect(isAddress(address)).toBe(true);
    expect(getAddress(address)).toBe(address);
  });

  it("is deterministic across calls (svm) and gives a valid base58 32-byte address", () => {
    const a = canaries("x402-redteam-v1", "ghost-paywall", "svm").get("attacker");
    const b = canaries("x402-redteam-v1", "ghost-paywall", "svm").get("attacker");
    expect(a).toEqual(b);

    // base58 alphabet, no 0/O/I/l
    expect(a.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);

    const bs58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n;
    for (const char of a.address) {
      value = value * 58n + BigInt(bs58.indexOf(char));
    }
    let hex = value.toString(16);
    if (hex.length % 2 === 1) hex = `0${hex}`;
    expect(hex.length / 2).toBe(32);
  });

  it("gives an svm secret that is a Solana-standard 64-byte keypair round-tripping to the same address", async () => {
    const key = canaries("x402-redteam-v1", "ghost-paywall", "svm").get("attacker");
    const keypairBytes = getBase58Encoder().encode(key.secret);
    expect(keypairBytes).toHaveLength(64);

    const signer = await createKeyPairSignerFromBytes(keypairBytes);
    expect(signer.address).toBe(key.address);
  });

  it("gives different addresses for different names", () => {
    const set = canaries("x402-redteam-v1", "ghost-paywall", "evm");
    expect(set.get("attacker").address).not.toBe(set.get("legit").address);

    const svmSet = canaries("x402-redteam-v1", "ghost-paywall", "svm");
    expect(svmSet.get("attacker").address).not.toBe(svmSet.get("legit").address);
  });

  it("gives different addresses for different scopes and chains", () => {
    const evmA = canaries("x402-redteam-v1", "scenario-a", "evm").get("attacker");
    const evmB = canaries("x402-redteam-v1", "scenario-b", "evm").get("attacker");
    expect(evmA.address).not.toBe(evmB.address);
  });
});

describe("agentWallet", () => {
  it("returns the agent scope's wallet key, same as canaries(seed, 'agent', chain).get('wallet')", () => {
    expect(agentWallet("x402-redteam-v1", "evm")).toEqual(
      canaries("x402-redteam-v1", "agent", "evm").get("wallet"),
    );
    expect(agentWallet("x402-redteam-v1", "svm")).toEqual(
      canaries("x402-redteam-v1", "agent", "svm").get("wallet"),
    );
  });
});
