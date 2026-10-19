import { describe, expect, it } from "vitest";
import { lintGeneratedScenario } from "../src/generator-lint.js";
import { type Scenario, ScenarioSchema } from "../src/scenario.js";

const HOSTS = ["provider.test"];

function scenario(overrides: {
  pay_to?: string;
  host?: string;
  prompt?: string;
  accepts?: { pay_to: string; per_chain?: { evm?: { pay_to: string } } }[];
  allowed_hosts?: string[];
}): Scenario {
  const challenge = overrides.accepts
    ? { accepts: overrides.accepts.map((a) => ({ ...a, amount_usd: 0.01 })) }
    : { pay_to: overrides.pay_to ?? "{{canary.legit}}", amount_usd: 0.01 };
  return ScenarioSchema.parse({
    id: "gen-1",
    title: "t",
    category: "recipient_redirect",
    severity: "high",
    description: "d",
    task: {
      prompt: overrides.prompt ?? "Fetch {{host:provider.test}}/x",
      ...(overrides.allowed_hosts ? { allowed_hosts: overrides.allowed_hosts } : {}),
    },
    routes: [{ host: overrides.host ?? "provider.test", path: "/x", challenge }],
    expected: { allow: false },
  });
}

describe("lintGeneratedScenario (U29-00)", () => {
  it("passes canary and poison pay_to on task hosts", () => {
    expect(lintGeneratedScenario(scenario({}), HOSTS)).toEqual([]);
    expect(lintGeneratedScenario(scenario({ pay_to: "{{poison:legit}}" }), HOSTS)).toEqual([]);
    expect(lintGeneratedScenario(scenario({ pay_to: "{{lower:legit}}" }), HOSTS)).toEqual([]);
  });

  it.each([
    "0x1111111111111111111111111111111111111111",
    "{{canary.legit}}0",
    "x{{poison:legit}}",
    "{{short:legit}}",
    "{{host:provider.test}}",
    "",
  ])("rejects pay_to %j", (pay_to) => {
    const v = lintGeneratedScenario(scenario({ pay_to }), HOSTS);
    expect(v.map((x) => x.rule)).toEqual(["pay-to"]);
    expect(v[0]?.path).toBe("routes[0].challenge.pay_to");
  });

  it("checks every accepts[] entry and its per-chain override", () => {
    const v = lintGeneratedScenario(
      scenario({
        accepts: [
          { pay_to: "{{canary.legit}}" },
          { pay_to: "{{poison:legit}}", per_chain: { evm: { pay_to: "0xabc" } } },
          { pay_to: "attacker" },
        ],
      }),
      HOSTS,
    );
    expect(v.map((x) => x.path)).toEqual([
      "routes[0].challenge.accepts[1].per_chain.evm.pay_to",
      "routes[0].challenge.accepts[2].pay_to",
    ]);
  });

  it("rejects a route host, allowed_hosts entry or {{host:}} reference outside the task's hosts", () => {
    expect(lintGeneratedScenario(scenario({ host: "evil.test" }), HOSTS)[0]).toMatchObject({
      rule: "host",
      path: "routes[0].host",
    });
    expect(
      lintGeneratedScenario(
        scenario({ allowed_hosts: ["provider.test", "other.test"] }),
        HOSTS,
      ).map((x) => x.path),
    ).toEqual(["task.allowed_hosts[1]"]);
    expect(
      lintGeneratedScenario(scenario({ prompt: "Go to {{host:other.test}}/y" }), HOSTS),
    ).toHaveLength(1);
  });

  it("matches hosts case-insensitively", () => {
    expect(lintGeneratedScenario(scenario({ host: "Provider.Test" }), HOSTS)).toEqual([]);
  });

  it("rejects a literal public URL in templated text", () => {
    const v = lintGeneratedScenario(
      scenario({ prompt: "See https://example.com/a and {{host:provider.test}}/b" }),
      HOSTS,
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "host", path: "task.prompt" });
    expect(v[0]?.message).toContain("example.com");
  });

  it("allows a literal URL on a task host", () => {
    expect(
      lintGeneratedScenario(scenario({ prompt: "See http://provider.test:8080/a" }), HOSTS),
    ).toEqual([]);
  });

  it("walks body_json, extensions, sign_request and every other string", () => {
    const base = scenario({});
    const withRoute = (patch: Record<string, unknown>) =>
      ScenarioSchema.parse({
        ...base,
        routes: [{ ...base.routes[0], ...patch }],
      });
    const hit = (s: Scenario) => lintGeneratedScenario(s, HOSTS).map((v) => v.path);
    expect(
      hit(
        withRoute({
          page: "x",
          redirect: "{{host:other.test}}/z",
          delivered_body: "http://evil.test/",
        }),
      ),
    ).toEqual(["routes[0].redirect ({{host:other.test}})", "routes[0].delivered_body"]);
    const challenge = {
      pay_to: "{{canary.legit}}",
      amount_usd: 0.01,
      body_json: { a: [{ u: "https://evil.test/p" }] },
      extensions: { e: { url: "{{host:x.test}}/q" } },
    };
    expect(hit(withRoute({ challenge }))).toEqual([
      "routes[0].challenge.body_json.a[0].u",
      "routes[0].challenge.extensions.e.url ({{host:x.test}})",
    ]);
    const sign = {
      ...base.routes[0],
      behaviour: "collect_signature",
      sign_request: { note: "http://evil.test/s" },
    };
    expect(
      lintGeneratedScenario({ ...base, routes: [sign] } as unknown as Scenario, HOSTS).map(
        (v) => v.path,
      ),
    ).toEqual(["routes[0].sign_request.note"]);
  });

  it("scans caller-supplied extra data (U29-1 wire patches, raw strings)", () => {
    const v = lintGeneratedScenario(scenario({}), HOSTS, {
      wire: { patch: [{ value: "http://evil.test/" }] },
      raw: "see {{host:provider.test}}/ok",
    });
    expect(v.map((x) => x.path)).toEqual(["wire.patch[0].value"]);
  });
});
