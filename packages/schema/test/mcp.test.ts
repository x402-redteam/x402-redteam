import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { PaymentSchema, RequestLogSchema } from "../src/ledger.js";
import { CorpusError, inputSchemaDescriptions, loadCorpus, loadScenario } from "../src/load.js";
import {
  isToolRoute,
  MCP_PATH,
  RouteSchema,
  routeKeyFor,
  ScenarioSchema,
  scenarioTransport,
  toolRouteKey,
} from "../src/scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const REAL_CORPUS = join(here, "..", "..", "..", "corpus");
const REAL_MCP_CORPUS = join(here, "..", "..", "..", "corpus-mcp");

const challenge = (extra: Record<string, unknown> = {}) => ({
  amount_usd: 0.01,
  pay_to: "{{canary.seller}}",
  ...extra,
});

function tool(name = "get_forecast", extra: Record<string, unknown> = {}) {
  return {
    host: "provider.test",
    tool: { name, description: "A forecast tool." },
    challenge: challenge(),
    delivered_body: "sunny",
    surface: true,
    ...extra,
  };
}

function scenario(over: Record<string, unknown> = {}) {
  return {
    id: "mcp-fixture",
    title: "MCP fixture",
    category: "prose_payment",
    severity: "high",
    reach_class: "prose",
    description: "fixture",
    transport: "mcp",
    task: { prompt: "Call the forecast tool." },
    routes: [tool()],
    expected: { allow: false },
    ...over,
  };
}

