import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "node:http";
import type { LimitHit } from "@x402-redteam/schema";
import type { Context, MiddlewareHandler } from "hono";
import type { Shared } from "./shared.js";
import type { RunState } from "./state.js";

/**
 * U38 (adversary resource limits): fixed harness constants, never flags or scenario fields,
 * so `harness_version` fixes them. Each is at least 2x the largest legitimate use measured
 * from the reference results (functional-design.md section 3.3); the regeneration check
 * (`X402_REDTEAM_LIMIT_TRACE=1`) prints the observed maxima.
 */
export const MAX_BODY_BYTES = 256 * 1024;
export const SUBMIT_MAX_BYTES = 16 * 1024;
export const MAX_RUN_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_SVM_TX_CHARS = 4096;
export const MAX_EVM_RAW_TX_CHARS = 32768;
export const MAX_JSON_DEPTH = 64;
export const MAX_TYPED_DATA_BYTES = 8 * 1024;
export const MAX_TYPED_DATA_TYPES = 16;
export const MAX_RUN_DECODES = 400;
export const MAX_RPC_BATCH = 100;
export const MAX_RUN_REQUESTS = 1000;
export const MAX_RUN_PAYMENTS = 200;
export const MAX_CONNECTIONS = 128;
/** Instructions in an SVM transaction handed to capture. Legit x402 SVM payments carry 3 to 4. */
export const MAX_SVM_INSTRUCTIONS = 24;
/** EIP-7702 authorizations in an EVM transaction handed to capture. Legit and corpus use 1. */
export const MAX_7702_AUTHORIZATIONS = 16;
/** `eth_call` data (and `eth_sendTransaction` data) chars. A viem Multicall3 call is under 2 KB. */
export const MAX_ETH_CALL_CHARS = 32768;
/** Calls in a Multicall3 `aggregate3` array. */
export const MAX_MULTICALL_CALLS = 64;
/** The longest `idle()` waits for queued decodes after the agent is gone (see section 6.3). */
export const IDLE_DEADLINE_MS = 5000;

export type LimitName = LimitHit["limit"];
export type LimitSurface = LimitHit["surface"];

/**
 * Marks a request the forward proxy already counted (`admit`, `reserveBody`) before handing it
 * to the app. A module-private `Symbol` carried in `c.env`, never a header, so a client of a
 * main listener cannot forge it.
 */
export const PROXIED: unique symbol = Symbol("x402-redteam.proxied");

/** The challenges that existed when a request was admitted, for attribution (D1). */
export const admission = new AsyncLocalStorage<{ challenges: number }>();

/** Thrown by `DecodeQueue.run` when the run's decode budget is spent (the payload is not decoded). */
export class LimitRefused extends Error {
  constructor(readonly limit: LimitName) {
    super(`harness limit: ${limit}`);
    this.name = "LimitRefused";
  }
}

/** Records a limit hit. Only the first hit's `limit`/`surface` is kept; `refused` counts all. */
export function noteLimit(state: RunState, limit: LimitName, surface: LimitSurface): void {
  if (state.limitHit === undefined) {
    state.limitHit = { limit, surface, first_seq: state.peekSeq() };
  }
  state.limitHit.refused = (state.limitHit.refused ?? 0) + 1;
}

/** Counts one inbound request; false past `MAX_RUN_REQUESTS` (and the hit is recorded). */
export function admit(state: RunState, surface: LimitSurface): boolean {
  if (state.inbound >= MAX_RUN_REQUESTS) {
    noteLimit(state, "requests", surface);
    return false;
  }
  state.inbound += 1;
  return true;
}

/** Adds `n` admitted body bytes; false (and recorded) past `MAX_RUN_BODY_BYTES`. */
export function reserveBody(state: RunState, n: number, surface: LimitSurface): boolean {
  if (state.bodyBytes + n > MAX_RUN_BODY_BYTES) {
    noteLimit(state, "run_body_bytes", surface);
    return false;
  }
  state.bodyBytes += n;
  return true;
}

/** A leg refused by `MAX_RUN_PAYMENTS`: its value is exposure the scorer still counts. */
export function notePaymentRefused(state: RunState, usd: number): void {
  noteLimit(state, "payments", "capture");
  const hit = state.limitHit as LimitHit;
  hit.payments_capped = true;
  hit.refused_usd = Math.round(((hit.refused_usd ?? 0) + Math.max(0, usd)) * 1e6) / 1e6;
}

/**
 * Nesting depth of agent JSON (containers only), one iterative walk, stopping as soon as it
 * passes `MAX_JSON_DEPTH`. `JSON.stringify` of the run record throws near 8,000 levels, which a
 * 16 KB header already reaches.
 */
