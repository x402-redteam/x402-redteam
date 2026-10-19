import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalize,
  FUZZ_PRIVATE_MARKER,
  type IssuedChallenge,
  type Payment,
  RESULT_ID_PATTERN,
  type RunRecord,
  stampJson,
  stampText,
} from "@x402-redteam/schema";
import {
  AUTHORIZATION_WINDOW_TOLERANCE_SECONDS,
  type Report,
  type RunScore,
} from "@x402-redteam/scorer";
import { SHAPES, type Shape } from "./cases.js";
import { type Manifest, type ManifestCase, sha256Canonical } from "./generate.js";

/**
 * `x402-redteam diff` (U29-3, design §2, ADR-033): a pure function of the manifest and the
 * runs' out dirs. Nothing here touches the network, the clock or the repository. Outputs
 * carry the private marker (ADR-028 #7).
 */

export const DIFF_VERSION = 1;

export class DiffRefusal extends Error {}

export interface ClientDescriptor {
  id: string;
  /** Core provenance as recorded at run time, e.g. `@x402/core@2.28.0`. Groups clients. */
  core: string;
  wrapper: string;
  /** Optional run directory (`dir=`), as an alternative to a positional argument. */
  dir?: string;
}

/** `id=ts-sdk,core=@x402/core@2.28.0,wrapper=sdk-default[,dir=<path>]`. */
export function parseClientSpec(spec: string): ClientDescriptor {
  const fields: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) throw new DiffRefusal(`--client "${spec}": "${part}" is not key=value`);
    const key = part.slice(0, at).trim();
    if (!["id", "core", "wrapper", "dir"].includes(key)) {
      throw new DiffRefusal(`--client "${spec}": unknown key "${key}"`);
    }
    if (key in fields) throw new DiffRefusal(`--client "${spec}": duplicate key "${key}"`);
    fields[key] = part.slice(at + 1).trim();
  }
  for (const key of ["id", "core", "wrapper"]) {
    if (!fields[key]) throw new DiffRefusal(`--client "${spec}": missing ${key}=`);
  }
  const id = fields.id as string;
  if (!RESULT_ID_PATTERN.test(id)) {
    throw new DiffRefusal(`--client id "${id}" must match ${RESULT_ID_PATTERN.source}`);
  }
  return {
    id,
    core: fields.core as string,
    wrapper: fields.wrapper as string,
    ...(fields.dir ? { dir: fields.dir } : {}),
  };
}

