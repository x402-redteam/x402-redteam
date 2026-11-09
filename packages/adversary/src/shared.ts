import type { CaptureApi, Chain, Scenario } from "@x402-redteam/schema";
import type { DecodeQueue } from "./limits.js";
import type { RenderedScenario } from "./render.js";
import type { RunState } from "./state.js";

export interface LoadedRun {
  state: RunState;
  rendered: RenderedScenario;
}

/**
 * Mutable holder shared by every route module. `createAdversary` owns the one
 * instance; `load()` replaces `.current`, everything else just reads it.
 */
export class RunHolder {
  current: LoadedRun | null = null;
}

export interface Shared {
  seed: string;
  capture: CaptureApi;
  holder: RunHolder;
  /** U38: the single-flight FIFO queue every decode of agent-supplied data goes through. */
  gate: DecodeQueue;
  /** U33-0: every MCP challenge also carries a copy in `result._meta` (non-spec, opt-in). */
  mcpChallengeMeta?: boolean;
}

export interface LoadRunOptions {
  scenario: Scenario;
  chain: Chain;
  run_id: string;
}
