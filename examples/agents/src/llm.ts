/**
 * The LLM reference agent, per U12 functional-design.md §3: a Claude tool-use agent that
 * decides for itself whether to pay, instead of following a scripted policy like
 * `naive`/`guarded`. Never run in CI; skipped (not failed) when `ANTHROPIC_API_KEY` is
 * absent (§3.4) - see `scripts/run-llm.sh` for the pre-flight skip, and this file's own
 * exit(2) for the case where it's invoked directly (e.g. by the harness itself) without
 * one. Results from this agent are experimental and are never written to `results/` or
 * ranked (application-design.md §8 "v2").
 *
 * The key is read only from `ANTHROPIC_API_KEY` (via the harness's `--pass-env`) and is
 * never written to task.json, logs, or reports - the `Anthropic` client reads it directly
 * from the environment; this file never logs it or threads it through any other value.
 */
import Anthropic from "@anthropic-ai/sdk";
import { runLlmAgent } from "./lib/llm-agent.js";
import { buildSystemPrompt, readLlmSettings } from "./lib/llm-config.js";
import { createToolHandlers, LLM_TOOLS, toHandlerMap } from "./lib/llm-tools.js";
import { readTask } from "./lib/wallet.js";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Per §3.4: invoked directly without a key, this is a hard failure (exit 2), not a
    // skip - the skip lives one level up, in scripts/run-llm.sh, which never starts the
    // harness at all. Inside the harness this makes every control fail (agent_ok is
    // false), which correctly makes the whole run exit 2 (ADR-009) rather than "pass".
    console.error(
      "llm: ANTHROPIC_API_KEY is not set. Run via scripts/run-llm.sh (which skips " +
        "cleanly), or pass one with --pass-env ANTHROPIC_API_KEY. See README 'Bring an " +
        "LLM agent'.",
    );
    process.exit(2);
  }

  const task = readTask();
  // X402_LLM_MODEL, X402_LLM_MAX_TURNS and the budgets, with their defaults (lib/llm-config.ts).
  const { model, maxTurns, perRunUsd, sessionUsd, spendFile } = readLlmSettings(process.env);
  const taskPath = process.env.X402_REDTEAM_TASK;

  // Exit 0 only when the model ends its turn; every other stop (budget, session budget
  // already spent, refusal, max_tokens, a turn without a tool call, max turns, API error)
  // exits 3, which the harness records as an agent error rather than a pass. Spend is
  // added to the spend file after every API call, and the transcript is written to
  // <dir of X402_REDTEAM_TASK>/../runs/<run_id>.transcript.json.
  const { exitCode } = await runLlmAgent({
    client: new Anthropic({ apiKey }),
    model,
    maxTurns,
    perRunUsd,
    sessionUsd,
    ...(spendFile ? { spendFile } : {}),
    system: buildSystemPrompt(task, process.env),
    userPrompt: task.prompt,
    tools: LLM_TOOLS,
    handlers: toHandlerMap(createToolHandlers(task)),
    ...(taskPath ? { taskPath } : {}),
    runId: task.run_id,
  });
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
