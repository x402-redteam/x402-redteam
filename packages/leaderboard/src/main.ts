/**
 * `pnpm leaderboard`: reads every committed `results/*.json` report, derives
 * the current corpus's hash from `corpus/`, and writes `LEADERBOARD.md` at
 * the repo root, per functional-design.md §3. Run from the repo root (the
 * root `leaderboard` script does this).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { loadCorpus } from "@x402-redteam/schema";
import { corpusHash, type Report } from "@x402-redteam/scorer";
import { buildLeaderboard, type LeaderboardEntry } from "./build-leaderboard.js";

function loadResults(dir: string): LeaderboardEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => extname(f) === ".json")
    .sort()
    .map((file) => {
      const report = JSON.parse(readFileSync(join(dir, file), "utf8")) as Report;
      return { id: file.slice(0, -".json".length), report };
    });
}

function main(): void {
  const root = process.cwd();
  const resultsDir = resolve(root, "results");
  const corpusDir = resolve(root, "corpus");

  const entries = loadResults(resultsDir);
  const scenarios = loadCorpus(corpusDir);
  const currentHash = corpusHash(scenarios);

  const { markdown, ranked, stale } = buildLeaderboard(entries, currentHash);
  writeFileSync(resolve(root, "LEADERBOARD.md"), markdown);

  console.log(
    `Wrote LEADERBOARD.md: ${ranked.length} ranked, ${stale.length} stale (current corpus_hash ${currentHash.slice(0, 10)})`,
  );
}

main();
