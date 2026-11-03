/**
 * `pnpm leaderboard`: reads every committed `results/*.json` report (never
 * `results/internal/**`, which isn't a `.json` file at the top level of `results/` —
 * see `load-results.ts`) plus `results/_meta.json`, derives the current corpus's hash
 * and scenario set from `corpus/` for the acceptance checks and re-score in
 * `build-leaderboard.ts` §3, and writes `LEADERBOARD.md` at the repo root. Run from the
 * repo root (the root `leaderboard` script does this).
 *
 * ADR-011 (U19) provenance: by default this reads whatever `results/_verified.json`
 * already says (`{}` if it doesn't exist - every guardrail-track entry is then Tier 3,
 * self-reported, rejected) and never makes a network call, per CLAUDE.md ("no network
 * calls from `pnpm leaderboard` or any unit test"). Passing `--verify-attestations`
 * additionally re-derives `results/_verified.json` first, by actually calling `gh
 * attestation verify` against each committed result's sibling `<id>.attestation.jsonl`
 * bundle - a separate, explicit, networked step a maintainer runs by hand (or a
 * dedicated CI job), never part of the default `pnpm leaderboard` invocation CI's own
 * diff-check runs.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCorpus } from "@x402-redteam/schema";
import { buildLeaderboard, buildMcpSection } from "./build-leaderboard.js";
import {
  loadHarnessAllowlist,
  loadResultsDir,
  loadResultsMeta,
  loadSeasonRecords,
  loadTier2EligibleCommits,
  loadVerifiedMap,
} from "./load-results.js";
import {
  type AttestationCheckParams,
  buildGhAttestationVerifyArgs,
  type ProvenanceVerifier,
  verifyEntries,
} from "./provenance.js";
import { buildVerifyCandidates } from "./verify-candidates.js";

/** The real, networked verifier `--verify-attestations` uses - never called from this
 * module's own default path, and never from a unit test (tests inject a stub into
 * `verifyEntries` directly instead of going through this file at all). Security review
 * HIGH-6: the argv itself is built by the pure, independently-tested
 * `buildGhAttestationVerifyArgs` - this function does nothing but pass it to
 * `execFile`. */
const ghAttestationVerifier: ProvenanceVerifier = (params: AttestationCheckParams) =>
  new Promise((resolvePromise) => {
    let args: string[];
    try {
      args = buildGhAttestationVerifyArgs(params);
    } catch {
      resolvePromise(false);
      return;
    }
    execFile("gh", args, (err) => resolvePromise(err === null));
  });

async function main(): Promise<void> {
  const root = process.cwd();
  const resultsDir = resolve(root, "results");
  const corpusDir = resolve(root, "corpus");

  const entries = loadResultsDir(resultsDir);
  const meta = loadResultsMeta(resultsDir);
  const harnessAllowlist = loadHarnessAllowlist(resultsDir);
  const tier2Eligible = loadTier2EligibleCommits(resultsDir);
  const seasonRecords = loadSeasonRecords(resultsDir);
  const scenarios = loadCorpus(corpusDir);

  let verified = loadVerifiedMap(resultsDir);
  if (process.argv.includes("--verify-attestations")) {
    const candidates = buildVerifyCandidates(entries, resultsDir, meta, tier2Eligible);
    verified = await verifyEntries(candidates, ghAttestationVerifier);
    writeFileSync(resolve(resultsDir, "_verified.json"), `${JSON.stringify(verified, null, 2)}\n`);
  }

  const {
    markdown,
    ranked,
    notRanked,
    guardrails,
    agents,
    reference,
    superseded,
    stale,
    rejected,
  } = buildLeaderboard(
    entries,
    scenarios,
    meta,
    harnessAllowlist,
    verified,
    seasonRecords,
    tier2Eligible,
  );

  // U30-3 (ADR-035 #3): the MCP family has its own corpus, results and section. It is
  // appended after the HTTP document, which is built exactly as before.
  const mcpCorpusDir = resolve(root, "corpus-mcp");
  const mcpResultsDir = resolve(resultsDir, "mcp");
  const mcp = existsSync(mcpCorpusDir)
    ? buildMcpSection(
        loadResultsDir(mcpResultsDir),
        loadCorpus(mcpCorpusDir),
        loadResultsMeta(mcpResultsDir),
      )
    : undefined;
  if (mcp !== undefined && mcp.refused.length > 0) {
    console.error(
      `results/mcp/: not a harness reference result (only mcp-guarded and mcp-naive, marked ` +
        `reference in results/mcp/_meta.json, are accepted): ${mcp.refused.join(", ")}`,
    );
    process.exit(1);
  }
  writeFileSync(
    resolve(root, "LEADERBOARD.md"),
    mcp === undefined ? markdown : `${markdown}\n${mcp.markdown}`,
  );

  console.log(
    `Wrote LEADERBOARD.md: ${ranked.length} ranked (Tier 1), ${notRanked.length} not ranked, ` +
      `${guardrails.length} verified (Tier 2), ${agents.length} agent-track, ${reference.length} ` +
      `reference, ${superseded.length} superseded schema, ${stale.length} stale, ` +
      `${rejected.length} rejected`,
  );
  if (mcp !== undefined) {
    console.log(
      `MCP section: ${mcp.rows.length} reference, ${mcp.stale.length} stale, ` +
        `${mcp.rejected.length} rejected`,
    );
  }
}

await main();