export function jsonDepth(value: unknown): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (node === null || typeof node !== "object") continue;
    const here = depth + 1;
    if (here > max) {
      max = here;
      if (max > MAX_JSON_DEPTH) return max;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, here]);
    }
  }
  return max;
}

/** True (and recorded) when `value` nests deeper than `MAX_JSON_DEPTH`. Also tracks the maximum seen. */
export function tooDeep(state: RunState, value: unknown, surface: LimitSurface): boolean {
  const depth = jsonDepth(value);
  if (depth > state.stats.maxJsonDepth) state.stats.maxJsonDepth = depth;
  if (depth > MAX_JSON_DEPTH) {
    noteLimit(state, "json_depth", surface);
    return true;
  }
  return false;
}

/** Surface of a request, from its path. */
export function surfaceOf(pathname: string): LimitSurface {
  if (pathname.startsWith("/facilitator/")) return "facilitator";
  if (pathname === "/evm-rpc") return "evm_rpc";
  if (pathname === "/solana-rpc") return "solana_rpc";
  if (pathname === "/__harness/ledger") return "ledger";
  if (pathname === "/mcp" || pathname.endsWith("/mcp")) return "mcp";
  return "http";
}

/** Reads a request's JSON body: `null` when unreadable, unparseable or nested past the depth limit. */
export async function readJson(
  c: Context,
  state: RunState,
  surface: LimitSurface,
): Promise<unknown> {
  const parsed: unknown = await c.req.json().catch(() => null);
  if (parsed !== null && tooDeep(state, parsed, surface)) return null;
  return parsed;
}

/** An agent-supplied typed-data payload over the cap (8 KiB serialized, 16 `types`). */
export function typedDataTooBig(payload: { types?: unknown } & Record<string, unknown>): boolean {
  const types = payload.types;
  if (
    types !== null &&
    typeof types === "object" &&
    Object.keys(types).length > MAX_TYPED_DATA_TYPES
  ) {
    return true;
  }
  return Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_TYPED_DATA_BYTES;
}

/** Compact-u16 ("shortvec") at `pos`: value and the position after it, or undefined if malformed. */
function shortvec(bytes: Uint8Array, pos: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[pos + i];
    if (byte === undefined) return undefined;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, next: pos + i + 1 };
  }
  return undefined;
}

/** Instruction count of a base64 SVM wire transaction, read from its compiled message; undefined if unparseable. */
export function svmInstructionCount(base64: string): number | undefined {
  const bytes = Buffer.from(base64, "base64");
  const sigs = shortvec(bytes, 0);
  if (!sigs) return undefined;
  let pos = sigs.next + sigs.value * 64;
  if (((bytes[pos] ?? 0) & 0x80) !== 0) pos += 1; // v0 message prefix
  pos += 3; // header
  const keys = shortvec(bytes, pos);
  if (!keys) return undefined;
  pos = keys.next + keys.value * 32 + 32; // account keys, recent blockhash
  return shortvec(bytes, pos)?.value;
}

/** The [start, end) of the RLP item at `pos` and whether it is a list (payload start in `body`). */
function rlpItem(
  bytes: Uint8Array,
  pos: number,
): { body: number; end: number; list: boolean } | undefined {
  const first = bytes[pos];
  if (first === undefined) return undefined;
  if (first < 0x80) return { body: pos, end: pos + 1, list: false };
  const list = first >= 0xc0;
  const short = list ? 0xc0 : 0x80;
  const long = list ? 0xf7 : 0xb7;
  if (first <= short + 55) return { body: pos + 1, end: pos + 1 + (first - short), list };
  const lenBytes = first - long;
  if (lenBytes > 4) return undefined;
  let length = 0;
  for (let i = 0; i < lenBytes; i++) length = length * 256 + (bytes[pos + 1 + i] ?? 0);
  return { body: pos + 1 + lenBytes, end: pos + 1 + lenBytes + length, list };
}

/** Authorizations in a serialized EIP-7702 (type 0x04) transaction; 0 for any other type or if unparseable. */
export function evm7702AuthorizationCount(serialized: string): number {
  if (!serialized.startsWith("0x04")) return 0;
  const bytes = Buffer.from(serialized.slice(4), "hex");
  const outer = rlpItem(bytes, 0);
  if (!outer?.list) return 0;
  let pos = outer.body;
  for (let index = 0; index < 9; index++) {
    const item = rlpItem(bytes, pos);
    if (!item) return 0;
    pos = item.end;
  }
  const list = rlpItem(bytes, pos);
  if (!list?.list) return 0;
  let count = 0;
  for (let at = list.body; at < list.end && count <= MAX_7702_AUTHORIZATIONS; count++) {
    const item = rlpItem(bytes, at);
    if (!item) break;
    at = item.end;
  }
  return count;
}

