/**
 * The LLM agent often checks a price with `http_get` before paying with `pay_and_get`.
 * That leaves the first challenge unpaid and pays a second, identical one. A scripted
 * model drives the real tool handlers against a live mock adversary to check that the
 * paid request is delivered and recorded as one valid payment.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { type Adversary, createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import type { Chain } from "@x402-redteam/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/lib/llm-agent.js";
import { createToolHandlers, LLM_TOOLS, toHandlerMap } from "../src/lib/llm-tools.js";
import { buildLiveTask, loadScenarioById, SEED } from "./helpers/live-task.js";

function message(
  stopReason: Anthropic.StopReason,
  content: Anthropic.ContentBlock[],
): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content,
    diagnostics: null,
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 100,
      output_tokens: 50,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}

function toolUse(id: string, name: string, input: unknown): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ContentBlock;
}

describe.each(["evm", "svm"] as Chain[])("LLM agent checks the price, then pays (%s)", (chain) => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });

  afterAll(async () => {
    await adversary.close();
  });

  it("http_get then pay_and_get on a paid control URL is delivered with one valid payment", async () => {
    const scenario = loadScenarioById("control-paid-fetch");
    adversary.load({ scenario, chain, run_id: `${chain}-llm-probe-then-pay` });
    const task = buildLiveTask(scenario, chain, adversary.baseUrl);
    const url = `${task.base_url}/api/report`;

    const results: string[] = [];
    const handlers = toHandlerMap(createToolHandlers(task));
    const recording = Object.fromEntries(
      Object.entries(handlers).map(([name, fn]) => [
        name,
        async (input: unknown) => {
          const out = await fn(input);
          results.push(out);
          return out;
        },
      ]),
    );

    const create = vi
      .fn()
      .mockResolvedValueOnce(message("tool_use", [toolUse("t1", "http_get", { url })]))
      .mockResolvedValueOnce(message("tool_use", [toolUse("t2", "pay_and_get", { url })]))
      .mockResolvedValueOnce(
        message("end_turn", [{ type: "text", text: "done", citations: null } as never]),
      );

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 6,
      budgetUsd: 5,
      system: "system",
      userPrompt: task.prompt,
      tools: LLM_TOOLS,
      handlers: recording,
    });

    expect(result.stopReason).toBe("end_turn");
    expect(JSON.parse(results[0] as string).status).toBe(402);
    expect(JSON.parse(results[1] as string).status).toBe(200);

    const drained = adversary.drain();
    expect(drained.delivered).toBe(true);
    expect(drained.payments).toHaveLength(1);
    expect(drained.payments[0]?.valid).toBe(true);
    expect(drained.payments[0]?.capture).toContain("header");
  });
});
