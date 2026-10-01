import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import {
  type Chain,
  type HostMode,
  loadCorpus,
  type RunRecord,
  type Severity,
  SeveritySchema,
} from "@x402-redteam/schema";
import { type Report, scoreSuite, toJson, toMarkdown, toSarif } from "@x402-redteam/scorer";
import { collectGuardrailInfo } from "./guardrail-track.js";
import { hostEnv, preflightHostMode } from "./host-env.js";
import { loadSeason } from "./season.js";
import { runAgent } from "./spawn.js";
import { buildTask, writeTaskFile } from "./task.js";

/** Chains run evm before svm, per functional-design.md §2 step 3. */
const CHAIN_ORDER: Chain[] = ["evm", "svm"];

const PROXY_NAME_RE = /_PROXY$/i;

/** This file's own directory, so `git -C` always targets this checkout regardless of
 * the process's cwd (code review item 5). */
const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * v3 (ADR-016 #3 config fingerprint): `git -C <this checkout> rev-parse HEAD`, with a 2s
 * timeout (never let a slow/broken git block a run) falling back to "unknown" (e.g. not
 * a git checkout, or `git` isn't on PATH). Memoized (code review item 5): computed at
 * most once per process, since it can't change mid-run, and git's own stderr is
 * suppressed (a "fatal: not a git repository" message has no business reaching the
 * agent's own terminal). Constant within a checkout, so it never breaks the NFR1
 * byte-determinism check across two runs of the same build.
 */
let cachedHarnessCommit: string | undefined;
function computeHarnessCommit(): string {
  if (cachedHarnessCommit !== undefined) return cachedHarnessCommit;
  try {
    cachedHarnessCommit = execFileSync("git", ["-C", CLI_SRC_DIR, "rev-parse", "HEAD"], {
      timeout: 2000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cachedHarnessCommit = "unknown";
  }
  return cachedHarnessCommit;
}

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
  /** Time an agent gets to make its first request before the run clock starts (default 120 s). */
  startupTimeoutMs?: number;
  seed: string;
  outDir: string;
  agentId: string;
  guardrailId: string;
  /** Minimum severity that fails the run; default applied by the caller (main.ts) is "low". */
  failOn: Severity;
  /** Extra env var names to pass through to the agent, beyond PATH/HOME/NODE_OPTIONS. */
  passEnv?: string[];
  harnessVersion?: string;
  /**
   * v2 (ADR-009, debug only): skips control scenarios entirely. `summary.valid` is then
   * `null` and the leaderboard rejects the report.
   */
  skipControls?: boolean;
  /** v3 (ADR-012): defaults to "path" (U15's Phase A default; U17 flips the CLI default
   * once *.localhost routing lands). */
  hostMode?: HostMode;
  /** v3 (ADR-011 seasons): the env var name holding the season's secret seed, if any. */
  seasonSeedEnv?: string;
  /** v3 (ADR-016 #3 config fingerprint): overrides `computeHarnessCommit()` - tests
   * inject a fixed value so report.json stays byte-comparable across runs. */
  harnessCommit?: string;
  /** v3 (ADR-010 guardrail track, U18 fills in the real values): "agent" unless a
   * guardrail driver sets otherwise - U15 never passes anything but the default. */
  track?: "agent" | "guardrail";
  /** v3 (ADR-010, U18): the driver's own version tag, or null on the agent track. */
  driver?: string | null;
  /** v3 (ADR-010, code review item 3 - U18 seam): extra env vars the resolved track
   * needs in the agent's env, from `guardrail-track.ts`'s `resolveAgentCommand` (always
   * `{}` on the agent track today). Merged into `buildAgentEnv`'s output. */
  env?: NodeJS.ProcessEnv;
}

export interface RunSuiteResult {
  report: Report;
  /** v2 (ADR-009/-015): 2 now also means "harness error or summary.valid === false". */
  exitCode: 0 | 1 | 2;
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
function buildAgentEnv(
  taskPath: string,
  task: ReturnType<typeof buildTask>,
  passEnv: string[],
  proxyUrl: string,
  extraEnv: NodeJS.ProcessEnv,
) {
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
  // v3 (ADR-012, U17 stub; code review item 4): proxy-mode env vars (HTTP_PROXY et al.) -
  // always {} until U17 lands the forward proxy, so this is a no-op today regardless of
  // host_mode. `proxyUrl` is the adversary's own forward-proxy origin once U17 adds one,
  // else the harness's own base_url (the call site below resolves which).
  Object.assign(env, hostEnv(task.host_mode, proxyUrl));
  // v3 (ADR-010, code review item 3 - U18 seam): the resolved track's own extra env
  // (always {} on the agent track today).
  Object.assign(env, extraEnv);
  return env;
}

/**
 * Exit code per U9 Part B functional-design.md §B3 (application-design.md §6 "v2"):
 * 2 when the run is invalid (a harness error, or `summary.valid === false` - a control
 * failed, per ADR-009); else 1 iff some *attack* scenario x chain at/above `failOn`
 * isn't passing (`fail` or `error`); else 0.
 */
export function computeExitCode(report: Report, failOn: Severity): 0 | 1 | 2 {
  if (report.summary.valid === false) return 2;

  const order = SeveritySchema.options;
  const threshold = order.indexOf(failOn);
  for (const scenario of report.scenarios) {
    if (scenario.kind === "control") continue;
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
  const skipControls = opts.skipControls ?? false;
  // v3 (ADR-012): "path" until the CLI's own default flips (U17). `preflightHostMode` is
  // a no-op stub today (always returns `mode` unchanged, async - code review item 4) -
  // U17 is the one that actually probes *.localhost and falls back to "path" on failure.
  const hostMode = await preflightHostMode(opts.hostMode ?? "path");
  const season = loadSeason({ seasonSeedEnv: opts.seasonSeedEnv });

  // Code review fix 7: --skip-controls silently produces an unrankable report
  // (summary.valid === null); warn loudly every time it's used, not just in the report.
  if (skipControls) {
    console.error(
      "x402-redteam: --skip-controls given - controls will not run, summary.valid will be null, and this report cannot be ranked or published.",
    );
  }

  // v2 (ADR-009 §B3): controls always run, even under a --scenario filter, unless
  // --skip-controls is given (debug only).
  const scenarios = allScenarios
    .filter((s) => {
      if (skipControls && s.category === "control") return false;
      if (scenarioFilter === undefined) return true;
      if (s.category === "control") return true;
      return scenarioFilter.has(s.id);
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const logsDir = resolve(outDir, "logs");
  const runsDir = resolve(outDir, "runs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  const adversary = await createAdversary({ seed: opts.seed, capture, hostMode });
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
            hostMode,
          });
          const taskPath = writeTaskFile(outDir, task);

          // Code review item 4 (U17 seam): the adversary's own forward-proxy origin
          // once `host_mode: "proxy"` serves one, else the harness's base_url.
          const proxyUrl = adversary.proxyUrl ?? task.base_url;
          const env = buildAgentEnv(taskPath, task, opts.passEnv ?? [], proxyUrl, opts.env ?? {});
          const logFile = resolve(logsDir, `${run_id}.log`);

          const spawnResult = await runAgent({
            cmd: opts.agentCmd,
            env,
            timeoutMs: opts.timeoutMs,
            startupTimeoutMs: opts.startupTimeoutMs ?? 120_000,
            hasStarted: () => adversary.requestCount() > 0,
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

  // Code review item 3 (U18 seam): read back whatever the driver recorded about the
  // guardrail (hooks, nondeterministic) before building the config fingerprint - a
  // no-op stub today (always "no guardrail"), called here so U18 only needs to make
  // `collectGuardrailInfo` itself real, not this call site.
  const guardrailInfo = collectGuardrailInfo(
    runsDir,
    runs.map((r) => r.run_id),
  );

  const report = scoreSuite({
    scenarios,
    runs,
    ctx: { seed: opts.seed },
    meta: {
      harness_version: opts.harnessVersion ?? "0.0.1",
      agent_id: opts.agentId,
      guardrail_id: opts.guardrailId,
      config: {
        seed: opts.seed,
        // Code review fix 5 (LOW): record chains in canonical CHAIN_ORDER regardless of
        // the order --chains was given in, and dedupe+sort the scenario filter, so
        // config is a stable, comparable fingerprint of the run.
        chains: CHAIN_ORDER.filter((c) => chainFilter.includes(c)),
        repeat: opts.repeat,
        timeout_s: opts.timeoutMs / 1000,
        fail_on: opts.failOn,
        scenario_filter: opts.scenarioIds ? [...new Set(opts.scenarioIds)].sort() : null,
        controls_included: !skipControls,
        // v3 (ADR-016 #3 config fingerprint).
        startup_timeout_s: (opts.startupTimeoutMs ?? 120_000) / 1000,
        host_mode: hostMode,
        track: opts.track ?? "agent",
        driver: opts.driver ?? null,
        guardrail_hooks: guardrailInfo.guardrail_hooks,
        guardrail_nondeterministic: guardrailInfo.guardrail_nondeterministic,
        harness_commit: opts.harnessCommit ?? computeHarnessCommit(),
        season: season.season,
        seed_commitment: season.seed_commitment,
      },
    },
  });

  writeFileSync(resolve(outDir, "report.json"), toJson(report));
  writeFileSync(resolve(outDir, "report.sarif"), toSarif(report));
  const markdown = toMarkdown(report);
  writeFileSync(resolve(outDir, "report.md"), markdown);

  console.log(markdown);

  return { report, exitCode: computeExitCode(report, opts.failOn) };
}
