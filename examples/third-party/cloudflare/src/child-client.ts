/**
 * Parent side of the JSON-lines channel to the Cloudflare child (fd 3, U25 §3.5.1, U33 §3.1).
 * Imports no package code. The child gets a clean environment: PATH, a fresh HOME and the
 * task path, never an API key. Its stderr is read line by line (and
 * passed on to our stderr), so the pre-sign log and any `EGRESS_BLOCKED` line arrive in
 * the order the child printed them.
 */
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { BASE_ENV_NAMES, childEnv, spawnSandboxed } from "@x402-redteam/sandbox";

const CHILD_SCRIPT = fileURLToPath(new URL("./child.ts", import.meta.url));
/** The adapter's own tsx and guard entry (U35 M1): the shared spawn resolves neither. */
const LOADER = import.meta.resolve("tsx");
const GUARD_ENTRY = fileURLToPath(new URL("./guard.ts", import.meta.url));

/** The only variables the child may see (ADR-029: no API key, nothing ambient). This adapter
 * adds none to the shared base list. */
export const CHILD_ENV_NAMES: readonly string[] = BASE_ENV_NAMES;
export { childEnv };

export class ChildCrashedError extends Error {}

export interface CloudflareChild {
  /** Resolves once the child's stderr has ended; every line has been passed to `onStderr`. */
  readonly stderrDone: Promise<void>;
  call(action: string, args?: unknown): Promise<unknown>;
  /** Closes the channel and resolves with the child's exit; rejects if it crashed. */
  close(): Promise<void>;
  /** Rejects as soon as the child exits on its own. */
  readonly crashed: Promise<never>;
  /** Ends the child at once, after a failed run. */
  kill(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export function startChild(opts: {
  env?: NodeJS.ProcessEnv;
  /** Only tests override this (a child that misbehaves on purpose). */
  script?: string;
  sandbox?: boolean;
  guard?: boolean;
  onStderr?: (line: string) => void;
} = {}): CloudflareChild {
  const env = opts.env ?? process.env;
  const taskPath = env.X402_REDTEAM_TASK;
  const spawned = spawnSandboxed({
    label: "cloudflare",
    script: opts.script ?? CHILD_SCRIPT,
    loader: LOADER,
    guardEntry: GUARD_ENTRY,
    ...(taskPath ? { taskPath } : {}),
    env,
    sandbox: opts.sandbox,
    guard: opts.guard,
    stdio: ["ignore", 2, "pipe", "pipe"],
  });
  const proc: ChildProcess = spawned.proc;
  // The fresh HOME goes when the child does.
  proc.once("close", () => spawned.dispose());
  const stderrDone = new Promise<void>((resolve) => {
    if (!proc.stderr) return resolve();
    const lines = createInterface({ input: proc.stderr });
    lines.on("line", (line) => {
      process.stderr.write(`${line}\n`);
      opts.onStderr?.(line);
    });
    lines.on("close", resolve);
  });
  const channel = proc.stdio[3] as (Readable & Writable) | null | undefined;
  if (!channel) throw new Error("child has no fd 3 channel");

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closing = false;

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
    proc.on("error", () => resolve({ code: null, signal: null }));
  });

  const crashed = exited.then(({ code, signal }) => {
    const err = new ChildCrashedError(
      `Cloudflare child exited unexpectedly (code ${code}, signal ${signal})`,
    );
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (closing && code === 0) return new Promise<never>(() => {});
    throw err;
  });
  // Observed here so an early crash is never an unhandled rejection; callers race it.
  crashed.catch(() => {});

  channel.on("error", (err) => {
    const wrapped = new ChildCrashedError(
      `fd 3 channel to the Cloudflare child failed: ${err.message}`,
    );
    for (const p of pending.values()) p.reject(wrapped);
    pending.clear();
  });

  createInterface({ input: channel }).on("line", (line) => {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p || msg.id === undefined) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "child action failed"));
  });

  return {
    stderrDone,
    crashed,
    kill() {
      closing = true;
      proc.kill("SIGKILL");
    },
    call(action, args) {
      const id = nextId++;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      channel.write(`${JSON.stringify({ id, action, args: args ?? {} })}\n`);
      return result;
    },
    async close() {
      closing = true;
      channel.end();
      const { code, signal } = await exited;
      if (code !== 0) {
        throw new ChildCrashedError(`Cloudflare child exited with code ${code}, signal ${signal}`);
      }
    },
  };
}
