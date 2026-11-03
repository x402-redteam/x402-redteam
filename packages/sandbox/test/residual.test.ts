import { describe, expect, it } from "vitest";
import {
  matchResidual,
  parseEnvResidual,
  parseResiduals,
  residualCovers,
} from "../src/residual.js";

// A temp decisions fixture; the real decisions.md records no residual.
const fixture = [
  "## ADR-029",
  "M7-residual: probes=P5 owner=Owner date=2026-11-04 secrets=ANTHROPIC_API_KEY,GH_TOKEN",
  "M7-residual: probes=LINUX,P5 owner=Owner date=2026-11-04",
  "not a residual: probes=P1 owner=x date=2026-11-04",
].join("\n");

const scoped = [
  "## ADR-028",
  "M7-residual: probes=P1 owner=Other date=2026-11-04",
  "## ADR-029",
  "```",
  "M7-residual: probes=P2 owner=Fenced date=2026-11-04",
  "```",
  "<!--",
  "M7-residual: probes=P3 owner=Commented date=2026-11-04",
  "-->",
  "M7-residual: probes=P4 owner=Real date=2026-11-04",
  "## ADR-032",
  "M7-residual: probes=P5 owner=Later date=2026-11-04",
].join("\n");

describe("residual scope", () => {
  it("counts only the ADR-029 section, outside fences and comments", () => {
    expect(parseResiduals(scoped).map((r) => r.owner)).toEqual(["Real"]);
    for (const p of ["P1", "P2", "P3", "P5"])
      expect(matchResidual(`probes=${p}`, scoped)).toBeUndefined();
    expect(matchResidual("probes=P4", scoped)?.owner).toBe("Real");
  });
  it("finds nothing without an ADR-029 section", () => {
    expect(parseResiduals("M7-residual: probes=P5 owner=x date=2026-11-04")).toEqual([]);
  });
});

describe("owner-recorded residual", () => {
  it("parses entries with probe ids and secret names", () => {
    const [a, b] = parseResiduals(fixture);
    expect(a).toEqual({
      probes: ["P5"],
      owner: "Owner",
      date: "2026-11-04",
      secrets: ["ANTHROPIC_API_KEY", "GH_TOKEN"],
    });
    expect(b?.probes).toEqual(["LINUX", "P5"]);
    expect(parseResiduals(fixture)).toHaveLength(2);
  });
  it("rejects an env value with no recorded entry", () => {
    expect(matchResidual("probes=P5", "")).toBeUndefined();
    expect(matchResidual("probes=P2", fixture)).toBeUndefined();
  });
  it("rejects a mismatched probe set, subset or superset", () => {
    expect(matchResidual("probes=P4,P5", fixture)).toBeUndefined();
    expect(matchResidual("probes=LINUX", fixture)).toBeUndefined();
  });
  it("rejects malformed and legacy values", () => {
    expect(parseEnvResidual("ADR-029:P5")).toBeUndefined();
    expect(parseEnvResidual(undefined)).toBeUndefined();
    expect(matchResidual("probes=", fixture)).toBeUndefined();
    expect(matchResidual("ADR-029:P5", fixture)).toBeUndefined();
  });
  it("accepts a matching entry, in any order", () => {
    expect(matchResidual("probes=P5", fixture)?.owner).toBe("Owner");
    expect(matchResidual("probes=P5,LINUX", fixture)?.probes).toEqual(["LINUX", "P5"]);
  });
  it("covers only the problems the entry names", () => {
    expect(residualCovers(["P5"], "probes=P5", fixture)).toBeDefined();
    expect(residualCovers(["P5", "P1"], "probes=P5", fixture)).toBeUndefined();
    expect(residualCovers(["P5"], undefined, fixture)).toBeUndefined();
  });
});
