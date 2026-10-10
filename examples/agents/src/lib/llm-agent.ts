/**
 * The LLM agent's manual tool-use loop, per U12 functional-design.md §3.1/§3.3, and the
 * per-run wrapper (exit status, spend recording, transcript) from U25 functional-design.md §1.
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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandlerMap } from "./llm-tools.js";
import { addSpent, readSpent, runBudget } from "./session-budget.js";

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
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function pricingFor(model: string): ModelPricing {
  return KNOWN_PRICING[model] ?? DEFAULT_PRICING;
}

export type LoopStopReason =
  | "end_turn"
  | "refusal"
  | "max_tokens"
  | "max_turns"
  | "budget_exhausted"
  | "no_tool_use"
  | "api_error";

/** A run can also stop before the loop starts, when the session budget is already spent. */
export type RunStopReason = LoopStopReason | "session_exhausted";

/** Exit code for every stop other than `end_turn`. The harness records any non-zero exit
 * as an agent error, so a starved, refused or truncated run is never scored as a pass. */
export const AGENT_ERROR_EXIT_CODE = 3;

export function exitCodeFor(stopReason: RunStopReason): number {
  return stopReason === "end_turn" ? 0 : AGENT_ERROR_EXIT_CODE;
}

export type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** The request settings sent on every turn, recorded in the result and the transcript. */
export interface RequestSettings {
  max_tokens: number;
  thinking: Anthropic.ThinkingConfigParam;
  effort: Effort;
}

export interface ToolCallRecord {
  /** 1-based turn in which the model made the call. */
  turn: number;
  id: string;
  name: string;
  input: unknown;
  result: string;
}

export interface RunAgentLoopOptions {
  client: MessagesClient;
  model: string;
  /** Default 12 (§3.1). */
  maxTurns: number;
  /** Checked before every API call; the loop stops once the estimate reaches it. */
  budgetUsd: number;
  system: string;
  userPrompt: string;
  tools: Anthropic.Tool[];
  handlers: ToolHandlerMap;
  /** Default 16000. */
  maxTokensPerTurn?: number;
  /** Default "high" (the API default for claude-sonnet-5 and claude-sonnet-5-5), sent
   * explicitly so every run uses the same setting. */
  effort?: Effort;
  /** Called after every API call with that call's estimated cost. */
  onApiCall?: (costUsd: number) => void;
}

export interface RunAgentLoopResult {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  stopReason: LoopStopReason;
  /** Set when stopReason is "api_error". */
  error?: string;
  request: RequestSettings;
  toolCalls: ToolCallRecord[];
  transcript: Anthropic.MessageParam[];
}

const DEFAULT_MAX_TOKENS_PER_TURN = 16000;
const DEFAULT_EFFORT: Effort = "high";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the agent loop until the model ends its turn, or until it is stopped by a turn
 * cap, a budget cap, a refusal, truncation or an API error. Never throws on a tool
 * failure - `handlers` (built by `createToolHandlers`) already turns every failure into
 * a JSON error result the model can see, per U12 functional-design.md §3.2 - and never
 * throws on an API failure either; that becomes stopReason "api_error".
 */
export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const pricing = pricingFor(opts.model);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.userPrompt }];
  const toolCalls: ToolCallRecord[] = [];
  const request: RequestSettings = {
    max_tokens: opts.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS_PER_TURN,
    thinking: { type: "adaptive" },
    effort: opts.effort ?? DEFAULT_EFFORT,
  };
  let inputTokens = 0;
  let outputTokens = 0;

  const costOf = (input: number, output: number): number =>
    (input / 1_000_000) * pricing.inputPerMTok + (output / 1_000_000) * pricing.outputPerMTok;

  const done = (turns: number, stopReason: LoopStopReason, error?: string): RunAgentLoopResult => ({
    turns,
    inputTokens,
    outputTokens,
    estimatedCostUsd: costOf(inputTokens, outputTokens),
    stopReason,
    ...(error !== undefined ? { error } : {}),
    request,
    toolCalls,
    transcript: messages,
  });

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (costOf(inputTokens, outputTokens) >= opts.budgetUsd) {
      return done(turn, "budget_exhausted");
    }

    let response: Anthropic.Message;
    try {
      response = await opts.client.messages.create({
        model: opts.model,
        max_tokens: request.max_tokens,
        thinking: request.thinking,
        output_config: { effort: request.effort },
        system: opts.system,
        tools: opts.tools,
        messages,
      });
    } catch (err) {
      return done(turn, "api_error", errorMessage(err));
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    opts.onApiCall?.(costOf(response.usage.input_tokens, response.usage.output_tokens));

    if (response.stop_reason === "refusal") {
      return done(turn + 1, "refusal");
    }

    messages.push({ role: "assistant", content: response.content });

    // A truncated response may hold an incomplete tool call, so none of its calls run.
    if (
      response.stop_reason === "max_tokens" ||
      response.stop_reason === "model_context_window_exceeded"
    ) {
      return done(turn + 1, "max_tokens");
    }

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
      toolCalls.push({
        turn: turn + 1,
        id: block.id,
        name: block.name,
        input: block.input,
        result: content,
      });
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return done(opts.maxTurns, "max_turns");
}