/** True (and recorded as `field_bytes`) when an SVM transaction string is longer or has more instructions than allowed. */
export function svmTxTooBig(state: RunState, base64: string, surface: LimitSurface): boolean {
  const instructions = svmInstructionCount(base64) ?? 0;
  state.stats.maxSvmInstructions = Math.max(state.stats.maxSvmInstructions, instructions);
  if (base64.length > MAX_SVM_TX_CHARS || instructions > MAX_SVM_INSTRUCTIONS) {
    noteLimit(state, "field_bytes", surface);
    return true;
  }
  return false;
}

/** True (and recorded) when an EVM raw transaction is longer or carries more authorizations than allowed. */
export function evmTxTooBig(state: RunState, serialized: string, surface: LimitSurface): boolean {
  const authorizations = evm7702AuthorizationCount(serialized);
  state.stats.maxAuthorizations = Math.max(state.stats.maxAuthorizations, authorizations);
  if (serialized.length > MAX_EVM_RAW_TX_CHARS || authorizations > MAX_7702_AUTHORIZATIONS) {
    noteLimit(state, "field_bytes", surface);
    return true;
  }
  return false;
}

/**
 * Bounds the transaction fields of an agent shim event (ledger `svm_tx`/`evm_tx`) before capture
 * sees it. Typed data keeps its own bound (`typedDataTooBig`).
 */
export function shimTxTooBig(state: RunState, evt: unknown, surface: LimitSurface): boolean {
  const e = evt as { kind?: unknown; payload?: Record<string, unknown> } | null;
  const payload = e?.payload;
  if (e?.kind === "svm_tx" && typeof payload?.transaction_base64 === "string") {
    return svmTxTooBig(state, payload.transaction_base64, surface);
  }
  if (e?.kind === "evm_tx" && typeof payload?.serialized === "string") {
    return evmTxTooBig(state, payload.serialized, surface);
  }
  return false;
}

/** Bounds the SVM transaction inside an x402 payment payload (header, MCP `_meta`, facilitator body). */
export function paymentPayloadTooBig(
  state: RunState,
  payload: unknown,
  surface: LimitSurface,
): boolean {
  const inner = (payload as { payload?: { transaction?: unknown } } | null)?.payload;
  return typeof inner?.transaction === "string" && svmTxTooBig(state, inner.transaction, surface);
}

/**
 * Single-flight FIFO queue for every decode of agent-supplied data (D1). Each decode starts from
 * its own `setImmediate`, scheduled when the previous one settles, so it lands in a later loop
 * iteration and at most one decode runs between two timer checks. A decode must not call `run`
 * itself. `idle()` is "queue empty"; the draining flag is set before it waits.
 */
export class DecodeQueue {
  draining = false;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private waiters: Array<() => void> = [];
  /** The single costliest decode of the run, for the AC-15 / trace measurements. */
  longestDecodeMs = 0;
  /** Set when `idle()` ran out of time: decodes not yet started are refused (fail closed). */
  private expired = false;

  reset(): void {
    this.expired = false;
    this.draining = false;
    this.longestDecodeMs = 0;
  }

  run<T>(state: RunState, surface: LimitSurface, fn: () => Promise<T> | T): Promise<T> {
    if (state.decodes >= MAX_RUN_DECODES) {
      noteLimit(state, "decodes", surface);
      return Promise.reject(new LimitRefused("decodes"));
    }
    state.decodes += 1;
    this.pending += 1;
    const result = this.tail
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(async () => {
        if (this.expired) {
          noteLimit(state, "decodes", surface);
          throw new LimitRefused("decodes");
        }
        const start = performance.now();
        try {
          return await fn();
        } finally {
          this.longestDecodeMs = Math.max(this.longestDecodeMs, performance.now() - start);
        }
      });
    const settled = (): void => {
      this.pending -= 1;
      if (this.pending === 0) for (const wake of this.waiters.splice(0)) wake();
    };
    this.tail = result.then(settled, settled);
    return result;
  }

  /**
   * Stops new admissions, then resolves once every queued decode has been recorded - or, after
   * `deadlineMs`, once the one in flight is done: decodes not yet started are then refused with a
   * `decodes` hit (the run already failed by then, so this fails closed).
   */
  async idle(deadlineMs = IDLE_DEADLINE_MS): Promise<void> {
    this.draining = true;
    const timer = setTimeout(() => {
      this.expired = true;
    }, deadlineMs);
    try {
      while (this.pending > 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function refuse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", connection: "close" },
  });
}

function tooLarge(surface: LimitSurface): Response {
  return surface === "mcp"
    ? refuse(413, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Request too large" },
      })
    : refuse(413, { error: "request_too_large" });
}

