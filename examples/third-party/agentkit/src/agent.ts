/**
 * AgentKit adapter parent (U25 §3.1, §3.3). Our code only: it imports no AgentKit code
 * and drives the sandboxed child (child.ts) over fd 3.
 *
 * X402_AGENTKIT_MODE picks the driver. Three scripted modes run a fixed driver over the
 * reference payers' crawl (crawl.ts):
 * - autopay:  every fetch is AgentKit's make_http_request_with_x402;
 * - twostep:  make_http_request, then retry_http_request_with_x402 with the first offered
 *             option when the answer is a 402;
 * - transfer: the autopay crawl plus prose-instructed transfers through AgentKit's ERC-20
 *             transfer action; compare it with the autopay run to isolate what the
 *             transfers add.
 * llm mode runs the built-in LLM agent's Claude loop and system prompt over AgentKit's
 * own actions (llm-mode.ts). This process holds ANTHROPIC_API_KEY; the child never does.
 *
 * Exit codes: 0 when the run measured what it set out to; 3 (scored as an agent error)
 * when it did not, for example an action failed in the child, a transfer ended without a
 * measured outcome, the provenance check failed, or (llm mode) the model stopped for any
 * reason except end_turn or the child crashed; 2 in llm mode without ANTHROPIC_API_KEY;
 * 1 for anything else, such as a scripted-mode child crash or a bad mode.
 */
import { pathToFileURL } from "node:url";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import type { MessagesClient } from "../../../agents/src/lib/llm-agent.js";
import { readLlmSettings } from "../../../agents/src/lib/llm-config.js";
import { classifyResult, isKnownRefusal } from "./classify.js";
import { type AgentKitChild, ChildCrashedError, startChild } from "./child-client.js";
import { allowedOrigins, type CrawlSeed, crawl, extractUrls, type FetchLike } from "./crawl.js";
import { checkChildEnv, runLlm } from "./llm-mode.js";
import type { LoadedVersions } from "./loaded-versions.js";
import { buildProvenance, recordProvenance, UnmeasuredError } from "./provenance.js";
import { readTask, type TaskFile, taskHostnames } from "./task.js";

export const ACTIONS = {
  autopay: "X402ActionProvider_make_http_request_with_x402",
  request: "X402ActionProvider_make_http_request",
  retry: "X402ActionProvider_retry_http_request_with_x402",
  erc20Transfer: "ERC20ActionProvider_transfer",
};
export type ActionNames = typeof ACTIONS;

/** The naive reference payer's prose matcher (examples/agents/src/naive.ts), EVM recipients. */
const PROSE_RE = /\b(?:pay|send|transfer)\s+\$?([\d.]+)[^\n]*?\bto\s+(0x[0-9a-fA-F]{40})/i;

/** The transfer action's own refusals, which are measured outcomes like a transfer. */
const TRANSFER_REFUSALS = [
  "Error: Transfer destination is the token contract address. Refusing transfer to prevent loss of funds.",
  "Error: Transfer destination is an ERC20 token contract. Refusing to transfer to prevent loss of funds.",
];

const MODES = ["autopay", "twostep", "transfer", "llm"] as const;
export type Mode = (typeof MODES)[number];

type ActionResult = Record<string, unknown>;

function parseResult(raw: unknown): ActionResult {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ActionResult) : {};
  } catch {
    return {};
  }
}

function bodyText(data: unknown): string {
  if (data === undefined || data === null) return "";
  return typeof data === "string" ? data : JSON.stringify(data);
}

/** A Response the crawler can read, rebuilt from an AgentKit action result. */
export function toResponse(status: number, data: unknown): Response {
  const safe = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
  const nullBody = safe === 204 || safe === 205 || safe === 304;
  return new Response(nullBody ? null : bodyText(data), { status: safe });
}

/**
 * Wraps the child so a failure the crawl would swallow is still seen. Every action error
 * (unknown action, schema parse failure, an exception in the child) goes into `fatal`.
 * An HTTP action's `error: true` result is judged by the same classifier as llm mode
 * (`classify.ts`, U25 §3.3a), with scripted mode's stricter rule: only a known refusal
 * (the payment client's own policy, a network mismatch, a guard refusal of a host outside
 * the task) is measured and only stops that fetch; any other error goes into `fatal`.
 */
