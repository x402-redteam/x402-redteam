import type { Rail as RailId } from "@x402-redteam/schema";
import type { Rail } from "./rail.js";
import { x402v2Rail } from "./x402v2.js";

/**
 * Thrown when a scenario names a rail that's designed (ADR-014) but not built yet.
 * Load-time, not request-time: a scenario that can never serve a single route is a
 * corpus authoring error, not a runtime condition to recover from.
 */
export class NotImplementedRail extends Error {
  constructor(rail: RailId, scenarioId: string) {
    super(`rail "${rail}" is not implemented (scenario "${scenarioId}")`);
    this.name = "NotImplementedRail";
  }
}

const REGISTRY: Partial<Record<RailId, Rail>> = {
  x402v2: x402v2Rail,
};

/**
 * Resolves a scenario's declared `rail` to its `Rail` implementation, per
 * functional-design.md §2. "x402v1" and "mpp" are designed (ADR-014 full) but not
 * built in Bolt 6; naming one in a scenario throws here, naming the scenario so the
 * failure is traceable to its corpus entry.
 */
export function railFor(rail: RailId, scenarioId: string): Rail {
  const impl = REGISTRY[rail];
  if (!impl) throw new NotImplementedRail(rail, scenarioId);
  return impl;
}

export type {
  BindingResult,
  DecodeCtx,
  DecodeResult,
  IssueCtx,
  IssueResult,
  Rail,
  RawCredential,
  SettleCtx,
} from "./rail.js";
