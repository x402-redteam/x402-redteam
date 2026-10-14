/**
 * ClawRouter adapter parent (U28 §3-§5). Our code only: it imports no ClawRouter code and
 * drives the sandboxed child (child.ts) over fd 3. The adapter is scripted, so a run is
 * free and deterministic: there is no LLM in the loop.
 *
 * X402_CLAWROUTER_PROFILE picks the configuration under test (`defaults` or `budget`).
 * The scenario's `task.prompt` ends with one plan line, see `PLAN_RE`.
 *
 * Exit codes:
 *   0  the run measured what it set out to;
 *   3  it did not, and the harness scores it as an agent error: a bad plan line, a child
 *      crash, a wallet or port mismatch, catalog fetches that did not settle, an outcome
 *      not in the exit-class table (classify.ts), a task-host refusal, or an
 *      `EGRESS_BLOCKED` after a pre-sign intent;
 *   1  anything else: a missing or unknown profile, `proxy` host mode, a non-EVM task, or
 *      something already listening on the payer's default port (8402).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { blockedHost } from "./blocked-host.js";
import { type ClawRouterChild, ChildCrashedError, startChild } from "./child-client.js";
import { classifyChat } from "./classify.js";
import { type RunNotes, writeNotes } from "./notes.js";
import { DEFAULT_PAYER_PORT, PORT_ENV } from "./ports.js";
import {
  type ChatResult,
  INTENT_PREFIX,
  type Intent,
  PROFILES,
  type Profile,
  type ReadyReport,
} from "./protocol.js";
import {
  buildProvenance,
  ConfigError,
  recordProvenance,
  UnmeasuredError,
} from "./provenance.js";
import { readTask, type TaskFile, taskHostnames } from "./task.js";

/** The plan line that ends every scenario's prompt, matched exactly. */
export const PLAN_RE = /^clawrouter: model=(\S+) calls=([1-9][0-9]?) body=(same|distinct)$/;

export interface Plan {
  model: string;
  calls: number;
  body: "same" | "distinct";
  /** The prompt without the plan line. */
  message: string;
}

/** Parses the plan line. Throws UnmeasuredError (exit 3) for anything else (U28 §4). */
export function parsePlan(prompt: string): Plan {
  const lines = prompt.replace(/\n+$/, "").split("\n");
  const last = lines[lines.length - 1] ?? "";
  for (const line of lines.slice(0, -1)) {
    if (line.startsWith("clawrouter:")) {
      throw new UnmeasuredError("a line starting with clawrouter: that is not the last line");
    }
  }
  const match = PLAN_RE.exec(last);
  if (!match) {
    throw new UnmeasuredError(
      last.startsWith("clawrouter:")
        ? "the clawrouter: plan line does not match the grammar"
        : "the prompt does not end with a clawrouter: plan line",
    );
  }
  const message = lines.slice(0, -1).join("\n").trimEnd();
  if (message === "") throw new UnmeasuredError("the prompt has no text before the plan line");
  return {
    model: match[1] as string,
    calls: Number(match[2]),
    body: match[3] as "same" | "distinct",
    message,
  };
}

/** The user message for call `k` of `n` (1-based). */
export function messageFor(plan: Plan, k: number): string {
  return plan.body === "distinct" ? `${plan.message} (call ${k} of ${plan.calls})` : plan.message;
}

/** Missing or unknown profile: exit 1 (m6). */
export function parseProfile(value: string | undefined): Profile {
  if ((PROFILES as readonly string[]).includes(value ?? "")) return value as Profile;
  throw new ConfigError(
    `X402_CLAWROUTER_PROFILE must be one of ${PROFILES.join(", ")} (got ${value ?? "nothing"})`,
  );
}

/** True when something accepts a TCP connection on 127.0.0.1 or ::1 at `port`. */
export async function somethingListens(port: number): Promise<boolean> {
  const { connect } = await import("node:net");
  const attempt = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const finish = (up: boolean): void => {
        socket.destroy();
        resolve(up);
      };
      socket.setTimeout(1000, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  return (await attempt("127.0.0.1")) || (await attempt("::1"));
}

/** A free port on 127.0.0.1 that is not the payer's default. The guard allows only
 * 127.0.0.1, so [::1] is not part of the child's reach. */
export async function pickFreePort(): Promise<number> {
  for (let tries = 0; tries < 20; tries++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const p = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(p));
      });
    });
    if (port !== DEFAULT_PAYER_PORT && port !== 0) return port;
  }
  throw new Error("could not pick a free port");
}

export interface RunOptions {
  task: TaskFile;
  taskPath: string;
  profile: Profile;
  /** The environment the child's is filtered from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Only tests override this (a child that misbehaves on purpose). */
  childScript?: string;
  /** Only tests override this: skip the 8402 check (it is covered by its own test). */
  skipPortCheck?: boolean;
}

export interface RunResult {
  exitCode: number;
}

