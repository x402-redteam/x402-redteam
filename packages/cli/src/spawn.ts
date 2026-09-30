import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface RunAgentOptions {
  /** Run as `sh -c <cmd>`, per application-design.md §6. */
  cmd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Absolute path; the agent's stdout/stderr are both appended here. */
  logFile: string;
}

export interface RunAgentResult {
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
}

/**
 * Runs the agent command to completion (or until it's killed), per
 * functional-design.md §3. On timeout, SIGTERM goes to the whole process
 * group first (`detached: true` + `process.kill(-pid)`), then SIGKILL 2s
 * later if it's still alive. `duration_ms` is wall-clock via
 * `performance.now()`.
 */
export function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  return new Promise((resolvePromise) => {
    const start = performance.now();
    const log = createWriteStream(opts.logFile);

    const child = spawn("sh", ["-c", opts.cmd], {
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const termTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        // process already gone
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // process already gone
        }
      }, 2000);
    }, opts.timeoutMs);

    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    const finish = (exit_code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      const duration_ms = performance.now() - start;
      log.end(() => {
        resolvePromise({ exit_code, timed_out: timedOut, duration_ms });
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}
