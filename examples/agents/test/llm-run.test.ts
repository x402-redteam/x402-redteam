/**
 * Exit status, spend recording and transcript output of one LLM agent run, driven by a
 * stubbed Messages client (no API key, no network).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ERROR_EXIT_CODE,
  type MessagesClient,
  runLlmAgent,
  transcriptPathFor,
} from "../src/lib/llm-agent.js";
import { readSpent } from "../src/lib/session-budget.js";

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
      input_tokens: partial.inputTokens ?? 100_000,
      output_tokens: partial.outputTokens ?? 10_000,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;
const toolUse = (id: string) =>
  ({
    type: "tool_use",
    id,
    name: "http_get",
    input: { url: "http://a.test/" },
  }) as Anthropic.ContentBlock;

/** 100k input + 10k output tokens at $2/$10 per MTok. */
const COST_PER_CALL = 0.3;

/** A temp `--out`-like layout: `<out>/tasks/<run_id>.json` and `<out>/runs/`. */
function setup(spentSoFar = 0) {
  const out = mkdtempSync(join(tmpdir(), "x402-llm-run-"));
  mkdirSync(join(out, "tasks"));
  mkdirSync(join(out, "runs"));
  const runId = "run-abc";
  const taskPath = join(out, "tasks", `${runId}.json`);
  writeFileSync(taskPath, "{}");
  const spendFile = join(out, "spend");
  if (spentSoFar > 0) writeFileSync(spendFile, `${spentSoFar}\n`);
  return { out, runId, taskPath, spendFile };
}

function run(
  client: MessagesClient,
  s: ReturnType<typeof setup>,
  over: Record<string, unknown> = {},
) {
  return runLlmAgent({
    client,
    model: "claude-sonnet-5",
    maxTurns: 12,
    perRunUsd: 5,
    sessionUsd: 20,
    spendFile: s.spendFile,
    system: "system prompt",
    userPrompt: "user prompt",
    tools: [{ name: "http_get", input_schema: { type: "object", properties: {} } }],
    handlers: { http_get: vi.fn().mockResolvedValue('{"status":200}') },
    taskPath: s.taskPath,
    runId: s.runId,
    log: () => {},
    ...over,
  });
}

describe("transcript write failure", () => {
  it("keeps the exit code when the transcript cannot be written", async () => {
    const s = setup();
    // A regular file where the out directory should be makes mkdir fail.
    const blocker = join(s.out, "blocker");
    writeFileSync(blocker, "");
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "refusal", content: [text("no")] }));
    const r = await run({ messages: { create } }, s, {
      taskPath: join(blocker, "tasks", `${s.runId}.json`),
    });
    expect(r.exitCode).toBe(3);
    expect(r.transcriptPath).toBeUndefined();
  });
});

function readTranscript(s: ReturnType<typeof setup>) {
  return JSON.parse(readFileSync(join(s.out, "runs", `${s.runId}.transcript.json`), "utf8"));
}

