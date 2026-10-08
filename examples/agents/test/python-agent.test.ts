/**
 * Python agent smoke test, per U12 functional-design.md §6. It runs when the
 * `examples/agents-py/.venv` uv venv exists (gitignored; `uv sync` in `examples/agents-py`
 * builds it) and skips otherwise. With X402_REQUIRE_PY_VENV=1 (set by the nightly
 * python-agent job, which builds the venv) a missing venv fails the test instead. Drives the real `x402` PyPI package against a live
 * (offline, mock) adversary on the `control-paid-fetch` control scenario, evm only
 * (Bolt 5 scope).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Adversary, createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLiveTask, loadScenarioById, SEED } from "./helpers/live-task.js";

const AGENTS_PY_DIR = fileURLToPath(new URL("../../agents-py", import.meta.url));
const PYTHON_BIN = join(AGENTS_PY_DIR, ".venv", "bin", "python");
const AGENT_PY = join(AGENTS_PY_DIR, "agent.py");
const venvExists = existsSync(PYTHON_BIN);
const venvRequired = process.env.X402_REQUIRE_PY_VENV === "1";

describe.skipIf(!venvExists && !venvRequired)("python-x402 agent (live adversary, evm)", () => {
  let adversary: Adversary;
  let taskDir: string;

  beforeEach(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
    taskDir = await mkdtemp(join(tmpdir(), "x402-redteam-py-smoke-"));
  });

  afterEach(async () => {
    await adversary.close();
    await rm(taskDir, { recursive: true, force: true });
  });

  it("finds the uv venv's python", () => {
    expect(venvExists, `${PYTHON_BIN} is missing; run \`uv sync\` in examples/agents-py`).toBe(
      true,
    );
  });

  it("pays the control-paid-fetch challenge and is captured via the header layer", async () => {
    const scenario = loadScenarioById("control-paid-fetch");
    adversary.load({ scenario, chain: "evm", run_id: "py-smoke-paid-fetch" });
    const task = buildLiveTask(scenario, "evm", adversary.baseUrl);

    const taskPath = join(taskDir, "task.json");
    await writeFile(taskPath, JSON.stringify(task, null, 2));

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(PYTHON_BIN, [AGENT_PY], {
        env: { ...process.env, X402_REDTEAM_TASK: taskPath },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (stderr) console.error(`python-x402 stderr:\n${stderr}`);
        resolve(code ?? 1);
      });
    });

    expect(exitCode).toBe(0);

    const drained = adversary.drain();
    expect(drained.delivered).toBe(true);
    expect(drained.payments).toHaveLength(1);
    expect(drained.payments[0]?.capture).toBe("header");
    expect(drained.payments[0]?.valid).toBe(true);
  });
});
