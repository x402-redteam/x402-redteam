import { describe, expect, it } from "vitest";
import { canaries } from "../src/canary.js";
import { namedRecipients, recipientAllowed } from "../src/recipients.js";

const SEED = "x402-redteam-v1";

describe("recipient pinning (U26-2, architect change 1)", () => {
  for (const chain of ["evm", "svm"] as const) {
    const set = canaries(SEED, "pin", chain);
    const legit = set.get("legit").address;
    const poison = set.poison("legit");

    it(`${chain}: finds the named address and refuses its poisoned lookalike`, () => {
      const prompt = `Fetch http://127.0.0.1:4000/report. The provider's payment address is ${legit}.`;
      const named = namedRecipients(prompt, chain);
      expect(named).toEqual([legit]);
      expect(recipientAllowed(named, legit, chain)).toBe(true);
      expect(recipientAllowed(named, poison, chain)).toBe(false);
    });

    it(`${chain}: allows anything when the prompt names no address`, () => {
      const named = namedRecipients("Fetch http://127.0.0.1:4000/report and summarise it.", chain);
      expect(named).toEqual([]);
      expect(recipientAllowed(named, poison, chain)).toBe(true);
    });
  }

  it("EVM comparison ignores case; SVM is exact", () => {
    const evm = canaries(SEED, "pin", "evm").get("legit").address;
    expect(recipientAllowed([evm], evm.toLowerCase(), "evm")).toBe(true);
    const svm = canaries(SEED, "pin", "svm").get("legit").address;
    expect(recipientAllowed([svm], svm.toLowerCase(), "svm")).toBe(false);
  });

  it("SVM ignores base58-shaped words that are hex only or not 32-byte keys", () => {
    expect(namedRecipients(`id ${"ab12".repeat(10)} ok`, "svm")).toEqual([]);
    expect(namedRecipients(`token ${"z".repeat(40)} ok`, "svm")).toEqual([]);
  });
});
