import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "@x402-redteam/schema";
import { type AttackCategory, CATEGORY_GUIDANCE, type Reference } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";

/**
 * U40a (design §6.3): every reference in the catalogue rests on something in this repo. An SDK
 * symbol must exist in the @x402/* 2.28.0 `dist/` tree of the package and file it cites; every
 * other anchor must appear in a public scenario description of that category. This proves
 * presence, not support (residual R6); support is a review item. It sits in `adversary` because
 * only this package has `@x402/*`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const X402 = join(here, "..", "node_modules", "@x402");
const CJS_DIST = join("dist", "cjs");

type Descriptions = Map<string, string>;

function loadDescriptions(): Descriptions {
  const scenarios = [
    ...loadCorpus(join(REPO, "corpus")),
    ...loadCorpus(join(REPO, "corpus-mcp")),
  ].filter((s) => s.category !== "control");
  const byCategory: Descriptions = new Map();
  for (const s of scenarios) {
    const folded = s.description.replace(/\s+/g, " ");
    byCategory.set(s.category, `${byCategory.get(s.category) ?? ""} ${folded}`);
  }
  return byCategory;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The text of the cited file, or with no file named the package's whole `dist/cjs` tree. */
function sdkText(citation: string): string {
  const spans = [...citation.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
  const pkg = spans.find((s) => s.startsWith("@x402/"))?.slice("@x402/".length);
  if (pkg === undefined) throw new Error(`no @x402 package in: ${citation}`);
  const root = join(X402, pkg, CJS_DIST);
  const file = spans.find((s) => s.endsWith(".js"));
  if (file !== undefined) return readFileSync(join(root, file), "utf8");
  return walk(root)
    .filter((p) => !p.endsWith(".map"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

/** On a word boundary, so `PaymentRequired` does not match inside `PaymentRequiredContext`. */
function hasToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

function isGrounded(
  ref: Reference,
  category: AttackCategory,
  descriptions: Descriptions,
  sdk: (citation: string) => string,
): boolean {
  const text = ref.kind === "sdk_source" ? sdk(ref.citation) : (descriptions.get(category) ?? "");
  return hasToken(text, ref.anchor);
}

const DESCRIPTIONS = loadDescriptions();
const ENTRIES = (
  Object.entries(CATEGORY_GUIDANCE) as Array<
    [AttackCategory, (typeof CATEGORY_GUIDANCE)[AttackCategory]]
  >
).flatMap(([category, g]) => g.references.map((ref) => ({ category, ref })));
const CITATIONS = ENTRIES.map((e) => e.ref.citation);

describe("category guidance references are grounded (design §6.3)", () => {
  it("covers the catalogue", () => {
    expect(ENTRIES).toHaveLength(22);
  });

  it.each(ENTRIES)("$category: $ref.anchor", ({ category, ref }) => {
    expect(isGrounded(ref, category, DESCRIPTIONS, sdkText)).toBe(true);
  });

  it.each(ENTRIES)("removing $ref.anchor fails for $category", ({ category, ref }) => {
    const stripped: Descriptions = new Map(
      [...DESCRIPTIONS].map(([c, text]) => [c, text.replaceAll(ref.anchor, "")]),
    );
    const sdk = (citation: string) => sdkText(citation).replaceAll(ref.anchor, "");
    expect(isGrounded(ref, category, stripped, sdk)).toBe(false);
  });

  it("an anchor inside a longer token does not count", () => {
    expect(hasToken("x PaymentRequiredContext y", "PaymentRequired")).toBe(false);
    expect(hasToken("x myPaymentRequired y", "PaymentRequired")).toBe(false);
    expect(hasToken("x PaymentRequired, y", "PaymentRequired")).toBe(true);
    expect(hasToken("ADR-010's history rule", "ADR-010")).toBe(true);
    expect(hasToken("arXiv 2605x11781", "2605.11781")).toBe(false);
  });

  it("an anchor from another category does not count", () => {
    const ref: Reference = { kind: "eip", citation: "x", anchor: "EIP-7702" };
    expect(isGrounded(ref, "rail_switch", DESCRIPTIONS, sdkText)).toBe(false);
  });
});

describe("citation rulings (owner gate 2026-11-07)", () => {
  it("keeps arXiv 2605.11781 on lookalike_domain only", () => {
    expect(ENTRIES.filter((e) => e.ref.anchor === "2605.11781").map((e) => e.category)).toEqual([
      "lookalike_domain",
    ]);
  });

  it("prints ERC-3009 (Draft), and anchors it on the corpus's own spelling", () => {
    const erc = ENTRIES.filter((e) => e.ref.anchor === "EIP-3009");
    expect(erc.map((e) => e.category).sort()).toEqual([
      "authorization_lifetime",
      "signature_request",
      "transfer_method_switch",
    ]);
    for (const { ref } of erc) expect(ref.citation).toBe("ERC-3009 (Draft)");
    for (const citation of CITATIONS) expect(citation).not.toContain("EIP-3009");
  });

  it("identifies the x402 v2 spec by file, repository and commit", () => {
    const specs = ENTRIES.filter((e) => e.ref.kind === "x402_spec");
    expect(specs.map((e) => e.category).sort()).toEqual(["challenge_injection", "resource_spoof"]);
    for (const { ref } of specs) {
      expect(ref.anchor).toBe("x402 v2 spec");
      expect(ref.citation).toContain("specs/x402-specification-v2.md");
      expect(ref.citation).toContain("x402-foundation/x402");
      expect(ref.citation).toContain("51a0664");
    }
  });
});

describe("Delta rev 4 citation rulings", () => {
  it("leaves recipient_redirect and replay with no reference", () => {
    expect(CATEGORY_GUIDANCE.recipient_redirect.references).toEqual([]);
    expect(CATEGORY_GUIDANCE.replay.references).toEqual([]);
  });

  it("cites the history rule where its text is", () => {
    const [ref] = CATEGORY_GUIDANCE.concurrent_spend.references;
    expect(ref?.anchor).toBe("ADR-010");
    expect(ref?.citation).toBe(
      "x402-redteam, `aidlc-docs/inception/application-design.md`, `history` (ADR-010 amendment)",
    );
    const design = readFileSync(
      join(REPO, "aidlc-docs", "inception", "application-design.md"),
      "utf8",
    );
    expect(design).toContain("`history` (ADR-010 amendment)");
  });
});

describe("citation form (design §6.3)", () => {
  it("each OWASP citation names the 2023 edition", () => {
    const owasp = ENTRIES.filter((e) => e.ref.kind === "owasp_llm");
    expect(owasp.length).toBe(4);
    for (const { ref } of owasp) {
      expect(ref.citation).toContain("OWASP Top 10 for LLM Applications, 2023 edition");
    }
  });

  it("no citation carries a URL, a section number or a line number", () => {
    for (const citation of CITATIONS) {
      expect(citation).not.toMatch(/https?:|§|:\d+\b/);
    }
  });

  it("an SDK citation names the TypeScript SDK at the pinned version", () => {
    const pinned = JSON.parse(readFileSync(join(X402, "core", "package.json"), "utf8")) as {
      version: string;
    };
    const sdk = ENTRIES.filter((e) => e.ref.kind === "sdk_source");
    expect(sdk.length).toBe(9);
    for (const { ref } of sdk) {
      expect(ref.citation).toContain(`(TypeScript SDK, ${pinned.version})`);
    }
  });
});
