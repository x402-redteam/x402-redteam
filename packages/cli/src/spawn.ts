import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";

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
  /**
   * How long to wait for the agent to close after its group has been sent SIGKILL
   * before the run is ended without it (default 10 s). A process the OS holds in an
   * uninterruptible state (for example while a launch-time security scan runs) cannot
   * act on SIGKILL, and the suite must not wait on it; the next run gets a fresh
   * adversary on a fresh port, so an abandoned process cannot reach it.
   */
  abandonAfterKillMs?: number;
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
 * functional-design.md §3. SIGTERM goes to the whole process group
 * (`detached: true` + `process.kill(-pid)`), then SIGKILL 2s later if it's
 * still alive - on a timeout, and again once the direct child has closed on
 * its own, so a non-detached sibling or grandchild never outlives its own
 * run regardless of how that run ended. `duration_ms` is wall-clock via
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
    let abandonTimer: NodeJS.Timeout | undefined;
    let settled = false;

    // Sends `signal` to the whole process group `detached: true` put `child` in - never
    // only `child` itself, so any process `child` spawned without detaching further
    // (an ordinary, non-detached grandchild) goes down with it. A detached grandchild
    // that started its own session/group is out of reach of this call by construction;
    // isolating it from the *next* run is `run.ts`'s job (a fresh adversary/port per
    // run), not this process group's. Returns whether the group actually existed to
    // receive the signal, so a caller can skip scheduling a follow-up signal to a group
    // that's already gone.
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return false; // process already gone, or never had a group to signal
      }
    };

    const kill = (): void => {
      timedOut = true;
      if (signalGroup("SIGTERM")) {
        killTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          abandonTimer = setTimeout(() => finish(null), opts.abandonAfterKillMs ?? 10_000);
        }, 2000);
      }
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
      if (abandonTimer) clearTimeout(abandonTimer);
      // Measurement integrity: the whole process group goes down at the end of every
      // run, the same way it does on a timeout - not only when this run actually timed
      // out. The direct child has already closed by the time `finish` runs, but that
      // says nothing about whether it leaves behind a non-detached sibling or
      // grandchild still sitting in its own group; this reaches that case the same way
      // `kill()` above does. The follow-up SIGKILL is only scheduled when the SIGTERM
      // actually reached a live group - nothing to follow up on otherwise. That timer
      // is `unref()`'d and nothing here is awaited before `resolvePromise` below, so
      // this adds no wall-clock time to this run.
      if (signalGroup("SIGTERM")) {
        setTimeout(() => signalGroup("SIGKILL"), 2000).unref();
      }
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

/**
 * U22 code review round 2 (item 3): a `--pass-env`'d secret is only ever meant to reach
 * the agent subprocess's own env - but an agent that echoes its env (deliberately, or by
 * accident in an error message) can still put that literal value into `logFile`, which
 * ends up both on disk under `out/logs/` and, by default, in this action's uploaded
 * build artifact (a wider-visibility surface than the job's own console). Called once
 * `runAgent` has resolved (its own `log.end()` callback already flushed and closed the
 * stream, so the file is complete and safe to read back), this replaces every literal
 * occurrence of each given secret value with `[REDACTED]`, in place.
 *
 * Best-effort, not a guarantee: it only catches the *exact* literal value passed through
 * `--pass-env` appearing verbatim (e.g. not re-encoded, wrapped, or partially printed) -
 * which is why `action.yml` still keeps `logs/` out of the uploaded artifact by default
 * (`include-agent-logs: false`) rather than relying on this alone. Values under 8
 * characters are skipped: short, low-entropy values (a port number, a boolean) are more
 * likely to appear in log text for unrelated reasons than to be a secret worth redacting,
 * and redacting them would make ordinary log output misleading.
 */
export function scrubSecretsFromLog(logFile: string, secrets: readonly string[]): void {
  const values = secrets.filter((s) => s.length >= 8);
  if (values.length === 0) return;

  let content: string;
  try {
    content = readFileSync(logFile, "utf8");
  } catch {
    return;
  }

  let scrubbed = content;
  for (const value of values) {
    scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  if (scrubbed !== content) {
    writeFileSync(logFile, scrubbed);
  }
}