/** The cause of a child outcome that makes the run unmeasured, or undefined. */
function egressProblem(
  egress: RunNotes["egress"],
  taskHosts: Set<string>,
): string | undefined {
  for (const e of egress) {
    const host = blockedHost(`EGRESS_BLOCKED ${e.target}`);
    if (host !== undefined && taskHosts.has(host.toLowerCase())) {
      return `the guard refused a task host (${host})`;
    }
    if (e.intents_before > 0) {
      return `EGRESS_BLOCKED ${e.target} after a pre-sign intent`;
    }
  }
  return undefined;
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const { task, taskPath, profile } = opts;
  if (task.host_mode === "proxy") throw new ConfigError("proxy host mode is not supported");
  if (task.chain !== "evm") throw new ConfigError("the ClawRouter adapter supports --chains evm only");
  if (!opts.skipPortCheck && (await somethingListens(DEFAULT_PAYER_PORT))) {
    throw new ConfigError(
      `something is listening on port ${DEFAULT_PAYER_PORT}, the payer's default; refusing to start`,
    );
  }
  const plan = parsePlan(task.prompt);
  if (profile === "budget" && !(task.budget_usd > 0)) {
    throw new UnmeasuredError("the budget profile needs a scenario with budget_usd above 0");
  }

  const notes: RunNotes = {
    run_id: task.run_id,
    profile,
    proxy_port: null,
    catalog_settled: null,
    catalog_requests: null,
    balance_stub_usd: null,
    budget_usd: task.budget_usd,
    plan: { model: plan.model, calls: plan.calls, body: plan.body, parallel: task.parallel === true },
    cache: "package default",
    calls: [],
    intents: [],
    egress: [],
    exit_code: null,
    exit_reason: null,
  };
  const taskHosts = taskHostnames(task);
  const finish = (exitCode: number, reason: string): RunResult => {
    notes.exit_code = exitCode;
    notes.exit_reason = reason;
    writeNotes(taskPath, notes);
    return { exitCode };
  };

  const port = await pickFreePort();
  notes.proxy_port = port;
  const home = mkdtempSync(join(tmpdir(), "x402rt-clawrouter-home-"));
  const parentEnv = opts.env ?? process.env;
  const child: ClawRouterChild = startChild({
    env: { ...parentEnv, HOME: home, X402_REDTEAM_TASK: taskPath, [PORT_ENV]: String(port) },
    ...(opts.childScript ? { script: opts.childScript } : {}),
    onStderr(line) {
      if (line.startsWith(INTENT_PREFIX)) {
        try {
          notes.intents.push(JSON.parse(line.slice(INTENT_PREFIX.length)) as Intent);
        } catch {
          // An unreadable intent line leaves no intent; reconcile will not see it.
        }
        return;
      }
      const at = line.indexOf("EGRESS_BLOCKED ");
      if (at >= 0) {
        notes.egress.push({
          target: line.slice(at + "EGRESS_BLOCKED ".length).trim(),
          intents_before: notes.intents.length,
        });
      }
    },
  });

  const work = (async (): Promise<RunResult> => {
    const ready = (await child.call("start", { profile })) as ReadyReport;
    notes.catalog_settled = ready.catalog_settled;
    notes.catalog_requests = ready.catalog_requests;
    notes.balance_stub_usd = ready.balance_stub_usd;
    if (!ready.catalog_settled) {
      return finish(3, "catalog_settled: false");
    }
    recordProvenance(taskPath, buildProvenance(profile));

    const call = (k: number): Promise<ChatResult> =>
      child.call("chat", { model: plan.model, content: messageFor(plan, k) }) as Promise<ChatResult>;
    const results: ChatResult[] = [];
    if (task.parallel === true) {
      results.push(...(await Promise.all(Array.from({ length: plan.calls }, (_, i) => call(i + 1)))));
    } else {
      for (let k = 1; k <= plan.calls; k++) results.push(await call(k));
    }

    let problem: string | undefined;
    results.forEach((result, i) => {
      const verdict = classifyChat(result, taskHosts);
      notes.calls.push({ k: i + 1, status: result.status, verdict: verdict.kind, reason: verdict.reason });
      if (verdict.kind === "unmeasured" && problem === undefined) {
        problem = `call ${i + 1}: ${verdict.reason}`;
      }
    });
    await child.close();
    await child.stderrDone;
    problem ??= egressProblem(notes.egress, taskHosts);
    return problem === undefined ? finish(0, "measured") : finish(3, problem);
  })();
  work.catch(() => {});

  try {
    // A crash rejects every pending call, and the race ends the run at once.
    return await Promise.race([work, child.crashed]);
  } catch (err) {
    child.kill();
    const message = err instanceof Error ? err.message : String(err);
    // A child that fails or crashes is never a measured payer result.
    if (err instanceof ConfigError) throw err;
    finish(3, message);
    throw err instanceof UnmeasuredError ? err : new UnmeasuredError(message);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof UnmeasuredError || err instanceof ChildCrashedError) return 3;
  return 1;
}

async function main(): Promise<void> {
  const profile = parseProfile(process.env.X402_CLAWROUTER_PROFILE);
  const taskPath = process.env.X402_REDTEAM_TASK;
  if (!taskPath) throw new ConfigError("X402_REDTEAM_TASK is not set");
  const { exitCode } = await run({ task: readTask(), taskPath, profile });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("clawrouter adapter:", err instanceof Error ? err.message : err);
    process.exit(exitCodeFor(err));
  });
}
