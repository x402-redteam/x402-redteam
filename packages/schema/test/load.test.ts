import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CorpusError, loadCorpus, loadScenario } from "../src/load.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

describe("loadScenario", () => {
  it("loads a valid minimal scenario", () => {
    const scenario = loadScenario(join(fixtures, "valid-minimal.yaml"));
    expect(scenario.id).toBe("valid-minimal");
    expect(scenario.chains).toEqual(["evm", "svm"]);
  });

  it("rule 1: rejects a scenario whose id does not match its filename", () => {
    expect(() => loadScenario(join(fixtures, "rule1-id-mismatch.yaml"))).toThrow(CorpusError);
    try {
      loadScenario(join(fixtures, "rule1-id-mismatch.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule1-id-mismatch.yaml");
      expect(corpusErr.path).toBe("id");
    }
  });

  it("rule 2: rejects a scenario with an unresolvable template variable", () => {
    try {
      loadScenario(join(fixtures, "rule2-unknown-var.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule2-unknown-var.yaml");
      expect(corpusErr.path).toBe("task.prompt");
      expect(corpusErr.message).toMatch(/unknown template variable/i);
    }
  });

  it("rule 2: challenge.description is also template-checked", () => {
    try {
      loadScenario(join(fixtures, "rule2b-unknown-var-description.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule2b-unknown-var-description.yaml");
      expect(corpusErr.path).toBe("routes[0].challenge.description");
      expect(corpusErr.message).toMatch(/unknown template variable/i);
    }
  });

  it("rule 3: rejects a scenario that leaks a pay_to canary into page prose (ADR-004)", () => {
    try {
      loadScenario(join(fixtures, "rule3-canary-leak.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule3-canary-leak.yaml");
      expect(corpusErr.path).toBe("routes[1].page");
      expect(corpusErr.message).toMatch(/attacker/);
    }
  });

  it("rule 3: also treats delivered_body as page text (ADR-004)", () => {
    try {
      loadScenario(join(fixtures, "rule3-canary-leak-delivered-body.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule3-canary-leak-delivered-body.yaml");
      expect(corpusErr.path).toBe("routes[0].delivered_body");
      expect(corpusErr.message).toMatch(/attacker/);
    }
  });

  it("rule 4: rejects a scenario that allows payment without max_usd", () => {
    try {
      loadScenario(join(fixtures, "rule4-missing-max-usd.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule4-missing-max-usd.yaml");
      expect(corpusErr.path).toBe("expected.max_usd");
    }
  });

  it("rule 5: rejects a redirect that does not resolve to a declared route", () => {
    try {
      loadScenario(join(fixtures, "rule5-bad-redirect.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.file).toContain("rule5-bad-redirect.yaml");
      expect(corpusErr.path).toBe("routes[0].redirect");
    }
  });
});

describe("loadCorpus", () => {
  it("loads every scenario in a valid corpus directory (recursively)", () => {
    const scenarios = loadCorpus(join(fixtures, "corpus-ok"));
    expect(scenarios.map((s) => s.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("rejects a corpus with a duplicate id across subdirectories", () => {
    try {
      loadCorpus(join(fixtures, "corpus-duplicate"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("id");
      expect(corpusErr.message).toMatch(/duplicate scenario id "dup"/);
    }
  });
});
