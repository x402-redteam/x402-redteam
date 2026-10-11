/**
 * Test entry point: runs the adapter exactly as agent.ts does, except that action names
 * can be overridden through X402_TEST_ACTIONS (JSON), and exits with the adapter's own
 * exit code. Used by exit-code.test.ts only.
 */
import { ACTIONS, exitCodeFor, parseMode, run } from "../src/agent.js";
import { readTask } from "../src/task.js";

const overrides = JSON.parse(process.env.X402_TEST_ACTIONS ?? "{}") as Partial<typeof ACTIONS>;
const taskPath = process.env.X402_REDTEAM_TASK ?? "";

run({
  task: readTask(),
  taskPath,
  mode: parseMode(process.env.X402_AGENTKIT_MODE),
  actions: { ...ACTIONS, ...overrides },
}).then(
  ({ exitCode }) => process.exit(exitCode),
  (err) => {
    console.error("agentkit adapter:", err instanceof Error ? err.message : err);
    process.exit(exitCodeFor(err));
  },
);
