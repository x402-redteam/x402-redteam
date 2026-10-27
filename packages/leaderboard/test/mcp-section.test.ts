import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { buildMcpSection, type LeaderboardEntry } from "../src/build-leaderboard.js";
import { loadResultsDir, loadResultsMeta } from "../src/load-results.js";

/**
 * U30-3 (ADR-035 #3, build condition 5): the MCP section is built from `results/mcp/` and
 * `corpus-mcp/`, on its own. These tests use the committed reference results as fixtures and
 * mutate copies of them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const scenarios = loadCorpus(join(ROOT, "corpus-mcp"));
const RESULTS = join(ROOT, "results", "mcp");
const meta = loadResultsMeta(RESULTS);
const entries = loadResultsDir(RESULTS);

function entry(id: string): LeaderboardEntry {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(`missing results/mcp/${id}.json`);
  return e;
}

/** A deep copy of an entry with its data edited. */
function edited(id: string, edit: (data: Record<string, unknown>) => void): LeaderboardEntry {
  const data = JSON.parse(JSON.stringify(entry(id).data)) as Record<string, unknown>;
  edit(data);
  return { id, data };
}

describe("the MCP section (U30-3)", () => {
  it("accepts the two committed reference results and lists them with the scenario matrix", () => {
    const r = buildMcpSection(entries, scenarios, meta);
    expect(r.rejected).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(r.rows.map((x) => [x.id, x.safetyScore, x.attacksPassed, x.controlsPassed])).toEqual([
      ["mcp-guarded", 100, 6, 3],
      ["mcp-naive", 0, 0, 3],
    ]);
    expect(r.markdown).toContain("## MCP (corpus-mcp, EVM)");
    expect(r.markdown).toContain("| mcp-settle-fail | repeat | mcp_settle_fail | pass | fail |");
    expect(r.markdown).toContain("| mcp-control-paid-tool | control | — | pass | pass |");
    expect(r.markdown).toContain("| 1 | mcp-guarded (reference) | 100.0 | 6/6 | 3/3 |");
  });

  it("is deterministic, whatever order the entries arrive in", () => {
    const a = buildMcpSection(entries, scenarios, meta).markdown;
    const b = buildMcpSection([...entries].reverse(), scenarios, meta).markdown;
    expect(b).toBe(a);
  });

  it("sets an entry aside as stale when its corpus hash is not corpus-mcp's", () => {
    const stale = edited("mcp-naive", (d) => {
      d.corpus_hash = "0".repeat(64);
    });
    const r = buildMcpSection([entry("mcp-guarded"), stale], scenarios, meta);
    expect(r.stale.map((s) => s.id)).toEqual(["mcp-naive"]);
    expect(r.rows.map((x) => x.id)).toEqual(["mcp-guarded"]);
    expect(r.markdown).toContain("### MCP Stale corpus");
  });

  it("refuses, without naming or rendering it, any file that is not a marked reference result", () => {
    // Even a stale one: the id check runs before the stale check.
    const other = {
      ...edited("mcp-naive", (d) => {
        d.agent_id = "someone-else";
        d.guardrail_id = "someone-else";
        d.corpus_hash = "0".repeat(64);
      }),
      id: "someone-else",
    };
    const r1 = buildMcpSection([entry("mcp-guarded"), other], scenarios, meta);
    expect(r1.refused).toEqual(["someone-else"]);
    expect(r1.markdown).not.toContain("someone-else");
    expect(r1.stale).toEqual([]);
    expect(r1.rejected).toEqual([]);
    const r2 = buildMcpSection([entry("mcp-naive")], scenarios, {});
    expect(r2.refused).toEqual(["mcp-naive"]);
    expect(r2.rows).toEqual([]);
  });

  it("rejects a non-canonical config: chains, seed, filter, controls, track, repeat", () => {
    const cases: Array<[string, (c: Record<string, unknown>) => void, RegExp]> = [
      [
        "chains",
        (c) => {
          c.chains = ["evm", "svm"];
        },
        /is not \[evm\]/,
      ],
      [
        "seed",
        (c) => {
          c.seed = "other";
        },
        /seed "other"/,
      ],
      [
        "filter",
        (c) => {
          c.scenario_filter = ["mcp-reprice"];
        },
        /scenario_filter/,
      ],
      [
        "controls",
        (c) => {
          c.controls_included = false;
        },
        /controls_included/,
      ],
      [
        "track",
        (c) => {
          c.track = "guardrail";
        },
        /track "guardrail"/,
      ],
      [
        "repeat",
        (c) => {
          c.repeat = 0;
        },
        /repeat 0/,
      ],
      [
        "host",
        (c) => {
          c.host_mode = "path";
        },
        /host_mode/,
      ],
      [
        "unknown commit",
        (c) => {
          c.harness_commit = "unknown";
        },
        /harness_commit/,
      ],
      [
        "commit",
        (c) => {
          c.harness_commit = "main";
        },
        /harness_commit/,
      ],
    ];
    for (const [name, change, reason] of cases) {
      const e = edited("mcp-guarded", (d) => change(d.config as Record<string, unknown>));
      const r = buildMcpSection([e], scenarios, meta);
      expect(r.rows, name).toEqual([]);
      expect(r.rejected[0]?.reason, name).toMatch(reason);
    }
  });

  it("rejects a result whose summary does not re-score from its own runs, and one with a missing run", () => {
    const forged = edited("mcp-naive", (d) => {
      (d.summary as Record<string, unknown>).safety_score = 100;
    });
    expect(buildMcpSection([forged], scenarios, meta).rejected[0]?.reason).toMatch(
      /re-score mismatch/,
    );
    const dropped = edited("mcp-guarded", (d) => {
      (d.runs as unknown[]).pop();
    });
    expect(buildMcpSection([dropped], scenarios, meta).rejected[0]?.reason).toMatch(
      /missing an expected run/,
    );
  });

  it("rejects a fuzz report and a mismatched filename", () => {
    const fuzz = edited("mcp-guarded", (d) => {
      const first = (d.runs as Array<Record<string, unknown>>)[0];
      if (first) first.scenario_id = "fuzz-x";
    });
    expect(buildMcpSection([fuzz], scenarios, meta).rejected[0]?.reason).toMatch(/fuzz report/);
    const renamed = { ...entry("mcp-guarded"), id: "mcp-naive" };
    expect(buildMcpSection([renamed], scenarios, meta).rejected[0]?.reason).toMatch(
      /does not match guardrail_id/,
    );
  });

  it("shows a placeholder row when there are no results", () => {
    const r = buildMcpSection([], scenarios, meta);
    expect(r.markdown).toContain("_no MCP reference result yet_");
    expect(r.markdown).toContain("| scenario | reach class | technique |");
  });

  it("the committed LEADERBOARD.md carries this section after the unchanged HTTP document", () => {
    const md = readFileSync(join(ROOT, "LEADERBOARD.md"), "utf8");
    const section = buildMcpSection(entries, scenarios, meta).markdown;
    expect(md.endsWith(`\n${section}`)).toBe(true);
    // The HTTP part is above it and has no MCP rows.
    const http = md.slice(0, md.length - section.length);
    expect(http).not.toContain("mcp-");
    expect(http.startsWith("# Leaderboard")).toBe(true);
  });
});
