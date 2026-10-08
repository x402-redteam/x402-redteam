import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import {
  type Chain,
  compareCodeUnits,
  type HostMode,
  loadCorpus,
  type RunRecord,
  type Severity,
  SeveritySchema,
} from "@x402-redteam/schema";
import {
  type Report,
  redact,
  scoreSuite,
  toJson,
  toMarkdown,
  toRedactedJson,
  toSarif,
} from "@x402-redteam/scorer";
import {
  collectGuardrailInfo,
  type DriverGdpRecord,
  hasGdpRecord,
  readGdpRecordFromDir,
  readGuardrailErrors,
} from "./guardrail-track.js";
import { hostEnv, preflightHostMode } from "./host-env.js";
import { loadSeason } from "./season.js";
import { runAgent, scrubSecretsFromLog } from "./spawn.js";
import { buildTask, writeTaskFile } from "./task.js";

/** Chains run evm before svm, per functional-design.md §2 step 3. */
const CHAIN_ORDER: Chain[] = ["evm", "svm"];

const PROXY_NAME_RE = /_PROXY$/i;

/** This file's own directory, so `git -C` always targets this checkout regardless of
 * the process's cwd (code review item 5). */
const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The name of the env var a container image can set (via a Docker build arg baked in at
 * image-build time) to tell the harness its own commit, for checkouts where `.git` isn't
 * present to ask (e.g. a ranked/verified-run image, whose `.dockerignore` excludes
 * `.git` on purpose). Also used by `buildAgentEnv` to make sure this value never reaches
 * the agent/guardrail subprocess's own env, however it got set.
 */
export const HARNESS_COMMIT_ENV_NAME = "X402_HARNESS_COMMIT";

/** A full, lowercase-hex 40-character commit SHA - the same format the leaderboard's
 * own allowlist check requires (`packages/leaderboard/src/canonical.ts`'s
 * `HARNESS_COMMIT_FORMAT`). The env value is lowercased before this is tested, so an
 * uppercase-hex value is still accepted and recorded in its canonical, lowercase form. */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * v3 (ADR-016 #3 config fingerprint): resolves the harness's own commit, in order -
 * `X402_HARNESS_COMMIT` when it's set to something that actually looks like a commit SHA
 * (a container image bakes this in at build time, from a build arg, precisely for
 * checkouts with no `.git` to ask); else `git -C <this checkout> rev-parse HEAD`, with a
 * 2s timeout (never let a slow/broken git block a run); else `"unknown"` (neither source
 * produced anything usable - e.g. not a git checkout, `git` isn't on PATH, and no env
 * value was baked in). Memoized: computed at most once per process, since it can't
 * change mid-run, and git's own stderr is suppressed (a "fatal: not a git repository"
 * message has no business reaching the agent's own terminal). Constant within a
 * checkout, so it never breaks the NFR1 byte-determinism check across two runs of the
 * same build.
 */
let cachedHarnessCommit: string | undefined;
function computeHarnessCommit(): string {
  if (cachedHarnessCommit !== undefined) return cachedHarnessCommit;
  const fromEnv = process.env[HARNESS_COMMIT_ENV_NAME]?.toLowerCase();
  if (fromEnv !== undefined && COMMIT_SHA_RE.test(fromEnv)) {
    cachedHarnessCommit = fromEnv;
    return cachedHarnessCommit;
  }
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
  /** Security review HIGH-12: the guardrail-under-test's own `org/repo@sha`, recorded
   * into `config.guardrail_repo_ref` - `null`/omitted outside a ranked/verified run. */
  guardrailRepoRef?: string | null;
  /** v3 (ADR-011, U19): run the agent (or guardrail-track driver) as this uid/gid -
   * Linux, root only. `main.ts` calls `validateAgentUid` and exits 2 before this ever
   * reaches `runSuite`, so a rejected uid never gets here. */
  agentUid?: number;
  /** Security review LOW: defaults to `agentUid` when omitted. */
  agentGid?: number;
  /** v3 (ADR-011, U19): also write `report.redacted.json` (no `runs[]`, violation
   * messages blanked - see `@x402-redteam/scorer`'s `redact`). Implies `quiet`
   * (security review CRITICAL-1): a redacted run must not print anything
   * scenario-revealing to its own stdout either, since a CI log is visible even when
   * only the redacted file is uploaded as an artifact. */
  redact?: boolean;
  /** v3 (ADR-011, U19, security review CRITICAL-1): suppress the full markdown report
   * on stdout, printing only the exit code and a handful of summary numbers (no
   * scenario id/title/description/host/canary ever reaches stdout this way). Always
   * true when `redact` is true, regardless of this flag's own value. `report.md` is
   * still written to disk either way - this only changes what reaches the console. */
  quiet?: boolean;
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
 * requested via `passEnv`), always drops `X402_HARNESS_COMMIT` (even if it was
 * explicitly requested via `passEnv` - the agent/guardrail under test has no business
 * knowing which harness build is grading it), and adds the `X402_*`, `SOLANA_RPC_URL`
 * and `X402_FACILITATOR_URL` variables, plus v2's `X402_EVM_RPC_URL` / `ETH_RPC_URL`.
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
    if (name === HARNESS_COMMIT_ENV_NAME) continue;
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
  // v3 (ADR-012): proxy-mode env vars (HTTP_PROXY et al.) - a no-op ({}) outside
  // `host_mode: "proxy"`. `proxyUrl` is the adversary's own forward-proxy origin in
  // proxy mode, else the harness's own base_url (the call site below resolves which).
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
 * Security review CRITICAL-1: the only thing `--quiet`/`--redact` print to stdout -
 * numbers and booleans only, deliberately hand-picked field by field (never a spread
 * of `report.summary`, so a future summary field can't silently leak through here
 * without a reviewer having to touch this function). No scenario id, title,
 * description, host, canary or violation message is reachable from this output.
 */
function quietSummaryLine(report: Report, exitCode: number): string {
  return JSON.stringify({
    exit_code: exitCode,
    valid: report.summary.valid,
    safety_score: report.summary.safety_score,
    unauthorized_usd: report.summary.unauthorized_usd,
    pass_rate: report.summary.pass_rate,
    reach_rate: report.summary.reach_rate,
    controls: report.summary.controls,
    scenarios: report.summary.scenarios,
    scenarios_passed: report.summary.scenarios_passed,
  });
}

/**
 * Checks every id named in `--scenario` actually matches a scenario the corpus loaded.
 * `scenarioIds === undefined` (no filter given) always passes. Throws naming exactly the
 * ids that matched nothing, sorted and de-duplicated, and nothing else about the corpus -
 * so a typo in a CI job's scenario list fails loudly and specifically instead of quietly
 * running zero attack scenarios. Exported for its own unit test.
 */
export function assertScenarioFilterKnown(
  allScenarios: ReadonlyArray<{ id: string }>,
  scenarioIds: readonly string[] | undefined,
): void {
  if (scenarioIds === undefined) return;
  const knownIds = new Set(allScenarios.map((s) => s.id));
  const unknown = [...new Set(scenarioIds)].filter((id) => !knownIds.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `--scenario: unknown scenario id(s) not found in the loaded corpus: ${unknown.join(", ")}`,
    );
  }
}

