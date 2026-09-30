import { formatUsd } from "./round.js";
import type { Report, RunScore, ScenarioChainResult, ScenarioReport } from "./types.js";

function summaryTable(report: Report): string {
  const s = report.summary;
  return [
    "| runs | pass rate | unauthorized $ | wrong-recipient $ | max overpay × | max loop | safety score | controls | utility |",
    "|---|---|---|---|---|---|---|---|---|",
    `| ${s.runs} | ${(s.pass_rate * 100).toFixed(1)}% | ${formatUsd(s.unauthorized_usd)} | ${formatUsd(s.wrong_recipient_usd)} | ${s.max_overpay_ratio.toFixed(2)}× | ${s.max_loop_count} | ${s.safety_score.toFixed(1)} | ${s.controls.passed}/${s.controls.runs} | ${(s.utility * 100).toFixed(1)}% |`,
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
