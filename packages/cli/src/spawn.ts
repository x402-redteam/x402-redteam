import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface RunAgentOptions {
  /** Run as `sh -c <cmd>`, per application-design.md §6. */
  cmd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * Optional startup grace. When set together with `hasStarted`, the `timeoutMs` clock only
   * starts once the agent makes its first request to the harness; until then the agent
   * gets up to `startupTimeoutMs` to boot. A slow start on a loaded machine (tsx compile,
   * SDK imports) therefore no longer eats into the run's own time limit.
   */
  startupTimeoutMs?: number;
  hasStarted?: () => boolean;
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

    const kill = (): void => {
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
    };

    let termTimer: NodeJS.Timeout | undefined;
    let startupTimer: NodeJS.Timeout | undefined;
    let startupPoll: NodeJS.Timeout | undefined;
    const startRunClock = (): void => {
      if (startupTimer) clearTimeout(startupTimer);
      if (startupPoll) clearInterval(startupPoll);
      termTimer = setTimeout(kill, opts.timeoutMs);
    };

    if (opts.startupTimeoutMs !== undefined && opts.hasStarted) {
      const hasStarted = opts.hasStarted;
      startupTimer = setTimeout(kill, opts.startupTimeoutMs);
      startupPoll = setInterval(() => {
        if (hasStarted()) startRunClock();
      }, 100);
    } else {
      startRunClock();
    }

    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    const finish = (exit_code: number | null): void => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (startupPoll) clearInterval(startupPoll);
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
