import { formatUsd } from "./round.js";
import type { Report, RunScore, ScenarioChainResult, ScenarioReport } from "./types.js";

/**
 * bolt5-closeout B1 residual: a no-op/crashed agent's run is `summary.valid === false`
 * (INVALID), and printing a numeric `safety_score` for it next to the INVALID banner was
 * flagged as a screenshot risk - the number looks like a real score at a glance. Shown
 * as "—" whenever the report doesn't count as a passing score at all, or (code review
 * round 1, U16) `safety_score` itself is `null` (zero total attack-severity weight - the
 * scenario set scored had no attack scenarios to measure).
 */
function safetyScoreCell(report: Report): string {
  if (report.summary.valid === false || report.summary.safety_score === null) return "—";
  return report.summary.safety_score.toFixed(1);
}

/** U18b item 2: "—" off the guardrail track (`null` - the column is meaningless
 * there), else the raw count, so a broken guardrail (GDP protocol errors - timeouts,
 * malformed lines, invalid decisions, a mid-run exit) stays visible in the report a
 * human actually reads, not just in `report.json`. */
function guardrailErrorsCell(report: Report): string {
  const n = report.summary.guardrail_errors;
  return n === null ? "—" : String(n);
}

function summaryTable(report: Report): string {
  const s = report.summary;
  return [
    "| runs | pass rate | unauthorized $ | wrong-recipient $ | max overpay × | max loop | safety score | controls | utility | guardrail errors |",
    "|---|---|---|---|---|---|---|---|---|---|",
    `| ${s.runs} | ${(s.pass_rate * 100).toFixed(1)}% | ${formatUsd(s.unauthorized_usd)} | ${formatUsd(s.wrong_recipient_usd)} | ${s.max_overpay_ratio.toFixed(2)}× | ${s.max_loop_count} | ${safetyScoreCell(report)} | ${s.controls.passed}/${s.controls.runs} | ${(s.utility * 100).toFixed(1)}% | ${guardrailErrorsCell(report)} |`,
  ].join("\n");
}

/** v3 (ADR-016 #1, Bolt 6): per-`ReachClass` reach and pass-while-reached rates, so a
 * reader can tell "the agent never saw this attack" apart from "the agent saw it and the
 * guardrail stopped it" (corpus/README.md). "—" for `reached`/`passed_while_reached`
 * when no scenario in that class declares a `surface: true` route (null, not 0; see
 * `ReachClassTotals`'s doc comment). */
function reachClassTable(report: Report): string {
  const rows = Object.entries(report.by_reach_class)
    .filter(([, totals]) => totals.runs > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reachClass, totals]) => {
      const reached = totals.reached === null ? "—" : `${totals.reached}/${totals.runs}`;
      const passedWhileReached =
        totals.passed_while_reached === null ? "—" : `${totals.passed_while_reached}`;
      return `| ${reachClass} | ${totals.runs} | ${totals.passed} | ${(totals.pass_rate * 100).toFixed(1)}% | ${reached} | ${passedWhileReached} |`;
    });
  return [
    "| reach class | runs | passed | pass rate | reached | passed while reached |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function categoryTable(report: Report): string {
  const rows = Object.entries(report.by_category)
    .filter(([, totals]) => totals.scenarios > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([category, totals]) =>
        `| ${category} | ${totals.scenarios} | ${totals.passed} | ${formatUsd(totals.unauthorized_usd)} |`,
    );
  return ["| category | scenarios | passed | unauthorized $ |", "|---|---|---|---|", ...rows].join(
    "\n",
  );
}

function paymentRows(report: Report, worst: RunScore): string {
  const run = report.runs.find((r) => r.run_id === worst.run_id);
  if (run === undefined || run.payments.length === 0) return "_no payments recorded_\n";

  const violationsByPayment = new Map<string, string[]>();
  for (const v of worst.violations) {
    if (v.payment_id === undefined) continue;
    const list = violationsByPayment.get(v.payment_id) ?? [];
    list.push(v.code);
    violationsByPayment.set(v.payment_id, list);
  }

  const header =
    "| seq | to | $ | network | instruction_source | capture | violations |\n|---|---|---|---|---|---|---|";
  const rows = [...run.payments]
    .sort((a, b) => a.seq - b.seq)
    .map((p) => {
      const vs = violationsByPayment.get(p.payment_id) ?? [];
      return `| ${p.seq} | ${p.to} | ${formatUsd(p.amount_usd)} | ${p.network} | ${p.instruction_source} | ${p.capture} | ${vs.join(", ") || "-"} |`;
    });
  return [header, ...rows].join("\n");
}

function failureSection(
  report: Report,
  scenario: ScenarioReport,
  result: ScenarioChainResult,
): string {
  return [
    `### ${scenario.id} [${result.chain}]`,
    "",
    paymentRows(report, result.worst),
    "",
    "**What this means**",
    "",
    scenario.description,
  ].join("\n");
}

/**
 * Deterministic markdown report, per functional-design.md §5 (v1) and U9
 * Part B functional-design.md §B4 (v2 INVALID banner). No timing content
 * besides a single final "Duration" line, which `stripTiming` makes
 * reproducible by zeroing `report.timing` before regenerating.
 */
export function toMarkdown(report: Report): string {
  const failing = report.scenarios.flatMap((scenario) =>
    scenario.results.filter((r) => !r.pass).map((result) => ({ scenario, result })),
  );

  const sections: string[] = [];

  if (report.summary.valid === false) {
    sections.push(
      "> **INVALID RUN** — one or more control scenarios failed. This report does not " +
        "count as a passing score: an agent that fails a control is failing to do the " +
        "legitimate job at all, not just refusing attacks.",
      "",
    );
  } else if (report.summary.valid === null) {
    sections.push(
      "> **WARNING** — controls were skipped (`--skip-controls`). This report cannot be " +
        "ranked or published.",
      "",
    );
  }

  sections.push(
    `# x402-redteam report — agent \`${report.agent_id}\`, guardrail \`${report.guardrail_id}\``,
    "",
    "## Summary",
    "",
    summaryTable(report),
    "",
    "## By category",
    "",
    categoryTable(report),
    "",
    "## By reach class",
    "",
    reachClassTable(report),
  );

  if (failing.length > 0) {
    sections.push("", "## Failures", "");
    for (const { scenario, result } of failing) {
      sections.push(failureSection(report, scenario, result), "");
    }
  }

  sections.push(`Duration: ${report.timing.total_ms}ms`);

  return `${sections.join("\n")}\n`;
}
