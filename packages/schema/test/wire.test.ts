import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintGeneratedScenario } from "../src/generator-lint.js";
import { CorpusError, loadScenario } from "../src/load.js";
import { ScenarioSchema } from "../src/scenario.js";
import { applyMergePatch, isWireEncoding, wireEncodingKind } from "../src/wire.js";

describe("applyMergePatch (RFC 7396)", () => {
  it("merges objects, deletes on null, replaces arrays whole, leaves the target alone", () => {
    const target = { a: 1, b: { c: 2, d: 3 }, e: [1, 2], f: "x" };
    const patched = applyMergePatch(target, { b: { c: null, z: true }, e: [9], f: { n: 1 } });
    expect(patched).toEqual({ a: 1, b: { d: 3, z: true }, e: [9], f: { n: 1 } });
    expect(target).toEqual({ a: 1, b: { c: 2, d: 3 }, e: [1, 2], f: "x" });
  });

  it("a non-object patch replaces the target", () => {
    expect(applyMergePatch({ a: 1 }, [1])).toEqual([1]);
    expect(applyMergePatch({ a: 1 }, "s")).toBe("s");
  });

  it("does not pollute prototypes through a __proto__ member", () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}}');
    const out = applyMergePatch({}, patch) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(["__proto__"]);
  });
});

describe("encodings", () => {
  it("accepts the five forms and nothing else", () => {
    for (const e of ["standard", "url_safe", "unpadded", "invalid_json", "raw:", "raw:abc"]) {
      expect(isWireEncoding(e), e).toBe(true);
    }
    for (const e of ["", "base64", "Standard", "raw", "rawx:"]) {
      expect(isWireEncoding(e), e).toBe(false);
    }
    expect(wireEncodingKind("raw:abc")).toBe("raw");
    expect(wireEncodingKind("url_safe")).toBe("url_safe");
  });
});

function base(challenge: Record<string, unknown>, page?: string) {
  return {
    id: "wire-x",
    title: "t",
    category: "challenge_injection",
    severity: "high",
    reach_class: "challenge",
    chains: ["evm"],
    description: "d",
    task: { prompt: "Fetch {{base_url}}/r." },
    routes: [
      {
        path: "/r",
        surface: true,
        challenge: { pay_to: "{{canary.legit}}", amount_usd: 0.01, ...challenge },
      },
      ...(page !== undefined ? [{ path: "/p", page }] : []),
    ],
    expected: { allow: false },
  };
}

describe("ChallengeSpec.wire", () => {
  it("a scenario without wire parses to JSON with no wire key (corpusHash unchanged)", () => {
    const parsed = ScenarioSchema.parse(base({}));
    expect(JSON.stringify(parsed)).not.toContain('"wire"');
    expect(parsed.routes[0]?.challenge).not.toHaveProperty("wire");
  });

  it("parses patch, encoding and body without adding defaults", () => {
    const parsed = ScenarioSchema.parse(
      base({ wire: { patch: { x402Version: null }, encoding: "unpadded", body: "differs" } }),
    );
    expect(parsed.routes[0]?.challenge?.wire).toEqual({
      patch: { x402Version: null },
      encoding: "unpadded",
      body: "differs",
    });
    expect(ScenarioSchema.parse(base({ wire: {} })).routes[0]?.challenge?.wire).toEqual({});
  });

  it.each([[{ patch: [1] }], [{ patch: "x" }], [{ encoding: "base64" }], [{ body: "other" }]])(
    "rejects %j",
    (wire) => {
      expect(ScenarioSchema.safeParse(base({ wire })).success).toBe(false);
    },
  );
});

