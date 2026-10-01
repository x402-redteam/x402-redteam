/**
 * GDP v1 stdio client, per application-design.md "Guardrail Decision Protocol v1" and
 * ADR-010 §2: spawns `--guardrail "<cmd>"` as a long-lived child process, sends
 * newline-delimited JSON requests, and matches newline-delimited JSON responses back by
 * `id`. A hook timeout (5s) and any protocol error (malformed line, mismatched id, the
 * guardrail process exiting) all resolve to `{decision:"deny"}` plus a `guardrail_error`
 * log line - "any deny blocks the payment" never has a code path that can hang the run.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  GdpHelloResponse,
  GdpHook,
  GdpRequest,
  GdpResponse,
  GdpTaskInfo,
} from "./protocol.js";

/** ADR-010 §2: a hook timeout of 5s counts as a deny. Overridable (test-only) via
 * `GdpClient`'s third constructor argument so unit tests don't have to wait 5s to
 * exercise the timeout path. */
const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export type GdpLogger = (message: string) => void;

interface Pending {
  resolve: (res: GdpResponse) => void;
  timer: NodeJS.Timeout;
}

/** `GdpClient.hello()`'s result, normalized so a dead/misbehaving guardrail looks
 * exactly like one that declared no hooks at all - the driver then just never asks it
 * anything, per driver loop §3 ("if the guardrail lacks `payment` ...  the SDK default
 * selector"). */
export interface GdpHello {
  hooks: GdpHook[];
  name: string;
  version: string;
  nondeterministic: boolean;
}

export class GdpClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly log: GdpLogger;
  private readonly hookTimeoutMs: number;
  private nextId = 0;
  private dead = false;
  private readonly pending = new Map<number, Pending>();

  constructor(
    cmd: string,
    env: NodeJS.ProcessEnv,
    log: GdpLogger,
    hookTimeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS,
  ) {
    this.log = log;
    this.hookTimeoutMs = hookTimeoutMs;
    // `sh -c <cmd>` mirrors how run.ts/spawn.ts spawn the agent itself, so a guardrail
    // command works in any language - its stderr is inherited straight into the
    // driver's own stderr, which the harness already redirects into the run's log file.
    this.child = spawn("sh", ["-c", cmd], { env, stdio: ["pipe", "pipe", "inherit"] });
    this.child.on("error", (err) => this.killAllPending(`guardrail process error: ${err.message}`));
    this.child.on("exit", (code, signal) => {
      this.dead = true;
      this.killAllPending(`guardrail process exited (code=${code}, signal=${signal})`);
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));
  }

  private killAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.log(`guardrail_error: ${reason} (request ${id})`);
      p.resolve({ id, decision: "deny", reason } as GdpResponse);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.log(`guardrail_error: malformed JSON line from guardrail: ${trimmed}`);
      return;
    }
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== "number" || !this.pending.has(id)) {
      this.log(`guardrail_error: response id mismatch (got ${JSON.stringify(id)})`);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(parsed as GdpResponse);
  }

  private write(msg: GdpRequest): void {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** Sends `msg` (its `id` is assigned here) and resolves with the matching response, a
   * timeout deny after 5s, or an immediate deny if the guardrail has already exited. */
  private send(build: (id: number) => GdpRequest): Promise<GdpResponse> {
    const id = this.nextId++;
    if (this.dead) {
      this.log(`guardrail_error: guardrail already exited (request ${id})`);
      return Promise.resolve({ id, decision: "deny", reason: "guardrail process has exited" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`guardrail_error: hook timeout after ${this.hookTimeoutMs}ms (request ${id})`);
        resolve({ id, decision: "deny", reason: "guardrail hook timed out" });
      }, this.hookTimeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.write(build(id));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        const reason = `failed to write to guardrail stdin: ${err instanceof Error ? err.message : String(err)}`;
        this.log(`guardrail_error: ${reason} (request ${id})`);
        resolve({ id, decision: "deny", reason });
      }
    });
  }

  /** Sends `hello` and returns its hooks, or an empty-hooks fallback (logged) if the
   * guardrail fails to answer in time or answers malformed - functional-design.md §4
   * only specifies hook-level failure handling, so a broken `hello` is treated the same
   * way: the driver just never asks this guardrail anything. */
  async hello(task: GdpTaskInfo): Promise<GdpHello> {
    const res = await this.send((id) => ({ id, type: "hello", gdp: 1, task }));
    if ("hooks" in res && Array.isArray(res.hooks)) {
      const hello = res as GdpHelloResponse;
      return {
        hooks: hello.hooks,
        name: hello.name ?? "unknown",
        version: hello.version ?? "unknown",
        nondeterministic: hello.nondeterministic === true,
      };
    }
    this.log("guardrail_error: hello did not return hooks; treating as no hooks implemented");
    return { hooks: [], name: "unknown", version: "unknown", nondeterministic: false };
  }

  /** Generic request/response round trip for `payment`/`transfer`/`sign`, per GDP v1. */
  request<R extends GdpResponse>(build: (id: number) => GdpRequest): Promise<R> {
    return this.send(build) as Promise<R>;
  }

  /** Kills the guardrail child process. Idempotent. */
  close(): void {
    if (!this.child.killed) {
      this.child.kill();
    }
  }
}
