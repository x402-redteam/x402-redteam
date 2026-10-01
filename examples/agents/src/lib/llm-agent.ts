/**
 * The LLM agent's manual tool-use loop, per U12 functional-design.md §3.1/§3.3.
 *
 * A manual loop (not the SDK's beta tool runner) so this module can be driven by a
 * `MessagesClient` stub in tests (§6, "the agent loop against a stubbed Messages client
 * that returns scripted tool calls") without an API key or network access - the real
 * `../llm.ts` wires in a genuine `Anthropic` client, which satisfies the same minimal
 * interface.
 *
 * Determinism note (§3.3): `claude-sonnet-5` rejects sampling parameters (`temperature`/
 * `top_p`/`top_k`) with a 400 - the API removed them for this model family - so, unlike
 * the design's "use temperature: 0 where the API allows it", this loop passes no sampling
 * parameter at all. LLM runs stay non-deterministic; use `--repeat` and pass_rate, never
 * a byte-identical-report assertion, exactly as the design already says.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandlerMap } from "./llm-tools.js";

/** The minimal slice of the real `Anthropic` client this loop needs - satisfied by both
 * the real SDK client and a test stub. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** claude-sonnet-5 pricing (the default model, X402_LLM_MODEL override notwithstanding) -
 * per the claude-api skill's cached model table, $2/$10 per MTok input/output. An
 * unrecognized model override falls back to this same rate as an order-of-magnitude
 * estimate: the printed spend is advisory (§2 "reports its estimated spend"), not a
 * billing reconciliation. */
export const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 2, outputPerMTok: 10 };

const KNOWN_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function pricingFor(model: string): ModelPricing {
  return KNOWN_PRICING[model] ?? DEFAULT_PRICING;
}

export type LoopStopReason =
  | "end_turn"
  | "refusal"
  | "max_turns"
  | "budget_exhausted"
  | "no_tool_use";

export interface RunAgentLoopOptions {
  client: MessagesClient;
  model: string;
  /** Default 12 (§3.1). */
  maxTurns: number;
  /** ~$5 per manual session (G5 user decision); checked *before* every API call, so the
   * loop always stops at or under the cap rather than after exceeding it. */
  budgetUsd: number;
  system: string;
  userPrompt: string;
  tools: Anthropic.Tool[];
  handlers: ToolHandlerMap;
  /** Default 4096. */
  maxTokensPerTurn?: number;
}

export interface RunAgentLoopResult {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  stopReason: LoopStopReason;
  transcript: Anthropic.MessageParam[];
}

const DEFAULT_MAX_TOKENS_PER_TURN = 4096;

/**
 * Runs the agent loop to completion (or until it's stopped by a turn cap, a budget cap,
 * or the model itself stopping). Never throws on a tool failure - `handlers` (built by
 * `createToolHandlers`) already turns every failure into a JSON error result the model
 * can see, per functional-design.md §3.2.
 */
export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const pricing = pricingFor(opts.model);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.userPrompt }];
  let inputTokens = 0;
  let outputTokens = 0;

  const estimatedCostUsd = (): number =>
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok;

  const done = (turns: number, stopReason: LoopStopReason): RunAgentLoopResult => ({
    turns,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimatedCostUsd(),
    stopReason,
    transcript: messages,
  });

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    // Checked before spending, not after: the loop always stops at-or-under budgetUsd.
    if (estimatedCostUsd() >= opts.budgetUsd) {
      return done(turn, "budget_exhausted");
    }

    const response = await opts.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS_PER_TURN,
      system: opts.system,
      tools: opts.tools,
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      return done(turn + 1, "refusal");
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUseBlocks.length === 0) {
      return done(turn + 1, response.stop_reason === "end_turn" ? "end_turn" : "no_tool_use");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const handler = opts.handlers[block.name];
      const content = handler
        ? await handler(block.input)
        : JSON.stringify({ error: `unknown tool "${block.name}"` });
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return done(opts.maxTurns, "max_turns");
}
