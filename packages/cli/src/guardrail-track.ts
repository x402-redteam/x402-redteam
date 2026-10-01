/**
 * ADR-010 Guardrail Decision Protocol v1 wiring, U18: `--guardrail "<cmd>"` runs
 * `packages/driver`'s standard driver as the agent, with the guardrail command passed
 * through as `X402_GUARDRAIL_CMD` - the driver spawns it itself and speaks GDP over its
 * stdio (functional-design.md §2/§3).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/driver`'s own version tag (functional-design.md §3: "any behaviour change
 * bumps to driver@2"). Kept here (not imported from `@x402-redteam/driver`) so this
 * package's dependency on the driver stays at the shell-command level only, same as the
 * agent track never imports an agent's own source. */
const DRIVER_VERSION = "driver@1";

/** This file's own directory, so the driver bin is found regardless of the process's
 * cwd - mirrors `run.ts`'s `CLI_SRC_DIR` convention. */
const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DRIVER_BIN = resolve(CLI_SRC_DIR, "..", "..", "driver", "bin", "x402-redteam-driver.mjs");

const VALID_HOOKS = new Set(["payment", "transfer", "sign"]);

export interface ResolveAgentCommandOptions {
  agent?: string;
  guardrail?: string;
}

/**
 * Code review item 3 (U18 seam): everything `run.ts` needs to spawn and record one
 * track, agent or guardrail, so `main.ts` can spread this straight into `RunSuiteOptions`
 * without the two call sites (CLI flags in, `runSuite` options out) drifting as U18 adds
 * real fields.
 */
export interface ResolvedAgentCommand {
  /** The `sh -c` command `runSuite` spawns per run. */
  agentCmd: string;
  /** Extra env vars the resolved track needs in the spawned process's env, beyond what
   * `run.ts`'s own `buildAgentEnv` already sets. On the guardrail track this is
   * `{X402_GUARDRAIL_CMD: opts.guardrail}` - the driver reads its own task.json from
   * `X402_REDTEAM_TASK`, the same env var every agent uses. */
  env: NodeJS.ProcessEnv;
  /** `RunConfig.track`. */
  track: "agent" | "guardrail";
  /** `RunConfig.driver` - the driver's own version tag (e.g. "driver@1"), or null on the
   * agent track. */
  driver: string | null;
}

/**
 * Resolves the shell command, env and track/driver `runSuite` should use for one run. On
 * the agent track (`--agent`, no `--guardrail`) this is simply `opts.agent` with no extra
 * env and `track: "agent"`/`driver: null`. On the guardrail track (`--guardrail`), the
 * agent command becomes `node <driver bin>` and the guardrail command is forwarded via
 * `X402_GUARDRAIL_CMD`. `main.ts` is responsible for rejecting `--agent` and
 * `--guardrail` together before this is ever called with both set.
 */
export function resolveAgentCommand(opts: ResolveAgentCommandOptions): ResolvedAgentCommand {
  if (opts.guardrail !== undefined) {
    return {
      agentCmd: `node "${DRIVER_BIN}"`,
      env: { X402_GUARDRAIL_CMD: opts.guardrail },
      track: "guardrail",
      driver: DRIVER_VERSION,
    };
  }
  if (opts.agent === undefined) {
    throw new Error("one of --agent or --guardrail is required");
  }
  return { agentCmd: opts.agent, env: {}, track: "agent", driver: null };
}

/** `RunConfig`'s guardrail-declared fields (`guardrail_hooks`, `guardrail_nondeterministic`). */
export interface GuardrailInfo {
  guardrail_hooks: string[] | null;
  guardrail_nondeterministic: boolean | null;
}

/** The driver's own per-run record, written to `<runsDir>/<run_id>.gdp.json`
 * (`packages/driver/src/main.ts`) exactly once, at the end of that run, after
 * `<run_id>.gdp.json` was deleted (if present) before the driver was even spawned - so
 * its mere existence means *this run's* driver got through `hello` and ran to
 * completion (code review findings 4/5). */
interface DriverGdpRecord {
  hooks?: unknown;
  nondeterministic?: unknown;
  guardrail_errors?: unknown;
}

