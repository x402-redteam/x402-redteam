import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Resolves an `sh -c`-safe command that runs one of the example agent scripts under tsx,
 * without relying on PATH containing `tsx` inside the harness's clean agent env. */
export function agentCmd(script: "naive" | "guarded"): string {
  const tsxCli = require.resolve("tsx/cli");
  const scriptPath = fileURLToPath(
    new URL(`../../../../examples/agents/src/${script}.ts`, import.meta.url),
  );
  return `"${process.execPath}" "${tsxCli}" "${scriptPath}"`;
}
