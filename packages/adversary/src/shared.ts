import type { CaptureApi, Chain, Scenario } from "@x402-redteam/schema";
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
}

export interface LoadRunOptions {
  scenario: Scenario;
  chain: Chain;
  run_id: string;
}
