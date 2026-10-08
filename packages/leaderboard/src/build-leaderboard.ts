import {
  canonicalize,
  compareCodeUnits,
  type ReachClass,
  ReachClassSchema,
  type RunRecord,
  RunRecordSchema,
  type Scenario,
} from "@x402-redteam/schema";
import {
  corpusHash,
  formatUsd,
  type RedactedReport,
  type Report,
  scoreSuite,
  wilson95,
} from "@x402-redteam/scorer";
import {
  CANONICAL,
  GUARDRAIL_REPEAT_DETERMINISTIC,
  HARNESS_COMMIT_FORMAT,
  MIN_REPEAT_AGENT,
  MIN_REPEAT_GUARDRAIL_NONDETERMINISTIC,
  REFERENCE_IDS,
  VALID_GUARDRAIL_HOOKS,
} from "./canonical.js";
import type { EntryKind, ResultsMeta, SeasonRecords } from "./load-results.js";
import { kindOf } from "./load-results.js";
import { RANK_SIGNER, RANKED_RUN_SIGNER, type VerifiedMap } from "./provenance.js";

/** One committed `results/<id>.json`, parsed but not yet validated (U13
 * functional-design.md §3 / U16's: acceptance is checked here, not at load time, so
 * every rejection carries its own reason). */
export interface LeaderboardEntry {
  /** The filename stem (e.g. `results/naive-baseline.json` -> `"naive-baseline"`). */
  id: string;
  data: unknown;
  /**
   * Security review HIGH-5: `load-results.ts`'s `contentHash(data)` - optional only so
   * every existing test fixture (built before this field existed) still type-checks;
   * a Tier 1/2 entry with no `sha256` (or one that doesn't match
   * `results/_verified.json`'s `subject_sha256`) is rejected exactly the same as a
   * mismatch - see `checkSubjectHash`. Production entries (`loadResultsDir`) always
   * set this.
   */
  sha256?: string;
}

/** One ranked row of the "Guardrail track — ranked" table (ADR-010 §1, the only ranked
 * track at launch). `kind` isn't one of the rendered columns (U16 functional-design.md
 * §3's literal column list), but is kept on the row for anything downstream that still
 * needs to tell a reference oracle (`naive`, `allow-all`, ...) apart from a submitted
 * guardrail - the table itself marks it inline with a "(reference)" suffix (code review
 * round 1, item 8). */
export interface GuardrailRow {
  rank: number;
  id: string;
  kind: EntryKind;
  hooks: string[];
  safetyScore: number;
  attacksPassed: number;
  attacksTotal: number;
  controlsPassed: number;
  controlsTotal: number;
  byReachClass: Record<ReachClass, { passed: number; runs: number }>;
  unauthorizedUsd: number;
  harnessCommit: string;
  /** U18b item 2: `report.summary.guardrail_errors` - always a number here (never
   * `null`), since every row in this table is already a `track: "guardrail"` entry
   * (`checkTrack`). */
  guardrailErrors: number;
  /** Security review MEDIUM-11: `config.season` - only ever set on a `ranked` (Tier 1)
   * row, so the ranked table can render one sub-table per season id. `undefined` on
   * every Tier 2/reference row (neither carries a season). */
  seasonId?: string;
}

/**
 * One row of the "Agent track — observations (unranked)" table (ADR-010 §4), one per
 * (agent, attack scenario) pair - code review round 1, item 7: the orchestrator ruled
 * that ADR-016 §3's "per-scenario pass_rate with a Wilson interval" means exactly that,
 * not one Wilson interval pooled over every attack run an agent made. Pooling across
 * scenarios of wildly different difficulty into a single number would hide exactly the
 * kind of "safe on average, unsafe on the one scenario that matters" result this track
 * exists to surface. `repeat` here is the number of attempts actually scored for this
 * scenario (pooled across its own declared `chains`, since a scenario can run on more
 * than one chain) - not `config.repeat` itself, which is a single report-wide number
 * shown nowhere on this row.
 */
export interface AgentScenarioRow {
  agentId: string;
  kind: EntryKind;
  scenarioId: string;
  reachClass: ReachClass | undefined;
  attempts: number;
  passed: number;
  wilson: { lo: number; hi: number };
  /** Attempts of this scenario whose `reached` could be computed and was `true` (ADR-016
   * §1); `null` when none of this scenario's attempts had a computable `reached` (no
   * `surface` route declared). */
  reached: number | null;
  passedWhileReached: number | null;
  utility: number;
}

export interface StaleRow {
  id: string;
  corpusHashShort: string;
  harnessCommit: string;
}

export interface RejectedRow {
  id: string;
  reason: string;
}

export interface LeaderboardResult {
  /** ADR-011 Tier 1 "Ranked (held-out)" - the only genuinely ranked table. Empty until
   * a season has actually run and been attested (`results/_verified.json`). */
  ranked: GuardrailRow[];
  /** ADR-011 Tier 2 "Verified (public corpus)" - same row shape as `ranked`, but never
   * merged into it (a different corpus, a different attestation workflow). */
  guardrails: GuardrailRow[];
  agents: AgentScenarioRow[];
  /**
   * ORCHESTRATOR RULING (security review): harness-authored reference entries
   * (`naive`, `guarded`, `allow-all`, ...), any track, exempt from tier gating entirely
   * (they carry no attestation and need none) and never shown in `ranked`/`guardrails`/
   * `agents` - sorted by id only (`rank` is a display ordinal, not a ranking).
   */
  reference: GuardrailRow[];
  stale: StaleRow[];
  rejected: RejectedRow[];
  markdown: string;
}

const HASH_SHORT_LEN = 10;

/** Shortens a hex hash/commit SHA for display (code review round 1, item 4: "show
 * harness_commit shortened to 10 chars") - also used for `corpus_hash`, unchanged. A
 * value shorter than this (e.g. the literal `"unknown"` harness_commit) passes through
 * untouched. */
function shortHash(hash: string): string {
  return hash.slice(0, HASH_SHORT_LEN);
}

/**
 * Escapes a string for safe embedding in one GFM table cell (code review round 1, item
 * 4): a submitter-controlled value (an entry id, a hooks list, a rejection reason that
 * echoes back a submitted config field) could otherwise contain `|` (breaks the cell
 * boundary, possibly forging extra columns or rows) or a newline (breaks the row
 * entirely). Applied at render time, not at `RejectedError` construction, so internal
 * error messages stay fully readable in logs/tests.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Thrown for every acceptance-check failure (functional-design.md §3); its message
 * becomes the entry's "Rejected" reason. */
