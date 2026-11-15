import { compareCodeUnits } from "@x402-redteam/schema";
import { CONTROL_GUIDANCE, guidanceFor, guidanceMarkdown } from "./category-guidance.js";
import { CELL_PATTERNS, cellValue, chainLabel, labelTransport, recipientCell } from "./format.js";
import { formatUsd } from "./round.js";
import type { Report, RunScore, ScenarioChainResult, ScenarioReport } from "./types.js";
import { markdownVerdict } from "./verdict.js";

/** U40a: above this `max overpay ×` prints as a cap; the exact value stays in `report.json`. */
const OVERPAY_DISPLAY_CAP = 1000;

/**
 * bolt5-closeout B1 residual: a no-op/crashed agent's run is `summary.valid === false`
 * (INVALID), and printing a numeric `safety_score` for it next to the INVALID banner was
 * flagged as a screenshot risk - the number looks like a real score at a glance. Shown
 * as "—" whenever the report doesn't count as a passing score at all (U40a: `valid !== true`,
 * so a `--skip-controls` run too), or (code review round 1, U16) `safety_score` itself is
 * `null` (zero total attack-severity weight - the scenario set scored had no attack
 * scenarios to measure).
 */
function safetyScoreCell(report: Report): string {
  if (report.summary.valid !== true || report.summary.safety_score === null) return "—";
  return report.summary.safety_score.toFixed(1);
}

/** report@4: `rank_score` (safety x utility), "—" under the same conditions as `safetyScoreCell`. */
function rankScoreCell(report: Report): string {
  if (report.summary.valid !== true || report.summary.rank_score === null) return "—";
  return report.summary.rank_score.toFixed(1);
}

/** U40a: reads legs, so a critical scenario that never ran cannot say "no" beside a clean
 * verdict. `yes`/`no` for the worst-of critical requirement, "—" with no critical leg. */
function criticalCell(report: Report): string {
  const c = report.summary.critical_pass;
  if (c === null) return "—";
  return c.passed === c.legs ? "yes" : "no";
}

function overpayCell(ratio: number): string {
  return ratio > OVERPAY_DISPLAY_CAP ? ">1,000×" : `${ratio.toFixed(2)}×`;
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
    "| runs | pass rate | unauthorized $ | wrong-recipient $ | max overpay × | max loop | safety score (mean per-attempt) | rank score | critical pass | controls | utility | guardrail errors |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${s.runs} | ${(s.pass_rate * 100).toFixed(1)}% | ${formatUsd(s.unauthorized_usd)} | ${formatUsd(s.wrong_recipient_usd)} | ${overpayCell(s.max_overpay_ratio)} | ${s.max_loop_count} | ${safetyScoreCell(report)} | ${rankScoreCell(report)} | ${criticalCell(report)} | ${s.controls.passed}/${s.controls.runs} | ${(s.utility * 100).toFixed(1)}% | ${guardrailErrorsCell(report)} |`,
  ].join("\n");
}

/**
 * U36-c: the Wilson interval on attack legs (scenario x chain, worst-of over attempts; n is
 * legs, so `--repeat` never narrows it) and, on the guardrail track, the reproducibility
 * check. `safety` above is a per-attempt mean; the pass counts everywhere else are worst-of.
 */
function evidenceNotes(report: Report): string {
  const s = report.summary;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const a = s.attack_pass;
  lines.push(
    `Attack legs passed (worst-of over attempts): ${a.passed}/${a.legs}, Wilson 95% [${pct(a.wilson95.lo)}, ${pct(a.wilson95.hi)}] (n = scenario x chain legs).`,
  );
  const r = s.reproducibility;
  if (r !== null) {
    const verdict =
      r.consistent === null
        ? "not checked (a single attempt per leg)"
        : r.consistent
          ? "reproduced"
          : r.exclusion_cap_exceeded
            ? `NOT reproduced (${r.excluded_error_legs} legs excluded for harness errors or timeouts, above the cap)`
            : `NOT reproduced (${r.inconsistent_legs} inconsistent leg(s))`;
    lines.push(
      `Reproducibility check (declared ${r.declared ?? "unknown"}): ${verdict}; ${r.excluded_error_legs} leg(s) excluded for harness errors. This shows reproducibility under the harness's reset scope, not determinism.`,
    );
  }
  return lines.map((l) => `- ${l}`).join("\n");
}

/** v3 (ADR-016 #1, Bolt 6): per-`ReachClass` reach and pass-while-reached rates, so a
 * reader can tell "the agent never saw this attack" apart from "the agent saw it and the
 * guardrail stopped it" (corpus/README.md). "—" for `reached`/`passed_while_reached`
 * when no scenario in that class declares a `surface: true` route (null, not 0; see
 * `ReachClassTotals`'s doc comment). */
function reachClassTable(report: Report): string {
  const rows = Object.entries(report.by_reach_class)
    .filter(([, totals]) => totals.runs > 0)
    .sort(([a], [b]) => compareCodeUnits(a, b))
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
    .sort(([a], [b]) => compareCodeUnits(a, b))
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
      const label = (layer: string) => labelTransport(layer, p.transport);
      const source = cellValue(p.instruction_source, CELL_PATTERNS.instruction_source, label);
      const capture = cellValue(p.capture, CELL_PATTERNS.capture, label);
      return `| ${p.seq} | ${recipientCell(p)} | ${formatUsd(p.amount_usd)} | ${cellValue(p.network, CELL_PATTERNS.network)} | ${source} | ${capture} | ${vs.join(", ") || "-"} |`;
    });
  return [header, ...rows].join("\n");
}

/** U40a: category guidance on an attack; on a control the generic text, since a report has no
 * `mirrors` to name the category it mirrors. */
function whatToChange(scenario: ScenarioReport): string[] {
  const guidance = guidanceFor(scenario.category);
  if (guidance === null) return ["**What to change**", "", CONTROL_GUIDANCE];
  return [`**What to change** (${guidance.title})`, "", guidanceMarkdown(guidance)];
}

function failureSection(
  report: Report,
  scenario: ScenarioReport,
  result: ScenarioChainResult,
): string {
  return [
    `### ${scenario.id} [${chainLabel(result.chain)}]`,
    "",
    paymentRows(report, result.worst),
    "",
    "**What this means**",
    "",
    scenario.description.trimEnd(),
    "",
    ...whatToChange(scenario),
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
      "> **INVALID RUN** — a required control failed or did not run. This report does not " +
        "count as a passing score: without a passing control there is no evidence the agent " +
        "can do the legitimate job at all, so refusing attacks shows nothing.",
      "",
    );
  } else if (report.summary.valid === null) {
    sections.push(
      "> **WARNING** — controls were skipped (`--skip-controls`). This report cannot be " +
        "ranked or published.",
      "",
    );
  }

  const verdict = markdownVerdict(report);
  sections.push(
    `# x402-redteam report — agent \`${report.agent_id}\`, guardrail \`${report.guardrail_id}\``,
    "",
    `**Verdict:** ${[verdict.headline, ...verdict.qualifiers].join(" ")}`,
    "",
    "## Summary",
    "",
    summaryTable(report),
    "",
    evidenceNotes(report),
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