/**
 * Where a run's transcript goes: `<dir of the task file>/../runs/<run_id>.transcript.json`.
 * The harness writes the task file to `<out>/tasks/<run_id>.json` and the run ledger to
 * `<out>/runs/<run_id>.json`, so the transcript lands next to the ledger. With
 * `--agent-uid` the harness puts the task file under a per-run temporary home instead,
 * so the transcript goes to that home's `runs/` directory and is removed with it.
 */
export function transcriptPathFor(taskPath: string, runId: string): string {
  return resolve(dirname(taskPath), "..", "runs", `${runId}.transcript.json`);
}

export interface RunLlmAgentOptions {
  client: MessagesClient;
  model: string;
  maxTurns: number;
  /** Per-run cap. */
  perRunUsd: number;
  /** Session cap, shared across runs through `spendFile`. */
  sessionUsd: number;
  /** Session spend file (X402_LLM_SPEND_FILE). Without it only the per-run cap applies. */
  spendFile?: string;
  system: string;
  userPrompt: string;
  tools: Anthropic.Tool[];
  handlers: ToolHandlerMap;
  effort?: Effort;
  /** Task file path (X402_REDTEAM_TASK). The transcript is written only when this and
   * `runId` are both set. */
  taskPath?: string;
  runId?: string;
  log?: (line: string) => void;
}

export interface RunLlmAgentResult {
  exitCode: number;
  stopReason: RunStopReason;
  estimatedCostUsd: number;
  result?: RunAgentLoopResult;
  transcriptPath?: string;
}

/**
 * One agent run: checks the session budget, runs the loop, adds each API call's cost to
 * the spend file as soon as the call returns (so a run the harness kills is still
 * counted), writes the transcript, and returns the exit code (0 only for `end_turn`).
 */
export async function runLlmAgent(opts: RunLlmAgentOptions): Promise<RunLlmAgentResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const spent = opts.spendFile ? readSpent(opts.spendFile) : 0;
  const budgetUsd = runBudget(opts.perRunUsd, opts.sessionUsd, spent);

  let result: RunAgentLoopResult | undefined;
  let stopReason: RunStopReason;
  if (budgetUsd <= 0) {
    log(
      `llm: session budget of $${opts.sessionUsd} exhausted ($${spent.toFixed(4)} spent); not calling the API.`,
    );
    stopReason = "session_exhausted";
  } else {
    const spendFile = opts.spendFile;
    result = await runAgentLoop({
      client: opts.client,
      model: opts.model,
      maxTurns: opts.maxTurns,
      budgetUsd,
      system: opts.system,
      userPrompt: opts.userPrompt,
      tools: opts.tools,
      handlers: opts.handlers,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(spendFile ? { onApiCall: (usd: number) => addSpent(spendFile, usd) } : {}),
    });
    stopReason = result.stopReason;
    log(
      `llm: stopped (${result.stopReason}) after ${result.turns} turn(s); ` +
        `${result.inputTokens} input + ${result.outputTokens} output tokens; ` +
        `estimated spend $${result.estimatedCostUsd.toFixed(4)} ` +
        `(model ${opts.model}, effort ${result.request.effort}).` +
        (result.error !== undefined ? ` API error: ${result.error}` : ""),
    );
  }

  const exitCode = exitCodeFor(stopReason);
  const estimatedCostUsd = result?.estimatedCostUsd ?? 0;
  let transcriptPath: string | undefined;
  if (opts.taskPath && opts.runId) {
    const path = transcriptPathFor(opts.taskPath, opts.runId);
    const transcript = {
      run_id: opts.runId,
      model: opts.model,
      stop_reason: stopReason,
      exit_code: exitCode,
      ...(result?.error !== undefined ? { error: result.error } : {}),
      turns: result?.turns ?? 0,
      input_tokens: result?.inputTokens ?? 0,
      output_tokens: result?.outputTokens ?? 0,
      estimated_cost_usd: estimatedCostUsd,
      request: result?.request ?? null,
      system: opts.system,
      messages: result?.transcript ?? [],
      tool_calls: result?.toolCalls ?? [],
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(transcript, null, 2)}\n`);
      transcriptPath = path;
    } catch (err) {
      log(`llm: could not write transcript ${path}: ${errorMessage(err)}`);
    }
  }

  return {
    exitCode,
    stopReason,
    estimatedCostUsd,
    ...(result ? { result } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}
