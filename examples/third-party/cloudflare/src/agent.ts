/**
 * Cloudflare Agents SDK adapter parent (U33 §3). Our code only: it imports no package code
 * and drives the sandboxed child (child.ts) over fd 3. The adapter is scripted, so a run is
 * free and deterministic: there is no LLM in the loop.
 *
 * X402_CLOUDFLARE_PROFILE picks the configuration under test (`default`, `raised-cap` or
 * `approve`). The scenario's `task.prompt` ends with one plan line, see plan.ts.
 *
 * Exit codes:
 *   0  the run measured what it set out to;
 *   3  it did not, and the harness scores it as an agent error: a bad plan line, a failed
 *      batch gate, a child crash, loaded versions that differ from the pins, an outcome not
 *      in the exit-class table (classify.ts), a smoke control that did not pay, a task-host
 *      refusal, or an `EGRESS_BLOCKED` after a pre-sign intent;
 *   1  anything else: a missing or unknown profile, `proxy` host mode, a non-EVM task, or
 *      the `approve` profile with a plan that states no price.
 */
import { pathToFileURL } from "node:url";
import { blockedHost } from "./blocked-host.js";
import { ChildCrashedError, type CloudflareChild, startChild } from "./child-client.js";
import { classifyCall } from "./classify.js";
import { ConfigError, UnmeasuredError } from "./errors.js";
import { batchIdOf, checkGate } from "./gate.js";
import { type RunNotes, writeNotes } from "./notes.js";
import { parsePlan } from "./plan.js";
import { priceToAtomic } from "./profiles.js";
import {
  type CallResult,
  INTENT_PREFIX,
  type Intent,
  type Pins,
  PROFILES,
  type Profile,
  type ReadyReport,
} from "./protocol.js";
import { buildProvenance, recordProvenance } from "./provenance.js";
import { readTask, type TaskFile, taskHostnames } from "./task.js";
import { readPins } from "./versions.js";

export { ChildCrashedError, ConfigError, UnmeasuredError };
export { parsePlan, PLAN_RE } from "./plan.js";

/** Missing or unknown profile: exit 1. */
export function parseProfile(value: string | undefined): Profile {
  if ((PROFILES as readonly string[]).includes(value ?? "")) return value as Profile;
  throw new ConfigError(
    `X402_CLOUDFLARE_PROFILE must be one of ${PROFILES.join(", ")} (got ${value ?? "nothing"})`,
  );
}

export interface RunOptions {
  task: TaskFile;
  taskPath: string;
  profile: Profile;
  /** The environment the child's is filtered from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Only tests override this (a child that misbehaves on purpose). */
  childScript?: string;
  /** Only tests override this (a version mismatch). Default: package.json's exact pins. */
  pins?: Pins;
}

export interface RunResult {
  exitCode: number;
}

/** The cause of a child outcome that makes the run unmeasured, or undefined. */
function egressProblem(egress: RunNotes["egress"], taskHosts: Set<string>): string | undefined {
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
  if (task.chain !== "evm") throw new ConfigError("the Cloudflare adapter supports --chains evm only");
  let plan: ReturnType<typeof parsePlan> | undefined;
  const notes: RunNotes = {
    run_id: task.run_id,
    batch_id: batchIdOf(task),
    profile,
    plan: null,
    price_atomic: null,
    loaded: null,
    calls: [],
    intents: [],
    egress: [],
    exit_code: null,
    exit_reason: null,
  };
  const finish = (exitCode: number, reason: string): RunResult => {
    notes.exit_code = exitCode;
    notes.exit_reason = reason;
    writeNotes(taskPath, notes);
    return { exitCode };
  };
  const taskHosts = taskHostnames(task);
  let child: CloudflareChild | undefined;

  try {
    plan = parsePlan(task.prompt);
    notes.plan = { server: plan.server, tools: plan.tools, price: plan.price, role: plan.role };
    // The approval rule needs a price to compare with (C4): a plan without one is misconfigured.
    if (profile === "approve" && plan.price === null) {
      throw new ConfigError("the approve profile needs a plan line with a price");
    }
    notes.price_atomic = plan.price === null ? null : String(priceToAtomic(plan.price));
    const url = task.mcp_servers?.[plan.server];
    if (url === undefined) {
      throw new UnmeasuredError(`the plan names server ${plan.server}, which the task does not serve`);
    }
    checkGate(taskPath, task.run_id, plan, notes.batch_id);

    const pins = opts.pins ?? readPins();
    const parentEnv = opts.env ?? process.env;
    child = startChild({
      env: { ...parentEnv, X402_REDTEAM_TASK: taskPath },
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
    const active = child;
    const planned = plan;

    const work = (async (): Promise<RunResult> => {
      const ready = (await active.call("start", {
        profile,
        url,
        server: planned.server,
        price_atomic: notes.price_atomic,
        pins,
      })) as ReadyReport;
      notes.loaded = ready.loaded;
      for (const tool of planned.tools) {
        if (!ready.tools.includes(tool)) {
          throw new UnmeasuredError(`planned tool ${tool} is not in tools/list`);
        }
      }
      recordProvenance(taskPath, buildProvenance(profile, pins));

      let problem: string | undefined;
      let k = 0;
      for (const tool of planned.tools) {
        k += 1;
        const call = (await active.call("call", { tool })) as CallResult;
        const verdict = classifyCall(call, taskHosts);
        notes.calls.push({
          k,
          tool,
          signed: call.signed,
          verdict: verdict.kind,
          outcome: verdict.outcome,
          reason: verdict.reason,
          channels: verdict.channels,
          decisions: call.decisions,
          accepts_seen: call.accepts_seen,
        });
        if (verdict.kind === "unmeasured" && problem === undefined) {
          problem = `call ${k} (${tool}): ${verdict.reason}`;
        }
      }
      await active.close();
      await active.stderrDone;
      // The smoke control exists to show the payer pays at all (gate, rule 1).
      if (planned.role === "control" && problem === undefined) {
        const unpaid = notes.calls.find((c) => c.outcome !== "paid_delivered");
        if (unpaid) problem = `smoke control: call to ${unpaid.tool} did not end in a paid delivery`;
      }
      problem ??= egressProblem(notes.egress, taskHosts);
      return problem === undefined ? finish(0, "measured") : finish(3, problem);
    })();
    work.catch(() => {});
    // A crash rejects every pending call, and the race ends the run at once.
    return await Promise.race([work, active.crashed]);
  } catch (err) {
    child?.kill();
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ConfigError) throw err;
    // A child that fails or crashes is never a measured payer result.
    finish(3, message);
    throw err instanceof UnmeasuredError ? err : new UnmeasuredError(message);
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof UnmeasuredError || err instanceof ChildCrashedError) return 3;
  return 1;
}

async function main(): Promise<void> {
  const profile = parseProfile(process.env.X402_CLOUDFLARE_PROFILE);
  const taskPath = process.env.X402_REDTEAM_TASK;
  if (!taskPath) throw new ConfigError("X402_REDTEAM_TASK is not set");
  const { exitCode } = await run({ task: readTask(), taskPath, profile });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("cloudflare adapter:", err instanceof Error ? err.message : err);
    process.exit(exitCodeFor(err));
  });
}
