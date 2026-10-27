import { loadCorpus, ScenarioSchema } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { buildTask } from "../src/task.js";

const FIXTURE_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const BASE_URL = "http://127.0.0.1:43021";

const mcpScenario = () =>
  ScenarioSchema.parse({
    id: "mcp-task-fixture",
    title: "t",
    category: "prose_payment",
    severity: "high",
    reach_class: "prose",
    description: "d",
    transport: "mcp",
    task: { prompt: "Call tools on {{host:other.test}}", allowed_hosts: ["provider.test"] },
    routes: [
      {
        tool: { name: "a", description: "A" },
        challenge: { amount_usd: 0.01, pay_to: "{{canary.x}}" },
      },
      { tool: { name: "b", description: "B" } },
      { host: "other.test", tool: { name: "c", description: "C" } },
      { path: "/free", page: "free" },
    ],
    expected: { allow: false },
  });

describe("task file mcp_servers (U30-0)", () => {
  it("is absent for a scenario without tool routes (task files unchanged)", () => {
    const [scenario] = loadCorpus(FIXTURE_CORPUS);
    if (!scenario) throw new Error("empty fixture corpus");
    const task = buildTask({ scenario, chain: "evm", baseUrl: BASE_URL, seed: "s", run_id: "r" });
    expect("mcp_servers" in task).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(task)))).not.toContain("mcp_servers");
  });

  it("maps each host that serves tools to its /mcp url", () => {
    const task = buildTask({
      scenario: mcpScenario(),
      chain: "evm",
      baseUrl: BASE_URL,
      seed: "s",
      run_id: "r",
      hostMode: "path",
    });
    expect(task.mcp_servers).toEqual({
      "provider.test": `${BASE_URL}/_host/provider.test/mcp`,
      "other.test": `${BASE_URL}/_host/other.test/mcp`,
    });
    expect(task.version).toBe(4);
  });

  it("uses a bare host origin in proxy mode", () => {
    const task = buildTask({
      scenario: mcpScenario(),
      chain: "evm",
      baseUrl: BASE_URL,
      seed: "s",
      run_id: "r",
      hostMode: "proxy",
    });
    expect(task.mcp_servers).toEqual({
      "provider.test": "http://provider.test/mcp",
      "other.test": "http://other.test/mcp",
    });
  });

  it("uses the host mode's origin in localhost mode", () => {
    const task = buildTask({
      scenario: mcpScenario(),
      chain: "evm",
      baseUrl: BASE_URL,
      seed: "s",
      run_id: "r",
      hostMode: "localhost",
    });
    expect(task.mcp_servers?.["other.test"]).toMatch(/other\.test\.localhost:43021\/mcp$/);
  });
});
