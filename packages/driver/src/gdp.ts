/**
 * GDP v1 stdio client, per application-design.md "Guardrail Decision Protocol v1" and
 * ADR-010 §2: spawns `--guardrail "<cmd>"` as a long-lived child process, sends
 * newline-delimited JSON requests, and matches newline-delimited JSON responses back by
 * `id`. A hook timeout (5s) and any protocol error (malformed line, mismatched id, an
 * invalid decision value, the guardrail process exiting) all resolve to
 * `{decision:"deny"}` plus a counted `guardrail_error` - "any deny blocks the payment"
 * never has a code path that can hang the run, and a broken guardrail is always visible
 * in the report rather than silently scoring like a deliberate policy (code review
 * round 1, findings 1/2/4).
 *
 * `hello` is NOT treated the same as a hook failure (code review finding 1): a guardrail
 * that never answers `hello`, or answers with anything other than a non-empty subset of
 * `{payment, transfer, sign}`, means the driver doesn't know what to ask it - there is no
 * safe "ask nothing" fallback, because that silently behaves exactly like `allow-all`.
 * `hello()` throws instead, and `main.ts` turns that into a non-zero driver exit (the run
 * becomes `error`, never a misleadingly valid-looking pass).
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
 * `GdpClient`'s fourth constructor argument so unit tests don't have to wait 5s to
 * exercise the timeout path. */
const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/** Code review finding 1: `hello` gets a startup-scale timeout, not the 5s hook
 * timeout - a guardrail's own boot (interpreter start, imports, model load for an
 * ML-based policy) can legitimately take longer than a single decision. Default 60s;
 * `main.ts` may pass a smaller value derived from the harness's own
 * `startup_timeout_s`/`X402_STARTUP_TIMEOUT_S`, since `hello` must still leave the
 * driver time to do its own work inside the harness's overall startup allowance. */
export const DEFAULT_HELLO_TIMEOUT_MS = 60_000;

const VALID_HOOKS: ReadonlySet<string> = new Set<GdpHook>(["payment", "transfer", "sign"]);

/**
 * `JSON.stringify` can't serialize a `bigint` on its own, and the `sign` hook's
 * `payload.typed_data.message` (code review finding 6) now forwards a wrapped signer's
 * *exact* captured input verbatim, which for viem's `signTypedData` routinely contains
 * `bigint` fields (an EIP-3009 `value`/`validAfter`/`validBefore`) - stringified the same
 * way `@x402-redteam/capture`'s own shim does (`packages/capture/src/shim/evm.ts`), so a
 * guardrail sees the same decimal-string convention the rest of the harness uses.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export type GdpLogger = (message: string) => void;

type PendingKind = "hello" | "decision";

interface Pending {
  resolve: (res: GdpResponse) => void;
  timer: NodeJS.Timeout;
  kind: PendingKind;
}

export interface GdpHello {
  hooks: GdpHook[];
  name: string;
  version: string;
  nondeterministic: boolean;
}

/** Thrown by `hello()` on timeout, a crash, or an invalid/empty `hooks` response - see
 * the module docstring. `main.ts` catches this and exits the driver non-zero. */
export class GdpHelloError extends Error {}

