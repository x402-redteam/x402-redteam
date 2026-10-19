import { describe, expect, it } from "vitest";
import { CatalogueError, loadCatalogue } from "../src/index.js";
import { BASE, CITE, PUBLIC_CATALOGUE, writeCatalogue } from "./helpers.js";

const mutation = (extra: string) =>
  `id: m-one\nfamily: fam\ncategory: unit_confusion\nchallenge:\n  amount_atomic: "1.5"\n${extra}`;

function load(files: Record<string, string>) {
  return loadCatalogue(writeCatalogue(files));
}

describe("catalogue schema", () => {
  it("loads the public smoke catalogue: two families, each a base plus one case", () => {
    const cat = loadCatalogue(PUBLIC_CATALOGUE);
    expect([...cat.bases.keys()].sort()).toEqual(["amount-format", "extra-fields"]);
    const tiers = cat.entries.filter((e) => e.base !== true).map((e) => [e.id, e.tier]);
    expect(tiers).toEqual([
      ["amount-non-digits", "spec-type"],
      ["unknown-extra-field", "undefined"],
    ]);
    const cited = cat.entries.find((e) => e.id === "amount-non-digits");
    expect(cited?.cite?.commit).toBe("0e6e8c55d86b4f14234fb6e49a4052074fb93e57");
  });

  it("requires a cite for spec-must", () => {
    expect(() =>
      load({
        "b.yaml": BASE("fam"),
        "m.yaml": mutation("tier: spec-must\nexpected_kind: refuse\n"),
      }),
    ).toThrow(/cite is required for spec-must/);
  });

  it("accepts spec-must with a cite and an expected_kind", () => {
    const cat = load({
      "b.yaml": BASE("fam"),
      "m.yaml": mutation(`tier: spec-must\nexpected_kind: pay_exactly\n${CITE}`),
    });
    expect(cat.entries).toHaveLength(2);
  });

  it("refuses a spec-must quote that states no requirement", () => {
    const weak = CITE.replace("A quoted sentence that MUST hold.", "Amounts are strings.");
    expect(() =>
      load({
        "b.yaml": BASE("fam"),
        "m.yaml": mutation(`tier: spec-must\nexpected_kind: refuse\n${weak}`),
      }),
    ).toThrow(/MUST or must/);
    const lower = CITE.replace("A quoted sentence that MUST hold.", "Protocol version (must be 2)");
    expect(() =>
      load({
        "b.yaml": BASE("fam"),
        "m.yaml": mutation(`tier: spec-must\nexpected_kind: refuse\n${lower}`),
      }),
    ).not.toThrow();
  });

  it("requires expected_kind for spec-must and forbids it elsewhere", () => {
    expect(() =>
      load({ "b.yaml": BASE("fam"), "m.yaml": mutation(`tier: spec-must\n${CITE}`) }),
    ).toThrow(/expected_kind is required/);
    expect(() =>
      load({
        "b.yaml": BASE("fam"),
        "m.yaml": mutation("tier: undefined\nexpected_kind: refuse\n"),
      }),
    ).toThrow(/spec-must only/);
  });

  it("requires a full 40-hex commit in a cite", () => {
    expect(() =>
      load({
        "b.yaml": BASE("fam"),
        "m.yaml": mutation(
          "tier: spec-must\nexpected_kind: refuse\ncite:\n  file: f.md\n  commit: main\n  quote: q\n",
        ),
      }),
    ).toThrow(/40-hex/);
  });

  it("refuses a bad id, a new category, a control category and an unknown key", () => {
    const base = { "b.yaml": BASE("fam") };
    expect(() =>
      load({ ...base, "m.yaml": mutation("tier: undefined\n").replace("m-one", "M_One") }),
    ).toThrow(/kebab-case/);
    expect(() =>
      load({ ...base, "m.yaml": mutation("tier: undefined\n").replace("unit_confusion", "fuzz") }),
    ).toThrow(CatalogueError);
    expect(() =>
      load({
        ...base,
        "m.yaml": mutation("tier: undefined\n").replace("unit_confusion", "control"),
      }),
    ).toThrow(/control/);
    expect(() => load({ ...base, "m.yaml": mutation("tier: undefined\nbogus: 1\n") })).toThrow(
      CatalogueError,
    );
  });

  it("needs exactly one base per family, unique ids, and an override per mutation", () => {
    expect(() => load({ "m.yaml": mutation("tier: undefined\n") })).toThrow(/no base entry/);
    expect(() =>
      load({ "a.yaml": BASE("fam"), "b.yaml": BASE("fam").replace("fam-base", "fam-base-2") }),
    ).toThrow(/two base entries/);
    expect(() => load({ "a.yaml": BASE("fam"), "b.yaml": BASE("fam") })).toThrow(/duplicate id/);
    expect(() =>
      load({
        "a.yaml": BASE("fam"),
        "m.yaml": "id: m-one\nfamily: fam\ncategory: unit_confusion\ntier: undefined\n",
      }),
    ).toThrow(/needs a challenge/);
  });

  it("reads JSON entries too", () => {
    const cat = load({
      "b.json": JSON.stringify({ id: "fam-base", family: "fam", base: true }),
      "m.json": JSON.stringify({
        id: "m-one",
        family: "fam",
        category: "unit_confusion",
        tier: "undefined",
        challenge: { amount_atomic: "1.5" },
      }),
    });
    expect(cat.entries.map((e) => e.id)).toEqual(["fam-base", "m-one"]);
  });
});
