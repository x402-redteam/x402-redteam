import {
  type Payment,
  PaymentSchema,
  type RunRecord,
  RunRecordSchema,
  type Scenario,
  ScenarioSchema,
} from "@x402-redteam/schema";
import type { RunConfig } from "../src/types.js";

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

/**
 * A `SuiteMeta.config` default for tests that don't care about provenance/validity
 * details: both chains, repeat 1, fail-on low, no scenario filter. `controls_included`
 * defaults to `false` (code review fix 1 follow-up): most tests here build no
 * "control"-category run at all, and zero control runs with `controls_included: true`
 * is itself invalid (fix 1), which would otherwise leak an unrelated INVALID
 * banner/SARIF entry into tests that aren't about control validity. Tests that
 * specifically exercise `summary.valid`/utility/controls override this explicitly.
 */
export function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    seed: "test-seed",
    chains: ["evm", "svm"],
    repeat: 1,
    timeout_s: 60,
    fail_on: "low",
    scenario_filter: null,
    controls_included: false,
    // v3 (ADR-016 #3 config fingerprint): defaults a test doesn't usually care about -
    // "path" host_mode/null driver/no guardrail hooks/no season, matching what U15's CLI
    // actually records before U17-U19 land their own pieces.
    startup_timeout_s: 120,
    host_mode: "path",
    track: "agent",
    driver: null,
    guardrail_hooks: null,
    guardrail_nondeterministic: null,
    harness_commit: "test-commit",
    season: null,
    seed_commitment: null,
    ...overrides,
  };
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
