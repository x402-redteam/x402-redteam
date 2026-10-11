/**
 * llm mode against a live mock adversary, with a stubbed Messages client in place of the
 * Anthropic API (no key, no network). The stub plays the model: it calls AgentKit's
 * make_http_request, then retry_http_request_with_x402 with the first offered option,
 * then ends its turn. Local only, like canary.test.ts; run with `pnpm test:llm`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
// The harness's own mock adversary and capture shim, loaded from this checkout.
import { type Adversary, createAdversary } from "../../../../packages/adversary/src/index.js";
import { capture } from "../../../../packages/capture/src/index.js";
import type { MessagesClient } from "../../../agents/src/lib/llm-agent.js";
import { buildSystemPrompt } from "../../../agents/src/lib/llm-config.js";
import { buildLiveTask, loadScenarioById, SEED } from "../../../agents/test/helpers/live-task.js";
import { type RunResult, run } from "../src/agent.js";
import type { AgentKitChild } from "../src/child-client.js";
import { classifyResult } from "../src/classify.js";
import { checkChildEnv, runLlm as runLlmMode } from "../src/llm-mode.js";
import { UnmeasuredError } from "../src/provenance.js";
import type { TaskFile } from "../src/task.js";

const REQUEST = "X402ActionProvider_make_http_request";
const RETRY = "X402ActionProvider_retry_http_request_with_x402";
const API_KEY = "sk-ant-test-not-a-real-key";

let adversary: Adversary;
let dir: string;

before(async () => {
  adversary = await createAdversary({ seed: SEED, capture });
  dir = realpathSync(mkdtempSync(join(tmpdir(), "x402rt-agentkit-llm-")));
});

after(async () => {
  await adversary.close();
  rmSync(dir, { recursive: true, force: true });
});

function message(
  stopReason: Anthropic.StopReason,
  content: Anthropic.ContentBlock[],
): Anthropic.Message {
  return {
    id: "msg_test",
    content,
    model: "claude-sonnet-5",
    role: "assistant",
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 100, output_tokens: 50 },
  } as Anthropic.Message;
}

function toolUse(id: string, name: string, input: unknown): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ContentBlock;
}

const END = message("end_turn", [{ type: "text", text: "done", citations: null } as never]);

/** The text of the last tool result the loop sent back. */
function lastToolResult(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const last = params.messages.at(-1);
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const result = blocks.find((b) => b.type === "tool_result");
  return typeof result?.content === "string" ? result.content : "";
}

/** A Messages client that answers each turn with the next scripted reply. */
function stubClient(
  replies: ((params: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message)[],
): { client: MessagesClient; calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming) {
        calls.push(params);
        const reply = replies[calls.length - 1];
        if (!reply) throw new Error(`unexpected API call ${calls.length}`);
        return reply(params);
      },
    },
  };
  return { client: client as unknown as MessagesClient, calls };
}

interface Setup {
  task: TaskFile;
  taskPath: string;
  out: string;
  env: NodeJS.ProcessEnv;
  url: string;
}

function setup(name: string): Setup {
  const scenario = loadScenarioById("control-paid-fetch");
  const runId = `agentkit-llm-${name}`;
  adversary.load({ scenario, chain: "evm", run_id: runId });
  const task = { ...buildLiveTask(scenario, "evm", adversary.baseUrl), run_id: runId } as TaskFile;
  const out = join(dir, name);
  mkdirSync(join(out, "tasks"), { recursive: true });
  const taskPath = join(out, "tasks", `${runId}.json`);
  writeFileSync(taskPath, JSON.stringify(task));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    X402_REDTEAM_TASK: taskPath,
    ANTHROPIC_API_KEY: API_KEY,
    X402_LLM_SPEND_FILE: join(out, "spend"),
  };
  return { task, taskPath, out, env, url: `${task.base_url}/api/report` };
}

async function runLlm(
  s: Setup,
  client: MessagesClient,
): Promise<{ result: RunResult; log: string[] }> {
  const log: string[] = [];
  const result = await run({
    task: s.task,
    taskPath: s.taskPath,
    mode: "llm",
    env: s.env,
    client,
    log: (line) => log.push(line),
  });
  return { result, log };
}

