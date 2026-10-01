import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * Security review HIGH-4/LOW: uids that must never be used for `--agent-uid`, beyond
 * `0` (checked separately, below) - `1000` and `1001` are the default unprivileged
 * users on, respectively, most Docker base images (`node`'s own default user) and
 * GitHub-hosted runners (the `runner` account, uid 1001). If the agent uid collided
 * with the *host* runner's own uid, and any host path were ever bind-mounted into the
 * container, the dropped-privilege guardrail process would share that host user's DAC
 * permissions (Linux uids are shared between a container and its host unless remapped
 * by a user namespace) - picking a uid outside this common range (ranked-run.yml uses
 * 2001) keeps that collision from being possible by construction. Exported so a caller
 * that knows its actual runner/base-image uid can extend the set.
 */
export const DEFAULT_RESERVED_AGENT_UIDS: ReadonlySet<number> = new Set([1000, 1001]);

/**
 * ADR-011 (U19): whether `--agent-uid` can run on this process, per
 * functional-design.md §4 ("spawn with `--agent-uid` on macOS or as non-root → exit 2
 * with the message") plus security review HIGH-4/LOW (reject uid 0, reject a uid that
 * collides with a commonly reserved runner/container uid). Linux + root only -
 * `process.getuid`/`setuid` don't exist on Windows, and macOS's privilege model differs
 * enough (no plain numeric `setuid` drop for an unprivileged child the way Linux
 * containers expect) that ADR-011 restricts this to Linux, where the ranked-run
 * container actually runs as root. Returns an error string when unsupported,
 * `undefined` when `uid` is `undefined` or every check passes.
 */
export function validateAgentUid(
  uid: number | undefined,
  reservedUids: ReadonlySet<number> = DEFAULT_RESERVED_AGENT_UIDS,
): string | undefined {
  if (uid === undefined) return undefined;
  if (uid === 0) {
    return "--agent-uid 0 is refused (uid 0 is root - this would drop no privilege at all)";
  }
  if (reservedUids.has(uid)) {
    return (
      `--agent-uid ${uid} is reserved (a common default runner/container uid) - choose ` +
      "a dedicated uid outside that range, e.g. 2001"
    );
  }
  if (process.platform !== "linux") {
    return `--agent-uid requires Linux (running on "${process.platform}")`;
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return "--agent-uid requires the harness itself to be running as root (uid 0)";
  }
  return undefined;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Security review HIGH-4 / re-review 4-residual: a best-effort sweep for any process
 * still owned by `agentUid` after one run ends, regardless of how it ended - a child
 * that detached from its own process group (so `runAgent`'s own SIGTERM/SIGKILL on
 * `-pid` never reached it) must not survive into the *next* run's execution, where it
 * could interfere with a different guardrail under test. Root-only (same precondition
 * as `--agent-uid` itself), and scoped to exactly this uid - it can never touch the
 * harness's own (root) process.
 *
 * Only `pkill`'s own "no matching process" result (exit code 1, the common, harmless
 * case) is swallowed. `pkill` itself being missing (`ENOENT` - the `.github/ranked`
 * image installs `procps` precisely so this never happens there) is a real
 * misconfiguration and **throws** rather than silently no-opping: a container that
 * can't sweep agentUid processes at all must not quietly proceed as if it had.
 */
export function killAgentUidProcesses(agentUid: number): void {
  try {
    execFileSync("pkill", ["-9", "-u", String(agentUid)], { stdio: "ignore" });
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      throw new Error(
        "killAgentUidProcesses: pkill is not installed - install procps (or an " +
          "equivalent providing pkill) in this image; refusing to silently skip the " +
          "post-run agentUid process sweep",
      );
    }
    // Any other failure (most commonly pkill's own exit 1, "no matching process") is
    // the harmless, common case - there is nothing more to sweep.
  }
}

export interface RunAgentOptions {
  /** Run as `sh -c <cmd>`, per application-design.md §6. */
  cmd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * ADR-011 (U19): drop the spawned process (and its children) to this uid/gid before
   * exec (Linux + root only - `validateAgentUid` must be checked by the caller first).
   * The driver/guardrail/agent then run unprivileged while the harness itself (this
   * process) stays root, so the held-out corpus can be mode 0400 (root-readable only)
   * in the ranked-run container. `gid` defaults to the same numeric value as `uid`.
   */
  agentUid?: number;
  /** Security review LOW: defaults to `agentUid` when omitted (set by `main.ts`, not
   * here, so the default is visible at the CLI layer). */
  agentGid?: number;
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
      ...(opts.agentUid !== undefined
        ? { uid: opts.agentUid, gid: opts.agentGid ?? opts.agentUid }
        : {}),
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
      // Security review HIGH-4: sweep for any lingering agentUid process *after every
      // run*, not only on a timeout kill - a clean exit from the direct child doesn't
      // guarantee a detached grandchild didn't survive it.
      if (opts.agentUid !== undefined) killAgentUidProcesses(opts.agentUid);
      const duration_ms = performance.now() - start;
      log.end(() => {
        resolvePromise({ exit_code, timed_out: timedOut, duration_ms });
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}
