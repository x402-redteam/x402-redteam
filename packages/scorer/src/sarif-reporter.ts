import type { Severity } from "@x402-redteam/schema";
import { formatUsd } from "./round.js";
import type { Report, ScenarioChainResult, ScenarioReport } from "./types.js";

const SECURITY_SEVERITY: Record<Severity, string> = {
  low: "3.0",
  medium: "5.0",
  high: "7.5",
  critical: "9.5",
};

function levelFor(severity: Severity): "error" | "warning" {
  return severity === "high" || severity === "critical" ? "error" : "warning";
}

function buildRule(scenario: ScenarioReport) {
  return {
    id: scenario.id,
    name: scenario.category,
    shortDescription: { text: scenario.title },
    fullDescription: { text: scenario.description },
    properties: {
      tags: ["security", "x402", scenario.category],
      "security-severity": SECURITY_SEVERITY[scenario.severity],
    },
    defaultConfiguration: { level: levelFor(scenario.severity) },
  };
}

function buildMessage(
  report: Report,
  chain: ScenarioChainResult["chain"],
  worst: ScenarioChainResult["worst"],
): string {
  const codes = [...new Set(worst.violations.map((v) => v.code))];
  const primary = worst.violations.find((v) => v.payment_id !== undefined);
  const run = report.runs.find((r) => r.run_id === worst.run_id);
  const payment =
    primary !== undefined
      ? run?.payments.find((p) => p.payment_id === primary.payment_id)
      : undefined;

  const paymentPart =
    payment !== undefined
      ? `paid ${formatUsd(payment.amount_usd)} to ${payment.to} (${payment.instruction_source})`
      : "no attributable payment";

  return `[${chain}] ${paymentPart}; violations: ${codes.join(", ")}`;
}

function buildResult(report: Report, scenario: ScenarioReport, result: ScenarioChainResult) {
  return {
    ruleId: scenario.id,
    level: levelFor(scenario.severity),
    message: { text: buildMessage(report, result.chain, result.worst) },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: `x402-redteam/agent/${report.agent_id}` },
          region: { startLine: 1 },
        },
      },
    ],
    partialFingerprints: { scenarioChain: `${scenario.id}:${result.chain}` },
  };
}

/**
 * SARIF 2.1.0 report, per functional-design.md §5. One rule per scenario;
 * one result per failing scenario x chain (`result.pass === false`).
 */
export function toSarif(report: Report): string {
  const rules = report.scenarios.map(buildRule);
  const results = report.scenarios.flatMap((scenario) =>
    scenario.results.filter((r) => !r.pass).map((result) => buildResult(report, scenario, result)),
  );

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0-rtm.5.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "x402-redteam",
            version: report.harness_version,
            informationUri: "https://github.com/x402-redteam/x402-redteam",
            rules,
          },
        },
        results,
      },
    ],
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}
