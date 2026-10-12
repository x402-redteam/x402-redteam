import { getBase58Encoder } from "@solana/kit";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { canaries, displayAddress, poisonAddress } from "../src/canary.js";
import { type RenderContext, render, TemplateError } from "../src/template.js";

const SEED = "x402-redteam-v1";

describe("poisonAddress (U26-2, M4)", () => {
  it("EVM: keeps the legit address's first and last 4 characters, checksummed, different middle", () => {
    const legit = canaries(SEED, "draft", "evm").get("legit").address;
    const poison = poisonAddress(SEED, "draft", "evm", "legit", legit);
    expect(poison).toBe(getAddress(poison));
    expect(poison.toLowerCase()).not.toBe(legit.toLowerCase());
    expect(poison.slice(2, 6).toLowerCase()).toBe(legit.slice(2, 6).toLowerCase());
    expect(poison.slice(-4).toLowerCase()).toBe(legit.slice(-4).toLowerCase());
    expect(poison).toHaveLength(42);
  });

  it("SVM: keeps the first and last 4 characters and decodes to 32 bytes", () => {
    const legit = canaries(SEED, "draft", "svm").get("legit").address;
    const poison = poisonAddress(SEED, "draft", "svm", "legit", legit);
    expect(poison).not.toBe(legit);
    expect(poison.slice(0, 4)).toBe(legit.slice(0, 4));
    expect(poison.slice(-4)).toBe(legit.slice(-4));
    expect(poison).toHaveLength(legit.length);
    expect(getBase58Encoder().encode(poison)).toHaveLength(32);
  });

  it("is a pure function of seed, scope, chain and name", () => {
    for (const chain of ["evm", "svm"] as const) {
      const legit = canaries(SEED, "draft", chain).get("legit").address;
      const a = poisonAddress(SEED, "draft", chain, "legit", legit);
      const b = poisonAddress(SEED, "draft", chain, "legit", legit);
      const other = poisonAddress("another-seed", "draft", chain, "legit", legit);
      expect(a).toBe(b);
      expect(other).not.toBe(a);
    }
  });
});

describe("displayAddress", () => {
  it("shows a wallet-style truncated form", () => {
    expect(displayAddress("0xAbCd000000000000000000000000000000001234")).toBe("0xAbCd…1234");
    expect(displayAddress("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe("9xQe…VFin");
  });

  it("the display form of a poisoned address equals the legit one, ignoring case", () => {
    const legit = canaries(SEED, "draft", "evm").get("legit").address;
    const poison = poisonAddress(SEED, "draft", "evm", "legit", legit);
    expect(displayAddress(poison).toLowerCase()).toBe(displayAddress(legit).toLowerCase());
  });
});

describe("render: {{poison:NAME}}, {{poison_short:NAME}}, {{short:NAME}}", () => {
  const ctx: RenderContext = {
    base_url: "http://h",
    chain: "evm",
    network: "n",
    usdc: "u",
    host: (n) => `http://h/_host/${n}`,
    canary: (n) => `0xAbCd00000000000000000000000000000000${n === "legit" ? "1234" : "5678"}`,
    poison: (n) => `0xAbCd11111111111111111111111111111111${n === "legit" ? "1234" : "5678"}`,
  };

  it("renders the full poisoned address and the display forms", () => {
    expect(render("{{poison:legit}}", ctx)).toBe("0xAbCd111111111111111111111111111111111234");
    expect(render("{{poison_short:legit}}", ctx)).toBe("0xAbCd…1234");
    expect(render("{{short:legit}}", ctx)).toBe("0xAbCd…1234");
  });

  it("throws without a name", () => {
    expect(() => render("{{poison}}", ctx)).toThrow(TemplateError);
    expect(() => render("{{poison_short}}", ctx)).toThrow(TemplateError);
    expect(() => render("{{short}}", ctx)).toThrow(TemplateError);
  });
});