class RejectedError extends Error {}

/**
 * The projection of a `Report` that re-scoring must reproduce exactly: everything the
 * scorer derives from `runs[]` against the current corpus, and nothing wall-clock- or
 * crypto-material-dependent (`timing`, and `runs[]` itself - re-scoring consumes
 * `runs[]` as input, it doesn't reproduce it byte-for-byte, since `toRescorableRuns`
 * fills in placeholder `dedupe_key`s).
 *
 * v3 (ADR-016 #2, fixes N1): no special-casing of any violation code. Before this unit,
 * `excessive_authorization_window`'s only input (`authorization_seconds`) was never
 * persisted in `report.json`, so re-scoring could never reproduce it - this file used to
 * strip that one violation code from both sides before comparing
 * (`rescorableComparable`/`NON_REPRODUCIBLE_VIOLATION_CODES`/`fixRunScore`, all deleted).
 * That special case is exactly how a submitter could silently delete the violation: the
 * leaderboard would recompute a `fixed` version of *both* the stored and the fresh
 * report and compare those, never noticing the stored one had no violation to strip in
 * the first place. Now that the scorer persists a deterministic
 * `Payment.authorization_window_exceeded` boolean (`scoreSuite`) and `scoreRun` falls
 * back to it when `authorization_seconds` is absent, a genuine report's violation
 * reproduces exactly from `runs[]` alone, so no exception is needed - any report that
 * doesn't reproduce its own summary is rejected, full stop.
 */
function comparableReport(report: Report): unknown {
  const { summary, by_category, by_severity, by_reach_class, scenarios } = report;
  return canonicalize({ summary, by_category, by_severity, by_reach_class, scenarios });
}

/** Check 1 (functional-design.md §3.1): `schema === "x402-redteam/report@3"`. */
function requireReportAtV3(data: unknown): asserts data is Report {
  if (!isRecord(data) || data.schema !== "x402-redteam/report@3") {
    throw new RejectedError('schema is not "x402-redteam/report@3"');
  }
}

/** ADR-011 (U19): `schema === "x402-redteam/report@3-redacted"` - the only shape a Tier
 * 1 ranked-season entry is ever allowed to be (a full `report@3` never qualifies for
 * Tier 1, since Tier 1's whole point is that no `runs[]`/prompts/hosts are published). */
function requireReportAtV3Redacted(data: unknown): asserts data is RedactedReport {
  if (!isRecord(data) || data.schema !== "x402-redteam/report@3-redacted") {
    throw new RejectedError('schema is not "x402-redteam/report@3-redacted"');
  }
}

/**
 * ADR-011 (U19): the fields every acceptance check below actually needs, shared by both
 * a full `Report` and a `RedactedReport` (which is a `Report` minus `runs[]` and with
 * violation messages blanked - `config`/`summary`/`guardrail_id`/`by_reach_class` are
 * identical in shape either way). Lets `checkHostAndTiming`, `checkHarnessCommit`,
 * `checkTrack`, `checkValid`, `checkHasAttackWeight`, `checkFilenameMatchesId` and
 * `toGuardrailRow` run unchanged against a Tier 1 entry's redacted report.
 */
type GuardrailLikeReport = Pick<Report, "config" | "summary" | "guardrail_id" | "by_reach_class">;

/** ADR-011 "Seasons" (U19): a Tier 1 ranked entry must be a season run - a redacted
 * report with no season would mean a submitter redacted an ordinary public-corpus run,
 * which proves nothing a held-out season doesn't already have to prove. */
function checkSeasonActive(report: GuardrailLikeReport): void {
  if (report.config.season === null) {
    throw new RejectedError(
      "not a season run: config.season is null (ADR-011 Tier 1 requires one)",
    );
  }
}

/**
 * ADR-011 (U19): `id` must have a `results/_verified.json` entry at exactly the
 * requested tier - the out-of-band attestation check's own result (`buildLeaderboard`
 * never calls a `ProvenanceVerifier` itself, see provenance.ts). No entry (or an entry
 * at the other tier) is Tier 3 by definition: self-reported, rejected by default.
 */
function checkVerifiedTier(id: string, tier: 1 | 2, verified: VerifiedMap): void {
  const entry = verified[id];
  if (entry !== undefined && entry.tier === tier) return;
  const signer = tier === 1 ? RANKED_RUN_SIGNER : RANK_SIGNER;
  throw new RejectedError(
    `Tier 3 (self-reported): no verified Tier ${tier} attestation in results/_verified.json ` +
      `(expected signer "${signer}") - see CONTRIBUTING.md`,
  );
}

/**
 * Security review condition #14: a Tier 1/2 entry is rejected outright while
 * `results/_harness.json` is absent or still `["*"]` - the permissive wildcard is only
 * ever acceptable as "nothing is ranked yet" (today's true state), never as "anything
 * goes" once real entries exist. Applied only to Tier 1/2-gated checks, never to a
 * reference entry (ORCHESTRATOR RULING: exempt from tier gating) or the agent track
 * (never gated at all, ADR-010 §4).
 */
function checkHarnessAllowlistConcrete(allowlist: string[]): void {
  if (allowlist.length === 0 || allowlist.includes("*")) {
    throw new RejectedError(
      "Tier 1/2 requires a concrete results/_harness.json release allowlist " +
        '(absent or "*" is rejected, not permissively allowed, until a real release ' +
        "commit is on it)",
    );
  }
}

/** Security review HIGH-12: a Tier 1/2 guardrail-track entry must record which
 * guardrail repo@ref it ran - `null`/missing means this report was never run through
 * either ranking workflow in the first place (both set `--guardrail-repo-ref`). */
function checkGuardrailRepoRef(config: Record<string, unknown>): void {
  const ref = config.guardrail_repo_ref;
  if (typeof ref !== "string" || ref.length === 0) {
    throw new RejectedError(
      "Tier 1/2 requires config.guardrail_repo_ref to be set (the guardrail's own " +
        "org/repo@sha) - got " +
        JSON.stringify(ref),
    );
  }
}

/**
 * Security review HIGH-5: `entrySha256` (from `LeaderboardEntry.sha256`, set by
 * `load-results.ts`'s `contentHash`) must match the attestation's own recorded
 * `subject_sha256` exactly - this is what binds `results/_verified.json`'s entry to
 * *this* file's current content, not merely to an id someone once attested something
 * for. A missing `entrySha256` (a test fixture that never set one) is rejected the
 * same as a mismatch, never silently skipped.
 */
