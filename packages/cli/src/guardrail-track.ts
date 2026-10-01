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

/**
 * The driver's own per-run record.
 *
 * U18b item 1 (coordinator revision): written to a private, per-run temp directory
 * (`X402_GDP_RECORD_DIR`, `mkdtemp`'d by `run.ts` before spawning and deleted by it
 * right after reading this record back) rather than the shared `out/runs/` tree keyed
 * by run id - a fresh directory per run has no "stale leftover from a previous spawn"
 * to worry about, and the guardrail subprocess never learns this directory's path at
 * all (the env var naming it is `X402_`-prefixed, so `scrubGuardrailEnv` strips it
 * before the guardrail ever sees its env) - so cwd no longer needs to be isolated for a
 * guardrail command to keep its relative paths working. `run.ts` reads this record
 * exactly once per run, immediately after that run's spawn returns, and passes the
 * in-memory result (or `undefined`) to `collectGuardrailInfo`/`readGuardrailErrors`
 * below rather than re-reading anything from disk afterwards.
 */
export interface DriverGdpRecord {
  hooks?: unknown;
  nondeterministic?: unknown;
  guardrail_errors?: unknown;
}

/** Reads and parses the driver's record at `<dir>/gdp.json`. `undefined` when the file
 * is missing or not valid JSON (e.g. the driver crashed before ever writing it, or
 * wrote a partial file it never got to complete - `run.ts` additionally never trusts
 * this unless the driver's own exit code was 0, see `run.ts`). */
export function readGdpRecordFromDir(dir: string): DriverGdpRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(resolve(dir, "gdp.json"), "utf8");
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
 * agent track never has any records to pass in). Aggregates every run's record rather
 * than trusting the first one found:
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
 *
 * U18b item 1 (coordinator revision): takes the records themselves (one per run, in
 * run order, `undefined` for a run whose record wasn't trusted) rather than a
 * `runsDir`/`runIds` pair to re-read from disk - each run's private record directory is
 * already gone (`run.ts` deletes it right after reading) by the time this runs, since it
 * aggregates across the whole suite at the end.
 */
export function collectGuardrailInfo(records: Array<DriverGdpRecord | undefined>): GuardrailInfo {
  let hooks: string[] | undefined;
  let hooksDisagree = false;
  let anyNondeterministic = false;
  let sawAnyRecord = false;

  for (const record of records) {
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

/**
 * Code review finding 4 (BLOCK): per-run count of GDP protocol errors (timeouts,
 * malformed lines, invalid decisions, the guardrail exiting mid-run) the driver recorded,
 * for `run.ts` to copy into that run's `RunRecord.guardrail_errors`.
 *
 * U18b item 2 (fix): `undefined` - never `0` - when there is no record at all (the
 * agent track, or a guardrail-track run whose driver crashed or whose `hello` failed
 * before ever writing one). `0` is a specific, meaningful claim - "the guardrail
 * answered every request cleanly" - and reporting it for a run the driver never
 * finished would say something false; `undefined` (which `run.ts` then omits from the
 * `RunRecord` entirely) correctly says "unknown", distinct from both "0 errors" and the
 * agent track's "not applicable" (`null`, `summary.guardrail_errors`'s own encoding).
 *
 * U18b item 1 (coordinator revision): takes the already-read `record` directly (the
 * caller read it from the private per-run directory before this is called), not a
 * `runsDir`/`runId` pair.
 */
export function readGuardrailErrors(record: DriverGdpRecord | undefined): number | undefined {
  if (!record) return undefined;
  const n = record.guardrail_errors;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

/**
 * Code review finding 5 (BLOCK): whether the driver wrote a (parseable) record at all.
 * A guardrail-track run with no record, despite the driver process exiting 0, means the
 * driver crashed or was killed after its own `main().catch` handler had already run (or
 * some other integrity failure) without that showing up as a non-zero exit code; such a
 * run must not be scored as a quiet pass.
 *
 * U18b item 1 (coordinator revision): takes the already-read `record` directly, not a
 * `runsDir`/`runId` pair to re-read from disk.
 */
export function hasGdpRecord(record: DriverGdpRecord | undefined): boolean {
  return record !== undefined;
}
