/**
 * The adapter's smoke gate (U28 §7.4). From the harness root, after the setup in the
 * README:
 *   node --import tsx examples/third-party/clawrouter/scripts/smoke.ts <base out dir> [runs]
 *
 * For each profile it runs the smoke corpus `runs` times (default 5), each into its own out
 * dir under the base dir, and checks that:
 *  - the harness exits 0 and both controls pass;
 *  - report.json minus `timing` is byte-identical across the runs;
 *  - the request order and the payments' route, payee, network and amount in runs/*.json
 *    are identical across the runs, with every catalog request before the first chat request;
 *  - every run has catalog_settled: true, no EGRESS_BLOCKED, and reconciles with zero
 *    unmatched intents.
 * The base dir must be outside the repository.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunNotes } from "../src/notes.js";
import { reconcileOutDir } from "../src/reconcile.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI = join(ROOT, "packages/cli/bin/x402-redteam.mjs");
const CORPUS = "examples/third-party/clawrouter/test/smoke-corpus";
const AGENT = "node --import tsx examples/third-party/clawrouter/src/agent.ts";

const base = process.argv[2] ? resolve(process.argv[2]) : undefined;
const runs = Number(process.argv[3] ?? 5);
if (!base) {
  console.error("usage: smoke.ts <base out dir> [runs]");
  process.exit(1);
}
const rel = relative(ROOT, base);
if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
  console.error("refusing: the out dir must be outside the repository");
  process.exit(1);
}

const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
  console.error(`FAIL ${message}`);
};

function stripTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTiming);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "timing")
        .map(([k, v]) => [k, stripTiming(v)]),
    );
  }
  return value;
}

interface RunFile {
  scenario_id: string;
  requests: { method: string; host: string; path: string; status: number; paid: boolean; seq: number }[];
  payments: { route_key: string; to: string; network: string; amount_atomic: string }[];
}

/** What must not change between runs, per scenario: request order and payment terms. */
function shape(outDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const file of readdirSync(join(outDir, "runs")).filter((f) => f.endsWith(".json"))) {
    const run = JSON.parse(readFileSync(join(outDir, "runs", file), "utf8")) as RunFile;
    out[run.scenario_id] = {
      requests: run.requests,
      payments: run.payments.map((p) => [p.route_key, p.to, p.network, p.amount_atomic]),
    };
  }
  return out;
}

function checkCatalogFirst(outDir: string, label: string): void {
  for (const file of readdirSync(join(outDir, "runs")).filter((f) => f.endsWith(".json"))) {
    const run = JSON.parse(readFileSync(join(outDir, "runs", file), "utf8")) as RunFile;
    const firstChat = run.requests.findIndex((r) => r.path === "/v1/chat/completions");
    const lastCatalog = run.requests.map((r) => r.path).lastIndexOf("/v1/models");
    if (lastCatalog < 0) fail(`${label} ${run.scenario_id}: no catalog request in the adversary log`);
    if (firstChat >= 0 && lastCatalog > firstChat) {
      fail(`${label} ${run.scenario_id}: a catalog request came after the first chat request`);
    }
  }
}

for (const profile of ["defaults", "budget"]) {
  const reports: string[] = [];
  const shapes: string[] = [];
  for (let i = 1; i <= runs; i++) {
    const label = `${profile}#${i}`;
    const outDir = join(base, profile, `run-${i}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    const res = spawnSync(
      process.execPath,
      [
        CLI, "run", "--agent", AGENT, "--corpus", CORPUS, "--chains", "evm",
        "--pass-env", "X402_CLAWROUTER_PROFILE", "--timeout", "240",
        "--agent-id", "clawrouter", "--guardrail-id", `clawrouter-${profile}`,
        "--out", outDir,
      ],
      { cwd: ROOT, env: { ...process.env, X402_CLAWROUTER_PROFILE: profile }, encoding: "utf8" },
    );
    if (res.status !== 0) {
      fail(`${label}: harness exit ${res.status}\n${res.stdout}\n${res.stderr}`);
      continue;
    }
    const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as {
      summary?: { valid?: boolean; controls_passed?: number; controls_total?: number };
    };
    reports.push(JSON.stringify(stripTiming(report)));
    shapes.push(JSON.stringify(shape(outDir)));
    checkCatalogFirst(outDir, label);
    for (const [runId, rec] of reconcileOutDir(outDir)) {
      if (rec.intents_without_capture.length > 0) fail(`${label} ${runId}: unmatched intents`);
      if (rec.captured_without_intent.length > 0) fail(`${label} ${runId}: payment without intent`);
    }
    for (const file of readdirSync(join(outDir, "notes")).filter((f) => /^[^.]+\.json$/.test(f))) {
      const notes = JSON.parse(readFileSync(join(outDir, "notes", file), "utf8")) as RunNotes;
      if (notes.catalog_settled !== true) fail(`${label} ${notes.run_id}: catalog_settled is not true`);
      if (notes.egress.length > 0) fail(`${label} ${notes.run_id}: egress ${JSON.stringify(notes.egress)}`);
      if (notes.exit_code !== 0) fail(`${label} ${notes.run_id}: exit ${notes.exit_code}`);
    }
    if (!existsSync(join(outDir, "provenance.json"))) fail(`${label}: no provenance.json`);
  }
  if (new Set(reports).size > 1) fail(`${profile}: report.json differs between runs (minus timing)`);
  if (new Set(shapes).size > 1) fail(`${profile}: request order or payment terms differ between runs`);
  console.log(`${profile}: ${reports.length}/${runs} runs completed`);
}

if (failures.length > 0) {
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("smoke OK");
