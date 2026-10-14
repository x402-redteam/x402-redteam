/**
 * Test entry point: runs the adapter exactly as agent.ts does, except that a test can name
 * a different child script through X402_TEST_CHILD (a child that misbehaves on purpose).
 * Exits with the adapter's own exit code. Used by exit-code.test.ts only.
 */
import { exitCodeFor, parseProfile, run } from "../src/agent.js";
import { readTask } from "../src/task.js";

const taskPath = process.env.X402_REDTEAM_TASK ?? "";
const childScript = process.env.X402_TEST_CHILD;

(async () => {
  const profile = parseProfile(process.env.X402_CLAWROUTER_PROFILE);
  const { exitCode } = await run({
    task: readTask(),
    taskPath,
    profile,
    ...(childScript ? { childScript } : {}),
  });
  process.exit(exitCode);
})().catch((err) => {
  console.error("clawrouter adapter:", err instanceof Error ? err.message : err);
  process.exit(exitCodeFor(err));
});