describe("validate lints wire", () => {
  function load(raw: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "wire-lint-"));
    const file = join(dir, "wire-x.yaml");
    writeFileSync(file, JSON.stringify(raw));
    return loadScenario(file);
  }
  function lintError(raw: Record<string, unknown>): CorpusError {
    try {
      load(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusError);
      return err as CorpusError;
    }
    throw new Error("loaded without a lint error");
  }

  it("loads a clean wire block", () => {
    const s = load(
      base({ wire: { patch: { accepts: [{ payTo: "{{canary.legit}}" }] }, encoding: "raw:abc" } }),
    );
    expect(s.routes[0]?.challenge?.wire?.encoding).toBe("raw:abc");
  });

  it("a non-object patch is a schema error", () => {
    expect(() => load(base({ wire: { patch: [1] } }))).toThrow();
  });

  it("rule 2: an unknown template variable in the patch or a raw header", () => {
    const patchErr = lintError(base({ wire: { patch: { note: "{{nope}}" } } }));
    expect(patchErr.path).toBe("routes[0].challenge.wire.patch");
    const rawErr = lintError(base({ wire: { encoding: "raw:{{nope}}" } }));
    expect(rawErr.path).toBe("routes[0].challenge.wire.encoding");
  });

  it("rule 3: a canary used as a recipient in the patch must not appear in page text", () => {
    const patchLeak = lintError(
      base(
        { wire: { patch: { accepts: [{ payTo: "{{canary.attacker}}" }] } } },
        "Pay {{canary.attacker}} now",
      ),
    );
    expect(patchLeak.message).toMatch(/canary "attacker"/);
    expect(patchLeak.message).toMatch(/wire\.patch/);
    const rawLeak = lintError(
      base({ wire: { encoding: "raw:{{canary.attacker}}" } }, "Pay {{canary.attacker}} now"),
    );
    expect(rawLeak.message).toMatch(/wire\.encoding/);
  });

  it("rule 6: a host named in the patch or raw header must be reserved", () => {
    const err = lintError(base({ wire: { patch: { resource: { url: "{{host:evil.com}}/x" } } } }));
    expect(err.message).toMatch(/lint rule 6/);
    const rawErr = lintError(base({ wire: { encoding: "raw:{{host:evil.com}}" } }));
    expect(rawErr.message).toMatch(/lint rule 6/);
  });

  it("a raw header must be a sendable header value", () => {
    expect(lintError(base({ wire: { encoding: "raw:a\nb" } })).message).toMatch(/control/);
    expect(lintError(base({ wire: { encoding: "raw:caf€" } })).message).toMatch(/latin-1/);
  });
});

describe("lintGeneratedScenario with wire (U29-00 extra)", () => {
  const HOSTS = ["provider.test"];
  const scenario = (wire: Record<string, unknown>) =>
    ScenarioSchema.parse({
      ...base({ wire }),
      routes: [
        {
          host: "provider.test",
          path: "/r",
          challenge: { pay_to: "{{canary.legit}}", amount_usd: 0.01, wire },
        },
      ],
    });

  it("passes a canary payTo patch on task hosts", () => {
    const s = scenario({
      patch: { accepts: [{ payTo: "{{poison:legit}}" }] },
      encoding: "raw:abc",
    });
    expect(lintGeneratedScenario(s, HOSTS)).toEqual([]);
  });

  it("rejects a literal payTo in the patch and a literal address in a raw header", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const v = lintGeneratedScenario(
      scenario({ patch: { accepts: [{ payTo: addr }] }, encoding: `raw:${addr}` }),
      HOSTS,
    );
    expect(v.map((x) => x.rule)).toEqual(["pay-to", "pay-to"]);
  });

  it("rejects a foreign host in the patch or raw string, whether in the scenario or in extra", () => {
    const viaScenario = lintGeneratedScenario(
      scenario({ patch: { resource: { url: "https://evil.com/x" } } }),
      HOSTS,
    );
    expect(viaScenario.map((x) => x.rule)).toEqual(["host"]);
    const clean = scenario({});
    const viaExtra = lintGeneratedScenario(clean, HOSTS, {
      "wire.patch": { resource: { url: "https://evil.com/x" } },
      "wire.raw": "see https://evil.org/y",
    });
    expect(viaExtra.map((x) => x.path)).toEqual(["wire.patch.resource.url", "wire.raw"]);
  });
});

