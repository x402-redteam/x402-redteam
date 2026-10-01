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

/** The driver's own `hello`-response record, written to `<runsDir>/<run_id>.gdp.json`
 * (`packages/driver/src/main.ts`). */
interface DriverGdpRecord {
  hooks?: unknown;
  nondeterministic?: unknown;
}

/**
 * Code review item 3 (U18 seam): reads back whatever the driver recorded about the
 * guardrail (hooks, `nondeterministic`) for this suite's runs, to build the report's
 * config fingerprint. On the agent track (no `*.gdp.json` files on disk, since no driver
 * ran) this reports "no guardrail", same as before U18. When several runs' records
 * disagree (a nondeterministic guardrail could in principle report different hooks
 * across runs, though none of the example guardrails do), the first run's record wins -
 * the config fingerprint is necessarily a single value, not per-run.
 */
export function collectGuardrailInfo(runsDir: string, runIds: string[]): GuardrailInfo {
  for (const runId of runIds) {
    let raw: string;
    try {
      raw = readFileSync(resolve(runsDir, `${runId}.gdp.json`), "utf8");
    } catch {
      continue;
    }
    let parsed: DriverGdpRecord;
    try {
      parsed = JSON.parse(raw) as DriverGdpRecord;
    } catch {
      continue;
    }
    const hooks = Array.isArray(parsed.hooks)
      ? parsed.hooks.filter((h): h is string => typeof h === "string")
      : null;
    const nondeterministic =
      typeof parsed.nondeterministic === "boolean" ? parsed.nondeterministic : null;
    return { guardrail_hooks: hooks, guardrail_nondeterministic: nondeterministic };
  }
  return { guardrail_hooks: null, guardrail_nondeterministic: null };
}
