/**
 * Test entry point: runs the adapter exactly as agent.ts does, except that a test can name
 * a different child script through X402_TEST_CHILD (a child that misbehaves on purpose).
 * Exits with the adapter's own exit code. Used by exit-code.test.ts only.
 */
import { exitCodeFor, parseProfile, run } from "../src/agent.js";
import { readTask } from "../src/task.js";
import { readPins } from "../src/versions.js";

const taskPath = process.env.X402_REDTEAM_TASK ?? "";
const childScript = process.env.X402_TEST_CHILD;
const pinCore = process.env.X402_TEST_PIN_CORE;

(async () => {
  const profile = parseProfile(process.env.X402_CLOUDFLARE_PROFILE);
  const { exitCode } = await run({
    task: readTask(),
    taskPath,
    profile,
    ...(childScript ? { childScript } : {}),
    ...(pinCore ? { pins: { ...readPins(), core: pinCore } } : {}),
  });
  process.exit(exitCode);
})().catch((err) => {
  console.error("cloudflare adapter:", err instanceof Error ? err.message : err);
  process.exit(exitCodeFor(err));
});