/** What `diff` reads from one run out dir. */
export interface RunDirData {
  report: Report;
  /** The ledger records (`runs/<run_id>.json`), by run id. */
  runs: Map<string, RunRecord>;
  /** Adapter notes (`notes/<run_id>.json`), by run id; absent for first-party runs. */
  notes: Map<string, unknown>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new DiffRefusal(`cannot read ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

export function loadRunDir(dir: string): RunDirData {
  const report = readJson(join(dir, "report.json")) as Report;
  const runs = new Map<string, RunRecord>();
  const runsDir = join(dir, "runs");
  if (!existsSync(runsDir)) throw new DiffRefusal(`${dir} has no runs/ directory`);
  for (const f of readdirSync(runsDir).sort()) {
    if (!/^[^.]+\.json$/.test(f)) continue; // skips `<run_id>.gdp.json`
    const rec = readJson(join(runsDir, f)) as RunRecord;
    runs.set(rec.run_id, rec);
  }
  const notes = new Map<string, unknown>();
  const notesDir = join(dir, "notes");
  if (existsSync(notesDir)) {
    for (const f of readdirSync(notesDir).sort()) {
      if (!/^[^.]+\.json$/.test(f)) continue; // skips `<run_id>.intents.jsonl`
      notes.set(f.replace(/\.json$/, ""), readJson(join(notesDir, f)));
    }
  }
  return { report, runs, notes };
}

export function parseManifest(value: unknown): Manifest {
  const m = value as Partial<Manifest> | null;
  if (
    m === null ||
    typeof m !== "object" ||
    m.manifest_version !== 1 ||
    typeof m.render_seed !== "string" ||
    typeof m.corpus_hash !== "object" ||
    m.corpus_hash === null ||
    !Array.isArray(m.cases)
  ) {
    throw new DiffRefusal(
      "manifest is not a cases.json this diff understands (manifest_version 1)",
    );
  }
  return m as Manifest;
}

// ---- outcomes ------------------------------------------------------------------------

export const OUTCOME_KINDS = [
  "signed_valid",
  "signed_invalid",
  "decode_error",
  "refused",
  "errored",
  "not_reached",
  "unmeasured",
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
/** Only these take part in the oracles. */
const COMPARABLE: ReadonlySet<OutcomeKind> = new Set(["signed_valid", "signed_invalid", "refused"]);

export interface Outcome {
  kind: OutcomeKind;
  reason?: string;
  /** decode_error only: the ledger's `terms_verified` for that leg. */
  terms_verified?: string;
}

export function outcomeLabel(o: Outcome): string {
  return o.reason !== undefined && o.kind === "signed_invalid"
    ? `signed_invalid(${o.reason})`
    : o.kind;
}

export interface SignedTerms {
  amount: string;
  to: string;
  asset: string;
  network: string;
}

export interface InvariantViolation {
  code:
    | "decode_error_leg"
    | "offer_unparseable"
    | "terms_mismatch"
    | "signature_not_over_offered_terms"
    | "window_exceeded";
  detail: string;
}

interface Analysis {
  outcome: Outcome;
  signed: SignedTerms[];
  violations: InvariantViolation[];
  /** Distinct `dedupe_key`s: a resent signature is one payment, a new authorization two. */
  payments: number;
  scorer_status: RunScore["status"] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function unmeasuredByNotes(notes: unknown): string | null {
  if (notes === undefined) return null;
  if (!isRecord(notes)) return "notes unreadable";
  const rec = notes.reconciliation;
  if (!isRecord(rec)) return "notes not reconciled";
  return rec.unmeasured === true ? "reconcile flagged the run" : null;
}

/** The offered entries a payment can answer: the readable `accepts` of every issuance
 * (post-patch for a wire issuance, ADR-032). */
function offeredEntries(run: RunRecord): {
  entries: Record<string, unknown>[];
  parseable: boolean;
} {
  const entries: Record<string, unknown>[] = [];
  let parseable = true;
  for (const c of run.challenges as IssuedChallenge[]) {
    if (c.wire !== undefined && c.wire.parseable === false) parseable = false;
    for (const e of c.accepts as unknown[]) if (isRecord(e)) entries.push(e);
  }
  return { entries, parseable: parseable && entries.length > 0 };
}

function termsOf(p: Payment): SignedTerms {
  return { amount: p.amount_atomic, to: p.to, asset: p.asset, network: p.network };
}

function checkPayment(
  p: Payment,
  offered: { entries: Record<string, unknown>[]; parseable: boolean },
  fallbackMaxAuthSeconds: number,
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  let maxAuthSeconds = fallbackMaxAuthSeconds;
  if (!offered.parseable) {
    out.push({ code: "offer_unparseable", detail: "signed over an offer no client could parse" });
  } else {
    let best: string[] | null = null;
    let bestEntry: Record<string, unknown> | null = null;
    for (const e of offered.entries) {
      const bad: string[] = [];
      if (e.amount !== p.amount_atomic) bad.push("amount");
      if (lc(e.payTo) !== lc(p.to)) bad.push("payTo");
      if (lc(e.asset) !== lc(p.asset)) bad.push("asset");
      if (e.network !== p.network) bad.push("network");
      if (best === null || bad.length < best.length) {
        best = bad;
        bestEntry = e;
      }
    }
    // The window is bounded by the entry the payment answers (the best match).
    const t = bestEntry?.maxTimeoutSeconds;
    if (typeof t === "number" && Number.isSafeInteger(t) && t > 0) maxAuthSeconds = t;
    if (best !== null && best.length > 0) {
      out.push({ code: "terms_mismatch", detail: best.sort().join(",") });
    }
    if (p.terms_verified === "offered_domain_only" || p.terms_verified === "client_copy") {
      out.push({ code: "signature_not_over_offered_terms", detail: p.terms_verified });
    }
  }
  if (
    typeof p.authorization_seconds === "number" &&
    p.authorization_seconds > maxAuthSeconds + AUTHORIZATION_WINDOW_TOLERANCE_SECONDS
  ) {
    out.push({
      code: "window_exceeded",
      detail: `${p.authorization_seconds}s > ${maxAuthSeconds}s`,
    });
  }
  return out;
}

function analyse(
  run: RunRecord,
  score: RunScore | undefined,
  notes: unknown,
  mc: ManifestCase,
): Analysis {
  const scorer_status = score?.status ?? null;
  const signed: SignedTerms[] = [];
  const violations: InvariantViolation[] = [];

  // The invariant runs on every decoded signed leg, whatever the run's outcome: a client
  // that signs a swapped payTo and then crashes still signed it. A decode_error belongs to
  // its own leg; it is checked only when the ledger could still read the offered terms
  // (`offered` / `offered_domain_only`), else the leg says nothing about what was signed.
  const offered = offeredEntries(run);
  for (const p of run.payments) {
    if (p.decode_error !== undefined) {
      if (p.terms_verified !== "offered" && p.terms_verified !== "offered_domain_only") continue;
      violations.push({ code: "decode_error_leg", detail: p.decode_error });
    }
    signed.push(termsOf(p));
    violations.push(...checkPayment(p, offered, mc.expected_max_authorization_seconds));
  }
  const payments = new Set(run.payments.map((p) => p.dedupe_key)).size;
  const done = (outcome: Outcome): Analysis => ({
    outcome,
    signed,
    violations,
    scorer_status,
    payments,
  });

  const why = unmeasuredByNotes(notes);
  if (why !== null) return done({ kind: "unmeasured", reason: why });
  if (run.exit_code !== 0 || run.timed_out) {
    return done({ kind: "errored", reason: run.timed_out ? "timeout" : `exit ${run.exit_code}` });
  }
  if (run.challenges.length === 0 || score?.reached === false) return done({ kind: "not_reached" });
  if (run.payments.length === 0) return done({ kind: "refused" });

  const bad = run.payments.find((p) => p.decode_error !== undefined);
  if (bad !== undefined) {
    return done({
      kind: "decode_error",
      reason: bad.decode_error as string,
      ...(bad.terms_verified !== undefined ? { terms_verified: bad.terms_verified } : {}),
    });
  }
  const invalid = run.payments.find((p) => !p.valid);
  return done(
    invalid === undefined
      ? { kind: "signed_valid" }
      : { kind: "signed_invalid", reason: invalid.invalid_reason ?? "invalid" },
  );
}

// ---- the diff ------------------------------------------------------------------------

export interface ClientInput {
  client: ClientDescriptor;
  data: RunDirData;
}

export interface CaseClientResult {
  outcome: string;
  kind: OutcomeKind;
  voided?: string;
  signed?: SignedTerms[];
  payments?: number;
  terms_verified?: string;
  attempts_differ?: boolean;
  scorer_status?: string | null;
}

export interface Difference {
  clients: [string, string];
  scope: "wrapper" | "implementation";
  kind: "outcome" | "terms" | "payment_count";
  detail: string;
}

export interface ExpectationHit {
  client: string;
  expected: string;
  outcome: string;
  scorer_agrees: boolean;
}

export interface CaseResult {
  id: string;
  scenario_id: string;
  family: string;
  tier: string;
  is_base: boolean;
  clients: Record<string, CaseClientResult>;
  invariant: Array<{ client: string; code: string; detail: string }>;
  expectation: ExpectationHit[];
  differential: Difference[];
  flagged: boolean;
}

export interface DiffResult {
  diff_version: number;
  manifest: { catalogue_sha256: string; render_seed: string; corpus_hash: Record<string, string> };
  harness_version: string;
  clients: Array<ClientDescriptor & { shape: Shape; cases_run: number; missing_cases: number }>;
  groups: Array<{ core: string; clients: string[] }>;
  voided: Array<{ client: string; family: string; reason: string }>;
  counts: {
    cases: number;
    flagged: number;
    invariant: number;
    expectation: number;
    differential_wrapper: number;
    differential_implementation: number;
    voided: number;
  };
  cases: CaseResult[];
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Throws DiffRefusal for any misalignment. Pure. */
export function diffRuns(manifest: Manifest, inputs: ClientInput[]): DiffResult {
  if (inputs.length < 1) throw new DiffRefusal("diff needs at least one run directory");
  const clients = [...inputs].sort((a, b) => compareStr(a.client.id, b.client.id));
  for (let i = 1; i < clients.length; i++) {
    if ((clients[i] as ClientInput).client.id === (clients[i - 1] as ClientInput).client.id) {
      throw new DiffRefusal(`duplicate client id "${(clients[i] as ClientInput).client.id}"`);
    }
  }
  const byScenario = new Map(manifest.cases.map((c) => [c.scenario_id, c]));
  const harnessVersions = new Set<string>();
  const shapes = new Map<string, Shape>();
  // client id -> case id -> analyses (one per attempt, attempt order)
  const analyses = new Map<string, Map<string, Analysis[]>>();

  for (const { client, data } of clients) {
    const { report } = data;
    if (report.schema !== "x402-redteam/report@3") {
      throw new DiffRefusal(`${client.id}: not a report@3 report.json`);
    }
    const shape = SHAPES.find((s) => manifest.corpus_hash[s] === report.corpus_hash);
    if (shape === undefined) {
      throw new DiffRefusal(`${client.id}: corpus_hash matches no shape in the manifest`);
    }
    shapes.set(client.id, shape);
    if (report.seed !== manifest.render_seed) {
      throw new DiffRefusal(
        `${client.id}: seed "${report.seed}" differs from the manifest's render_seed`,
      );
    }
    harnessVersions.add(report.harness_version);
    if (harnessVersions.size > 1) throw new DiffRefusal("harness_version differs across reports");

    const reportRunIds = new Set(report.runs.map((r) => r.run_id));
    // Refusals print counts and reasons only, never case or run ids (ADR-028 #7).
    const missing = [...reportRunIds].filter((id) => !data.runs.has(id)).length;
    if (missing > 0)
      throw new DiffRefusal(`${client.id}: ${missing} run record(s) missing from runs/`);
    const extra = [...data.runs.keys()].filter((id) => !reportRunIds.has(id)).length;
    if (extra > 0) throw new DiffRefusal(`${client.id}: ${extra} run record(s) not in report.json`);
    const scores = new Map<string, RunScore>();
    for (const s of report.scenarios) {
      for (const r of s.results) for (const a of r.attempts) scores.set(a.run_id, a);
    }

    const perCase = new Map<string, Analysis[]>();
    let unknownScenarios = 0;
    let hashMismatches = 0;
    const runs = [...data.runs.values()]
      .filter((r) => r.chain === "evm")
      .sort((a, b) => compareStr(a.scenario_id, b.scenario_id) || a.attempt - b.attempt);
    for (const run of runs) {
      const mc = byScenario.get(run.scenario_id);
      if (mc === undefined) {
        unknownScenarios++;
        continue;
      }
      // F5: the offered accepts, unfiltered, must hash to the manifest's value. Never
      // route_key or challenge_id.
      for (const c of run.challenges as IssuedChallenge[]) {
        const raw =
          c.wire !== undefined
            ? isRecord(c.wire.offered)
              ? c.wire.offered.accepts
              : undefined
            : c.accepts;
        const hash = sha256Canonical(raw === undefined ? null : raw);
        if (hash !== mc.offered_terms_sha256) {
          hashMismatches++;
          break;
        }
      }
      const list = perCase.get(mc.id) ?? [];
      list.push(analyse(run, scores.get(run.run_id), data.notes.get(run.run_id), mc));
      perCase.set(mc.id, list);
    }
    if (unknownScenarios > 0) {
      throw new DiffRefusal(`${client.id}: ${unknownScenarios} run(s) are not in the manifest`);
    }
    if (hashMismatches > 0) {
      throw new DiffRefusal(
        `${client.id}: offered accepts of ${hashMismatches} run(s) do not match the manifest hash`,
      );
    }
    analyses.set(client.id, perCase);
  }

  // Base-control voiding (F4): a client that fails a family's base control has that
  // family's results voided.
  const voidedFamilies = new Map<string, string>(); // `${client}\u0000${family}` -> reason
  const voided: DiffResult["voided"] = [];
  for (const { client } of clients) {
    const perCase = analyses.get(client.id) as Map<string, Analysis[]>;
    const families = new Set(manifest.cases.map((c) => c.family));
    for (const family of [...families].sort(compareStr)) {
      const ran = manifest.cases.some((c) => c.family === family && perCase.has(c.id));
      if (!ran) continue;
      const base = manifest.cases.find((c) => c.family === family && c.is_base);
      const a = base === undefined ? undefined : perCase.get(base.id)?.[0];
      let reason: string | null = null;
      if (a === undefined) reason = "base control not run";
      else if (a.outcome.kind !== "signed_valid")
        reason = `base control ${outcomeLabel(a.outcome)}`;
      else if (a.scorer_status !== "pass") reason = `base control scorer ${a.scorer_status}`;
      if (reason !== null) {
        voidedFamilies.set(`${client.id}\u0000${family}`, reason);
        voided.push({ client: client.id, family, reason });
      }
    }
  }

  const cases: CaseResult[] = [];
  for (const mc of manifest.cases) {
    const res: Record<string, CaseClientResult> = {};
    const live: Array<{ id: string; core: string; a: Analysis; r: CaseClientResult }> = [];
    // Every non-voided client, whatever its outcome: the invariant reads signed legs of
    // errored, timed-out and unmeasured runs too. Violations are the union over attempts.
    const signers: Array<{ id: string; violations: InvariantViolation[] }> = [];
    for (const { client } of clients) {
      const list = analyses.get(client.id)?.get(mc.id);
      const a = list?.[0];
      if (list === undefined || a === undefined) continue;
      const r: CaseClientResult = {
        outcome: outcomeLabel(a.outcome),
        kind: a.outcome.kind,
        ...(a.signed.length > 0 ? { signed: a.signed } : {}),
        payments: a.payments,
        ...(a.outcome.terms_verified !== undefined
          ? { terms_verified: a.outcome.terms_verified }
          : {}),
        ...(list.some((x) => outcomeLabel(x.outcome) !== outcomeLabel(a.outcome))
          ? { attempts_differ: true }
          : {}),
        scorer_status: a.scorer_status,
      };
      const v = voidedFamilies.get(`${client.id}\u0000${mc.family}`);
      if (v !== undefined) r.voided = v;
      res[client.id] = r;
      if (v === undefined) {
        const seen = new Set<string>();
        const violations = list
          .flatMap((x) => x.violations)
          .filter((x) => {
            const k = `${x.code}|${x.detail}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        signers.push({ id: client.id, violations });
      }
      if (v === undefined && COMPARABLE.has(a.outcome.kind)) {
        live.push({ id: client.id, core: client.core, a, r });
      }
    }

    const invariant: CaseResult["invariant"] = [];
    const expectation: ExpectationHit[] = [];
    const differential: Difference[] = [];
    for (const { id, violations } of signers) {
      for (const v of violations) invariant.push({ client: id, code: v.code, detail: v.detail });
    }
    for (const { id, a } of live) {
      if (a.outcome.kind === "refused") continue;
      // Oracle 2: spec-must only. The scorer verdict is a cross-check.
      if (mc.tier === "spec-must" && mc.expected_kind !== null) {
        const hit = mc.expected_kind === "refuse" ? true : a.violations.length > 0;
        if (hit) {
          expectation.push({
            client: id,
            expected: mc.expected_kind,
            outcome: outcomeLabel(a.outcome),
            scorer_agrees: a.scorer_status === "fail",
          });
        }
      }
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const x = live[i] as (typeof live)[number];
        const y = live[j] as (typeof live)[number];
        const scope = x.core === y.core ? "wrapper" : "implementation";
        const la = outcomeLabel(x.a.outcome);
        const lb = outcomeLabel(y.a.outcome);
        if (la !== lb) {
          differential.push({
            clients: [x.id, y.id],
            scope,
            kind: "outcome",
            detail: `${la} vs ${lb}`,
          });
        } else if (x.a.outcome.kind !== "refused") {
          // The distinct terms, not the count: a client that retries signs the same terms twice.
          const key = (s: SignedTerms[]) =>
            JSON.stringify(
              [
                ...new Set(
                  s.map((t) => JSON.stringify({ ...t, to: lc(t.to), asset: lc(t.asset) })),
                ),
              ].sort(compareStr),
            );
          if (x.a.payments !== y.a.payments) {
            differential.push({
              clients: [x.id, y.id],
              scope,
              kind: "payment_count",
              detail: `${x.a.payments} vs ${y.a.payments} distinct authorization(s)`,
            });
          }
          if (key(x.a.signed) !== key(y.a.signed)) {
            differential.push({
              clients: [x.id, y.id],
              scope,
              kind: "terms",
              detail: "signed terms differ",
            });
          }
        }
      }
    }
    const unstable = Object.values(res).some((r) => r.attempts_differ === true);
    const crossDisagree = expectation.some((e) => !e.scorer_agrees);
    cases.push({
      id: mc.id,
      scenario_id: mc.scenario_id,
      family: mc.family,
      tier: mc.tier,
      is_base: mc.is_base,
      clients: res,
      invariant,
      expectation,
      differential,
      flagged:
        invariant.length > 0 ||
        expectation.length > 0 ||
        differential.length > 0 ||
        unstable ||
        crossDisagree,
    });
  }

  const groups = new Map<string, string[]>();
  for (const { client } of clients)
    groups.set(client.core, [...(groups.get(client.core) ?? []), client.id]);
  const allDiffs = cases.flatMap((c) => c.differential);
  return {
    diff_version: DIFF_VERSION,
    manifest: {
      catalogue_sha256: manifest.catalogue_sha256,
      render_seed: manifest.render_seed,
      corpus_hash: manifest.corpus_hash,
    },
    harness_version: [...harnessVersions][0] as string,
    clients: clients.map(({ client }) => ({
      id: client.id,
      core: client.core,
      wrapper: client.wrapper,
      shape: shapes.get(client.id) as Shape,
      cases_run: analyses.get(client.id)?.size ?? 0,
      missing_cases: manifest.cases.length - (analyses.get(client.id)?.size ?? 0),
    })),
    groups: [...groups.entries()]
      .sort(([a], [b]) => compareStr(a, b))
      .map(([core, ids]) => ({ core, clients: ids })),
    voided,
    counts: {
      cases: cases.length,
      flagged: cases.filter((c) => c.flagged).length,
      invariant: cases.reduce((n, c) => n + c.invariant.length, 0),
      expectation: cases.reduce((n, c) => n + c.expectation.length, 0),
      differential_wrapper: allDiffs.filter((d) => d.scope === "wrapper").length,
      differential_implementation: allDiffs.filter((d) => d.scope === "implementation").length,
      voided: voided.length,
    },
    cases,
  };
}

// ---- output --------------------------------------------------------------------------

function cell(s: string): string {
  // Backslash first (as the leaderboard's escapeCell): else `\|` would leave the pipe live.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

export function renderTriage(result: DiffResult, manifest: Manifest): string {
  const ids = result.clients.map((c) => c.id);
  const byId = new Map(manifest.cases.map((c) => [c.id, c]));
  const lines: string[] = [
    "# Fuzz triage (private)",
    "",
    `Cases ${result.counts.cases}, flagged ${result.counts.flagged}, clients ${ids.join(", ")}.`,
    "A hit is a lead, never a finding on its own (ADR-033).",
    "",
    `| mutation | tier | citation | ${ids.join(" | ")} | oracle |`,
    `|---|---|---|${ids.map(() => "---").join("|")}|---|`,
  ];
  for (const c of result.cases.filter((x) => x.flagged)) {
    const cite = byId.get(c.id)?.cite;
    const fired: string[] = [];
    if (c.invariant.length > 0) {
      fired.push(
        `invariant: ${c.invariant.map((v) => `${v.client} ${v.code}(${v.detail})`).join("; ")}`,
      );
    }
    if (c.expectation.length > 0) {
      fired.push(
        `expectation: ${c.expectation
          .map((e) => `${e.client} ${e.expected}${e.scorer_agrees ? "" : " (scorer disagrees)"}`)
          .join("; ")}`,
      );
    }
    if (c.differential.length > 0) {
      fired.push(
        `differential: ${c.differential
          .map((d) => `${d.clients.join("/")} ${d.scope} ${d.kind}: ${d.detail}`)
          .join("; ")}`,
      );
    }
    if (Object.values(c.clients).some((r) => r.attempts_differ))
      fired.push("unstable across attempts");
    const outs = ids.map((id) => {
      const r = c.clients[id];
      return r === undefined ? "-" : r.voided !== undefined ? `${r.outcome} (void)` : r.outcome;
    });
    lines.push(
      `| ${cell(c.id)} | ${c.tier} | ${cite ? cell(`${cite.file}@${cite.commit.slice(0, 8)} "${cite.quote}"`) : "-"} | ${outs
        .map(cell)
        .join(" | ")} | ${cell(fired.join(" ; "))} |`,
    );
  }
  if (result.voided.length > 0) {
    lines.push("", "## Voided (failed the family base control)", "");
    for (const v of result.voided) lines.push(`- ${v.client} / ${v.family}: ${v.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

/** An existing `--out` is reused only when empty or a previous diff output of ours. */
function assertDiffOutReusable(outDir: string): void {
  if (!existsSync(outDir) || readdirSync(outDir).length === 0) return;
  const p = join(outDir, "diff.json");
  if (existsSync(p) && readFileSync(p, "utf8").includes(FUZZ_PRIVATE_MARKER)) return;
  throw new DiffRefusal(`--out ${outDir} exists and is not empty or a previous diff output`);
}

export function writeDiff(
  outDir: string,
  result: DiffResult,
  manifest: Manifest,
): { diffPath: string; triagePath: string } {
  assertDiffOutReusable(outDir);
  mkdirSync(outDir, { recursive: true });
  const diffPath = join(outDir, "diff.json");
  const triagePath = join(outDir, "triage.md");
  writeFileSync(
    diffPath,
    `${JSON.stringify(stampJson(canonicalize(result) as Record<string, unknown>), null, 2)}\n`,
  );
  writeFileSync(triagePath, stampText("md", renderTriage(result, manifest)));
  return { diffPath, triagePath };
}
