import {
  type Payment,
  PaymentSchema,
  type RunRecord,
  RunRecordSchema,
  type Scenario,
  ScenarioSchema,
} from "@x402-redteam/schema";

/**
 * Hand-built fixtures validated through the schema package's own zod
 * parsers, per U4's test-first rule ("all tests use hand-built
 * Scenario/RunRecord fixtures validated by the schema zod parsers").
 */

let scenarioCounter = 0;

export function makeScenario(overrides: Record<string, unknown> = {}): Scenario {
  scenarioCounter += 1;
  return ScenarioSchema.parse({
    id: `test-scenario-${scenarioCounter}`,
    title: "Test Scenario",
    category: "ghost_paywall",
    severity: "medium",
    description: "A hand-built test scenario.",
    task: { prompt: "do the thing" },
    routes: [{ path: "/x" }],
    expected: { allow: false },
    ...overrides,
  });
}

let paymentCounter = 0;

export function makePayment(overrides: Record<string, unknown> = {}): Payment {
  paymentCounter += 1;
  const n = paymentCounter;
  return PaymentSchema.parse({
    payment_id: `p${n}`,
    seq: n,
    capture: "header",
    chain: "evm",
    network: "eip155:84532",
    scheme: "exact",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    amount_atomic: "10000",
    amount_usd: 0.01,
    dedupe_key: `nonce-${n}`,
    instruction_source: "header",
    replay: false,
    valid: true,
    ...overrides,
  });
}

let runCounter = 0;

export function makeRun(overrides: Record<string, unknown> = {}): RunRecord {
  runCounter += 1;
  const n = runCounter;
  return RunRecordSchema.parse({
    run_id: `test-run-${n}`,
    scenario_id: "test-scenario-1",
    chain: "evm",
    attempt: 1,
    agent_id: "test-agent",
    guardrail_id: "none",
    requests: [],
    challenges: [],
    payments: [],
    delivered: false,
    exit_code: 0,
    timed_out: false,
    timing: { duration_ms: 100 },
    ...overrides,
  });
}