/**
 * Orchestrates the full suite run, per functional-design.md §2: boots a fresh adversary
 * per run, drives it sequentially over (scenario, chain, attempt), scores the runs and
 * writes every report artifact. Exported for tests as well as `main.ts`'s `run` command.
 */
export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const allScenarios = loadCorpus(opts.corpus);
  assertScenarioFilterKnown(allScenarios, opts.scenarioIds);
  const scenarioFilter = opts.scenarioIds ? new Set(opts.scenarioIds) : undefined;
  const chainFilter = opts.chains ?? CHAIN_ORDER;
  const skipControls = opts.skipControls ?? false;
  // v3 (ADR-012): this function's own default is "path" - the CLI's `--host-mode` flag
  // defaults to "localhost" (main.ts), so in practice `opts.hostMode` is always given by
  // callers that go through the CLI; direct `runSuite` callers (other units' e2e suites)
  // that omit it get "path" unchanged. `preflightHostMode` probes *.localhost (a real
  // DNS resolve plus a loopback GET) and falls back to "path" on failure.
  const hostMode = await preflightHostMode(opts.hostMode ?? "path");
  const season = loadSeason({ seasonSeedEnv: opts.seasonSeedEnv, corpusDir: opts.corpus });
  // v3 (ADR-011 seasons, U19): the real secret seed is used operationally - wallet and
  // canary derivation, task rendering, run ids - exactly like any other `--seed`. It
  // must never be the *reported* seed though: `config.seed` and the top-level
  // `report.seed` field show `"season:<id>"` instead, so the secret itself never enters
  // report.json, a log line or `task.json` (season.test.ts / the probe in
  // functional-design.md §4 grep an out dir for the literal seed string). Outside a
  // season, both are simply `opts.seed`, so behaviour is byte-identical to before.
  const effectiveSeed = season.seed ?? opts.seed;
  const reportedSeed = season.season !== null ? `season:${season.season}` : opts.seed;

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
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const logsDir = resolve(outDir, "logs");
  const runsDir = resolve(outDir, "runs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  const runs: RunRecord[] = [];
  // U18b item 1 (coordinator revision): one entry per guardrail-track run, in run
  // order, fed to `collectGuardrailInfo` after the loop - each run's own private record
  // directory is deleted right after it's read, so nothing is left on disk to re-scan
  // afterwards (unlike the old `<runsDir>/<run_id>.gdp.json` sidecar scheme).
  const gdpRecords: Array<DriverGdpRecord | undefined> = [];

  for (const scenario of scenarios) {
    for (const chain of CHAIN_ORDER) {
      if (!chainFilter.includes(chain) || !scenario.chains.includes(chain)) continue;

      for (let attempt = 1; attempt <= opts.repeat; attempt++) {
        const run_id = computeRunId(effectiveSeed, scenario.id, chain, attempt);

        // Measurement integrity: one adversary instance, on its own ephemeral port, per
        // run - bound right before this run's agent is spawned and closed right after
        // this run's ledger is drained, never shared with the run before or after it. A
        // process that outlives its own run (e.g. a detached grandchild that escaped the
        // process-group kill below) has nothing left to reach: this run's listener is
        // already gone by the time any later run starts, and it was never told that
        // later run's own, differently-numbered port, so a stray late request can only
        // fail to connect - it can never be recorded into a different run's ledger.
        const adversary = await createAdversary({ seed: effectiveSeed, capture, hostMode });
        try {
          adversary.load({ scenario, chain, run_id });
          const task = buildTask({
            scenario,
            chain,
            baseUrl: adversary.baseUrl,
            seed: effectiveSeed,
            run_id,
            hostMode,
          });
          // Security review HIGH-7: when the spawned process drops to `agentUid`, it
          // needs a writable $HOME of its own - inheriting the harness's own (root,
          // typically /root) would make any tool that writes under $HOME (npm/tsx
          // caches, etc.) fail with EACCES for the unprivileged uid. A fresh per-run
          // directory, `chown`'d to that uid/gid, is removed again right after the run
          // the same way the GDP record dir already is. Created *before* the task file
          // below, since the task file's own chowned location (security review N2)
          // nests under it.
          let agentHomeDir: string | undefined;
          if (opts.agentUid !== undefined) {
            agentHomeDir = mkdtempSync(resolve(tmpdir(), "x402-agent-home-"));
            chownSync(agentHomeDir, opts.agentUid, opts.agentGid ?? opts.agentUid);
          }

          // Security re-review N2: task.json carries the agent's own wallet secret
          // (private key / base58 secret key) and prompt - the dropped-privilege agent
          // must actually be able to read it, so it can never live only under the
          // shared, root-owned `outDir` when `agentUid` is set (the same root-only
          // directory `--redact`'s reports stay under, per security review HIGH-4).
          // `writeTaskFile` creates `<base>/tasks/<run_id>.json` as root regardless of
          // the parent's own ownership, so the new `tasks` subdir and the file itself
          // are explicitly `chown`'d right after - nested under `agentHomeDir`, so both
          // are cleaned up together after the run.
          const taskPath = writeTaskFile(agentHomeDir ?? outDir, task);
          if (agentHomeDir !== undefined && opts.agentUid !== undefined) {
            chownSync(
              resolve(agentHomeDir, "tasks"),
              opts.agentUid,
              opts.agentGid ?? opts.agentUid,
            );
            chownSync(taskPath, opts.agentUid, opts.agentGid ?? opts.agentUid);
          }

          // Code review item 4 (U17 seam): the adversary's own forward-proxy origin
          // once `host_mode: "proxy"` serves one, else the harness's base_url.
          const proxyUrl = adversary.proxyUrl ?? task.base_url;
          const env = buildAgentEnv(taskPath, task, opts.passEnv ?? [], proxyUrl, opts.env ?? {});
          const logFile = resolve(logsDir, `${run_id}.log`);
          const isGuardrailTrack = (opts.track ?? "agent") === "guardrail";

          if (agentHomeDir !== undefined) {
            env.HOME = agentHomeDir;
          }

          // U18b item 1 (coordinator revision): a fresh, private per-run directory for
          // the driver's GDP record - `mkdtemp` makes a brand-new, uniquely-named
          // directory every time, so there is no "stale leftover from an earlier spawn"
          // to delete first (unlike the old `<runsDir>/<run_id>.gdp.json` sidecar, keyed
          // by a run id that repeats across invocations of the same `--out`). Named to
          // the driver only via this `X402_`-prefixed env var, which `scrubGuardrailEnv`
          // (packages/driver/src/main.ts) strips before the guardrail subprocess ever
          // sees its env - the guardrail cannot locate, read or race this directory
          // through its env, and its cwd is left alone (the driver's own, typically the
          // harness caller's), so a guardrail command written with a relative path
          // (e.g. `tsx examples/guardrails/x.ts`, this repo's own convention) still
          // works.
          //
          // Security review HIGH-7: when `agentUid` is set, the *driver itself* runs
          // under that dropped uid (it's the process `runAgent` spawns in the
          // guardrail-track - see `guardrail-track.ts`'s `resolveAgentCommand`), so it
          // needs write access to this directory too, or it can never write `gdp.json`
          // in the first place. `chown` it right after creating it, same as the HOME
          // dir above.
          if (isGuardrailTrack) {
            const recordDir = mkdtempSync(resolve(tmpdir(), "x402-gdp-"));
            if (opts.agentUid !== undefined) {
              chownSync(recordDir, opts.agentUid, opts.agentGid ?? opts.agentUid);
            }
            env.X402_GDP_RECORD_DIR = recordDir;
          }

          const spawnResult = await runAgent({
            cmd: opts.agentCmd,
            env,
            timeoutMs: opts.timeoutMs,
            startupTimeoutMs: opts.startupTimeoutMs ?? 120_000,
            hasStarted: () => adversary.requestCount() > 0,
            logFile,
            // v3 (ADR-011, U19): main.ts already rejected (exit 2) a uid that
            // `validateAgentUid` doesn't accept, so any value here is safe to use.
            agentUid: opts.agentUid,
            agentGid: opts.agentGid,
          });

          // U22 code review round 2 (item 3): best-effort scrub of this run's own
          // `--pass-env` secret values out of its log file, now that `runAgent` has
          // resolved (the log stream is already flushed and closed) - an agent that
          // echoes its own env must not leave a pass-env secret's literal value sitting
          // in `out/logs/*.log`, which the Action uploads as a build artifact by
          // default. `env[name]` (not `process.env[name]`) is the value actually
          // forwarded to this run's subprocess, through the same `names` allowlist
          // `buildAgentEnv` used above.
          scrubSecretsFromLog(
            logFile,
            (opts.passEnv ?? []).flatMap((name) => {
              const value = env[name];
              return typeof value === "string" ? [value] : [];
            }),
          );
          // Security review HIGH-7: the HOME dir's only purpose was this one run.
          if (agentHomeDir !== undefined) {
            rmSync(agentHomeDir, { recursive: true, force: true });
          }

          const drained = adversary.drain();

          // Code review finding 5 (BLOCK, U18): a guardrail-track run that exited 0 but
          // left no record is an integrity failure (the driver crashed or was killed
          // after reporting success, or some other bug), not a quiet pass - force a
          // non-zero exit code so scoring treats it as `error`, the same as any other
          // agent failure. Finding 4: copy the driver's own per-run error count
          // (timeouts, malformed lines, invalid decisions, mid-run exits) onto the
          // record so a broken guardrail stays visible even when it happens to still
          // score "safely" (every denied payment both from a real policy and from GDP
          // protocol noise looks identical to the scorer otherwise).
          //
          // U18b item 1: the record is trusted only when the *driver's own, unmodified*
          // exit code (`spawnResult.exit_code`, before the `exit_code` override below)
          // is 0 - a non-zero exit means the driver itself reported failure, so whatever
          // it may have left behind isn't trustworthy either. `readGdpRecordFromDir` is
          // simply never called in that case - a non-zero exit already makes this run
          // `error` on its own (via `agent_ok`/`RunScore.status`), and `guardrail_errors`
          // stays `undefined`, never a possibly-stale number.
          let exit_code = spawnResult.exit_code;
          let guardrail_errors: number | undefined;
          if (isGuardrailTrack) {
            const recordDir = env.X402_GDP_RECORD_DIR as string;
            const driverExitedCleanly = spawnResult.exit_code === 0;
            const record = driverExitedCleanly ? readGdpRecordFromDir(recordDir) : undefined;
            if (driverExitedCleanly && !hasGdpRecord(record)) {
              console.error(
                `x402-redteam: guardrail track run ${run_id} exited 0 but left no GDP record - treating as a harness error, not a pass.`,
              );
              exit_code = 1;
            }
            guardrail_errors = readGuardrailErrors(record);
            gdpRecords.push(record);
            // The harness's own audit copy (U18b item 1): kept for a human to inspect
            // under `out/runs/`, never read back - `record` itself (in memory) is what
            // feeds `guardrail_errors` above and `collectGuardrailInfo` after the loop.
            if (record !== undefined) {
              writeFileSync(
                resolve(runsDir, `${run_id}.gdp.json`),
                `${JSON.stringify(record, null, 2)}\n`,
              );
            }
            rmSync(recordDir, { recursive: true, force: true });
          }

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
            exit_code,
            timed_out: spawnResult.timed_out,
            ...(guardrail_errors !== undefined ? { guardrail_errors } : {}),
            timing: { duration_ms: spawnResult.duration_ms },
          };
          runs.push(runRecord);
          writeFileSync(
            resolve(runsDir, `${run_id}.json`),
            `${JSON.stringify(runRecord, null, 2)}\n`,
          );
        } finally {
          await adversary.close();
        }
      }
    }
  }

  // Code review item 3 / finding 5 (U18 seam): aggregate whatever the driver recorded
  // about the guardrail (hooks, nondeterministic) before building the config
  // fingerprint - only on the guardrail track, since the agent track never runs the
  // driver and so `gdpRecords` is always empty there. U18b item 1 (coordinator
  // revision): aggregates the in-memory `gdpRecords` collected during the loop above,
  // not a re-scan of `runsDir` - each run's private record directory is already deleted
  // by now.
  const guardrailInfo =
    (opts.track ?? "agent") === "guardrail"
      ? collectGuardrailInfo(gdpRecords)
      : { guardrail_hooks: null, guardrail_nondeterministic: null };

  const report = scoreSuite({
    scenarios,
    runs,
    // v3 (ADR-011 seasons, U19): `ctx.seed` must be the real *operational* seed
    // (`effectiveSeed`) - scoring re-derives the same canary addresses the run itself
    // rendered with, and a mismatched seed here would silently break every
    // canary-based violation check. `scoreSuite` also copies `ctx.seed` verbatim into
    // the top-level `report.seed` field, so that field is overwritten below (before
    // `report.json` is ever written) with `reportedSeed` - the one place the real
    // secret would otherwise leak into a committed artifact.
    ctx: { seed: effectiveSeed },
    meta: {
      harness_version: opts.harnessVersion ?? "0.0.1",
      agent_id: opts.agentId,
      guardrail_id: opts.guardrailId,
      config: {
        // v3 (ADR-011 seasons, U19): "season:<id>" outside a season this is simply
        // `opts.seed` (reportedSeed === opts.seed when no season is active) - never the
        // real secret.
        seed: reportedSeed,
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
        guardrail_repo_ref: opts.guardrailRepoRef ?? null,
      },
    },
  });

  // v3 (ADR-011 seasons, U19): overwrite the top-level `seed` field `scoreSuite` set
  // from `ctx.seed` (the real operational seed, required for correct scoring - see the
  // comment above) with the same `reportedSeed` already used for `config.seed`, so the
  // real secret never reaches a written file. A no-op outside a season.
  const reportToWrite: Report = { ...report, seed: reportedSeed };

  writeFileSync(resolve(outDir, "report.json"), toJson(reportToWrite));
  writeFileSync(resolve(outDir, "report.sarif"), toSarif(reportToWrite));
  const markdown = toMarkdown(reportToWrite);
  writeFileSync(resolve(outDir, "report.md"), markdown);

  // v3 (ADR-011, U19): `--redact` writes `report.redacted.json` alongside the full
  // report - the only artifact a Tier 1 ranked run publishes (no `runs[]`, no violation
  // messages). Built from `reportToWrite`, so it inherits the same seed override.
  if (opts.redact === true) {
    writeFileSync(resolve(outDir, "report.redacted.json"), toRedactedJson(redact(reportToWrite)));
  }

  const exitCode = computeExitCode(reportToWrite, opts.failOn);

  // Security review CRITICAL-1: `--redact` implies `quiet` regardless of the flag's own
  // value - the full markdown (every scenario id/title/description/host/canary) must
  // never reach stdout on a run whose whole point is that nothing but the redacted
  // summary leaves the container. `report.md` on disk is unaffected either way.
  if (opts.quiet === true || opts.redact === true) {
    console.log(quietSummaryLine(reportToWrite, exitCode));
  } else {
    console.log(markdown);
  }

  return { report: reportToWrite, exitCode };
}
