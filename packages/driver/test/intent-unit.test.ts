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
});
