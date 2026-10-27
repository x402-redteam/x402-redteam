/**
 * One LLM agent task, end to end (the part of `../llm.ts` that does not need a key): the HTTP
 * tools, and for a task with `mcp_servers` the MCP tools of U30-5, then the run itself. A
 * separate module so tests drive it with a stubbed `MessagesClient`.
 *
 * An MCP task is refused in `proxy` host mode, and exits 3 before the first API call if
 * bridging fails. Every MCP client is closed in a `finally`, whatever way the run ends.
 */
import { AGENT_ERROR_EXIT_CODE, type MessagesClient, runLlmAgent } from "./llm-agent.js";
import type { LlmSettings } from "./llm-config.js";
import { bridgeMcpTools, type McpToolset } from "./llm-mcp.js";
import { createToolHandlers, createUrlGuard, LLM_TOOLS, toHandlerMap } from "./llm-tools.js";
import { mcpServers } from "./mcp.js";
import { refuseUnsupportedProxyMode, type TaskFile } from "./wallet.js";

export interface RunLlmTaskOptions {
  task: TaskFile;
  client: MessagesClient;
  settings: LlmSettings;
  system: string;
  /** X402_REDTEAM_TASK, for the transcript path. */
  taskPath?: string;
  log?: (line: string) => void;
}

export async function runLlmTask(opts: RunLlmTaskOptions): Promise<number> {
  const { task, settings } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const guard = createUrlGuard(task, log);

  let mcp: McpToolset | undefined;
  if (Object.keys(mcpServers(task)).length > 0) {
    // The MCP SDK transport uses Node `fetch`, which ignores proxy variables.
    refuseUnsupportedProxyMode(task);
    try {
      mcp = await bridgeMcpTools(task, { guard, log });
    } catch (err) {
      log(`llm: MCP bridging failed: ${err instanceof Error ? err.message : String(err)}`);
      return AGENT_ERROR_EXIT_CODE;
    }
  }

  try {
    const { exitCode } = await runLlmAgent({
      client: opts.client,
      model: settings.model,
      maxTurns: settings.maxTurns,
      perRunUsd: settings.perRunUsd,
      sessionUsd: settings.sessionUsd,
      ...(settings.spendFile ? { spendFile: settings.spendFile } : {}),
      system: opts.system,
      userPrompt: task.prompt,
      tools: [...LLM_TOOLS, ...(mcp?.tools ?? [])],
      handlers: { ...toHandlerMap(createToolHandlers(task, { guard })), ...(mcp?.handlers ?? {}) },
      ...(opts.taskPath ? { taskPath: opts.taskPath } : {}),
      runId: task.run_id,
      log,
    });
    return exitCode;
  } finally {
    await mcp?.close();
  }
}
