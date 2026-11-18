import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { termsQualify } from "../src/index.js";

// U37b-a (AC-a7): one predicate decides control credit (scorer) and delivery (adversary).
describe("termsQualify (U37b-a, moved unchanged from the scorer)", () => {
  it.each([
    ["client_copy", false],
    ["offered_domain_only", false],
    ["none", false],
    [undefined, false],
    ["offered", true],
  ] as const)("an EVM header leg reading %s qualifies: %s", (reading, expected) => {
    expect(
      termsQualify({ chain: "evm", capture: "header", scheme: "exact", terms_verified: reading }),
    ).toBe(expected);
  });

  it("provenance, not scheme: a header leg echoing transfer is still covered", () => {
    expect(
      termsQualify({
        chain: "evm",
        capture: "header+rpc",
        scheme: "transfer",
        terms_verified: "client_copy",
      }),
    ).toBe(false);
  });

  it.each(["rpc", "shim", "rpc+shim"] as const)(
    "an EVM transfer seen only by %s is exempt",
    (capture) => {
      expect(
        termsQualify({ chain: "evm", capture, scheme: "transfer", terms_verified: undefined }),
      ).toBe(true);
    },
  );

  it("a shim-only authorization is not exempt", () => {
    expect(
      termsQualify({ chain: "evm", capture: "shim", scheme: "exact", terms_verified: undefined }),
    ).toBe(false);
  });

  it("every SVM leg is exempt", () => {
    expect(
      termsQualify({ chain: "svm", capture: "header", scheme: "exact", terms_verified: undefined }),
    ).toBe(true);
  });

  it("the scorer and the adversary import it and neither defines its own", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    for (const rel of [
      "../../scorer/src/score-run.ts",
      "../../adversary/src/credential.ts",
      "../../adversary/src/facilitator.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/function termsQualify/);
      expect(src, rel).toMatch(/termsQualify,?[\s\S]*from "@x402-redteam\/schema"/);
    }
  });
});
