import type { Category, ReachClass, Severity } from "@x402-redteam/schema";
import type { CategoryTotals, Report, ReportSummary, RunConfig, SeverityTotals } from "./types.js";

/**
 * `report@3-redacted` (ADR-011, application-design.md "Contracts (v3, Bolt 6)"; security
 * review finding CRITICAL-2): the only artifact a Tier 1 ranked run publishes. Holds
 * *only* `summary`/`by_category`/`by_severity`/`by_reach_class`/`config` plus the
 * `corpus_hash`/`harness_version`/`agent_id`/`guardrail_id` identity fields - literally
 * "summary, by_*, config and hashes" per ADR-011, nothing else. `scenarios[]` (every
 * scenario id, title, description) and `runs[]` (every request URL, host, canary,
 * violation message) are both dropped entirely, not merely blanked - a held-out
 * scenario's id or description is itself corpus content this report must never reveal.
 * The top-level `seed` field is dropped too, even though `run.ts` already overwrites it
 * to `"season:<id>"` before this ever runs - this module makes no assumption about what
 * its caller already redacted.
 */
export interface RedactedReport {
  schema: "x402-redteam/report@3-redacted";
  harness_version: string;
  agent_id: string;
  guardrail_id: string;
  corpus_hash: string;
  config: RunConfig;
  summary: ReportSummary;
  by_category: Record<Category, CategoryTotals>;
  by_severity: Record<Severity, SeverityTotals>;
  by_reach_class: Record<ReachClass, ReachClassTotalsRedacted>;
}

/** Re-declared rather than imported from `./types.js` only to keep this file's public
 * surface self-contained and obviously complete under review - identical shape. */
interface ReachClassTotalsRedacted {
  runs: number;
  passed: number;
  pass_rate: number;
  reached: number | null;
  passed_while_reached: number | null;
}

/**
 * Pure (ADR-011 / functional-design.md §2, security review CRITICAL-2): `redact(report)
 * -> report@3-redacted`. Keeps `summary`/`by_category`/`by_severity`/`by_reach_class`/
 * `config` and the identity/hash fields byte-identical; drops `scenarios[]` and
 * `runs[]` and the top-level `seed` entirely (not blanked - absent). There is nothing
 * left to blank inside `summary`/`by_*`/`config` that names a held-out scenario, host or
 * canary - those only ever lived in `scenarios[]`/`runs[]`.
 */
export function redact(report: Report): RedactedReport {
  return {
    schema: "x402-redteam/report@3-redacted",
    harness_version: report.harness_version,
    agent_id: report.agent_id,
    guardrail_id: report.guardrail_id,
    corpus_hash: report.corpus_hash,
    config: report.config,
    summary: report.summary,
    by_category: report.by_category,
    by_severity: report.by_severity,
    by_reach_class: report.by_reach_class,
  };
}
