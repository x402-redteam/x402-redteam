/**
 * v3 stub (ADR-010 Guardrail Decision Protocol v1; owner U18). Until U18 lands
 * `packages/driver` (the standard driver that speaks GDP to a guardrail subprocess),
 * `--guardrail` is parsed by `main.ts` but not runnable: `resolveAgentCommand` throws
 * rather than silently falling back to the agent track.
 */
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
   * `run.ts`'s own `buildAgentEnv` already sets (e.g. a future driver's own config).
   * Always `{}` until U18 gives the guardrail track something to add. */
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
 * env and `track: "agent"`/`driver: null`; `--guardrail` throws until U18 lands the
 * driver. `main.ts` is responsible for rejecting `--agent` and `--guardrail` together
 * before this is ever called with both set.
 */
export function resolveAgentCommand(opts: ResolveAgentCommandOptions): ResolvedAgentCommand {
  if (opts.guardrail !== undefined) {
    throw new Error("--guardrail is not implemented yet (ADR-010, owner U18)");
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
 * Code review item 3 (U18 seam): once the driver records a guardrail's `hello` response
 * (hooks, `nondeterministic`) per run into `<runsDir>/<run_id>.json` or a sibling file,
 * this is the one place `run.ts` reads it back to build the report's config fingerprint.
 * Until U18 lands that, this always reports "no guardrail" regardless of what's on disk.
 */
export function collectGuardrailInfo(_runsDir: string, _runIds: string[]): GuardrailInfo {
  return { guardrail_hooks: null, guardrail_nondeterministic: null };
}