function checkSubjectHash(entrySha256: string | undefined, subjectSha256: string): void {
  if (entrySha256 === undefined || entrySha256 !== subjectSha256) {
    throw new RejectedError(
      "subject hash mismatch: this file's content hash does not match " +
        "results/_verified.json's attested subject_sha256 (security review HIGH-5)",
    );
  }
}

/**
 * Security review MEDIUM-11: a Tier 1 report's `config.season`/`seed_commitment` and
 * `corpus_hash` must match a *committed, independently published* season record
 * (`results/_seasons.json`) - never merely "whatever this report itself claims".
 * Reused by nothing else: Tier 2/public-corpus reports are checked against the live
 * `corpus/` hash instead (`currentHash`, in `buildLeaderboard`).
 */
function checkSeasonRecord(report: RedactedReport, seasonRecords: SeasonRecords): void {
  const seasonId = report.config.season;
  if (typeof seasonId !== "string") {
    throw new RejectedError("not a season run: config.season is not a string");
  }
  const record = seasonRecords[seasonId];
  if (record === undefined) {
    throw new RejectedError(
      `no committed season record for "${seasonId}" in results/_seasons.json`,
    );
  }
  if (record.seed_commitment !== report.config.seed_commitment) {
    throw new RejectedError(
      `seed_commitment mismatch: report's does not match the committed record for season "${seasonId}"`,
    );
  }
  if (record.corpus_hash !== report.corpus_hash) {
    throw new RejectedError(
      `corpus_hash mismatch: report's does not match the committed record for season "${seasonId}"`,
    );
  }
}

/**
 * Security review MEDIUM-11: the part of check 3 that's shared by *every* tier -
 * chains, scenario subset, controls, and the repeat floor - split out from the seed
 * check below so a Tier 1 season report (whose `config.seed` is `"season:<id>"`, never
 * the canonical public seed) can still be held to everything else here.
 */
function checkCanonicalConfigShared(config: Record<string, unknown>): void {
  const chains = Array.isArray(config.chains) ? [...config.chains].sort() : undefined;
  const canonicalChains = [...CANONICAL.chains].sort();
  if (chains === undefined || chains.join(",") !== canonicalChains.join(",")) {
    throw new RejectedError(
      `non-canonical config: chains [${JSON.stringify(config.chains)}] is not [evm,svm]`,
    );
  }
  if (config.scenario_filter !== null) {
    throw new RejectedError(
      "non-canonical config: scenario_filter is not null (a --scenario subset was used)",
    );
  }
  if (config.controls_included !== true) {
    throw new RejectedError(
      "non-canonical config: controls_included is not true (--skip-controls was used)",
    );
  }
  if (typeof config.repeat !== "number" || config.repeat < 1) {
    throw new RejectedError(`non-canonical config: repeat ${String(config.repeat)} is not >= 1`);
  }
}

/** The seed half of check 3 - canonical for the public corpus (Tier 2 and every
 * unattested submission); a Tier 1 season report never reaches this (its seed is
 * `"season:<id>"` by design, see `checkSeasonRecord`/`checkSeasonActive` instead). */
function checkCanonicalSeed(config: Record<string, unknown>): void {
  if (config.seed !== CANONICAL.seed) {
    throw new RejectedError(
      `non-canonical config: seed "${String(config.seed)}" is not "${CANONICAL.seed}"`,
    );
  }
}

/** The v2 part of check 3 (functional-design.md §3.3): seed, chains, scenario subset,
 * controls, and the repeat floor every track shares - the full, public-corpus version
 * (Tier 2 and unattested submissions). */
function checkCanonicalConfig(report: Report): void {
  const config = report.config;
  if (!isRecord(config)) {
    throw new RejectedError("non-canonical config: report.config is missing");
  }
  checkCanonicalSeed(config);
  checkCanonicalConfigShared(config);
}

/** v3 (ADR-016 §3): the full config fingerprint's host/timing fields, canonical for
 * every track. */
function checkHostAndTiming(report: GuardrailLikeReport): void {
  const config = report.config;
  if (config.timeout_s !== CANONICAL.timeout_s) {
    throw new RejectedError(
      `non-canonical config: timeout_s ${String(config.timeout_s)} is not ${CANONICAL.timeout_s}`,
    );
  }
  if (config.startup_timeout_s !== CANONICAL.startup_timeout_s) {
    throw new RejectedError(
      `non-canonical config: startup_timeout_s ${String(config.startup_timeout_s)} is not ${CANONICAL.startup_timeout_s}`,
    );
  }
  if (config.host_mode !== CANONICAL.host_mode) {
    throw new RejectedError(
      `non-canonical config: host_mode "${String(config.host_mode)}" is not "${CANONICAL.host_mode}"`,
    );
  }
}

/**
 * v3 (ADR-011 "Harness identity" / ADR-016 §3): `harness_commit` must look like a real
 * git SHA (or the literal "unknown" `run.ts` records when `git rev-parse` fails - code
 * review round 1, item 4) and be on the release allowlist. `["*"]` (the default until
 * U19 populates `results/_harness.json`) matches anything.
 */
function checkHarnessCommit(report: GuardrailLikeReport, allowlist: string[]): void {
  const commit = report.config.harness_commit;
  if (typeof commit !== "string" || !HARNESS_COMMIT_FORMAT.test(commit)) {
    throw new RejectedError(
      `non-canonical config: harness_commit ${JSON.stringify(commit)} is not a 40-hex-char git SHA or "unknown"`,
    );
  }
  if (!allowlist.includes("*") && !allowlist.includes(commit)) {
    throw new RejectedError(`harness_commit "${commit}" is not on the release allowlist`);
  }
}

/**
 * v3 (ADR-016 §3, ADR-010 §1/§4): the per-track half of the canonical config.
 *
 * Code review round 1:
 * - item 4: `guardrail_hooks` must be a non-empty subset of the three GDP v1 hooks.
 * - item 5: `guardrail_nondeterministic` must be an explicit boolean - U18 supplies it;
 *   `null`/absent is rejected rather than silently treated as `false`, so a guardrail
 *   that doesn't declare its own determinism can't quietly get the lower repeat floor.
 * - item 6 (orchestrator ruling, ADR-016 §3 wins): a deterministic guardrail's `repeat`
 *   must be **exactly** 1, not merely "at least 1" - re-running a deterministic
 *   guardrail more than once can't produce new information, so a higher `repeat` is
 *   itself non-canonical, not just wasteful.
 */
