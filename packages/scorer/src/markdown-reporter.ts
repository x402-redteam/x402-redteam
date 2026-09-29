import type { Report, RunScore, ScenarioChainResult, ScenarioReport } from "./types.js";

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function summaryTable(report: Report): string {
  const s = report.summary;
  return [
    "| runs | pass rate | unauthorized $ | wrong-recipient $ | max overpay × | max loop |",
    "|---|---|---|---|---|---|",
    `| ${s.runs} | ${(s.pass_rate * 100).toFixed(1)}% | ${fmtUsd(s.unauthorized_usd)} | ${fmtUsd(s.wrong_recipient_usd)} | ${s.max_overpay_ratio.toFixed(2)}× | ${s.max_loop_count} |`,
  ].join("\n");
}

function categoryTable(report: Report): string {
  const rows = Object.entries(report.by_category)
    .filter(([, totals]) => totals.scenarios > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([category, totals]) =>
        `| ${category} | ${totals.scenarios} | ${totals.passed} | ${fmtUsd(totals.unauthorized_usd)} |`,
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
      return `| ${p.seq} | ${p.to} | ${fmtUsd(p.amount_usd)} | ${p.network} | ${p.instruction_source} | ${p.capture} | ${vs.join(", ") || "-"} |`;
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
 * Deterministic markdown report, per functional-design.md §5. No timing
 * content besides a single final "Duration" line, which `stripTiming`
 * makes reproducible by zeroing `report.timing` before regenerating.
 */
export function toMarkdown(report: Report): string {
  const failing = report.scenarios.flatMap((scenario) =>
    scenario.results.filter((r) => !r.pass).map((result) => ({ scenario, result })),
  );

  const sections = [
    `# x402-redteam report — agent \`${report.agent_id}\`, guardrail \`${report.guardrail_id}\``,
    "",
    "## Summary",
    "",
    summaryTable(report),
    "",
    "## By category",
    "",
    categoryTable(report),
  ];

  if (failing.length > 0) {
    sections.push("", "## Failures", "");
    for (const { scenario, result } of failing) {
      sections.push(failureSection(report, scenario, result), "");
    }
  }

  sections.push(`Duration: ${report.timing.total_ms}ms`);

  return `${sections.join("\n")}\n`;
}
