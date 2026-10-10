/**
 * Stubbed-Messages-client tests for the agent loop, per U12 functional-design.md §6
 * "the agent loop against a stubbed Messages client that returns scripted tool calls" -
 * no API key, no network, runs in `pnpm test`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PRICING, pricingFor, runAgentLoop } from "../src/lib/llm-agent.js";
import type { ToolHandlerMap } from "../src/lib/llm-tools.js";

/** Builds a minimal fake `Anthropic.Message` - only the fields `runAgentLoop` reads. */
function fakeMessage(partial: {
  stopReason: Anthropic.StopReason;
  content: Anthropic.ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
}): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content: partial.content,
    diagnostics: null,
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: partial.stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: partial.inputTokens ?? 100,
      output_tokens: partial.outputTokens ?? 50,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: null } as Anthropic.ContentBlock;
}

function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ContentBlock;
}

const BASE_TOOLS: Anthropic.Tool[] = [
  { name: "http_get", input_schema: { type: "object", properties: {} } },
];

describe("runAgentLoop", () => {
  it("calls the matching handler and stops at end_turn", async () => {
    // create() receives a *reference* to the loop's mutable `messages` array, which the
    // loop keeps appending to after this call returns - so the messages this call was
    // actually invoked with must be snapshotted (structuredClone) at call time, not read
    // back from `create.mock.calls` after the loop has finished mutating that array.
    let secondCallMessages: unknown[] = [];
    const create = vi
      .fn()
      .mockImplementationOnce(async () =>
        fakeMessage({
          stopReason: "tool_use",
          content: [toolUseBlock("t1", "http_get", { url: "http://example.test" })],
        }),
      )
      .mockImplementationOnce(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        secondCallMessages = structuredClone(params.messages);
        return fakeMessage({ stopReason: "end_turn", content: [textBlock("done")] });
      });
    const handler = vi.fn().mockResolvedValue(JSON.stringify({ status: 402 }));
    const handlers: ToolHandlerMap = { http_get: handler };

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "system prompt",
      userPrompt: "user prompt",
      tools: BASE_TOOLS,
      handlers,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ url: "http://example.test" });
    expect(result.stopReason).toBe("end_turn");
    expect(result.turns).toBe(2);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(100);

    // Tool result was fed back as a user turn before the second create() call.
    const lastMessage = secondCallMessages[secondCallMessages.length - 1] as {
      role: string;
      content: Array<{ type: string; tool_use_id: string }>;
    };
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content[0]?.type).toBe("tool_result");
    expect(lastMessage.content[0]?.tool_use_id).toBe("t1");
  });

  it("reports an unknown tool name as a tool_result error instead of throwing", async () => {
    let secondCallMessages: unknown[] = [];
    const create = vi
      .fn()
      .mockImplementationOnce(async () =>
        fakeMessage({
          stopReason: "tool_use",
          content: [toolUseBlock("t1", "does_not_exist", {})],
        }),
      )
      .mockImplementationOnce(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        secondCallMessages = structuredClone(params.messages);
        return fakeMessage({ stopReason: "end_turn", content: [textBlock("ok")] });
      });

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: {},
    });

    expect(result.stopReason).toBe("end_turn");
    const toolResult = (
      secondCallMessages[secondCallMessages.length - 1] as {
        content: Array<{ content: string }>;
      }
    ).content[0];
    expect(JSON.parse(toolResult?.content ?? "{}").error).toMatch(/unknown tool/);
  });

  it("stops at max_turns when the model keeps calling tools", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage({
        stopReason: "tool_use",
        content: [toolUseBlock("t1", "http_get", { url: "http://example.test" })],
      }),
    );
    const handler = vi.fn().mockResolvedValue("{}");

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 3,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: { http_get: handler },
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("stops on refusal without running any tool", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "refusal", content: [] }));
    const handler = vi.fn();

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: { http_get: handler },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("refusal");
  });

  it("stops before exceeding the budget cap, without an extra API call", async () => {
    // 1M input tokens @ $2/MTok = $2/turn; a $5 budget allows 2 turns of spend
    // before the 3rd pre-flight check trips (estimated cost already >= budget).
    const create = vi.fn().mockResolvedValue(
      fakeMessage({
        stopReason: "tool_use",
        content: [toolUseBlock("t1", "http_get", {})],
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    );
    const handler = vi.fn().mockResolvedValue("{}");

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: { http_get: handler },
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.estimatedCostUsd).toBeCloseTo(6, 6);
  });

  it("stops with max_tokens when the response is truncated", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "max_tokens", content: [textBlock("…")] }));

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: {},
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  it("treats a context-window stop as truncated and runs none of its tool calls", async () => {
    const create = vi.fn().mockResolvedValueOnce(
      fakeMessage({
        stopReason: "model_context_window_exceeded",
        content: [toolUseBlock("t1", "http_get", {})],
      }),
    );
    const handler = vi.fn();

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: { http_get: handler },
    });

    expect(result.stopReason).toBe("max_tokens");
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops with max_tokens without running a truncated tool call", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        fakeMessage({ stopReason: "max_tokens", content: [toolUseBlock("t1", "http_get", {})] }),
      );
    const handler = vi.fn();

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: { http_get: handler },
    });

    expect(result.stopReason).toBe("max_tokens");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns api_error instead of throwing when the API call fails", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("connection reset"));

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: {},
    });

    expect(result.stopReason).toBe("api_error");
    expect(result.error).toMatch(/connection reset/);
  });

  it("sends max_tokens 16000, adaptive thinking and an explicit effort", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "end_turn", content: [textBlock("ok")] }));

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: {},
    });

    const params = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.max_tokens).toBe(16000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "high" });
    expect(result.request).toEqual({
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      effort: "high",
    });
  });

  it("reports the cost of each API call as it happens", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        fakeMessage({
          stopReason: "tool_use",
          content: [toolUseBlock("t1", "http_get", {})],
          inputTokens: 1_000_000,
          outputTokens: 0,
        }),
      )
      .mockResolvedValueOnce(
        fakeMessage({
          stopReason: "end_turn",
          content: [textBlock("ok")],
          inputTokens: 0,
          outputTokens: 1_000_000,
        }),
      );
    const onApiCall = vi.fn();

    await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 50,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: { http_get: vi.fn().mockResolvedValue("{}") },
      onApiCall,
    });

    expect(onApiCall.mock.calls.map((c) => c[0])).toEqual([2, 10]);
  });

  it("stops with no_tool_use when the model stops without calling a tool or end_turn", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "pause_turn", content: [textBlock("…")] }));

    const result = await runAgentLoop({
      client: { messages: { create } },
      model: "claude-sonnet-5",
      maxTurns: 12,
      budgetUsd: 5,
      system: "s",
      userPrompt: "u",
      tools: BASE_TOOLS,
      handlers: {},
    });

    expect(result.stopReason).toBe("no_tool_use");
  });
});

describe("pricingFor", () => {
  it("returns the known rate for claude-sonnet-5", () => {
    expect(pricingFor("claude-sonnet-5")).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
  });

  it("returns the claude-sonnet-5 rate for claude-sonnet-5-5", () => {
    expect(pricingFor("claude-sonnet-5-5")).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
  });

  it("falls back to DEFAULT_PRICING for an unrecognized model override", () => {
    expect(pricingFor("some-future-model")).toEqual(DEFAULT_PRICING);
  });
});
