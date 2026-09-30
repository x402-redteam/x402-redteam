import { formatUsd, type Report } from "@x402-redteam/scorer";

/** One committed `results/<id>.json`, parsed. */
export interface LeaderboardEntry {
  /** The filename stem (e.g. `results/naive-baseline.json` -> `"naive-baseline"`). */
  id: string;
  report: Report;
}

export interface RankedRow {
  rank: number;
  guardrailId: string;
  scenariosPassed: number;
  scenariosTotal: number;
  /** scenariosPassed / scenariosTotal (0 when scenariosTotal is 0). */
  passRate: number;
  unauthorizedUsd: number;
  worstCategory: string;
  corpusHashShort: string;
  harnessVersion: string;
}

export interface StaleRow {
  guardrailId: string;
  corpusHashShort: string;
  harnessVersion: string;
}

export interface LeaderboardResult {
  ranked: RankedRow[];
  stale: StaleRow[];
  markdown: string;
}

const CORPUS_HASH_SHORT_LEN = 10;

function shortHash(hash: string): string {
  return hash.slice(0, CORPUS_HASH_SHORT_LEN);
}

/**
 * The category that hurt this guardrail the most: highest `unauthorized_usd`,
 * ties broken by the most scenario failures, then by category name. Returns
 * "-" when the report has no unauthorized $ and no scenario failures in any
 * category (a clean run).
 */
function worstCategory(report: Report): string {
  let best: { category: string; usd: number; failed: number } | undefined;

  for (const [category, totals] of Object.entries(report.by_category)) {
    if (totals.scenarios === 0) continue;
    const failed = totals.scenarios - totals.passed;
    if (totals.unauthorized_usd === 0 && failed === 0) continue;

    if (
      best === undefined ||
      totals.unauthorized_usd > best.usd ||
      (totals.unauthorized_usd === best.usd &&
        (failed > best.failed ||
          (failed === best.failed && category.localeCompare(best.category) < 0)))
    ) {
      best = { category, usd: totals.unauthorized_usd, failed };
    }
  }

  return best?.category ?? "-";
}

function toRow(entry: LeaderboardEntry): Omit<RankedRow, "rank"> {
  const { report } = entry;
  const scenariosTotal = report.summary.scenarios;
  const scenariosPassed = report.summary.scenarios_passed;
  return {
    guardrailId: report.guardrail_id,
    scenariosPassed,
    scenariosTotal,
    passRate: scenariosTotal === 0 ? 0 : scenariosPassed / scenariosTotal,
    unauthorizedUsd: report.summary.unauthorized_usd,
    worstCategory: worstCategory(report),
    corpusHashShort: shortHash(report.corpus_hash),
    harnessVersion: report.harness_version,
  };
}

function renderRankedTable(ranked: RankedRow[]): string[] {
  const header = [
    "| rank | guardrail | scenarios passed | pass rate | unauthorized $ at risk | worst category | corpus_hash | harness |",
    "|---|---|---|---|---|---|---|---|",
  ];
  if (ranked.length === 0) {
    return [
      ...header,
      "| _no results for the current corpus yet — see CONTRIBUTING.md_ | | | | | | | |",
    ];
  }
  const rows = ranked.map(
    (r) =>
      `| ${r.rank} | ${r.guardrailId} | ${r.scenariosPassed}/${r.scenariosTotal} | ${(r.passRate * 100).toFixed(1)}% | ${formatUsd(r.unauthorizedUsd)} | ${r.worstCategory} | \`${r.corpusHashShort}\` | ${r.harnessVersion} |`,
  );
  return [...header, ...rows];
}

function renderStaleSection(stale: StaleRow[]): string[] {
  if (stale.length === 0) {
    return ["## Stale corpus", "", "_none_"];
  }
  return [
    "## Stale corpus",
    "",
    "Generated against an older corpus; excluded from ranking above until rerun (`pnpm leaderboard` re-derives the current corpus hash from `corpus/`).",
    "",
    "| guardrail | corpus_hash | harness |",
    "|---|---|---|",
    ...stale.map((r) => `| ${r.guardrailId} | \`${r.corpusHashShort}\` | ${r.harnessVersion} |`),
  ];
}

function renderMarkdown(ranked: RankedRow[], stale: StaleRow[]): string {
  const lines = [
    "# Leaderboard",
    "",
    "Guardrail results against the current `corpus/`, ranked by scenarios passed (descending), then unauthorized $ at risk (ascending). Regenerate with `pnpm leaderboard`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to submit your own result.",
    "",
    ...renderRankedTable(ranked),
    "",
    ...renderStaleSection(stale),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Builds the leaderboard from committed `results/*.json` reports, per
 * functional-design.md §3: only entries whose `corpus_hash` matches
 * `currentCorpusHash` are ranked (scenarios passed desc, then unauthorized $
 * asc, then guardrail id for a deterministic tie-break); the rest are listed
 * separately as stale. Pure and deterministic: the same input always
 * produces byte-identical markdown.
 */
export function buildLeaderboard(
  entries: LeaderboardEntry[],
  currentCorpusHash: string,
): LeaderboardResult {
  const current: LeaderboardEntry[] = [];
  const staleEntries: LeaderboardEntry[] = [];
  for (const entry of entries) {
    if (entry.report.corpus_hash === currentCorpusHash) {
      current.push(entry);
    } else {
      staleEntries.push(entry);
    }
  }

  const ranked = current
    .map(toRow)
    .sort((a, b) => {
      if (b.scenariosPassed !== a.scenariosPassed) return b.scenariosPassed - a.scenariosPassed;
      if (a.unauthorizedUsd !== b.unauthorizedUsd) return a.unauthorizedUsd - b.unauthorizedUsd;
      return a.guardrailId.localeCompare(b.guardrailId);
    })
    .map((row, i) => ({ rank: i + 1, ...row }));

  const stale = staleEntries
    .map((entry) => ({
      guardrailId: entry.report.guardrail_id,
      corpusHashShort: shortHash(entry.report.corpus_hash),
      harnessVersion: entry.report.harness_version,
    }))
    .sort((a, b) => a.guardrailId.localeCompare(b.guardrailId));

  return { ranked, stale, markdown: renderMarkdown(ranked, stale) };
}
