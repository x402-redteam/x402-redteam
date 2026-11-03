import { basename, resolve } from "node:path";
import {
  CorpusError,
  KNOWN_REFUSAL_ONLY_MCP,
  lintControlFloor,
  loadCorpus,
  MCP_CORPUS_DIRNAME,
  refusalOnlyChains,
} from "@x402-redteam/schema";

/**
 * `loadCorpus` + print errors, per functional-design.md §1. Returns the
 * process exit code (0 on success, 2 on any corpus error) rather than
 * calling `process.exit` itself, so it stays testable.
 */
export function validate(corpusDir: string, opts: { floor?: boolean } = {}): number {
  try {
    const scenarios = loadCorpus(corpusDir);
    // Lint rule 9 (control-floor, U36-a): corpus/ and a held-out corpus; corpus-mcp/ exempt.
    // A corpus with attacks and no controls fails too; `--no-floor` (opts.floor === false)
    // is the explicit opt-out for fragments and test fixtures.
    // A generated fuzz corpus (`fuzz-` ids with a `fuzz:` technique) is exempt too: it is
    // a few mutants of the public corpus, not a corpus a score is computed against.
    const generated = scenarios.some(
      (s) => s.id.startsWith("fuzz-") && (s.technique ?? "").startsWith("fuzz:"),
    );
    const exempt = generated || basename(resolve(corpusDir)) === MCP_CORPUS_DIRNAME;
    const hasAttacks = scenarios.some((s) => s.category !== "control");
    let floorNote = "";
    if (opts.floor !== false && !exempt && hasAttacks) {
      const f = lintControlFloor(scenarios);
      if (f.problems.length > 0) {
        for (const problem of f.problems) console.error(`${corpusDir}: control-floor: ${problem}`);
        return 2;
      }
      floorNote =
        `; ${f.controls} controls (${f.gate} gate, ${f.battery} battery), ` +
        `${f.categories_mirrored}/${f.categories} categories mirrored, ` +
        `${f.critical_categories_mirrored}/${f.critical_categories} critical-bearing categories mirrored`;
    }
    for (const s of scenarios) {
      if (KNOWN_REFUSAL_ONLY_MCP.has(s.id) && refusalOnlyChains(s).length > 0) {
        console.error(
          `note: ${s.id} is refusal-only (lint rule 8, known MCP exception; relabel pending an owner decision)`,
        );
      }
    }
    console.log(`OK: ${scenarios.length} scenario(s) loaded from ${corpusDir}${floorNote}`);
    return 0;
  } catch (err) {
    if (err instanceof CorpusError) {
      const path = err.path
        ? `${err.file}: ${err.path}: ${err.message}`
        : `${err.file}: ${err.message}`;
      console.error(path);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 2;
  }
}
