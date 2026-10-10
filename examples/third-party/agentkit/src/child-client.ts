/**
 * Parent side of the JSON-lines channel to the AgentKit child (fd 3, U25 §3.5.1).
 * Imports no AgentKit code. The child gets a clean environment: PATH, HOME, the task
 * path and the harness's mock URLs, never an API key.
 */
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnSandboxed } from "./sandbox.js";

const CHILD_SCRIPT = fileURLToPath(new URL("./child.ts", import.meta.url));

/** The only variables the child may see (ADR-029: no API key, nothing ambient). */
export const CHILD_ENV_NAMES = [
  "PATH",
  "HOME",
  "X402_REDTEAM_TASK",
  "X402_REDTEAM_BASE_URL",
  "X402_REDTEAM_CHAIN",
] as const;

export function childEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export class ChildCrashedError extends Error {}

export interface AgentKitChild {
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

export function startChild(
  opts: { env?: NodeJS.ProcessEnv; sandbox?: boolean; guard?: boolean } = {},
): AgentKitChild {
  const proc: ChildProcess = spawnSandboxed({
    script: CHILD_SCRIPT,
    env: childEnv(opts.env ?? process.env),
    sandbox: opts.sandbox,
    guard: opts.guard,
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
      `AgentKit child exited unexpectedly (code ${code}, signal ${signal})`,
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
      `fd 3 channel to the AgentKit child failed: ${err.message}`,
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
        throw new ChildCrashedError(`AgentKit child exited with code ${code}, signal ${signal}`);
      }
    },
  };
}