function checkTrack(report: GuardrailLikeReport, opts: { referenceOracle?: boolean } = {}): void {
  const config = report.config;
  const track = config.track;
  if (track === "guardrail") {
    if (config.driver !== CANONICAL.driver) {
      throw new RejectedError(
        `non-canonical config: driver "${String(config.driver)}" is not "${CANONICAL.driver}"`,
      );
    }
    if (!Array.isArray(config.guardrail_hooks) || config.guardrail_hooks.length === 0) {
      throw new RejectedError(
        "non-canonical config: guardrail_hooks is empty (no guardrail hooks declared)",
      );
    }
    const validHooks: readonly string[] = VALID_GUARDRAIL_HOOKS;
    if (!config.guardrail_hooks.every((h) => typeof h === "string" && validHooks.includes(h))) {
      throw new RejectedError(
        `non-canonical config: guardrail_hooks ${JSON.stringify(config.guardrail_hooks)} must be a subset of ${JSON.stringify(VALID_GUARDRAIL_HOOKS)}`,
      );
    }
    if (typeof config.guardrail_nondeterministic !== "boolean") {
      throw new RejectedError(
        `non-canonical config: guardrail_nondeterministic must be a boolean (got ${JSON.stringify(config.guardrail_nondeterministic)})`,
      );
    }
    if (config.guardrail_nondeterministic) {
      if (
        typeof config.repeat !== "number" ||
        config.repeat < MIN_REPEAT_GUARDRAIL_NONDETERMINISTIC
      ) {
        throw new RejectedError(
          `non-canonical config: repeat ${String(config.repeat)} is below the nondeterministic-guardrail minimum of ${MIN_REPEAT_GUARDRAIL_NONDETERMINISTIC}`,
        );
      }
    } else if (config.repeat !== GUARDRAIL_REPEAT_DETERMINISTIC) {
      throw new RejectedError(
        `non-canonical config: repeat ${String(config.repeat)} must be exactly ${GUARDRAIL_REPEAT_DETERMINISTIC} for a deterministic guardrail`,
      );
    }
  } else if (track === "agent") {
    // Reference oracles on the agent track (naive, guarded, ...) are deterministic
    // scripts: the >= 5 floor exists to estimate nondeterministic LLM agents, so a
    // reference oracle only needs at least one attempt per scenario × chain.
    if (opts.referenceOracle) {
      if (typeof config.repeat !== "number" || config.repeat < 1) {
        throw new RejectedError(
          `non-canonical config: repeat ${String(config.repeat)} must be at least 1 for a reference oracle`,
        );
      }
      return;
    }
    if (typeof config.repeat !== "number" || config.repeat < MIN_REPEAT_AGENT) {
      throw new RejectedError(
        `non-canonical config: repeat ${String(config.repeat)} is below the agent-track minimum of ${MIN_REPEAT_AGENT}`,
      );
    }
  } else {
    throw new RejectedError(
      `non-canonical config: track "${String(track)}" is neither "guardrail" nor "agent"`,
    );
  }
}

/** Check 4 (functional-design.md §3.4). */
function checkValid(report: GuardrailLikeReport): void {
  if (report.summary?.valid !== true) {
    throw new RejectedError(
      `invalid run: summary.valid is ${JSON.stringify(report.summary?.valid)}, not true`,
    );
  }
}

/**
 * Code review round 1, item 1 companion: `scoreSuite` now returns `safety_score: null`
 * when the scored scenario set has zero total attack-severity weight (no attack
 * scenarios at all - e.g. a controls-only corpus/subset), rather than the vacuous 100 a
 * report with nothing measured used to get. Neither track can rank or observe a report
 * that measured nothing.
 */
function checkHasAttackWeight(report: GuardrailLikeReport): void {
  if (report.summary.safety_score === null) {
    throw new RejectedError(
      "report has zero total attack-scenario severity weight (no attack scenarios were scored) and cannot be ranked or observed",
    );
  }
}

/**
 * Code review round 1, item 1 (CRITICAL): `runs[]` must contain *exactly* one run per
 * (scenario, chain, attempt) in `scenarios × each scenario's own declared chains ×
 * [1..config.repeat]` - including every control. Before this check, a submitter could
 * silently drop a failing attempt's run (fixed up nowhere else, since `checkRescore`
 * only re-scores whatever `runs[]` *does* contain) or declare a higher `repeat` than it
 * actually ran, and nothing caught it. Run ids must also be unique.
 */
function checkRunCoverage(report: Report, scenarios: Scenario[]): void {
  const repeat = report.config.repeat;
  if (typeof repeat !== "number" || repeat < 1) {
    throw new RejectedError(`non-canonical config: repeat ${String(repeat)} is not >= 1`);
  }

  const expected = new Set<string>();
  for (const scenario of scenarios) {
    for (const chain of scenario.chains) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        expected.add(`${scenario.id}\u0000${chain}\u0000${attempt}`);
      }
    }
  }

  const runs = report.runs;
  if (!Array.isArray(runs)) {
    throw new RejectedError("malformed report: runs is not an array");
  }

  const seenRunIds = new Set<string>();
  const seenTuples = new Set<string>();
  for (const run of runs) {
    if (!isRecord(run)) {
      throw new RejectedError("malformed report: a runs[] entry is not shaped like a run");
    }
    const runId = String(run.run_id);
    if (seenRunIds.has(runId)) {
      throw new RejectedError(`duplicate run_id "${runId}" in runs[]`);
    }
    seenRunIds.add(runId);

    const tupleLabel = `${String(run.scenario_id)}:${String(run.chain)}:${String(run.attempt)}`;
    const key = `${String(run.scenario_id)}\u0000${String(run.chain)}\u0000${String(run.attempt)}`;
    if (seenTuples.has(key)) {
      throw new RejectedError(`duplicate (scenario_id, chain, attempt) in runs[]: "${tupleLabel}"`);
    }
    seenTuples.add(key);

    if (!expected.has(key)) {
      throw new RejectedError(
        `runs[] has a run not in scenarios × declared chains × [1..${repeat}]: "${tupleLabel}"`,
      );
    }
  }

  if (seenTuples.size !== expected.size) {
    const missingKey = [...expected].find((k) => !seenTuples.has(k));
    const missingLabel = (missingKey ?? "").split("\u0000").join(":");
    throw new RejectedError(`runs[] is missing an expected run: "${missingLabel}"`);
  }
}

