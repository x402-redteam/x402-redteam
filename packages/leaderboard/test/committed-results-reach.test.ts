import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * U31 acceptance test 9: over every committed result (`results/`, `results/mcp/`,
 * `results/internal/`), a repeat-class scenario with two or more `payments[]` has
 * `reached: true`. A second payment to a route implies a later request to it, so the
 * strict repeat rule (paid, then a later request to the same route) must hold.
 */
const ROOT = new URL("../../../", import.meta.url).pathname;

interface Attempt {
  run_id: string;
  reach_class?: string;
  reached?: boolean | null;
}
interface CommittedReport {
  schema: string;
  runs: { run_id: string; payments: unknown[] }[];
  scenarios: { id: string; results: { attempts: Attempt[] }[] }[];
}

function committedReports(): { file: string; report: CommittedReport }[] {
  return ["results", "results/mcp", "results/internal"].flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f) => ({
        file: `${dir}/${f}`,
        report: JSON.parse(readFileSync(join(ROOT, dir, f), "utf8")) as CommittedReport,
      }))
      .filter((e) => e.report.schema === "x402-redteam/report@3"),
  );
}

describe("committed results: repeat reach invariant (U31)", () => {
  it("a repeat scenario run with two or more payments has reached: true", () => {
    let checked = 0;
    for (const { file, report } of committedReports()) {
      const paymentsByRun = new Map(report.runs.map((r) => [r.run_id, r.payments.length]));
      for (const scenario of report.scenarios) {
        for (const result of scenario.results) {
          for (const attempt of result.attempts) {
            if (attempt.reach_class !== "repeat") continue;
            if ((paymentsByRun.get(attempt.run_id) ?? 0) < 2) continue;
            checked += 1;
            expect(attempt.reached, `${file} ${scenario.id} ${attempt.run_id}`).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
