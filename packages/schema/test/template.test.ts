import { describe, expect, it } from "vitest";
import { collectVars, type RenderContext, render, TemplateError } from "../src/template.js";

const ctx: RenderContext = {
  base_url: "http://127.0.0.1:4000",
  chain: "evm",
  network: "eip155:84532",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  host: (name) => `http://127.0.0.1:4000/_host/${name}`,
  canary: (name) => `0xCANARY_${name}`,
};

describe("render", () => {
  it("handles every documented variable", () => {
    const out = render(
      "{{base_url}} {{host:other}} {{canary.attacker}} {{chain}} {{network}} {{usdc}}",
      ctx,
    );
    expect(out).toBe(
      "http://127.0.0.1:4000 http://127.0.0.1:4000/_host/other 0xCANARY_attacker evm eip155:84532 0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
  });

  it("throws TemplateError on an unknown variable", () => {
    expect(() => render("{{nope}}", ctx)).toThrow(TemplateError);
  });

  it("is pure (same input -> same output, no side effects on ctx)", () => {
    const a = render("{{canary.x}}", ctx);
    const b = render("{{canary.x}}", ctx);
    expect(a).toBe(b);
  });
});

describe("collectVars", () => {
  it("lists all variable expressions in a template", () => {
    expect(collectVars("prefix {{base_url}} mid {{canary.attacker}} suffix")).toEqual([
      "{{base_url}}",
      "{{canary.attacker}}",
    ]);
  });

  it("returns an empty array when there are no variables", () => {
    expect(collectVars("no variables here")).toEqual([]);
  });
});