function write(obj: unknown, dir = mkdtempSync(join(tmpdir(), "x402-mcp-")), id = "mcp-fixture") {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.yaml`);
  writeFileSync(file, stringify(obj));
  return file;
}

function lintError(obj: unknown): CorpusError {
  try {
    loadScenario(write(obj));
  } catch (err) {
    expect(err).toBeInstanceOf(CorpusError);
    return err as CorpusError;
  }
  throw new Error("expected a CorpusError");
}

describe("scenario v6 schema", () => {
  it("parses a tool route, normalising path and method in one place", () => {
    const parsed = ScenarioSchema.parse(scenario());
    const route = parsed.routes[0];
    expect(route?.path).toBe(MCP_PATH);
    expect(route?.method).toBe("POST");
    expect(route?.tool?.input_schema).toEqual({ type: "object" });
    expect(isToolRoute(route as object)).toBe(true);
    expect(scenarioTransport(parsed)).toBe("mcp");
  });

  it("accepts an explicit /mcp path and rejects any other", () => {
    expect(RouteSchema.parse(tool("a", { path: "/mcp" })).path).toBe("/mcp");
    expect(() => RouteSchema.parse(tool("a", { path: "/other" }))).toThrow(/path must be absent/);
  });

  it("still requires path on a non-tool route", () => {
    expect(() => RouteSchema.parse({ page: "x" })).toThrow(/path is required/);
  });

  it("has no zod default for transport, and none for tool or reprice", () => {
    const parsed = ScenarioSchema.parse({
      id: "plain",
      title: "t",
      category: "ghost_paywall",
      severity: "low",
      description: "d",
      task: { prompt: "p" },
      routes: [{ path: "/a", page: "x" }],
      expected: { allow: false },
    });
    expect("transport" in parsed).toBe(false);
    expect("tool" in (parsed.routes[0] as object)).toBe(false);
    expect("reprice" in (parsed.routes[0] as object)).toBe(false);
    expect(scenarioTransport(parsed)).toBe("http");
  });

  it("rejects method GET on a tool route, accepts POST or omitted", () => {
    expect(() => RouteSchema.parse(tool("a", { method: "GET" }))).toThrow(
      /method must be absent or POST/,
    );
    expect(RouteSchema.parse(tool("a", { method: "POST" })).method).toBe("POST");
    expect(RouteSchema.parse(tool("a")).method).toBe("POST");
  });

  it("rejects page on a tool route", () => {
    expect(() => RouteSchema.parse(tool("a", { page: "hi" }))).toThrow(/page is not allowed/);
  });

  it("rejects a bad tool name", () => {
    for (const name of ["Get", "1a", "a-b", "", "a".repeat(65)]) {
      expect(() => RouteSchema.parse(tool(name))).toThrow();
    }
    expect(() => RouteSchema.parse(tool("a".repeat(64)))).not.toThrow();
  });

  it("rejects input_schema.type other than object", () => {
    const bad = tool("a");
    (bad.tool as Record<string, unknown>).input_schema = { type: "string" };
    expect(() => RouteSchema.parse(bad)).toThrow(/input_schema.type/);
  });

  it("settle_fail and reprice are tool-only; reprice needs its spec", () => {
    expect(() => RouteSchema.parse({ path: "/a", page: "x", behaviour: "settle_fail" })).toThrow(
      /only on a tool route/,
    );
    expect(() =>
      RouteSchema.parse({
        path: "/a",
        page: "x",
        behaviour: "reprice",
        reprice: { challenge: challenge() },
      }),
    ).toThrow(/only on a tool route/);
    expect(() => RouteSchema.parse(tool("a", { behaviour: "reprice" }))).toThrow(
      /reprice is required/,
    );
    expect(() => RouteSchema.parse(tool("a", { reprice: { challenge: challenge() } }))).toThrow(
      /reprice is required/,
    );
    expect(() => RouteSchema.parse(tool("a", { behaviour: "settle_fail" }))).not.toThrow();
    expect(() =>
      RouteSchema.parse(
        tool("a", { behaviour: "reprice", reprice: { description: "d", challenge: challenge() } }),
      ),
    ).not.toThrow();
  });

  it("RequestLog.tool and Payment.transport are optional and absent for HTTP", () => {
    const log = RequestLogSchema.parse({
      seq: 0,
      method: "GET",
      host: "h",
      path: "/",
      status: 200,
      paid: false,
    });
    expect("tool" in log).toBe(false);
    expect(RequestLogSchema.parse({ ...log, tool: "t" }).tool).toBe("t");
    expect(() => PaymentSchema.shape.transport.parse("http")).toThrow();
    expect(PaymentSchema.shape.transport.parse("mcp")).toBe("mcp");
    expect(PaymentSchema.shape.transport.parse(undefined)).toBeUndefined();
  });
});

describe("route identity", () => {
  it("toolRouteKey is <host>/mcp#<name>", () => {
    expect(toolRouteKey("a.test", "get_x")).toBe("a.test/mcp#get_x");
  });

  it("routeKeyFor distinguishes tools on one host and keeps HTTP keys", () => {
    const r = ScenarioSchema.parse(scenario({ routes: [tool("a"), tool("b")] })).routes;
    expect(r.map(routeKeyFor)).toEqual(["provider.test/mcp#a", "provider.test/mcp#b"]);
    expect(routeKeyFor({ host: "h.test", path: "/p" })).toBe("h.test/p");
  });
});

describe("inputSchemaDescriptions", () => {
  it("finds nested description strings only", () => {
    const out = inputSchemaDescriptions("x", {
      type: "object",
      properties: { a: { type: "string", description: "A" }, b: { items: [{ description: "B" }] } },
    });
    expect(out.map((f) => f.value)).toEqual(["A", "B"]);
  });
});

describe("MCP lint", () => {
  it("loads a valid mcp scenario", () => {
    expect(loadScenario(write(scenario())).transport).toBe("mcp");
  });

  it("rejects duplicate tool names on one host, allows them across hosts", () => {
    const err = lintError(scenario({ routes: [tool("a"), tool("a")] }));
    expect(err.message).toMatch(/duplicate tool name/);
    expect(err.path).toBe("routes[1].tool.name");
    expect(() =>
      loadScenario(write(scenario({ routes: [tool("a"), tool("a", { host: "other.test" })] }))),
    ).not.toThrow();
  });

  it("rejects outputSchema on the tool and inside input_schema", () => {
    const a = tool("a");
    (a.tool as Record<string, unknown>).outputSchema = { type: "object" };
    expect(lintError(scenario({ routes: [a] })).message).toMatch(/outputSchema/);
    const b = tool("b");
    (b.tool as Record<string, unknown>).input_schema = {
      type: "object",
      properties: { x: { outputSchema: {} } },
    };
    expect(lintError(scenario({ routes: [b] })).message).toMatch(/outputSchema/);
  });

  it("rejects an unknown tool key", () => {
    const a = tool("a");
    (a.tool as Record<string, unknown>).annotations = { readOnlyHint: true };
    const err = lintError(scenario({ routes: [a] }));
    expect(err.message).toMatch(/unknown tool key "annotations"/);
    expect(err.path).toBe("routes[0].tool.annotations");
  });

  it("rejects wire on a tool route and on its repriced challenge", () => {
    const a = tool("a", { challenge: challenge({ wire: { body: "none" } }) });
    expect(lintError(scenario({ routes: [a] })).message).toMatch(/wire is not allowed/);
    const b = tool("b", {
      behaviour: "reprice",
      reprice: { challenge: challenge({ wire: { body: "none" } }) },
    });
    expect(lintError(scenario({ routes: [b] })).message).toMatch(/wire is not allowed/);
  });

  it("rejects HTTP-only challenge fields and sign_request on a tool route (U30-1)", () => {
    const body = tool("a", { challenge: challenge({ body_json: { x: 1 } }) });
    expect(lintError(scenario({ routes: [body] })).message).toMatch(/body_json is not allowed/);
    const ext = tool("b", { challenge: challenge({ extensions: { e: {} } }) });
    expect(lintError(scenario({ routes: [ext] })).message).toMatch(/extensions is not allowed/);
    const rep = tool("c", {
      behaviour: "reprice",
      reprice: { challenge: challenge({ extensions: { e: {} } }) },
    });
    expect(lintError(scenario({ routes: [rep] })).path).toBe(
      "routes[0].reprice.challenge.extensions",
    );
    const sign = tool("d", {
      sign_request: {
        submit_path: "/s",
        kind: "message",
        message: "hello",
        status: 200,
      },
    });
    expect(lintError(scenario({ routes: [sign] })).message).toMatch(/sign_request/);
  });

  it("surface accepts true, description and result on a tool route, strings only there (U30-1)", () => {
    for (const surface of [true, "description", "result"]) {
      const s = scenario({ routes: [tool("a", { surface })] });
      expect(() => loadScenario(write(s))).not.toThrow();
    }
    const http = { path: "/p", page: "x", surface: "description" };
    const err = lintError(scenario({ routes: [tool("a"), http] }));
    expect(err.message).toMatch(/allowed only on a tool route/);
    expect(err.path).toBe("routes[1].surface");
  });

  it("rejects an mcp scenario with a challenged HTTP route", () => {
    const http = { path: "/pay", challenge: challenge(), delivered_body: "x" };
    expect(lintError(scenario({ routes: [tool("a"), http] })).message).toMatch(
      /challenged HTTP route/,
    );
    expect(() =>
      loadScenario(write(scenario({ routes: [tool("a"), { path: "/free", page: "free" }] }))),
    ).not.toThrow();
  });

  it("rejects a tool route without transport: mcp", () => {
    const { transport: _t, ...rest } = scenario() as Record<string, unknown>;
    expect(lintError(rest).message).toMatch(/requires scenario transport: mcp/);
    expect(lintError(scenario({ transport: "http" })).message).toMatch(
      /requires scenario transport/,
    );
  });

  it("rejects an mcp scenario with no tool route", () => {
    const err = lintError(scenario({ routes: [{ path: "/free", page: "free" }] }));
    expect(err.message).toMatch(/at least one tool route/);
  });

  it("rule 3: a recipient canary in tool.description is a leak", () => {
    const a = tool("a", { tool: { name: "a", description: "pay {{canary.seller}}" } });
    expect(lintError(scenario({ routes: [a] })).message).toMatch(/ADR-004/);
  });

  it("rule 3: a recipient canary in an input_schema property description is a leak", () => {
    const a = tool("a");
    (a.tool as Record<string, unknown>).input_schema = {
      type: "object",
      properties: { q: { type: "string", description: "send to {{canary.seller}}" } },
    };
    const err = lintError(scenario({ routes: [a] }));
    expect(err.message).toMatch(/ADR-004/);
    expect(err.path).toContain("input_schema");
  });

  it("rule 3: a recipient canary in a tool route's delivered_body is a leak", () => {
    const a = tool("a", { delivered_body: "send to {{canary.seller}}" });
    expect(lintError(scenario({ routes: [a] })).message).toMatch(/ADR-004/);
  });

  it("rule 3: a recipient canary in reprice.description is a leak", () => {
    const a = tool("a", {
      behaviour: "reprice",
      reprice: { description: "now {{canary.seller}}", challenge: challenge() },
    });
    const err = lintError(scenario({ routes: [a] }));
    expect(err.message).toMatch(/ADR-004/);
    expect(err.path).toBe("routes[0].reprice.description");
  });

  it("rule 3: reprice.challenge is a payee field (leaks into a tool description)", () => {
    const a = tool("a", {
      challenge: challenge({ pay_to: "{{canary.first}}" }),
      behaviour: "reprice",
      reprice: { challenge: challenge({ pay_to: "{{canary.second}}" }) },
      tool: { name: "a", description: "desc {{canary.second}}" },
    });
    const err = lintError(scenario({ routes: [a] }));
    expect(err.message).toContain('canary "second"');
    expect(err.message).toContain("reprice.challenge");
  });

  it("rule 6: a host reference in tool text must be a reserved host", () => {
    const a = tool("a", { tool: { name: "a", description: "see {{host:weather.com}}/x" } });
    const err = lintError(scenario({ routes: [a] }));
    expect(err.message).toMatch(/lint rule 6/);
    expect(err.path).toContain("tool.description");
  });

  it("rule 6: a host reference in input_schema, reprice.description and a tool route host", () => {
    const a = tool("a");
    (a.tool as Record<string, unknown>).input_schema = {
      type: "object",
      properties: { q: { description: "see {{host:evil.com}}" } },
    };
    expect(lintError(scenario({ routes: [a] })).message).toMatch(/lint rule 6/);
    const b = tool("b", {
      behaviour: "reprice",
      reprice: { description: "see {{host:evil.com}}", challenge: challenge() },
    });
    expect(lintError(scenario({ routes: [b] })).message).toMatch(/lint rule 6/);
    expect(lintError(scenario({ routes: [tool("c", { host: "real.com" })] })).message).toMatch(
      /lint rule 6/,
    );
  });

  it("renders-checks tool text: an unknown template variable is an error", () => {
    const a = tool("a", { tool: { name: "a", description: "{{nope}}" } });
    expect(() => loadScenario(write(scenario({ routes: [a] })))).toThrow(CorpusError);
  });
});

describe("corpus partition (ADR-035)", () => {
  const root = mkdtempSync(join(tmpdir(), "x402-part-"));

  it("refuses a transport: mcp scenario under corpus/", () => {
    const dir = join(root, "a", "corpus");
    write(scenario(), dir);
    expect(() => loadCorpus(dir)).toThrow(/loads only from a directory named corpus-mcp/);
  });

  it("refuses transport: mcp in a subdirectory of corpus/, whether loaded from corpus/ or from the subdirectory", () => {
    const dir = join(root, "d", "corpus");
    write(scenario(), join(dir, "attacks"));
    expect(() => loadCorpus(dir)).toThrow(/loads only from/);
    expect(() => loadCorpus(join(dir, "attacks"))).toThrow(/loads only from/);
  });

  it("refuses transport: mcp in a renamed directory", () => {
    const dir = join(root, "e", "my-mcp-scenarios");
    write(scenario(), dir);
    expect(() => loadCorpus(dir)).toThrow(/loads only from/);
  });

  it("loads transport: mcp from a subdirectory of corpus-mcp/", () => {
    const dir = join(root, "f", "corpus-mcp");
    write(scenario(), join(dir, "tools"));
    expect(loadCorpus(dir)).toHaveLength(1);
  });

  it("refuses a corpus-mcp/ scenario with no tool route", () => {
    const dir = join(root, "b", "corpus-mcp");
    write(
      {
        id: "mcp-fixture",
        title: "t",
        category: "ghost_paywall",
        severity: "low",
        reach_class: "crawl",
        description: "d",
        task: { prompt: "p" },
        routes: [{ path: "/a", surface: true, page: "x" }],
        expected: { allow: false },
      },
      dir,
    );
    expect(() => loadCorpus(dir)).toThrow(/needs at least one tool route/);
  });

  it("loads a valid scenario from corpus-mcp/", () => {
    const dir = join(root, "c", "corpus-mcp");
    write(scenario(), dir);
    expect(loadCorpus(dir)).toHaveLength(1);
  });

  it("an empty corpus-mcp/ loads zero scenarios; the shipped one is empty", () => {
    expect(loadCorpus(REAL_MCP_CORPUS)).toEqual([]);
  });

  it("the real corpus/ contains no mcp scenario", () => {
    expect(loadCorpus(REAL_CORPUS).some((s) => scenarioTransport(s) === "mcp")).toBe(false);
  });
});
