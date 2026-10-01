/**
 * `pnpm leaderboard`: reads every committed `results/*.json` report (never
 * `results/internal/**`, which isn't a `.json` file at the top level of `results/` —
 * see `load-results.ts`) plus `results/_meta.json`, derives the current corpus's hash
 * and scenario set from `corpus/` for the acceptance checks and re-score in
 * `build-leaderboard.ts` §3, and writes `LEADERBOARD.md` at the repo root. Run from the
 * repo root (the root `leaderboard` script does this).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCorpus } from "@x402-redteam/schema";
import { buildLeaderboard } from "./build-leaderboard.js";
import { loadResultsDir, loadResultsMeta } from "./load-results.js";

function main(): void {
  const root = process.cwd();
  const resultsDir = resolve(root, "results");
  const corpusDir = resolve(root, "corpus");

  const entries = loadResultsDir(resultsDir);
  const meta = loadResultsMeta(resultsDir);
  const scenarios = loadCorpus(corpusDir);

  const { markdown, ranked, stale, rejected } = buildLeaderboard(entries, scenarios, meta);
  writeFileSync(resolve(root, "LEADERBOARD.md"), markdown);

  console.log(
    `Wrote LEADERBOARD.md: ${ranked.length} ranked, ${stale.length} stale, ${rejected.length} rejected`,
  );
}

main();
