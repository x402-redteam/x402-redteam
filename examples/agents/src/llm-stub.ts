/**
 * Test-only probe (U30-5): the real LLM agent task (`lib/llm-task.ts`, the HTTP and MCP
 * tools) driven by a scripted stand-in for the model, so the harness can score a run with
 * no API key and no network. Like `promptonly` and `obedient`, it is not a reference agent,
 * and is not evidence about any model.
 *
 * `X402_LLM_STUB` (passed with `--pass-env`) picks the script:
 * - `second-server`: calls the first bridged tool, then connects to the server URL its
 *   result names (`mcp_list_tools`) and calls `get_quote` there with `mcp_call` (no payment).
 * - `pay-description-payee`: sends $0.03 with `send_usdc` to the address a tool description
 *   tells the reader to pay.
 * - `pay-fair`: pays the first bridged tool once with `mcp_pay_and_call`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./lib/llm-agent.js";
import { runLlmTask } from "./lib/llm-task.js";
import { readTask } from "./lib/wallet.js";

type Call = { name: string; input: unknown };
type Script = (ctx: { tools: Anthropic.Tool[]; lastResult: string }) => Call[];

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/;
const SERVER_RE = /^\[server: ("(?:[^"\\]|\\.)*") \| tool: ("(?:[^"\\]|\\.)*")\]/;
const URL_RE = /https?:\/\/[^\s"'\\]+?\/mcp/;

function firstBridged(tools: Anthropic.Tool[]): Anthropic.Tool {
  const tool = tools.find((t) => t.name.startsWith("mcp__"));
  if (!tool) throw new Error("llm-stub: no bridged tool");
  return tool;
}

const SCRIPTS: Record<string, Script[]> = {
  "second-server": [
    ({ tools }) => [{ name: firstBridged(tools).name, input: {} }],
    ({ lastResult }) => [
      { name: "mcp_list_tools", input: { server: URL_RE.exec(lastResult)?.[0] } },
    ],
    ({ lastResult }) => [
      {
        name: "mcp_call",
        input: { server: JSON.parse(lastResult).server, tool: "get_quote" },
      },
    ],
  ],
  "pay-description-payee": [
    ({ tools }) => {
      const to = tools.map((t) => ADDRESS_RE.exec(t.description ?? "")?.[0]).find(Boolean);
      return [{ name: "send_usdc", input: { to, amount_usd: 0.03 } }];
    },
  ],
  "pay-fair": [
    ({ tools }) => {
      const described = SERVER_RE.exec(firstBridged(tools).description ?? "");
      return [
        {
          name: "mcp_pay_and_call",
          input: {
            server: JSON.parse(described?.[1] ?? "null"),
            tool: JSON.parse(described?.[2] ?? "null"),
          },
        },
      ];
    },
  ],
};

function lastToolResultText(messages: Anthropic.MessageParam[]): string {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return "";
  for (const block of last.content) {
    if (block.type === "tool_result" && typeof block.content === "string") return block.content;
  }
  return "";
}

function scriptedClient(script: Script[]): MessagesClient {
  let turn = 0;
  return {
    messages: {
      async create(params) {
        const step = script[turn++];
        const content: Anthropic.ContentBlock[] = step
          ? step({
              tools: params.tools as Anthropic.Tool[],
              lastResult: lastToolResultText(params.messages),
            }).map(
              (call, i) =>
                ({
                  type: "tool_use",
                  id: `toolu_stub_${turn}_${i}`,
                  name: call.name,
                  input: call.input,
                }) as Anthropic.ContentBlock,
            )
          : [{ type: "text", text: "done", citations: null } as Anthropic.ContentBlock];
        return {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "stub",
          content,
          stop_reason: step ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    },
  };
}

async function main(): Promise<void> {
  const script = SCRIPTS[process.env.X402_LLM_STUB ?? ""];
  if (!script) throw new Error("llm-stub: X402_LLM_STUB names no script");
  const taskPath = process.env.X402_REDTEAM_TASK;
  process.exitCode = await runLlmTask({
    task: readTask(),
    client: scriptedClient(script),
    settings: { model: "stub", maxTurns: 12, perRunUsd: 5, sessionUsd: 20 },
    system: "stub",
    ...(taskPath ? { taskPath } : {}),
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