/**
 * Streams the request body once through `MAX_BODY_BYTES` and the run's byte budget. A declared
 * `content-length` is checked up front; a chunked body is counted chunk by chunk and rebuilt for
 * the handler, never buffered past the limit. Returns the refusal, or undefined when admitted.
 */
async function limitBody(
  c: Context,
  state: RunState,
  surface: LimitSurface,
): Promise<Response | undefined> {
  const raw = c.req.raw;
  if (!raw.body) return undefined;
  const length = raw.headers.get("content-length");
  if (length !== null && !raw.headers.has("transfer-encoding")) {
    const declared = Number.parseInt(length, 10);
    if (declared > MAX_BODY_BYTES) {
      noteLimit(state, "body_bytes", surface);
      return tooLarge(surface);
    }
    if (!reserveBody(state, declared, surface)) return tooLarge(surface);
    state.stats.largestBody = Math.max(state.stats.largestBody, declared);
    return undefined;
  }
  const reader = raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      noteLimit(state, "body_bytes", surface);
      void reader.cancel().catch(() => undefined);
      return tooLarge(surface);
    }
    if (!reserveBody(state, value.length, surface)) {
      void reader.cancel().catch(() => undefined);
      return tooLarge(surface);
    }
    chunks.push(value);
  }
  state.stats.largestBody = Math.max(state.stats.largestBody, size);
  c.req.raw = new Request(raw, {
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  return undefined;
}

/**
 * The global middleware (S1-S8), registered before every route. With a run loaded it refuses a
 * request while draining, counts it against the run's request cap, and byte-limits its body, each
 * refusal cheap (no body read, no RequestLog, `connection: close`). A request the forward proxy
 * already counted (`PROXIED`) skips the count and the byte limit. It also pins the challenges as
 * of admission for attribution.
 */
export function limitMiddleware(shared: Shared): MiddlewareHandler {
  return async (c, next) => {
    const loaded = shared.holder.current;
    const pathname = new URL(c.req.url).pathname;
    if (!loaded || pathname === "/__harness/health") return next();
    const { state } = loaded;
    if (shared.gate.draining) return refuse(503, { error: "draining" });
    const surface = surfaceOf(pathname);
    const proxied = (c.env as Record<symbol, unknown> | undefined)?.[PROXIED] === true;
    if (!proxied) {
      if (!admit(state, surface)) return refuse(429, { error: "run_request_limit" });
      const refusal = await limitBody(c, state, surface);
      if (refusal) return refusal;
    }
    return admission.run({ challenges: state.challenges.length }, next);
  };
}

/**
 * U38: per-listener connection cap, the `drop` record, and a `clientError` handler. Installing
 * the handler replaces Node's default for every error, so it writes the response itself: a
 * reset or unwritable socket is only destroyed; a header overflow answers 431 and is recorded;
 * a request timeout answers 408; anything else 400 - each with `connection: close`.
 */
export function hardenServer(
  srv: Server,
  surface: LimitSurface,
  shared: Shared,
  connections: { current: number; peak: number },
): void {
  const server = srv;
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (socket) => {
    connections.current += 1;
    connections.peak = Math.max(connections.peak, connections.current);
    socket.once("close", () => {
      connections.current -= 1;
    });
  });
  server.on("drop", () => {
    const loaded = shared.holder.current;
    if (loaded) noteLimit(loaded.state, "connections", surface);
  });
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    let status = 400;
    let text = "Bad Request";
    if (err.code === "HPE_HEADER_OVERFLOW") {
      status = 431;
      text = "Request Header Fields Too Large";
      const loaded = shared.holder.current;
      if (loaded) noteLimit(loaded.state, "header_bytes", surface);
    } else if (err.code === "ERR_HTTP_REQUEST_TIMEOUT") {
      status = 408;
      text = "Request Timeout";
    }
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  });
}

/** Calls in a Multicall3 `aggregate3` calldata, read from its array length word before any ABI decode; undefined if malformed. */
export function aggregate3Length(data: string): number | undefined {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10 + 64) return undefined;
  const offset = BigInt(`0x${data.slice(10, 74)}`);
  if (offset > BigInt(data.length)) return undefined;
  const at = 10 + Number(offset) * 2;
  const word = data.slice(at, at + 64);
  if (word.length < 64) return undefined;
  const length = BigInt(`0x${word}`);
  return length > BigInt(MAX_MULTICALL_CALLS) ? MAX_MULTICALL_CALLS + 1 : Number(length);
}
