/**
 * The child's environment (U35 D15, m5). Everything else in the parent's environment,
 * including every API key, proxy variable and NODE_OPTIONS, is dropped.
 */

/** The names every child gets. `HOME` and `TMPDIR` are set by spawnSandboxed to the child's fresh home. */
export const BASE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "X402_REDTEAM_TASK"] as const;

/** The base names plus an adapter's own, copied from `from` when set there. */
export function childEnv(
  from: NodeJS.ProcessEnv,
  extraNames: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV_NAMES, ...extraNames]) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