export class GdpClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly log: GdpLogger;
  private readonly hookTimeoutMs: number;
  private nextId = 0;
  private dead = false;
  private errors = 0;
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
    // Code review finding 11: writing to stdin after the guardrail has already closed it
    // (crashed, or closed stdin deliberately) raises an async EPIPE on the stream, which
    // is an unhandled 'error' event (crashes the whole driver process) unless listened
    // for here - the try/catch around `.write()` in `send()` only catches a synchronous
    // throw, which EPIPE is not.
    this.child.stdin.on("error", (err) => {
      this.logError(`guardrail stdin error: ${err.message}`);
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));
  }

  /** Every call site that represents one broken-protocol event, so `errorCount` (written
   * to the run's `*.gdp.json` sidecar, then `RunRecord.guardrail_errors`, code review
   * finding 4) counts exactly the events a human would call "the guardrail misbehaved". */
  private logError(message: string): void {
    this.errors++;
    this.log(`guardrail_error: ${message}`);
  }

  /** Count of protocol-error events this session has logged (timeouts, malformed lines,
   * id mismatches, invalid decisions, the guardrail exiting mid-run). */
  get errorCount(): number {
    return this.errors;
  }

  private killAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.logError(`${reason} (request ${id})`);
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
      this.logError(`malformed JSON line from guardrail: ${trimmed}`);
      return;
    }
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== "number" || !this.pending.has(id)) {
      this.logError(`response id mismatch (got ${JSON.stringify(id)})`);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (pending.kind === "hello") {
      // `hello()` itself validates the `hooks` shape (it needs to throw, not deny).
      pending.resolve(parsed as GdpResponse);
      return;
    }

    // Code review finding 2 (BLOCK): a decision response is trusted only when
    // `decision` is *exactly* the string "allow" or "deny" - anything else (wrong case
    // like "DENY", a missing field, an unrelated shape) is a protocol violation, not a
    // tacit allow. Range-checking `accept_index` against the specific request's accepts
    // list happens at the call site (`pay.ts`), which is the only place that knows it.
    const decision = (parsed as { decision?: unknown }).decision;
    if (decision === "allow" || decision === "deny") {
      pending.resolve(parsed as GdpResponse);
      return;
    }
    this.logError(`invalid decision value from guardrail (got ${JSON.stringify(decision)})`);
    pending.resolve({ id, decision: "deny", reason: "guardrail returned an invalid decision" });
  }

  private write(msg: GdpRequest): void {
    this.child.stdin.write(`${JSON.stringify(msg, jsonReplacer)}\n`);
  }

  /** Sends `msg` (its `id` is assigned here) and resolves with the matching response, a
   * timeout deny after `timeoutMs`, or an immediate deny if the guardrail has already
   * exited. */
  private send(
    build: (id: number) => GdpRequest,
    kind: PendingKind,
    timeoutMs: number,
  ): Promise<GdpResponse> {
    const id = this.nextId++;
    if (this.dead) {
      this.logError(`guardrail already exited (request ${id})`);
      return Promise.resolve({ id, decision: "deny", reason: "guardrail process has exited" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.logError(`hook timeout after ${timeoutMs}ms (request ${id})`);
        resolve({ id, decision: "deny", reason: "guardrail hook timed out" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, kind });
      try {
        this.write(build(id));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        const reason = `failed to write to guardrail stdin: ${err instanceof Error ? err.message : String(err)}`;
        this.logError(`${reason} (request ${id})`);
        resolve({ id, decision: "deny", reason });
      }
    });
  }

  /**
   * Sends `hello` and returns its hooks. Throws `GdpHelloError` on a timeout, a crash,
   * or a `hooks` value that isn't a non-empty array drawn from
   * `{payment, transfer, sign}` (code review finding 1) - there is no safe fallback,
   * because "ask nothing" is behaviourally identical to `allow-all`.
   */
  async hello(task: GdpTaskInfo, timeoutMs: number = DEFAULT_HELLO_TIMEOUT_MS): Promise<GdpHello> {
    const res = await this.send((id) => ({ id, type: "hello", gdp: 1, task }), "hello", timeoutMs);
    const hooks = this.validateHooks((res as { hooks?: unknown }).hooks);
    if (!hooks) {
      this.logError(`hello failed or returned invalid hooks: ${JSON.stringify(res)}`);
      throw new GdpHelloError(
        "guardrail hello failed, timed out, or did not return a non-empty hooks array drawn from payment/transfer/sign",
      );
    }
    const hello = res as GdpHelloResponse;
    return {
      hooks,
      name: typeof hello.name === "string" ? hello.name : "unknown",
      version: typeof hello.version === "string" ? hello.version : "unknown",
      nondeterministic: hello.nondeterministic === true,
    };
  }

  private validateHooks(hooks: unknown): GdpHook[] | undefined {
    if (!Array.isArray(hooks) || hooks.length === 0) return undefined;
    const result: GdpHook[] = [];
    for (const h of hooks) {
      if (typeof h !== "string" || !VALID_HOOKS.has(h)) return undefined;
      result.push(h as GdpHook);
    }
    return [...new Set(result)];
  }

  /** Generic request/response round trip for `payment`/`transfer`/`sign`, per GDP v1. */
  request<R extends GdpResponse>(build: (id: number) => GdpRequest): Promise<R> {
    return this.send(build, "decision", this.hookTimeoutMs) as Promise<R>;
  }

  /** Kills the guardrail child process. Idempotent. */
  close(): void {
    if (!this.child.killed) {
      this.child.kill();
    }
  }
}