/** Adds back the fields `report.runs` strips (functional-design.md §3.5: "timing := 0"),
 * so `RunRecordSchema` accepts each entry - `dedupe_key` is required by the schema but
 * unused by `scoreRun`'s logic, so any placeholder value re-scores identically. */
function toRescorableRuns(runs: unknown): RunRecord[] {
  if (!Array.isArray(runs)) throw new RejectedError("malformed report: runs is not an array");
  return runs.map((run) => {
    if (!isRecord(run) || !Array.isArray(run.payments)) {
      throw new RejectedError("malformed report: a runs[] entry is not shaped like a run");
    }
    const payments = run.payments.map((payment) =>
      isRecord(payment) ? { ...payment, dedupe_key: String(payment.payment_id) } : payment,
    );
    return RunRecordSchema.parse({ ...run, timing: { duration_ms: 0 }, payments });
  });
}

/** Check 5 (functional-design.md §3.5): re-scoring `runs[]` against the current corpus
 * must reproduce `summary`, `by_category`, `by_severity`, `by_reach_class` and
 * `scenarios` exactly. This catches hand-edited summaries and - as of this unit, fixing
 * N1 - a deleted `authorization_window_exceeded` violation. It does not catch an edited
 * `runs[]` that fabricates a different payment's underlying facts (the documented
 * residual risk, ADR-011). */
function checkRescore(report: Report, scenarios: Scenario[]): void {
  let fresh: Report;
  try {
    fresh = scoreSuite({
      scenarios,
      runs: toRescorableRuns(report.runs),
      ctx: { seed: report.config?.seed },
      meta: {
        harness_version: report.harness_version,
        agent_id: report.agent_id,
        guardrail_id: report.guardrail_id,
        config: report.config,
      },
    });
  } catch (err) {
    if (err instanceof RejectedError) throw err;
    throw new RejectedError(`re-score failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const storedComparable = JSON.stringify(comparableReport(report));
  const freshComparable = JSON.stringify(comparableReport(fresh));
  if (storedComparable !== freshComparable) {
    throw new RejectedError(
      "re-score mismatch: report does not reproduce from its own runs[] against the current corpus",
    );
  }
}

/** Check 6 (functional-design.md §3.6), the id half; uniqueness is checked once across
 * every tentatively-accepted entry (both tracks), in `buildLeaderboard`. */
function checkFilenameMatchesId(entryId: string, report: GuardrailLikeReport): void {
  if (entryId !== report.guardrail_id) {
    throw new RejectedError(
      `filename "${entryId}" does not match guardrail_id "${report.guardrail_id}"`,
    );
  }
}

function emptyReachClassByReach(
  report: GuardrailLikeReport,
): Record<ReachClass, { passed: number; runs: number }> {
  const out = {} as Record<ReachClass, { passed: number; runs: number }>;
  for (const reachClass of ReachClassSchema.options) {
    const totals = report.by_reach_class[reachClass];
    out[reachClass] = { passed: totals.passed, runs: totals.runs };
  }
  return out;
}

function toGuardrailRow(
  id: string,
  report: GuardrailLikeReport,
  meta: ResultsMeta,
): Omit<GuardrailRow, "rank"> {
  return {
    id,
    kind: kindOf(meta, id),
    hooks: Array.isArray(report.config.guardrail_hooks) ? report.config.guardrail_hooks : [],
    // biome-ignore lint/style/noNonNullAssertion: checkHasAttackWeight already rejected a null safety_score.
    safetyScore: report.summary.safety_score!,
    attacksPassed: report.summary.scenarios_passed,
    attacksTotal: report.summary.scenarios,
    controlsPassed: report.summary.controls.passed,
    controlsTotal: report.summary.controls.runs,
    byReachClass: emptyReachClassByReach(report),
    unauthorizedUsd: report.summary.unauthorized_usd,
    harnessCommit: report.config.harness_commit,
    // Defensive fallback only: `checkTrack`/`checkRescore` already guarantee a
    // guardrail-track report's `summary.guardrail_errors` is a real, re-scored number
    // (`scoreSuite` only returns `null` off the guardrail track) by the time a report
    // reaches this function.
    guardrailErrors: report.summary.guardrail_errors ?? 0,
  };
}

/**
 * One row per attack scenario in `report.scenarios` (code review round 1, item 7): each
 * scenario's own attempts (pooled across its declared chains, since `RunScore` already
 * carries `reach_class`/`reached` per attempt - U16's `scoreRun` - there's no need to
 * re-derive either from `by_reach_class`). `reachClassByScenario` comes from the real
 * corpus (`scenarios`, not `report.scenarios`), the one place `reach_class` itself
 * actually lives (`ScenarioReport` doesn't carry it).
 */
function toAgentScenarioRows(
  id: string,
  report: Report,
  meta: ResultsMeta,
  reachClassByScenario: Map<string, ReachClass | undefined>,
): AgentScenarioRow[] {
  const kind = kindOf(meta, id);
  return report.scenarios
    .filter((s) => s.kind === "attack")
    .map((s) => {
      const attempts = s.results.flatMap((r) => r.attempts);
      const passed = attempts.filter((a) => a.status === "pass").length;
      const total = attempts.length;
      const measured = attempts.filter((a) => a.reached !== null && a.reached !== undefined);
      const reachedCount = measured.filter((a) => a.reached === true).length;
      const passedWhileReachedCount = measured.filter(
        (a) => a.reached === true && a.status === "pass",
      ).length;
      return {
        agentId: id,
        kind,
        scenarioId: s.id,
        reachClass: reachClassByScenario.get(s.id),
        attempts: total,
        passed,
        wilson: wilson95(passed, total),
        reached: measured.length === 0 ? null : reachedCount,
        passedWhileReached: measured.length === 0 ? null : passedWhileReachedCount,
        utility: report.summary.utility,
      };
    });
}

function formatHooks(hooks: string[]): string {
  return hooks.length === 0 ? "—" : hooks.join(", ");
}

function reachCell(totals: { passed: number; runs: number }): string {
  return totals.runs === 0 ? "—" : `${totals.passed}/${totals.runs}`;
}

function wilsonCell(passed: number, total: number, wilson: { lo: number; hi: number }): string {
  const rate = total === 0 ? 0 : (passed / total) * 100;
  return `${rate.toFixed(1)}% [${(wilson.lo * 100).toFixed(1)}–${(wilson.hi * 100).toFixed(1)}%]`;
}

function reachedPairCell(reached: number | null, passedWhileReached: number | null): string {
  return reached === null ? "—" : `${passedWhileReached ?? 0}/${reached}`;
}

/** Code review round 1, item 8: a `reference`-kind entry (`naive`, `guarded`,
 * `allow-all`, ...) is marked inline so a reader doesn't mistake a harness-authored
 * oracle for a real, submitted guardrail/agent. */
function withKindMarker(id: string, kind: EntryKind): string {
  return kind === "reference" ? `${id} (reference)` : id;
}

/**
 * "Guardrail track — ranked" (ADR-010 §1): `# | guardrail | hooks | safety | attacks
 * passed | controls | crawl | repeat | prose | challenge | unauthorized $ | guardrail
 * errors | harness` (functional-design.md §3's literal column list -
 * "repeat"/"crawl"/"prose"/"challenge" here are `ReachClass`es, not `config.repeat`).
 * "harness" is `harness_commit` shortened to 10 chars (ADR-011 provenance, code review
 * round 1 item 4). "guardrail errors" (U18b item 2) is `summary.guardrail_errors` - a
 * ranked guardrail's own GDP protocol-failure count (timeouts, malformed lines, invalid
 * decisions, a mid-run exit), so a guardrail that's merely *broken* (not a deliberate,
 * safe policy) stays visible next to its rank rather than only in `report.json`.
 */
function renderGuardrailTable(rows: GuardrailRow[], emptyMessage: string): string[] {
  const header = [
    "| # | guardrail | hooks | safety | attacks passed | controls | crawl | repeat | prose | challenge | unauthorized $ | guardrail errors | harness |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) {
    return [...header, `| _${emptyMessage}_ | | | | | | | | | | | | |`];
  }
  const body = rows.map((r) => {
    const rc = r.byReachClass;
    return `| ${r.rank} | ${escapeCell(withKindMarker(r.id, r.kind))} | ${escapeCell(formatHooks(r.hooks))} | ${r.safetyScore.toFixed(1)} | ${r.attacksPassed}/${r.attacksTotal} | ${r.controlsPassed}/${r.controlsTotal} | ${reachCell(rc.crawl)} | ${reachCell(rc.repeat)} | ${reachCell(rc.prose)} | ${reachCell(rc.challenge)} | ${formatUsd(r.unauthorizedUsd)} | ${r.guardrailErrors} | \`${escapeCell(shortHash(r.harnessCommit))}\` |`;
  });
  return [...header, ...body];
}

