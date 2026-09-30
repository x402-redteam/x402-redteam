import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import {
  type Chain,
  loadCorpus,
  type RunRecord,
  type Severity,
  SeveritySchema,
} from "@x402-redteam/schema";
import { type Report, scoreSuite, toJson, toMarkdown, toSarif } from "@x402-redteam/scorer";
import { runAgent } from "./spawn.js";
import { buildTask, writeTaskFile } from "./task.js";

/** Chains run evm before svm, per functional-design.md §2 step 3. */
const CHAIN_ORDER: Chain[] = ["evm", "svm"];

const PROXY_NAME_RE = /_PROXY$/i;

export interface RunSuiteOptions {
  /** The `sh -c` command that starts the agent under test. */
  agentCmd: string;
  corpus: string;
  /** Defaults to both chains. */
  chains?: Chain[];
  /** Defaults to every scenario in the corpus. */
  scenarioIds?: string[];
  repeat: number;
  timeoutMs: number;
  seed: string;
  outDir: string;
  agentId: string;
  guardrailId: string;
  /** Minimum severity that fails the run; default applied by the caller (main.ts) is "low". */
  failOn: Severity;
  /** Extra env var names to pass through to the agent, beyond PATH/HOME/NODE_OPTIONS. */
  passEnv?: string[];
  harnessVersion?: string;
}

export interface RunSuiteResult {
  report: Report;
  exitCode: 0 | 1;
}

function computeRunId(seed: string, scenarioId: string, chain: Chain, attempt: number): string {
  return createHash("sha256")
    .update(`${seed}:${scenarioId}:${chain}:${attempt}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * A clean env for the agent subprocess, per application-design.md §6 (v1) and §6 "v2":
 * inherits PATH/HOME/NODE_OPTIONS and any `passEnv` names from the harness's own
 * environment, always drops anything ending in `_PROXY` (even if it was explicitly
 * requested via `passEnv`), and adds the `X402_*`, `SOLANA_RPC_URL` and
 * `X402_FACILITATOR_URL` variables, plus v2's `X402_EVM_RPC_URL` / `ETH_RPC_URL`.
 */
function buildAgentEnv(taskPath: string, task: ReturnType<typeof buildTask>, passEnv: string[]) {
  const names = new Set(["PATH", "HOME", "NODE_OPTIONS", ...passEnv]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (PROXY_NAME_RE.test(name)) continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.X402_REDTEAM_TASK = taskPath;
  env.X402_REDTEAM_BASE_URL = task.base_url;
  env.X402_REDTEAM_CHAIN = task.chain;
  env.X402_FACILITATOR_URL = task.facilitator_url;
  env.SOLANA_RPC_URL = task.solana_rpc_url;
  env.X402_EVM_RPC_URL = task.evm_rpc_url;
  env.ETH_RPC_URL = task.evm_rpc_url;
  return env;
}

/** Exit code per functional-design.md §2 step 6: 1 iff some scenario x chain at/above `failOn` failed. */
export function computeExitCode(report: Report, failOn: Severity): 0 | 1 {
  const order = SeveritySchema.options;
  const threshold = order.indexOf(failOn);
  for (const scenario of report.scenarios) {
    if (order.indexOf(scenario.severity) < threshold) continue;
    if (scenario.results.some((r) => !r.pass)) return 1;
  }
  return 0;
}

/**
 * Orchestrates the full suite run, per functional-design.md §2: boots one
 * adversary, drives it sequentially over (scenario, chain, attempt), scores
 * the runs and writes every report artifact. Exported for tests as well as
 * `main.ts`'s `run` command.
 */
export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const allScenarios = loadCorpus(opts.corpus);
  const scenarioFilter = opts.scenarioIds ? new Set(opts.scenarioIds) : undefined;
  const chainFilter = opts.chains ?? CHAIN_ORDER;

  const scenarios = allScenarios
    .filter((s) => scenarioFilter === undefined || scenarioFilter.has(s.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const logsDir = resolve(outDir, "logs");
  const runsDir = resolve(outDir, "runs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  const adversary = await createAdversary({ seed: opts.seed, capture });
  const runs: RunRecord[] = [];

  try {
    for (const scenario of scenarios) {
      for (const chain of CHAIN_ORDER) {
        if (!chainFilter.includes(chain) || !scenario.chains.includes(chain)) continue;

        for (let attempt = 1; attempt <= opts.repeat; attempt++) {
          const run_id = computeRunId(opts.seed, scenario.id, chain, attempt);

          adversary.load({ scenario, chain, run_id });
          const task = buildTask({
            scenario,
            chain,
            baseUrl: adversary.baseUrl,
            seed: opts.seed,
            run_id,
          });
          const taskPath = writeTaskFile(outDir, task);

          const env = buildAgentEnv(taskPath, task, opts.passEnv ?? []);
          const logFile = resolve(logsDir, `${run_id}.log`);

          const spawnResult = await runAgent({
            cmd: opts.agentCmd,
            env,
            timeoutMs: opts.timeoutMs,
            logFile,
          });

          const drained = adversary.drain();

          const runRecord: RunRecord = {
            run_id,
            scenario_id: scenario.id,
            chain,
            attempt,
            agent_id: opts.agentId,
            guardrail_id: opts.guardrailId,
            requests: drained.requests,
            challenges: drained.challenges,
            payments: drained.payments,
            delivered: drained.delivered,
            exit_code: spawnResult.exit_code,
            timed_out: spawnResult.timed_out,
            timing: { duration_ms: spawnResult.duration_ms },
          };
          runs.push(runRecord);
          writeFileSync(
            resolve(runsDir, `${run_id}.json`),
            `${JSON.stringify(runRecord, null, 2)}\n`,
          );
        }
      }
    }
  } finally {
    await adversary.close();
  }

  const report = scoreSuite({
    scenarios,
    runs,
    ctx: { seed: opts.seed },
    meta: {
      harness_version: opts.harnessVersion ?? "0.0.1",
      agent_id: opts.agentId,
      guardrail_id: opts.guardrailId,
    },
  });

  writeFileSync(resolve(outDir, "report.json"), toJson(report));
  writeFileSync(resolve(outDir, "report.sarif"), toSarif(report));
  const markdown = toMarkdown(report);
  writeFileSync(resolve(outDir, "report.md"), markdown);

  console.log(markdown);

  return { report, exitCode: computeExitCode(report, opts.failOn) };
}
