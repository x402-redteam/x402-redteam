/**
 * U38 (D2): the Action's artifact staging step runs the real `run:` script (not a copy of it)
 * and never stages `logs/` unless the harness finished normally (exit 0 or 1): a harness
 * error, a kill or a missing exit code may leave an unscrubbed log, and `if: always()` runs
 * the upload anyway.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ACTION = fileURLToPath(new URL("../../../action.yml", import.meta.url));

interface Step {
  id?: string;
  run?: string;
  env?: Record<string, string>;
}

const stepScript = (): { run: string; env: Record<string, string> } => {
  const doc = parse(readFileSync(ACTION, "utf8")) as { runs: { steps: Step[] } };
  const step = doc.runs.steps.find((s) => s.id === "artifact");
  if (!step?.run) throw new Error("action.yml has no artifact staging step");
  return { run: step.run, env: step.env ?? {} };
};

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "x402-u38-action-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Runs the staging script against an out dir holding two logs; `listed` is the manifest (null: none). */
function stage(
  exitCode: string,
  includeLogs: "true" | "false",
  listed: string[] | null = ["a.log"],
): { logs: string[]; report: boolean } {
  const out = join(work, "out");
  mkdirSync(join(out, "logs"), { recursive: true });
  writeFileSync(join(out, "logs", "a.log"), "scrubbed agent output\n");
  writeFileSync(join(out, "logs", "b.log"), "a run that crashed before its scrub\n");
  if (listed !== null) writeFileSync(join(out, ".scrubbed-logs"), `${listed.join("\n")}\n`);
  writeFileSync(join(out, "report.json"), "{}");
  const output = join(work, "github-output");
  writeFileSync(output, "");
  const { run, env } = stepScript();
  expect(Object.keys(env)).toContain("EXIT_CODE");
  const result = spawnSync("bash", ["-c", run], {
    cwd: work,
    env: {
      PATH: process.env.PATH ?? "",
      OUT_DIR: "out",
      INCLUDE_AGENT_LOGS: includeLogs,
      EXIT_CODE: exitCode,
      RUNNER_TEMP: work,
      GITHUB_OUTPUT: output,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const dir = readFileSync(output, "utf8").trim().replace(/^dir=/, "");
  const logsDir = join(dir, "logs");
  return {
    logs: existsSync(logsDir) ? readdirSync(logsDir).sort() : [],
    report: existsSync(join(dir, "report.json")),
  };
}

describe("U38 D2: the Action never uploads logs the CLI has not confirmed scrubbed", () => {
  it("stages exactly the logs listed in the manifest when opted in and the harness exited 0 or 1", () => {
    expect(stage("0", "true")).toEqual({ logs: ["a.log"], report: true });
    expect(stage("1", "true")).toEqual({ logs: ["a.log"], report: true });
  });

  it("exit 1 with no manifest (a crash before any scrub) stages no logs", () => {
    expect(stage("1", "true", null)).toEqual({ logs: [], report: true });
  });

  it("a crash mid-run stages none of that run's log: only listed logs are copied", () => {
    expect(stage("1", "true", [])).toEqual({ logs: [], report: true });
    expect(
      stage("1", "true", ["../report.json", "/etc/passwd", ".scrubbed", "missing.log"]),
    ).toEqual({
      logs: [],
      report: true,
    });
  });

  it("drops logs/ on a harness error (exit 2), a kill, or no exit code, even when opted in and listed", () => {
    for (const code of ["2", "137", ""]) {
      expect(stage(code, "true"), `exit ${JSON.stringify(code)}`).toEqual({
        logs: [],
        report: true,
      });
    }
  });

  it("still drops logs/ by default", () => {
    expect(stage("0", "false")).toEqual({ logs: [], report: true });
  });
});
