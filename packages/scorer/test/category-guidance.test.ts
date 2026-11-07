import { type Category, CategorySchema } from "@x402-redteam/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AttackCategory,
  CATEGORY_GUIDANCE,
  type CategoryGuidance,
  CONTROL_GUIDANCE,
  guidanceFor,
  guidanceMarkdown,
  guidanceText,
  UNKNOWN_CATEGORY_GUIDANCE,
  VIOLATION_LABELS,
} from "../src/category-guidance.js";
import type { ViolationCode } from "../src/types.js";
import { forbiddenWords } from "./forbidden-words.js";

const ATTACK_CATEGORIES = CategorySchema.options.filter((c) => c !== "control");

describe("CATEGORY_GUIDANCE (design §4.1, §6)", () => {
  it("has a title and a remediation for every attack category, and no control entry", () => {
    expect(Object.keys(CATEGORY_GUIDANCE).sort()).toEqual([...ATTACK_CATEGORIES].sort());
    for (const g of Object.values(CATEGORY_GUIDANCE)) {
      expect(g.title.trim()).not.toBe("");
      expect(g.remediation.trim()).not.toBe("");
      for (const r of g.references) {
        expect(r.citation.trim()).not.toBe("");
        expect(r.anchor.trim()).not.toBe("");
      }
    }
  });

  it("is closed at compile time over categories and violation codes", () => {
    expectTypeOf(CATEGORY_GUIDANCE).toEqualTypeOf<Record<AttackCategory, CategoryGuidance>>();
    expectTypeOf(VIOLATION_LABELS).toEqualTypeOf<Record<ViolationCode, string>>();
    // @ts-expect-error "control" is not an attack category.
    const control: AttackCategory = "control";
    expect(control).toBe("control");
    // @ts-expect-error not a violation code.
    const code: ViolationCode = "not_a_code";
    expect(code).toBe("not_a_code");
  });

  it("uses no forbidden word (§5.4)", () => {
    for (const g of Object.values(CATEGORY_GUIDANCE)) {
      expect(forbiddenWords(g.title)).toEqual([]);
      expect(forbiddenWords(g.remediation)).toEqual([]);
    }
    expect(forbiddenWords(CONTROL_GUIDANCE)).toEqual([]);
    expect(forbiddenWords(Object.values(VIOLATION_LABELS).join(" "))).toEqual([]);
  });

  it("the scan itself catches each forbidden word on a word boundary", () => {
    for (const w of [
      "safe",
      "secure",
      "Certified",
      "compliant",
      "guaranteed",
      "audited",
      "proven",
    ]) {
      expect(forbiddenWords(`this is ${w}.`)).toHaveLength(1);
    }
    expect(forbiddenWords("safety score, unsafely")).toEqual([]);
    expect(forbiddenWords("It does not show the agent is safe.")).toEqual([]);
    expect(forbiddenWords("The agent is safe.")).toHaveLength(1);
  });

  it("leaves a category with no citation empty (§6.3)", () => {
    for (const c of [
      "budget_split",
      "fake_delivery",
      "price_bait",
      "rail_switch",
      "recipient_redirect",
      "replay",
    ] as const) {
      expect(CATEGORY_GUIDANCE[c].references).toEqual([]);
    }
  });

  it("labels every $0 violation code so that $0 does not read as harmless (§7.3)", () => {
    expect(VIOLATION_LABELS.excessive_authorization_window).toContain("counts no dollars");
    expect(VIOLATION_LABELS.standing_approval).toContain("counts no dollars");
    expect(VIOLATION_LABELS.off_scheme_signature).toContain("counts no dollars");
    expect(VIOLATION_LABELS.resource_limit).not.toContain("counts no dollars");
  });
});

describe("guidance rendering", () => {
  it("guidanceFor returns the entry for an attack category and null for a control", () => {
    expect(guidanceFor("replay")).toBe(CATEGORY_GUIDANCE.replay);
    expect(guidanceFor("control" satisfies Category)).toBeNull();
  });

  it.each(["no_such_category", "constructor", "__proto__", "toString"])(
    "guidanceFor gives the fixed fallback for the unknown category %s",
    (category) => {
      expect(guidanceFor(category)).toBe(UNKNOWN_CATEGORY_GUIDANCE);
      expect(guidanceFor(category)?.remediation).not.toBe(CONTROL_GUIDANCE);
    },
  );

  it("the fallback uses no forbidden word and cites nothing", () => {
    expect(forbiddenWords(guidanceText(UNKNOWN_CATEGORY_GUIDANCE))).toEqual([]);
    expect(UNKNOWN_CATEGORY_GUIDANCE.references).toEqual([]);
  });

  it("guidanceText has no backtick: SARIF help.text is plain text", () => {
    for (const g of Object.values(CATEGORY_GUIDANCE)) {
      expect(guidanceText(g)).not.toContain("`");
    }
    expect(guidanceText(CATEGORY_GUIDANCE.accepts_ordering)).toContain("accepts[]");
    expect(guidanceMarkdown(CATEGORY_GUIDANCE.accepts_ordering)).toContain("`accepts[]`");
  });

  it("names the application retry wrapper, not the SDK's own wrapper", () => {
    expect(CATEGORY_GUIDANCE.retry_storm.remediation).toContain("application retry wrapper");
  });

  it("adds a references line only when there are references", () => {
    const withRefs = CATEGORY_GUIDANCE.ghost_paywall;
    const noRefs = CATEGORY_GUIDANCE.rail_switch;
    expect(guidanceMarkdown(withRefs)).toBe(
      `${withRefs.remediation}\n\nReferences: ${withRefs.references[0]?.citation}`,
    );
    expect(guidanceText(withRefs)).toBe(
      `${withRefs.title}. ${withRefs.remediation} References: ${withRefs.references[0]?.citation}`,
    );
    expect(guidanceMarkdown(noRefs)).toBe(noRefs.remediation);
    expect(guidanceText(noRefs)).toBe(`${noRefs.title}. ${noRefs.remediation}`);
  });
});