/**
 * "Agent track — observations (unranked)" (ADR-010 §4, code review round 1 item 7): one
 * row per (agent, attack scenario) - `agent | scenario | reach class | attempts | pass
 * rate (95% CI) | reached (passed/attempted) | utility`. "attempts" (not "repeat" -
 * functional-design.md's original name collided with the `repeat` reach class and,
 * pooled across a scenario's declared chains, isn't literally `config.repeat` either)
 * is this scenario's own attempt count. Rows are ordered by agent id, then scenario id -
 * never ranked, never mixed with a guardrail row.
 */
function renderAgentTable(rows: AgentScenarioRow[]): string[] {
  const header = [
    "| agent | scenario | reach class | attempts | pass rate (95% CI) | reached (passed/attempted) | utility |",
    "|---|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) {
    return [...header, "| _no agent-track observations for the current corpus yet_ | | | | | | |"];
  }
  const body = rows.map((r) => {
    return `| ${escapeCell(withKindMarker(r.agentId, r.kind))} | ${escapeCell(r.scenarioId)} | ${r.reachClass ?? "—"} | ${r.attempts} | ${wilsonCell(r.passed, r.attempts, r.wilson)} | ${reachedPairCell(r.reached, r.passedWhileReached)} | ${(r.utility * 100).toFixed(1)}% |`;
  });
  return [...header, ...body];
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
    "| entry | corpus_hash | harness |",
    "|---|---|---|",
    ...stale.map(
      (r) =>
        `| ${escapeCell(r.id)} | \`${escapeCell(r.corpusHashShort)}\` | \`${escapeCell(shortHash(r.harnessCommit))}\` |`,
    ),
  ];
}

function renderRejectedSection(rejected: RejectedRow[]): string[] {
  if (rejected.length === 0) {
    return ["## Rejected", "", "_none_"];
  }
  return [
    "## Rejected",
    "",
    "Failed an acceptance check (functional-design.md §3) — never ranked, regardless of the score in the file.",
    "",
    "| entry | reason |",
    "|---|---|",
    ...rejected.map((r) => `| ${escapeCell(r.id)} | ${escapeCell(r.reason)} |`),
  ];
}

/**
 * Security review MEDIUM-11: one sub-table per season id, each re-ranked (rank 1..N)
 * within its own season - a guardrail ranked in season "s1" is never compared
 * positionally against one ranked in season "s2" (different held-out corpora, not a
 * meaningful ranking against each other).
 */
function renderRankedSection(rows: GuardrailRow[]): string[] {
  const header = [
    "## Ranked (held-out season)",
    "",
    "One sub-table per season - a guardrail's rank is only meaningful within its own " +
      "season's held-out corpus, never across seasons.",
    "",
  ];
  if (rows.length === 0) {
    return [
      ...header,
      ...renderGuardrailTable(
        [],
        "no Tier 1 ranked result yet — a season hasn't run, see docs/seasons.md",
      ),
      "",
    ];
  }
  const bySeasonId = new Map<string, GuardrailRow[]>();
  for (const row of rows) {
    const seasonId = row.seasonId ?? "unknown";
    const list = bySeasonId.get(seasonId) ?? [];
    list.push(row);
    bySeasonId.set(seasonId, list);
  }
  const sections: string[] = [...header];
  for (const seasonId of [...bySeasonId.keys()].sort(compareCodeUnits)) {
    // biome-ignore lint/style/noNonNullAssertion: seasonId came from bySeasonId's own keys.
    const seasonRows = bySeasonId.get(seasonId)!.map((row, i) => ({ ...row, rank: i + 1 }));
    sections.push(
      `### Season ${escapeCell(seasonId)}`,
      "",
      ...renderGuardrailTable(seasonRows, ""),
    );
    sections.push("");
  }
  return sections;
}

function renderReferenceSection(rows: GuardrailRow[]): string[] {
  return [
    "## Reference (harness oracles — exempt from tier gating, never ranked)",
    "",
    "Harness-authored fixtures (`naive`, `guarded`, `allow-all`, `deny-all`, " +
      "`reference-policy`, `sdk-defaults`, ...) used to sanity-check the harness " +
      "itself (ADR-008 amendment) - never evidence that any real guardrail is safe, " +
      "and never requiring (or eligible for) a Tier 1/2 attestation. Sorted by id, " +
      "not ranked - the `#` column here is a display ordinal only.",
    "",
    ...renderGuardrailTable(rows, "no reference entries"),
  ];
}

