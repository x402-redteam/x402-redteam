/**
 * llm mode (U25 §3.3, §3.5.5): the built-in LLM agent's Claude loop and system prompt
 * (examples/agents/src/lib/llm-agent.ts and lib/llm-config.ts, imported by relative path)
 * with AgentKit's own actions as the tools. Each tool call runs in the sandboxed child
 * over fd 3, and its result goes back to the model exactly as AgentKit returned it.
 *
 * What this holds constant and what it varies: the model, the system prompt, the turn cap
 * and the budgets are the built-in agent's; the tool names, descriptions, input schemas,
 * result text and wallet are AgentKit's. AgentKit's own template prompt and step limit are
 * not used.
 *
 * A run is not measured, and exits 3, when the child fails a call (unknown action, input
 * that fails AgentKit's schema, an exception), when the child crashes, or when a result
 * shows a failure of the run itself rather than an outcome (classify.ts: a guard refusal
 * of a task host, a transport or signing failure). The adapter then stops the loop before
 * the next API call. Every other AgentKit result, including its own `error: true`
 * outcomes and a refusal of a host outside the task, is measured behaviour and goes to
 * the model unchanged.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { type MessagesClient, runLlmAgent } from "../../../agents/src/lib/llm-agent.js";
import { buildSystemPrompt, readLlmSettings } from "../../../agents/src/lib/llm-config.js";
import type { AgentKitChild } from "./child-client.js";
import { classifyResult } from "./classify.js";
import { UnmeasuredError } from "./provenance.js";
import { type TaskFile, taskHostnames } from "./task.js";

/** The action providers llm mode exposes, exactly (U25 §3.5.5). */
export const LLM_PROVIDERS = ["X402ActionProvider", "WalletActionProvider", "ERC20ActionProvider"];

/** Actions of those providers that need a CDP API or a network beyond the task hosts. */
export const EXCLUDED_ACTIONS: Record<string, string> = {
  X402ActionProvider_discover_x402_services:
    "queries a facilitator's discovery endpoint (Coinbase CDP by default), not a task host",
};

/** One entry of the child's `__list_actions`: AgentKit's name, description and schema
 * (converted with zod-to-json-schema). */
export interface ListedAction {
  name: string;
  description: string;
  input_schema: unknown;
}

/** AgentKit's actions as Anthropic tools: names and descriptions unchanged, the
 * zod-to-json-schema output as the input schema minus its `$schema` key. */
export function toTools(listed: ListedAction[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const action of listed) {
    const provider = action.name.split("_")[0] ?? "";
    if (!LLM_PROVIDERS.includes(provider)) {
      throw new UnmeasuredError(
        `the child offers an action outside llm mode's providers: ${action.name}`,
      );
    }
    if (action.name in EXCLUDED_ACTIONS) continue;
    const { $schema: _, ...schema } = (action.input_schema ?? {}) as Record<string, unknown>;
    if (schema.type !== "object") {
      throw new UnmeasuredError(`${action.name}: its input schema is not a JSON object schema`);
    }
    tools.push({
      name: action.name,
      description: action.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
    });
  }
  return tools;
}

/** Fails unless the child's environment is free of any Anthropic variable (ADR-029 §1). */
export function checkChildEnv(names: string[]): string[] {
  const leaked = names.filter((name) => name.startsWith("ANTHROPIC_"));
  if (leaked.length > 0) {
    throw new UnmeasuredError(`the AgentKit child can see ${leaked.join(", ")}`);
  }
  return names;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Handler = (input: unknown) => Promise<string>;

/**
 * Runs the model's tool calls in the child and records any failure that makes the run
 * unmeasured. Once one is recorded, the wrapped client refuses the next API call, so the
 * loop stops (stop reason api_error, which exits 3) and its transcript is still written.
 */
export class ToolBridge {
  readonly fatal: string[] = [];
  private readonly taskHosts: Set<string>;

  constructor(
    private readonly child: AgentKitChild,
    task: TaskFile,
    private readonly log: (line: string) => void,
  ) {
    this.taskHosts = taskHostnames(task);
  }

  handler(name: string): Handler {
    return async (input) => {
      let raw: unknown;
      try {
        raw = await this.child.call(name, input);
      } catch (err) {
        this.fatal.push(`${name}: ${errorText(err)}`);
        return JSON.stringify({ adapter_error: errorText(err) });
      }
      const result =
        raw === undefined ? "null" : typeof raw === "string" ? raw : JSON.stringify(raw);
      const verdict = classifyResult(result, this.taskHosts);
      if (verdict.kind === "unmeasured") {
        this.fatal.push(`${name}: ${verdict.reason}`);
      } else if (verdict.kind === "refused_non_task_host") {
        this.log(`agentkit adapter: refused non-task host ${verdict.host} (measured)`);
      }
      return result;
    };
  }

  handlers(tools: Anthropic.Tool[]): Record<string, Handler> {
    return Object.fromEntries(tools.map((tool) => [tool.name, this.handler(tool.name)]));
  }

  guard(client: MessagesClient): MessagesClient {
    return {
      messages: {
        create: (params) => {
          if (this.fatal.length > 0) {
            return Promise.reject(
              new Error(`the adapter stopped the run: ${this.fatal.join("; ")}`),
            );
          }
          return client.messages.create(params);
        },
      },
    };
  }
}

export interface RunLlmOptions {
  child: AgentKitChild;
  task: TaskFile;
  taskPath: string;
  client: MessagesClient;
  /** X402_LLM_* settings and X402_LLM_POLICY_HINTS are read from here. */
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** One llm-mode run. Resolves with runLlmAgent's exit code (0 only for end_turn), or
 * throws UnmeasuredError when the child failed a call. */
export async function runLlm(opts: RunLlmOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const settings = readLlmSettings(opts.env);
  const tools = toTools((await opts.child.call("__list_actions")) as ListedAction[]);
  const bridge = new ToolBridge(opts.child, opts.task, log);
  const { exitCode } = await runLlmAgent({
    client: bridge.guard(opts.client),
    model: settings.model,
    maxTurns: settings.maxTurns,
    perRunUsd: settings.perRunUsd,
    sessionUsd: settings.sessionUsd,
    ...(settings.spendFile ? { spendFile: settings.spendFile } : {}),
    system: buildSystemPrompt(opts.task, opts.env),
    userPrompt: opts.task.prompt,
    tools,
    handlers: bridge.handlers(tools),
    taskPath: opts.taskPath,
    runId: opts.task.run_id,
    log,
  });
  if (bridge.fatal.length > 0) {
    throw new UnmeasuredError(`the run did not measure cleanly: ${bridge.fatal.join("; ")}`);
  }
  return exitCode;
}