describe("runLlmAgent exit status", () => {
  it("returns 0 when the model ends its turn normally, and records the spend", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "tool_use", content: [toolUse("t1")] }))
      .mockResolvedValueOnce(fakeMessage({ stopReason: "end_turn", content: [text("done")] }));
    const r = await run({ messages: { create } }, s);
    expect(r.stopReason).toBe("end_turn");
    expect(r.exitCode).toBe(0);
    expect(readSpent(s.spendFile)).toBeCloseTo(2 * COST_PER_CALL, 6);
  });

  it("returns 3 when the per-run budget is exhausted, and records the spend", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage({ stopReason: "tool_use", content: [toolUse("t1")] }));
    const r = await run({ messages: { create } }, s, { perRunUsd: 0.5 });
    expect(r.stopReason).toBe("budget_exhausted");
    expect(r.exitCode).toBe(AGENT_ERROR_EXIT_CODE);
    expect(create).toHaveBeenCalledTimes(2);
    expect(readSpent(s.spendFile)).toBeCloseTo(2 * COST_PER_CALL, 6);
  });

  it("returns 3 without calling the API when the session budget is already spent", async () => {
    const s = setup(20);
    const create = vi.fn();
    const r = await run({ messages: { create } }, s);
    expect(r.stopReason).toBe("session_exhausted");
    expect(r.exitCode).toBe(3);
    expect(create).not.toHaveBeenCalled();
    expect(readSpent(s.spendFile)).toBe(20);
  });

  it("returns 3 on a refusal, and records the spend", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "refusal", content: [] }));
    const r = await run({ messages: { create } }, s);
    expect(r.stopReason).toBe("refusal");
    expect(r.exitCode).toBe(3);
    expect(readSpent(s.spendFile)).toBeCloseTo(COST_PER_CALL, 6);
  });

  it("returns 3 on max_tokens, and records the spend", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "max_tokens", content: [text("cut off")] }));
    const r = await run({ messages: { create } }, s);
    expect(r.stopReason).toBe("max_tokens");
    expect(r.exitCode).toBe(3);
    expect(readSpent(s.spendFile)).toBeCloseTo(COST_PER_CALL, 6);
  });

  it("returns 3 on a turn without tool use that is not end_turn, and records the spend", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "pause_turn", content: [text("...")] }));
    const r = await run({ messages: { create } }, s);
    expect(r.stopReason).toBe("no_tool_use");
    expect(r.exitCode).toBe(3);
    expect(readSpent(s.spendFile)).toBeCloseTo(COST_PER_CALL, 6);
  });

  it("returns 3 when max turns is reached, and records the spend", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage({ stopReason: "tool_use", content: [toolUse("t1")] }));
    const r = await run({ messages: { create } }, s, { maxTurns: 3 });
    expect(r.stopReason).toBe("max_turns");
    expect(r.exitCode).toBe(3);
    expect(readSpent(s.spendFile)).toBeCloseTo(3 * COST_PER_CALL, 6);
  });

  it("returns 3 on an API error, and keeps the spend of earlier calls", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "tool_use", content: [toolUse("t1")] }))
      .mockRejectedValueOnce(new Error("overloaded"));
    const r = await run({ messages: { create } }, s);
    expect(r.stopReason).toBe("api_error");
    expect(r.exitCode).toBe(3);
    expect(readSpent(s.spendFile)).toBeCloseTo(COST_PER_CALL, 6);
  });

  it("records spend after each call, before the run finishes", async () => {
    const s = setup();
    const seen: number[] = [];
    const create = vi.fn().mockImplementation(async () => {
      seen.push(readSpent(s.spendFile));
      return fakeMessage({
        stopReason: seen.length < 3 ? "tool_use" : "end_turn",
        content: seen.length < 3 ? [toolUse(`t${seen.length}`)] : [text("done")],
      });
    });
    await run({ messages: { create } }, s);
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeCloseTo(COST_PER_CALL, 6);
    expect(seen[2]).toBeCloseTo(2 * COST_PER_CALL, 6);
  });
});

describe("runLlmAgent transcript", () => {
  it("is written next to the run ledger, derived from the task file location", () => {
    expect(transcriptPathFor("/x/out/tasks/r1.json", "r1")).toBe("/x/out/runs/r1.transcript.json");
  });

  it("holds messages, tool calls, stop reason, cost, model and request settings", async () => {
    const s = setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage({ stopReason: "tool_use", content: [toolUse("t1")] }))
      .mockResolvedValueOnce(fakeMessage({ stopReason: "max_tokens", content: [text("cut")] }));
    const r = await run({ messages: { create } }, s);
    const t = readTranscript(s);
    expect(r.transcriptPath).toBe(join(s.out, "runs", `${s.runId}.transcript.json`));
    expect(t.run_id).toBe(s.runId);
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.stop_reason).toBe("max_tokens");
    expect(t.exit_code).toBe(3);
    expect(t.estimated_cost_usd).toBeCloseTo(2 * COST_PER_CALL, 6);
    expect(t.request).toEqual({
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      effort: "high",
    });
    expect(t.tool_calls).toEqual([
      {
        turn: 1,
        id: "t1",
        name: "http_get",
        input: { url: "http://a.test/" },
        result: '{"status":200}',
      },
    ]);
    expect(t.messages.length).toBe(4);
    expect(t.messages[0]).toEqual({ role: "user", content: "user prompt" });
  });

  it("is written when the session budget was already spent", async () => {
    const s = setup(20);
    await run({ messages: { create: vi.fn() } }, s);
    const t = readTranscript(s);
    expect(t.stop_reason).toBe("session_exhausted");
    expect(t.exit_code).toBe(3);
    expect(t.estimated_cost_usd).toBe(0);
  });

  it("records the API error message", async () => {
    const s = setup();
    const create = vi.fn().mockRejectedValueOnce(new Error("overloaded"));
    await run({ messages: { create } }, s);
    expect(readTranscript(s).error).toMatch(/overloaded/);
  });
});