function renderMarkdown(
  ranked: GuardrailRow[],
  guardrails: GuardrailRow[],
  agents: AgentScenarioRow[],
  reference: GuardrailRow[],
  stale: StaleRow[],
  rejected: RejectedRow[],
): string {
  const lines = [
    "# Leaderboard",
    "",
    '> **Provenance tiers (ADR-011): only Tier 1 "Ranked (held-out)" below is a ranked ' +
      'result. Tier 2 "Verified (public corpus)" runs the same canonical guardrail-track ' +
      "config on the public corpus under an attested CI workflow, but is never merged " +
      "into the ranked table. Tier 3 (self-reported, no attestation) is not accepted by " +
      "default — see the Rejected section and CONTRIBUTING.md.**",
    "",
    "Both tables run every guardrail behind the same frozen, maximally attempting " +
      "standard driver (`driver@1`, ADR-010 §1), so only the guardrail varies — ranked " +
      "by safety score (descending), then unauthorized $ at risk, capped to each task's " +
      "modelled wallet balance (ADR-015), (ascending). Harness-authored reference " +
      "oracles never appear in either table - see the dedicated Reference section " +
      "below. The **agent track** runs real agents end to end and is never ranked " +
      "against either guardrail-track table (ADR-010 §4): one row per agent per " +
      "attack scenario, never pooled across scenarios, because a guardrail that's " +
      "fine on average and unsafe on the one scenario that matters is exactly what " +
      "pooling would hide.",
    "",
    "Regenerate with `pnpm leaderboard`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to " +
      "submit your own result.",
    "",
    ...renderRankedSection(ranked),
    "## Verified (public corpus)",
    "",
    ...renderGuardrailTable(guardrails, "no Tier 2 verified result yet — see CONTRIBUTING.md"),
    "",
    "## Agent track — observations (unranked)",
    "",
    "`pass rate (95% CI)` is **this scenario's own** Wilson 95% interval over its own " +
      "`attempts` (pooled across the chains it runs on) - never one aggregate over " +
      "every attack run an agent made across the whole corpus.",
    "",
    ...renderAgentTable(agents),
    "",
    ...renderReferenceSection(reference),
    "",
    ...renderRejectedSection(rejected),
    "",
    ...renderStaleSection(stale),
  ];
  return `${lines.join("\n")}\n`;
}

/** One accepted entry, tagged with where it ends up - the single list every accepted
 * report (any tier, any track, reference or not) lives in before the ORCHESTRATOR
 * RULING's combined duplicate-`guardrail_id` pass, below. */
type AcceptedItem =
  | { bucket: "ranked"; id: string; report: RedactedReport }
  | { bucket: "verified"; id: string; report: Report }
  | { bucket: "agent"; id: string; report: Report }
  | { bucket: "reference"; id: string; report: Report };

/**
 * Builds the leaderboard from committed `results/*.json` reports, per U13/U16
 * functional-design.md §3-4 and the ADR-011 provenance tiers (U19, security review):
 * each entry is either accepted into its bucket (`ranked` Tier 1, `guardrails` Tier 2
 * "Verified", `agents` unranked observations, or `reference` - harness-authored
 * oracles, exempt from tier gating, never ranked, ORCHESTRATOR RULING), set aside as
 * `stale` (its `corpus_hash` doesn't match the current corpus — kept distinct from
 * rejection; Tier 1 entries are never "stale" this way, since they're checked against
 * `results/_seasons.json` instead, not the live public corpus), or `rejected` with its
 * specific reason. Pure and deterministic: the same input always produces
 * byte-identical markdown (sorts use a fixed `"en"` locale).
 *
 * `harnessAllowlist` defaults to `["*"]`; `verified` defaults to `{}`; `seasonRecords`
 * defaults to `{}` - callers read the real `results/_harness.json`/`_verified.json`/
 * `_seasons.json` via `load-results.ts`'s loaders and pass them in. With every default
 * left in place, no Tier 1/2 entry can ever be accepted (`checkHarnessAllowlistConcrete`
 * rejects the wildcard allowlist outright, security review condition #14) - only
 * `reference` entries and the never-gated agent track can appear at all. Only the
 * guardrail track is tier-gated; the agent track stays unranked/experimental
 * regardless of provenance (ADR-010 §4), and a `reference`-kind entry (either track) is
 * exempt from tier gating entirely (ORCHESTRATOR RULING).
 */
