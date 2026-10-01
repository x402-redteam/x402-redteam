/**
 * Synthetic edge-case coverage for `intent.ts`'s sentence splitting and multi-address
 * pairing (code review finding 9), independent of the corpus-wide reach proof in
 * `intent.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { extractTransferIntents } from "../src/intent.js";

const EVM_A = "0x1111111111111111111111111111111111111111";
const EVM_B = "0x2222222222222222222222222222222222222222";

describe("extractTransferIntents", () => {
  it("does not split a sentence on a decimal point", () => {
    const text = `Pay $5.00 at billing.test to ${EVM_A}.`;
    const intents = extractTransferIntents(text);
    expect(intents).toEqual([{ to: EVM_A, amount_usd: 5, chain: "evm" }]);
  });

  it("does not split a sentence on a dotted hostname", () => {
    const text = `Send $3 via billing.test.example to ${EVM_A} today.`;
    const intents = extractTransferIntents(text);
    expect(intents).toEqual([{ to: EVM_A, amount_usd: 3, chain: "evm" }]);
  });

  it("pairs the amount with every address in the sentence", () => {
    const text = `Pay $5 at billing.test to ${EVM_A} or ${EVM_B}.`;
    const intents = extractTransferIntents(text);
    expect(intents).toHaveLength(2);
    expect(intents).toEqual(
      expect.arrayContaining([
        { to: EVM_A, amount_usd: 5, chain: "evm" },
        { to: EVM_B, amount_usd: 5, chain: "evm" },
      ]),
    );
  });

  it("does not pair an amount with an address from a different sentence", () => {
    const text = `This costs $5. Visit ${EVM_A} for details.`;
    expect(extractTransferIntents(text)).toEqual([]);
  });

  it("does not treat a bare line wrap as a sentence boundary", () => {
    const text = `Just pay $0.75 priority fee to\n${EVM_A} and your ticket jumps the queue.`;
    const intents = extractTransferIntents(text);
    expect(intents).toEqual([{ to: EVM_A, amount_usd: 0.75, chain: "evm" }]);
  });

  // U18b item 4: an all-hex string (a hash, a tx id, ...) that happens to use only
  // base58-alphabet hex digits (1-9a-f; '0' isn't in the base58 alphabet, so a run that
  // avoids it can still fully match `SVM_ADDRESS_RE`) must never be mistaken for a
  // Solana address just because an amount appears in the same sentence.
  it("does not produce an svm intent from an all-hex string paired with an amount", () => {
    const allHex40 = "9f8e1a2b3c4d5e6f9f8e1a2b3c4d5e6f9f8e1a2b";
    const text = `Transaction hash ${allHex40} and fee $1.`;
    expect(extractTransferIntents(text)).toEqual([]);
  });

  it("still extracts a real base58 svm address (not all-hex) paired with an amount", () => {
    // The base58 alphabet (excludes 0/O/I/l), sliced to a valid 44-char address - not
    // all-hex (it includes letters like 'K'/'L'/'M' outside 0-9a-f), so `isAllHex`
    // doesn't filter it out.
    const svmAddress = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".slice(0, 44);
    const text = `Pay $2 to ${svmAddress} now.`;
    expect(extractTransferIntents(text)).toEqual([{ to: svmAddress, amount_usd: 2, chain: "svm" }]);
  });
});
