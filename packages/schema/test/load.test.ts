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

  // v2 (Bolt 5, U9 Part A §A1 "Lint (v2)"): rule 2 also scans resource_url, every
  // body_json string leaf, and accepts[].pay_to.
  it("rule 2 (v2): challenge.resource_url is template-checked", () => {
    try {
      loadScenario(join(fixtures, "v2-resource-url-unknown-var.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[0].challenge.resource_url");
      expect(corpusErr.message).toMatch(/unknown template variable/i);
    }
  });

  it("rule 2 (v2): every body_json string leaf is template-checked", () => {
    try {
      loadScenario(join(fixtures, "v2-body-json-unknown-var.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      // Checked via the shared renderJsonStrings (code review L6), which renders the
      // whole value rather than tracking individual leaf paths, so the reported path is
      // the body_json field as a whole; the message still names the exact bad variable.
      expect(corpusErr.path).toBe("routes[0].challenge.body_json");
      expect(corpusErr.message).toMatch(/unknown template variable/i);
      expect(corpusErr.message).toMatch(/bogus_var/);
    }
  });

  it("rule 2 (v2): every accepts[].pay_to is template-checked", () => {
    try {
      loadScenario(join(fixtures, "v2-accepts-unknown-var.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[0].challenge.accepts[1].pay_to");
      expect(corpusErr.message).toMatch(/unknown template variable/i);
    }
  });

  // v2: "body_json counts as page-visible text for rule 3", and accepts[].pay_to is
  // scanned as a payTo-canary source alongside challenge.pay_to.
  it("rule 3 (v2): body_json counts as page-visible text", () => {
    try {
      loadScenario(join(fixtures, "v2-body-json-canary-leak.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[1].challenge.body_json");
      expect(corpusErr.message).toMatch(/attacker/);
      expect(corpusErr.message).toMatch(/routes\[0\]\.challenge\.pay_to/);
    }
  });

  it("rule 3 (v2): accepts[].pay_to is scanned as a payTo canary source", () => {
    try {
      loadScenario(join(fixtures, "v2-accepts-canary-leak.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[1].page");
      expect(corpusErr.message).toMatch(/attacker/);
      expect(corpusErr.message).toMatch(/routes\[0\]\.challenge\.accepts\[0\]\.pay_to/);
    }
  });

  it("rule 3 (v2): a per_chain.pay_to override is scanned as a payTo canary source", () => {
    try {
      loadScenario(join(fixtures, "v2-per-chain-pay-to-canary-leak.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[1].page");
      expect(corpusErr.message).toMatch(/attacker/);
      expect(corpusErr.message).toMatch(/routes\[0\]\.challenge\.per_chain\.evm\.pay_to/);
    }
  });

  it("rule 3 (v2): an accepts[].per_chain.pay_to override is scanned as a payTo canary source", () => {
    try {
      loadScenario(join(fixtures, "v2-accepts-per-chain-pay-to-canary-leak.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[1].page");
      expect(corpusErr.message).toMatch(/attacker/);
      expect(corpusErr.message).toMatch(
        /routes\[0\]\.challenge\.accepts\[0\]\.per_chain\.evm\.pay_to/,
      );
    }
  });

  it("rule 2 (v2): a per_chain.pay_to override is template-checked", () => {
    try {
      loadScenario(join(fixtures, "v2-per-chain-pay-to-unknown-var.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("routes[0].challenge.per_chain.evm.pay_to");
      expect(corpusErr.message).toMatch(/unknown template variable/i);
    }
  });

  // v2 (ADR-009 control lint, §A3).
  it("§A3: a well-formed control scenario loads clean", () => {
    const scenario = loadScenario(join(fixtures, "v2-control-valid.yaml"));
    expect(scenario.category).toBe("control");
  });

  it("§A3: a control scenario must have expected.allow true", () => {
    try {
      loadScenario(join(fixtures, "v2-control-not-allow.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      expect((err as CorpusError).path).toBe("expected.allow");
    }
  });

  it("§A3: a control scenario must have expected.min_payments >= 1", () => {
    try {
      loadScenario(join(fixtures, "v2-control-missing-min-payments.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      expect((err as CorpusError).path).toBe("expected.min_payments");
    }
  });

  // Code review L2.
  it("§A3: a control scenario's min_payments must not exceed its max_payments", () => {
    try {
      loadScenario(join(fixtures, "v2-control-min-exceeds-max-payments.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("expected.min_payments");
      expect(corpusErr.message).toMatch(/must not exceed/);
    }
  });

  it("§A3: a control scenario must have expected.require_delivered true", () => {
    try {
      loadScenario(join(fixtures, "v2-control-missing-require-delivered.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      expect((err as CorpusError).path).toBe("expected.require_delivered");
    }
  });

  it("§A3: only a control scenario may set expected.min_payments > 0", () => {
    try {
      loadScenario(join(fixtures, "v2-noncontrol-min-payments.yaml"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      const corpusErr = err as CorpusError;
      expect(corpusErr.path).toBe("expected.min_payments");
      expect(corpusErr.message).toMatch(/only a "control" scenario/);
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
