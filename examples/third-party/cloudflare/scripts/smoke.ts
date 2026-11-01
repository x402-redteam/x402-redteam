/**
 * The adapter's smoke gate (U33 §5). From the harness root, after the setup in the README:
 *   node --import tsx examples/third-party/cloudflare/scripts/smoke.ts <base out dir> [runs]
 *
 * Under `--mcp-challenge-meta`, for each profile it runs the smoke corpus `runs` times
 * (default 5) in localhost host mode, and once in path host mode, each into its own out dir
 * under the base dir, and checks that:
 *  - the harness exits 0 and both smoke scenarios finish with adapter exit 0;
 *  - report.json minus `timing` is byte-identical across the runs;
 *  - the request order and the payments' route, payee, network and amount in runs/*.json
 *    are identical across the runs;
 *  - no run has EGRESS_BLOCKED, and each reconciles with no unmatched intent and no
 *    issuance mismatch.
 * It then runs the corpus once without the run option and checks that every run exits 3:
 * the smoke control cannot pay without the `_meta` copy, so the batch gate closes.
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
const CORPUS = "examples/third-party/cloudflare/test/smoke/corpus-mcp";
const AGENT = "node --import tsx examples/third-party/cloudflare/src/agent.ts";
const PROFILES = ["default", "raised-cap", "approve"];

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
  for (const file of readdirSync(join(outDir, "runs")).filter((f) => /^[^.]+\.json$/.test(f))) {
    const run = JSON.parse(readFileSync(join(outDir, "runs", file), "utf8")) as RunFile;
    out[run.scenario_id] = {
      requests: run.requests,
      payments: run.payments.map((p) => [p.route_key, p.to, p.network, p.amount_atomic]),
    };
  }
  return out;
}

function harness(profile: string, outDir: string, opts: { meta: boolean; hostMode: string }) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(dirname(outDir), { recursive: true });
  return spawnSync(
    process.execPath,
    [
      CLI, "run", "--agent", AGENT, "--corpus", CORPUS, "--chains", "evm",
      "--host-mode", opts.hostMode,
      ...(opts.meta ? ["--mcp-challenge-meta"] : []),
      "--pass-env", "X402_CLOUDFLARE_PROFILE", "--timeout", "120",
      "--agent-id", "cloudflare", "--guardrail-id", `cloudflare-${profile}`,
      "--out", outDir,
    ],
    { cwd: ROOT, env: { ...process.env, X402_CLOUDFLARE_PROFILE: profile }, encoding: "utf8" },
  );
}

function notesOf(outDir: string): RunNotes[] {
  return readdirSync(join(outDir, "notes"))
    .filter((f) => /^[^.]+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(outDir, "notes", f), "utf8")) as RunNotes);
}

for (const profile of PROFILES) {
  const reports: string[] = [];
  const shapes: string[] = [];
  const plan: [string, number][] = [["localhost", runs], ["path", 1]];
  for (const [hostMode, count] of plan) {
    for (let i = 1; i <= count; i++) {
      const label = `${profile}/${hostMode}#${i}`;
      const outDir = join(base, profile, hostMode, `run-${i}`);
      const res = harness(profile, outDir, { meta: true, hostMode });
      if (res.status !== 0) {
        fail(`${label}: harness exit ${res.status}\n${res.stdout}\n${res.stderr}`);
        continue;
      }
      if (hostMode === "localhost") {
        const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
        reports.push(JSON.stringify(stripTiming(report)));
        shapes.push(JSON.stringify(shape(outDir)));
      }
      for (const [runId, rec] of reconcileOutDir(outDir)) {
        if (rec.intents_without_capture.length > 0) fail(`${label} ${runId}: unmatched intents`);
        if (rec.issuance_mismatches.length > 0) fail(`${label} ${runId}: ${rec.issuance_mismatches.join("; ")}`);
      }
      const all = notesOf(outDir);
      if (all.length !== 2) fail(`${label}: expected 2 runs, saw ${all.length}`);
      for (const notes of all) {
        if (notes.egress.length > 0) fail(`${label} ${notes.run_id}: egress ${JSON.stringify(notes.egress)}`);
        if (notes.exit_code !== 0) fail(`${label} ${notes.run_id}: exit ${notes.exit_code}: ${notes.exit_reason}`);
      }
      if (!existsSync(join(outDir, "provenance.json"))) fail(`${label}: no provenance.json`);
    }
  }
  if (new Set(reports).size > 1) fail(`${profile}: report.json differs between runs (minus timing)`);
  if (new Set(shapes).size > 1) fail(`${profile}: request order or payment terms differ between runs`);
  console.log(`${profile}: ${reports.length}/${runs} localhost runs completed`);
}

// A batch whose smoke control is unpaid: without the run option the control's challenge is
// not in the channel the client reads, so it exits 3, and every later run exits 3 at the gate.
{
  const outDir = join(base, "unpaid-control", "run-1");
  const res = harness("default", outDir, { meta: false, hostMode: "localhost" });
  if (!existsSync(join(outDir, "notes"))) {
    fail(`unpaid-control: no notes\n${res.stdout}\n${res.stderr}`);
  } else {
    const all = notesOf(outDir);
    if (all.length !== 2) fail(`unpaid-control: expected 2 runs, saw ${all.length}`);
    for (const notes of all) {
      if (notes.exit_code !== 3) fail(`unpaid-control ${notes.run_id}: exit ${notes.exit_code}, expected 3`);
    }
  }
  console.log("unpaid-control: every run exits 3");
}

if (failures.length > 0) {
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("smoke OK");