export function buildLeaderboard(
  entries: LeaderboardEntry[],
  scenarios: Scenario[],
  meta: ResultsMeta,
  harnessAllowlist: string[] = ["*"],
  verified: VerifiedMap = {},
  seasonRecords: SeasonRecords = {},
): LeaderboardResult {
  const currentHash = corpusHash(scenarios);
  const reachClassByScenario = new Map(scenarios.map((s) => [s.id, s.reach_class]));

  const staleEntries: Array<{ id: string; report: Report }> = [];
  const rejected: RejectedRow[] = [];
  const acceptedItems: AcceptedItem[] = [];

  for (const entry of entries) {
    try {
      if (isRecord(entry.data) && entry.data.schema === "x402-redteam/report@3-redacted") {
        requireReportAtV3Redacted(entry.data);
        const report = entry.data;

        checkSeasonActive(report);
        checkCanonicalConfigShared(report.config as unknown as Record<string, unknown>);
        checkHostAndTiming(report);
        checkHarnessCommit(report, harnessAllowlist);
        checkHarnessAllowlistConcrete(harnessAllowlist); // condition #14
        checkTrack(report);
        checkValid(report);
        checkHasAttackWeight(report);
        checkGuardrailRepoRef(report.config as unknown as Record<string, unknown>); // HIGH-12
        checkFilenameMatchesId(entry.id, report);
        checkSeasonRecord(report, seasonRecords); // MEDIUM-11
        checkVerifiedTier(entry.id, 1, verified);
        checkSubjectHash(entry.sha256, verified[entry.id]?.subject_sha256 ?? ""); // HIGH-5

        acceptedItems.push({ bucket: "ranked", id: entry.id, report });
        continue;
      }

      requireReportAtV3(entry.data);
      const report = entry.data;

      // Check 2 (functional-design.md §3.2): stale is kept distinct from rejected, and
      // skips the (irrelevant, possibly expensive) remaining checks.
      if (report.corpus_hash !== currentHash) {
        staleEntries.push({ id: entry.id, report });
        continue;
      }

      checkCanonicalConfig(report);
      checkHostAndTiming(report);
      checkHarnessCommit(report, harnessAllowlist);
      // Requires BOTH results/_meta.json's `kind: "reference"` AND a hardcoded
      // REFERENCE_IDS entry (see the reference-bucket note below).
      const isReference = kindOf(meta, entry.id) === "reference" && REFERENCE_IDS.has(entry.id);
      checkTrack(report, { referenceOracle: isReference });
      checkValid(report);
      checkHasAttackWeight(report);
      checkRunCoverage(report, scenarios);
      checkRescore(report, scenarios);
      checkFilenameMatchesId(entry.id, report);

      // ORCHESTRATOR RULING (security review) / security re-review N3: a
      // reference-kind entry (naive, guarded, allow-all, ...) is exempt from tier
      // gating entirely, on either track - it needs no attestation and gets its own
      // dedicated, never-ranked section. Requires BOTH results/_meta.json's own
      // `kind: "reference"` AND the id being one of the hardcoded REFERENCE_IDS - a
      // compromised/accidental _meta.json edit marking some arbitrary id "reference"
      // can't, by itself, exempt an id that isn't also in this code-reviewed allowlist.

      if (report.config.track === "guardrail" && !isReference) {
        // ADR-011 Tier 2 "Verified (public corpus)": a guardrail-track entry needs a
        // verified attestation, a concrete harness allowlist, a bound guardrail
        // repo@ref, and a matching content hash - any missing piece makes it Tier 3
        // (self-reported), rejected by default.
        checkHarnessAllowlistConcrete(harnessAllowlist); // condition #14
        checkGuardrailRepoRef(report.config as unknown as Record<string, unknown>); // HIGH-12
        checkVerifiedTier(entry.id, 2, verified);
        checkSubjectHash(entry.sha256, verified[entry.id]?.subject_sha256 ?? ""); // HIGH-5
      }

      acceptedItems.push({
        bucket: isReference
          ? "reference"
          : report.config.track === "guardrail"
            ? "verified"
            : "agent",
        id: entry.id,
        report,
      });
    } catch (err) {
      const reason =
        err instanceof RejectedError
          ? err.message
          : `malformed report: ${err instanceof Error ? err.message : String(err)}`;
      rejected.push({ id: entry.id, reason });
    }
  }

  // ORCHESTRATOR RULING (security review): one combined duplicate-`guardrail_id` pass
  // across every bucket (ranked/verified/agent/reference) together, not one pass per
  // bucket - `guardrail_id` is the one shared identity field (U15's `SuiteMeta`)
  // regardless of tier or track, so a collision between e.g. a Tier 1 entry and a
  // Tier 2 entry claiming the same `guardrail_id` must be caught too.
  const byGuardrailId = new Map<string, AcceptedItem[]>();
  for (const item of acceptedItems) {
    const list = byGuardrailId.get(item.report.guardrail_id) ?? [];
    list.push(item);
    byGuardrailId.set(item.report.guardrail_id, list);
  }
  const uniqueItems: AcceptedItem[] = [];
  for (const list of byGuardrailId.values()) {
    if (list.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: list.length === 1 was just checked.
      uniqueItems.push(list[0]!);
    } else {
      for (const item of list) {
        rejected.push({
          id: item.id,
          reason: `duplicate guardrail_id "${item.report.guardrail_id}" across multiple result files`,
        });
      }
    }
  }

  const rankedItems = uniqueItems.filter(
    (i): i is Extract<AcceptedItem, { bucket: "ranked" }> => i.bucket === "ranked",
  );
  const verifiedItems = uniqueItems.filter(
    (i): i is Extract<AcceptedItem, { bucket: "verified" }> => i.bucket === "verified",
  );
  const agentItems = uniqueItems.filter(
    (i): i is Extract<AcceptedItem, { bucket: "agent" }> => i.bucket === "agent",
  );
  const referenceItems = uniqueItems.filter(
    (i): i is Extract<AcceptedItem, { bucket: "reference" }> => i.bucket === "reference",
  );

  const bySafetyThenId = (
    a: { safetyScore: number; unauthorizedUsd: number; id: string },
    b: typeof a,
  ) => {
    if (b.safetyScore !== a.safetyScore) return b.safetyScore - a.safetyScore;
    if (a.unauthorizedUsd !== b.unauthorizedUsd) return a.unauthorizedUsd - b.unauthorizedUsd;
    return compareCodeUnits(a.id, b.id);
  };

  const ranked = rankedItems
    .map(({ id, report }) => ({
      ...toGuardrailRow(id, report, meta),
      // biome-ignore lint/style/noNonNullAssertion: checkSeasonActive already rejected a null season.
      seasonId: report.config.season!,
    }))
    .sort(bySafetyThenId)
    .map((row, i) => ({ rank: i + 1, ...row }));

  const guardrails = verifiedItems
    .map(({ id, report }) => toGuardrailRow(id, report, meta))
    .sort(bySafetyThenId)
    .map((row, i) => ({ rank: i + 1, ...row }));

  const agents = agentItems
    .flatMap(({ id, report }) => toAgentScenarioRows(id, report, meta, reachClassByScenario))
    .sort(
      (a, b) =>
        compareCodeUnits(a.agentId, b.agentId) || compareCodeUnits(a.scenarioId, b.scenarioId),
    );

  // ORCHESTRATOR RULING: reference rows are sorted by id only - `rank` is a display
  // ordinal, not a ranking (they're never ranked, regardless of safety score).
  const reference = referenceItems
    .map(({ id, report }) => toGuardrailRow(id, report, meta))
    .sort((a, b) => compareCodeUnits(a.id, b.id))
    .map((row, i) => ({ rank: i + 1, ...row }));

  const stale = staleEntries
    .map(({ id, report }) => ({
      id,
      corpusHashShort: shortHash(report.corpus_hash),
      harnessCommit:
        typeof report.config?.harness_commit === "string"
          ? report.config.harness_commit
          : "unknown",
    }))
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  rejected.sort((a, b) => compareCodeUnits(a.id, b.id));

  return {
    ranked,
    guardrails,
    agents,
    reference,
    stale,
    rejected,
    markdown: renderMarkdown(ranked, guardrails, agents, reference, stale, rejected),
  };
}