describe("agentkit llm mode", { timeout: 120_000 }, () => {
  it("pays control-paid-fetch through make_http_request then retry_http_request_with_x402", async () => {
    const s = setup("paid");
    const { client, calls } = stubClient([
      () => message("tool_use", [toolUse("t1", REQUEST, { url: s.url, method: "GET" })]),
      (params) => {
        const offered = JSON.parse(lastToolResult(params));
        assert.equal(offered.status, "error_402_payment_required");
        return message("tool_use", [
          toolUse("t2", RETRY, {
            url: s.url,
            method: "GET",
            selectedPaymentOption: offered.acceptablePaymentOptions[0],
          }),
        ]);
      },
      () => END,
    ]);

    const { result, log } = await runLlm(s, client);
    assert.equal(result.exitCode, 0, log.join("\n"));
    assert.equal(calls.length, 3);

    // The same prompt as the built-in agent, and AgentKit's own tools.
    const first = calls[0] as Anthropic.MessageCreateParamsNonStreaming;
    assert.equal(first.system, buildSystemPrompt(s.task, s.env));
    assert.equal(first.model, "claude-sonnet-5");
    const tools = (first.tools ?? []) as Anthropic.Tool[];
    const names = tools.map((t) => t.name);
    assert.ok(names.includes(REQUEST) && names.includes(RETRY), names.join(", "));
    assert.ok(!names.includes("X402ActionProvider_discover_x402_services"));
    assert.deepEqual([...new Set(names.map((n) => n.split("_")[0]))].sort(), [
      "ERC20ActionProvider",
      "WalletActionProvider",
      "X402ActionProvider",
    ]);
    const request = tools.find((t) => t.name === REQUEST);
    assert.match(request?.description ?? "", /retry_http_request_with_x402/);
    assert.equal(request?.input_schema.type, "object");
    assert.ok(!("$schema" in (request?.input_schema ?? {})));

    const drained = adversary.drain();
    assert.equal(drained.delivered, true);
    assert.equal(drained.payments.length, 1);
    assert.equal(drained.payments[0]?.valid, true);

    const provenance = JSON.parse(readFileSync(join(s.out, "provenance.json"), "utf8"));
    assert.equal(provenance.mode, "llm");
    assert.equal(provenance.model, "claude-sonnet-5");
    const transcript = JSON.parse(
      readFileSync(join(s.out, "runs", `${s.task.run_id}.transcript.json`), "utf8"),
    );
    assert.equal(transcript.stop_reason, "end_turn");
    const toolCalls = transcript.tool_calls as { name: string; result: string }[];
    assert.deepEqual(
      toolCalls.map((c) => c.name),
      [REQUEST, RETRY],
    );
    // The retry's result went back to the model as AgentKit wrote it.
    const paid = JSON.parse(toolCalls[1]?.result ?? "");
    assert.equal(paid.status, "success");
    assert.equal(paid.message, "Request completed successfully with payment");
    assert.ok(Number(readFileSync(join(s.out, "spend"), "utf8")) > 0);
  });

  it("gives the child no API key", async () => {
    const s = setup("env");
    const { client } = stubClient([() => END]);
    const { result } = await runLlm(s, client);
    assert.equal(result.exitCode, 0);
    assert.ok(result.childEnvNames?.includes("X402_REDTEAM_TASK"));
    assert.ok(
      !result.childEnvNames?.some((n) => n.startsWith("ANTHROPIC_")),
      String(result.childEnvNames),
    );
    adversary.drain();
  });

  it("exits 3 when the model stops for any reason except end_turn", async () => {
    const s = setup("max-tokens");
    const { client } = stubClient([() => message("max_tokens", [])]);
    const { result } = await runLlm(s, client);
    assert.equal(result.exitCode, 3);
    adversary.drain();
  });

  it("ends the run unmeasured, before another API call, when the child fails a call", async () => {
    const s = setup("schema-error");
    const { client, calls } = stubClient([
      () => message("tool_use", [toolUse("t1", REQUEST, { url: "not a url" })]),
    ]);
    await assert.rejects(runLlm(s, client), UnmeasuredError);
    assert.equal(calls.length, 1);
    const transcript = JSON.parse(
      readFileSync(join(s.out, "runs", `${s.task.run_id}.transcript.json`), "utf8"),
    );
    assert.equal(transcript.stop_reason, "api_error");
    assert.ok(existsSync(join(s.out, "provenance.json")));
    adversary.drain();
  });
});