function readGdpRecord(runsDir: string, runId: string): DriverGdpRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(resolve(runsDir, `${runId}.gdp.json`), "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as DriverGdpRecord;
  } catch {
    return undefined;
  }
}

function normalizeHooks(hooks: unknown): string[] | undefined {
  if (!Array.isArray(hooks) || hooks.length === 0) return undefined;
  const result: string[] = [];
  for (const h of hooks) {
    if (typeof h !== "string" || !VALID_HOOKS.has(h)) return undefined;
    result.push(h);
  }
  return result;
}

function hooksEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Code review finding 5 (BLOCK): run.ts calls this only on the guardrail track (the
 * agent track never has `*.gdp.json` files to read, but the gate is explicit rather than
 * incidental). Aggregates every run's record rather than trusting the first one found:
 * - `guardrail_nondeterministic` is the boolean OR across every run that reported one -
 *   a guardrail that *ever* declares itself nondeterministic is nondeterministic, full
 *   stop - and a concrete `true`/`false` (never `null`) whenever at least one run has a
 *   record at all, which is what U16's leaderboard checks require on the guardrail
 *   track.
 * - if different runs' `hooks` arrays disagree (sorted-set inequality - order doesn't
 *   matter), this guardrail isn't being consistent about what it implements, and the
 *   config fingerprint can't give one honest answer: `guardrail_hooks` is reported
 *   `null`, which fails U16's "non-empty subset" canonical-config check and so the
 *   report is rejected rather than silently ranked on whichever run happened to be read
 *   first.
 */
export function collectGuardrailInfo(runsDir: string, runIds: string[]): GuardrailInfo {
  let hooks: string[] | undefined;
  let hooksDisagree = false;
  let anyNondeterministic = false;
  let sawAnyRecord = false;

  for (const runId of runIds) {
    const record = readGdpRecord(runsDir, runId);
    if (!record) continue;
    sawAnyRecord = true;

    const recordHooks = normalizeHooks(record.hooks);
    if (recordHooks) {
      if (hooks === undefined) {
        hooks = recordHooks;
      } else if (!hooksEqual(hooks, recordHooks)) {
        hooksDisagree = true;
      }
    }
    if (record.nondeterministic === true) anyNondeterministic = true;
  }

  if (!sawAnyRecord) {
    return { guardrail_hooks: null, guardrail_nondeterministic: null };
  }
  if (hooksDisagree) {
    console.error(
      "x402-redteam: this guardrail's declared hooks disagreed across runs in this suite - " +
        "config.guardrail_hooks is null, and this report cannot be accepted as a canonical " +
        "guardrail-track entry.",
    );
    return { guardrail_hooks: null, guardrail_nondeterministic: anyNondeterministic };
  }
  return { guardrail_hooks: hooks ?? null, guardrail_nondeterministic: anyNondeterministic };
}

/** Code review finding 4 (BLOCK): per-run count of GDP protocol errors (timeouts,
 * malformed lines, invalid decisions, the guardrail exiting mid-run) the driver recorded
 * for `runId`, for `run.ts` to copy into that run's `RunRecord.guardrail_errors`. `0`
 * when the run has no record at all (the agent track, or a run whose driver crashed
 * before ever writing one - `hasGdpRecord` is the signal for that case; this function
 * alone can't distinguish "no errors" from "no record"). */
export function readGuardrailErrors(runsDir: string, runId: string): number {
  const n = readGdpRecord(runsDir, runId)?.guardrail_errors;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * Code review finding 5 (BLOCK): whether the driver wrote a (parseable) `*.gdp.json`
 * record for `runId` at all. `run.ts` deletes this file before spawning the driver for
 * `runId` and checks this afterwards - a guardrail-track run with no record, despite the
 * driver process exiting 0, means the driver crashed or was killed after its own
 * `main().catch` handler had already run (or some other integrity failure) without that
 * showing up as a non-zero exit code; such a run must not be scored as a quiet pass.
 */
export function hasGdpRecord(runsDir: string, runId: string): boolean {
  return readGdpRecord(runsDir, runId) !== undefined;
}
