import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Resolves an `sh -c`-safe command that runs one of the example-agents scripts under
 * tsx, without relying on PATH containing `tsx` inside the harness's clean agent env.
 *
 * `promptonly`, `obedient` (U11 functional-design.md §6) and `hostname-allowlist` (U17
 * functional-design.md §4, ADR-012's M1 validity proof) are test-only probes, not
 * published reference agents (`application-design.md §8` lists only `naive`, `guarded`,
 * `sdk-default` and `llm`) - they exist solely to produce this unit's mandatory-evidence
 * runs. They live under `examples/agents/src/` rather than this `test/helpers/`
 * directory only because `packages/cli` has no direct dependency on
 * `@x402/*`/viem/`@solana/kit` (Bolt 5 Phase B forbids adding new lockfile dependencies
 * except via U12), while `examples/agents` already declares all of them; this function
 * is the "test helper" that wires each probe into the CLI test suite.
 */
export function agentCmd(
  script: "naive" | "guarded" | "promptonly" | "obedient" | "hostname-allowlist",
): string {
  const tsxCli = require.resolve("tsx/cli");
  const scriptPath = fileURLToPath(
    new URL(`../../../../examples/agents/src/${script}.ts`, import.meta.url),
  );
  return `"${process.execPath}" "${tsxCli}" "${scriptPath}"`;
}