describe("agentkit llm mode: measured and unmeasured results", { timeout: 120_000 }, () => {
  it("passes a measured error: true result to the model, and the run can end 0", async () => {
    const s = setup("network-mismatch");
    const option = {
      scheme: "exact",
      network: "eip155:1",
      asset: "0x0000000000000000000000000000000000000001",
      amount: "10000",
    };
    const { client } = stubClient([
      () =>
        message("tool_use", [
          toolUse("t1", RETRY, { url: s.url, method: "GET", selectedPaymentOption: option }),
        ]),
      (params) => {
        const result = JSON.parse(lastToolResult(params));
        assert.equal(result.error, true);
        assert.equal(result.message, "Network mismatch");
        return END;
      },
    ]);
    const { result, log } = await runLlm(s, client);
    assert.equal(result.exitCode, 0, log.join("\n"));
    assert.equal(adversary.drain().payments.length, 0);
  });

  it("exits 3 on a transport failure against a task host", async () => {
    const s = setup("transport");
    // 127.0.0.1 is a task host (the base URL's); port 9 has nothing listening.
    const { client, calls } = stubClient([
      () => message("tool_use", [toolUse("t1", REQUEST, { url: "http://127.0.0.1:9/x" })]),
    ]);
    await assert.rejects(runLlm(s, client), /transport failure/);
    assert.equal(calls.length, 1);
    adversary.drain();
  });

  it("exits 3 on a guard refusal of a task host in a plain-string result", async () => {
    const s = setup("plain-refusal");
    const transfer = "ERC20ActionProvider_transfer";
    const child: AgentKitChild = {
      crashed: new Promise<never>(() => {}),
      kill() {},
      async close() {},
      async call(action) {
        if (action === "__list_actions") {
          return [
            { name: transfer, description: "t", input_schema: { type: "object", properties: {} } },
          ];
        }
        return "Error transferring the asset: EGRESS_BLOCKED tcp:127.0.0.1:8545";
      },
    };
    const { client, calls } = stubClient([
      () => message("tool_use", [toolUse("t1", transfer, {})]),
    ]);
    await assert.rejects(
      runLlmMode({ child, task: s.task, taskPath: s.taskPath, client, env: s.env, log: () => {} }),
      (err) =>
        err instanceof UnmeasuredError && /guard refused task host 127\.0\.0\.1/.test(err.message),
    );
    assert.equal(calls.length, 1);
    adversary.drain();
  });

  it("checkChildEnv rejects a leaked ANTHROPIC_* name", () => {
    assert.throws(() => checkChildEnv(["PATH", "ANTHROPIC_API_KEY"]), UnmeasuredError);
    assert.throws(() => checkChildEnv(["ANTHROPIC_BASE_URL"]), UnmeasuredError);
    assert.deepEqual(checkChildEnv(["HOME", "PATH"]), ["HOME", "PATH"]);
  });

  it("classifies results", () => {
    const hosts = new Set(["127.0.0.1", "provider.test.localhost"]);
    const kind = (r: string) => classifyResult(r, hosts).kind;
    const err = (message: string, details = "") =>
      JSON.stringify({ error: true, message, details });
    const spend =
      "Failed to create payment payload: All payment requirements were rejected by " +
      "spendControls.maxAmountPerPayment (1).";
    // Measured outcomes.
    assert.equal(
      kind(JSON.stringify({ success: true, status: 500, data: "fetch failed" })),
      "measured",
    );
    assert.equal(kind(err("Network mismatch", "Wallet is on x")), "measured");
    assert.equal(kind(err("HTTP 503 error when accessing http://x", "Unavailable")), "measured");
    assert.equal(kind(err("Error making request to http://x", spend)), "measured");
    assert.equal(kind("Error: Insufficient USDC (0x1) token balance. Requested to send 5"), "measured");
    assert.equal(kind("Error: Transfer destination is the token contract address. Refusing transfer"), "measured");
    assert.equal(kind("Transferred 3 of USDC (0x1) to 0x2"), "measured");
    assert.equal(kind("Error transferring the asset: insufficient funds"), "unmeasured");
    assert.equal(kind("Error during transfer: boom"), "unmeasured");
    assert.equal(kind("Error: Could not fetch token details for 0x1"), "unmeasured");
    assert.equal(
      kind(
        err(
          "Network error when accessing https://evil.example",
          "fetch failed: EGRESS_BLOCKED fetch:https://evil.example",
        ),
      ),
      "refused_non_task_host",
    );
    // Unmeasured.
    assert.equal(
      kind("Error: EGRESS_BLOCKED fetch:http://provider.test.localhost:1"),
      "unmeasured",
    );
    assert.equal(
      kind(err("Network error when accessing http://127.0.0.1:9", "fetch failed")),
      "unmeasured",
    );
    assert.equal(
      kind("Error getting balance: HTTP request failed. URL: http://127.0.0.1"),
      "unmeasured",
    );
    assert.equal(
      kind("Error transferring the asset: connect ECONNREFUSED 127.0.0.1:8545"),
      "unmeasured",
    );
    assert.equal(
      kind(err("Error making request to http://x", "Failed to create payment payload: boom")),
      "unmeasured",
    );
    assert.equal(
      kind(err("Error making request to http://x", "something unexpected")),
      "unmeasured",
    );
  });
});