class Driver {
  readonly fatal: string[] = [];
  private readonly taskHosts: Set<string>;

  constructor(
    readonly child: AgentKitChild,
    readonly task: TaskFile,
    readonly actions: ActionNames,
  ) {
    this.taskHosts = taskHostnames(task);
  }

  async call(action: string, args: object): Promise<unknown> {
    try {
      return await this.child.call(action, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fatal.push(`${action}: ${message}`);
      throw err;
    }
  }

  /** Parses an HTTP action's result; throws (for the crawl) when the request failed. */
  async http(action: string, args: { url: string; [key: string]: unknown }): Promise<ActionResult> {
    const raw = await this.call(action, args);
    const result = parseResult(raw);
    if (result.error !== true) return result;
    const detail = `${String(result.message)} ${String(result.details ?? "")}`;
    const verdict = classifyResult(String(raw), this.taskHosts);
    if (verdict.kind === "refused_non_task_host") {
      console.error(`agentkit adapter: refused non-task host ${verdict.host} (measured)`);
    } else if (verdict.kind === "measured" && isKnownRefusal(detail)) {
      console.error(`agentkit adapter: ${action} ${args.url}: ${detail} (measured)`);
    } else {
      const reason = verdict.kind === "unmeasured" ? verdict.reason : `unrecognised error: ${detail}`;
      this.fatal.push(`${action} ${args.url}: ${reason}`);
    }
    throw new Error(detail);
  }

  autopayFetch(): FetchLike {
    return async (url) => {
      const result = await this.http(this.actions.autopay, { url, method: "GET" });
      return toResponse(Number(result.status), result.data);
    };
  }

  requestFetch(): FetchLike {
    return async (url) => {
      const result = await this.http(this.actions.request, { url, method: "GET" });
      if (result.status === "error_402_payment_required") return toResponse(402, result);
      return toResponse(Number(result.status), result.data);
    };
  }

  twostepFetch(): FetchLike {
    const plain = this.requestFetch();
    return async (url, init) => {
      const first = await plain(url, init);
      if (first.status !== 402) return first;
      const offered = parseResult(await first.text());
      const options = Array.isArray(offered.acceptablePaymentOptions)
        ? offered.acceptablePaymentOptions
        : [];
      const option = options[0];
      if (option === undefined) return toResponse(402, offered);
      const method = typeof offered.method === "string" ? offered.method : "GET";
      const result = await this.http(this.actions.retry, {
        url,
        method,
        selectedPaymentOption: option,
      });
      if (result.status === "success") return toResponse(200, result.data);
      return toResponse(Number(result.httpStatus), result.data);
    };
  }

  async transfers(pages: { url: string; body: string }[]): Promise<void> {
    const seen = new Set<string>();
    for (const page of pages) {
      const match = PROSE_RE.exec(page.body);
      if (!match) continue;
      const amount = match[1];
      const to = match[2];
      if (!amount || !to || !Number.isFinite(Number(amount))) continue;
      const key = `${page.url}\u0000${to}\u0000${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = String(
        await this.call(this.actions.erc20Transfer, {
          amount,
          tokenAddress: CHAIN_DEFAULTS.evm.asset,
          destinationAddress: to,
        }),
      );
      const line = result.split("\n")[0] ?? "";
      console.error(`agentkit adapter: transfer from ${page.url}: ${line}`);
      if (!line.startsWith("Transferred ") && !TRANSFER_REFUSALS.includes(line)) {
        this.fatal.push(`${this.actions.erc20Transfer} from ${page.url}: ${line}`);
      }
    }
  }
}

export function parseMode(value: string | undefined): Mode {
  if (MODES.includes(value as Mode)) return value as Mode;
  throw new Error(
    `X402_AGENTKIT_MODE must be one of ${MODES.join(", ")} (got ${value ?? "nothing"})`,
  );
}

async function drive(driver: Driver, mode: Mode): Promise<void> {
  const origins = allowedOrigins(driver.task);
  const seeds: CrawlSeed[] = extractUrls(driver.task.prompt, origins).map((url) => ({
    url,
    referrerBody: "",
  }));
  const fetchFn = mode === "twostep" ? driver.twostepFetch() : driver.autopayFetch();
  const pages = await crawl(fetchFn, seeds, { origins });
  if (mode === "transfer") await driver.transfers(pages);
  if (driver.fatal.length > 0) {
    throw new UnmeasuredError(`the run did not measure cleanly: ${driver.fatal.join("; ")}`);
  }
}

export interface RunOptions {
  task: TaskFile;
  taskPath: string;
  mode: Mode;
  /** Only tests override this (a wrong name must end the run with exit 3). */
  actions?: ActionNames;
  /** The environment the child's is filtered from and llm mode's settings are read from.
   * Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** llm mode: the Messages client (the real Anthropic client, or a test stub). */
  client?: MessagesClient;
  log?: (line: string) => void;
}

export interface RunResult {
  /** 0, or 3 when llm mode stopped for any reason except end_turn. */
  exitCode: number;
  /** llm mode: the variable names the child reported from its own environment. */
  childEnvNames?: string[];
}

export async function run(opts: RunOptions): Promise<RunResult> {
  if (opts.task.host_mode === "proxy") throw new Error("proxy host mode is not supported");
  if (opts.task.chain !== "evm") {
    throw new Error("the AgentKit adapter supports --chains evm only");
  }
  const env = opts.env ?? process.env;
  const llm = opts.mode === "llm";
  const client = opts.client;
  if (llm && !client) throw new Error("llm mode needs a Messages client");
  const child = startChild({ env });
  const work = (async (): Promise<RunResult> => {
    const loaded = (await child.call("__provenance")) as LoadedVersions;
    if (!llm || !client) {
      recordProvenance(opts.taskPath, buildProvenance(opts.mode, loaded));
      await drive(new Driver(child, opts.task, opts.actions ?? ACTIONS), opts.mode);
      return { exitCode: 0 };
    }
    const { model } = readLlmSettings(env);
    recordProvenance(opts.taskPath, buildProvenance(opts.mode, loaded, model));
    const childEnvNames = checkChildEnv((await child.call("__env_names")) as string[]);
    const exitCode = await runLlm({
      child,
      task: opts.task,
      taskPath: opts.taskPath,
      client,
      env,
      ...(opts.log ? { log: opts.log } : {}),
    });
    return { exitCode, childEnvNames };
  })();
  let result: RunResult;
  try {
    // A crash rejects every pending call, and the race ends the run at once.
    result = await Promise.race([work, child.crashed]);
    await child.close();
  } catch (err) {
    child.kill();
    // In llm mode a child crash is never a measured AgentKit result.
    if (llm && err instanceof ChildCrashedError) throw new UnmeasuredError(err.message);
    throw err;
  }
  return result;
}

export function exitCodeFor(err: unknown): number {
  return err instanceof UnmeasuredError ? 3 : 1;
}

/** Exit code when llm mode starts without ANTHROPIC_API_KEY, as for examples/agents/src/llm.ts. */
export const MISSING_KEY_EXIT_CODE = 2;

async function main(): Promise<void> {
  const mode = parseMode(process.env.X402_AGENTKIT_MODE);
  const taskPath = process.env.X402_REDTEAM_TASK;
  if (!taskPath) throw new Error("X402_REDTEAM_TASK is not set");
  let client: MessagesClient | undefined;
  if (mode === "llm") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error(
        "agentkit adapter: ANTHROPIC_API_KEY is not set. Run llm mode through " +
          "scripts/run-llm.sh (which skips cleanly), or pass one with --pass-env ANTHROPIC_API_KEY.",
      );
      process.exit(MISSING_KEY_EXIT_CODE);
    }
    // Loaded only in llm mode. The key stays in this process; the child never gets it.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey }) as unknown as MessagesClient;
  }
  const { exitCode } = await run({
    task: readTask(),
    taskPath,
    mode,
    ...(client ? { client } : {}),
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("agentkit adapter:", err instanceof Error ? err.message : err);
    process.exit(exitCodeFor(err));
  });
}
