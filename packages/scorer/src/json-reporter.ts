import { stableStringify } from "./canonical-json.js";
import type { RedactedReport } from "./redact.js";
import type { Report } from "./types.js";

/** `report.json`: stable output (sorted keys, 2-space indent, trailing newline). */
export function toJson(report: Report): string {
  return stableStringify(report);
}

/** `report.redacted.json` (ADR-011, U19): same stable formatting as `toJson`. */
export function toRedactedJson(report: RedactedReport): string {
  return stableStringify(report);
}

/**
 * Returns a copy of `report` with all non-deterministic timing content
 * zeroed out (same run ids kept, values reset to 0), so two reports built
 * from the same inputs at different wall-clock times compare equal via
 * `toJson(stripTiming(r))`.
 */
export function stripTiming(report: Report): Report {
  const zeroedRuns: Record<string, number> = {};
  for (const runId of Object.keys(report.timing.runs)) {
    zeroedRuns[runId] = 0;
  }
  return { ...report, timing: { total_ms: 0, runs: zeroedRuns } };
}