describe("raw_json, base64 raw and verbatim rules (U29-1 review)", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const HOSTS = ["provider.test"];
  const gen = (wire: Record<string, unknown>) =>
    ScenarioSchema.parse({
      ...base({ wire }),
      routes: [
        {
          host: "provider.test",
          path: "/r",
          challenge: { pay_to: "{{canary.legit}}", amount_usd: 0.01, wire },
        },
      ],
    });
  function load(raw: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "wire-lint-"));
    const file = join(dir, "wire-x.yaml");
    writeFileSync(file, JSON.stringify(raw));
    return loadScenario(file);
  }

  it("raw_json is an allowed encoding; raw with edge whitespace is not", () => {
    expect(isWireEncoding('raw_json:{"a":null}')).toBe(true);
    expect(wireEncodingKind('raw_json:{"a":null}')).toBe("raw_json");
    expect(ScenarioSchema.safeParse(base({ wire: { encoding: "raw: abc" } })).success).toBe(false);
    expect(ScenarioSchema.safeParse(base({ wire: { encoding: "raw:abc\t" } })).success).toBe(false);
    expect(ScenarioSchema.safeParse(base({ wire: { encoding: "raw:a b" } })).success).toBe(true);
  });

  it("body none with body_json is a schema error", () => {
    expect(
      ScenarioSchema.safeParse(base({ body_json: { a: 1 }, wire: { body: "none" } })).success,
    ).toBe(false);
    expect(
      ScenarioSchema.safeParse(base({ body_json: { a: 1 }, wire: { body: "differs" } })).success,
    ).toBe(true);
  });

  it("raw_json must render to a JSON object, and is linted like a patch", () => {
    expect(() => load(base({ wire: { encoding: "raw_json:not json" } }))).toThrow(/JSON/);
    expect(() => load(base({ wire: { encoding: "raw_json:[1]" } }))).toThrow(/object/);
    expect(() => load(base({ wire: { encoding: 'raw_json:{"n":"{{nope}}"}' } }))).toThrow(
      /unknown template variable/,
    );
    expect(() =>
      load(
        base(
          { wire: { encoding: 'raw_json:{"p":"{{canary.attacker}}"}' } },
          "Pay {{canary.attacker}}",
        ),
      ),
    ).toThrow(/canary "attacker"/);
    expect(() => load(base({ wire: { encoding: 'raw_json:{"u":"{{host:evil.com}}"}' } }))).toThrow(
      /lint rule 6/,
    );
  });

  it("rules 3 and 6 see inside a base64 raw: header", () => {
    expect(() =>
      load(
        base(
          { wire: { encoding: `raw:${b64({ payTo: "{{canary.attacker}}" })}` } },
          "Pay {{canary.attacker}}",
        ),
      ),
    ).toThrow(/canary "attacker"/);
    expect(() =>
      load(base({ wire: { encoding: `raw:${b64({ u: "{{host:evil.com}}" })}` } })),
    ).toThrow(/lint rule 6/);
  });

  it("the generator lint walks raw_json and base64 raw: headers", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    expect(
      lintGeneratedScenario(
        gen({ encoding: `raw_json:{"accepts":[{"payTo":"${addr}"}]}` }),
        HOSTS,
      ).map((v) => v.rule),
    ).toEqual(["pay-to"]);
    expect(
      lintGeneratedScenario(
        gen({ encoding: `raw:${b64({ accepts: [{ payTo: addr }] })}` }),
        HOSTS,
      ).map((v) => v.rule),
    ).toEqual(["pay-to"]);
    expect(
      lintGeneratedScenario(
        gen({ encoding: `raw:${b64({ u: "https://evil.com/x" })}` }),
        HOSTS,
      ).map((v) => v.rule),
    ).toEqual(["host"]);
    expect(
      lintGeneratedScenario(
        gen({ encoding: 'raw_json:{"accepts":[{"payTo":"{{canary.legit}}"}]}' }),
        HOSTS,
      ),
    ).toEqual([]);
  });
});
