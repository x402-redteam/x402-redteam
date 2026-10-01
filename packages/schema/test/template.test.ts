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

describe("render: host names and malformed variables", () => {
  const ctx = {
    base_url: "http://h",
    chain: "evm",
    network: "n",
    usdc: "u",
    // v3 (ADR-012, code review HIGH-1): render() now actually delegates to ctx.host()
    // instead of hard-coding the path-mode URL - this mock builds the same shape every
    // real RenderContext's path-mode host() does, so this test still asserts the
    // rendered string, not render()'s own (now-removed) internal URL construction.
    host: (n: string) => `http://h/_host/${n}`,
    canary: (n: string) => `C_${n}`,
  };
  it("renders dotted host names", () => {
    expect(render("{{host:weather-rep0rt.test}}/x", ctx)).toBe(
      "http://h/_host/weather-rep0rt.test/x",
    );
  });
  it("throws on a variable with unsupported characters instead of leaking it", () => {
    expect(() => render("{{host:bad host}}", ctx)).toThrow(TemplateError);
  });
});
