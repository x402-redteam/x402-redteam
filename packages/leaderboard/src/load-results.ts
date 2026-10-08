/**
 * Loads committed `results/*.json` report files and `results/_meta.json`, per
 * functional-design.md §2. `readdirSync` (no `recursive` option) only ever lists a
 * directory's direct children, so `results/internal/` - a subdirectory, not a
 * `.json` file - is never returned here: the leaderboard structurally never reads
 * `results/internal/` (U13 functional-design.md §2/§6, user decision at G5), without
 * needing an explicit exclusion rule that could later be loosened by accident.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { canonicalize } from "@x402-redteam/schema";
import type { VerifiedEntry, VerifiedMap } from "./provenance.js";

/**
 * Security review HIGH-5: a deterministic content hash of a parsed report, independent
 * of key order or whitespace - the same hash `buildLeaderboard` recomputes to check
 * against `VerifiedEntry.subject_sha256`, and what `--verify-attestations` records into
 * that field when it verifies an attestation. Deliberately hashes the *canonicalized*
 * value, not the raw file bytes: a submitter's own `report.json` and this repo's
 * freshly-read copy of it can differ in incidental formatting (trailing newline, key
 * order) without differing in content, and this hash must agree on both.
 */

/** Security review HIGH-5: sha256 of `data`'s canonicalized JSON - see
 * the doc comment above for why this isn't a raw-byte hash. */
export function contentHash(data: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(data)))
    .digest("hex");
}

/** One committed `results/<id>.json`, parsed but not yet validated. */
export interface RawResultEntry {
  /** The filename stem, e.g. `results/naive-baseline.json` -> `"naive-baseline"`. */
  id: string;
  data: unknown;
  /** Security review HIGH-5: `contentHash(data)` - what a `VerifiedEntry.subject_sha256`
   * must match for this entry to be accepted at Tier 1/2. */
  sha256: string;
}

export type EntryKind = "reference" | "submitted";

/**
 * `results/_meta.json`: `{ "<id>": { "kind": "reference", "owner"?: "submitter-login" } }`
 * (functional-design.md §2). Security review HIGH-6: `owner` is the submitter's GitHub
 * login/org - required to verify a Tier 2 attestation's `--owner` (a Tier 2 report is
 * attested by the submitter's own repo, which the signer-workflow path alone doesn't
 * name). Absent for reference entries and for any entry that hasn't gone through the
 * `--verify-attestations` step yet.
 */
export type ResultsMeta = Record<string, { kind: EntryKind; owner?: string }>;

const META_FILENAME = "_meta.json";

/**
 * Every `results/_*.json` file (`_meta.json`, `_harness.json`, and any future
 * underscore-prefixed sidecar file) is harness metadata, never a submitted report - code
 * review round 1, item 2: the original exclusion only named `_meta.json` itself, so
 * `_harness.json` (and anything else U19 adds the same way) would otherwise have been
 * loaded and rejected as a malformed "report".
 */
function isSidecarFile(filename: string): boolean {
  return filename.startsWith("_");
}

/** Every top-level `results/*.json` file except underscore-prefixed sidecar files
 * (`_meta.json`, `_harness.json`, ...), sorted by id. */
export function loadResultsDir(dir: string): RawResultEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => extname(f) === ".json" && !isSidecarFile(f))
    .sort()
    .map((file) => {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
      return { id: file.slice(0, -".json".length), data, sha256: contentHash(data) };
    });
}

/** `results/_meta.json`, or `{}` when absent. */
export function loadResultsMeta(dir: string): ResultsMeta {
  try {
    const raw = JSON.parse(readFileSync(join(dir, META_FILENAME), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return {};
    return raw as ResultsMeta;
  } catch {
    return {};
  }
}

/** The `kind` for `id` per `results/_meta.json`; entries absent from it are `submitted`. */
export function kindOf(meta: ResultsMeta, id: string): EntryKind {
  return meta[id]?.kind ?? "submitted";
}

const HARNESS_ALLOWLIST_FILENAME = "_harness.json";

/** The default allowlist (ADR-016 §3 / ADR-011: "the file starts with `{"allow":["*"]}`
 * until U19 fills it, and `"*"` matches anything") - what a *missing*
 * `results/_harness.json` falls back to, so the leaderboard's `harness_commit` check
 * works before U19 has written the real file. A *present but malformed* file is a
 * different situation entirely (code review round 1, item 3) - see below. */
const DEFAULT_HARNESS_ALLOWLIST: string[] = ["*"];

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * `results/_harness.json`'s `{ "allow": [...] }` release allowlist (ADR-011 "Harness
 * identity"), as the list of allowed harness commits. Each entry is either a plain commit
 * string or a `HarnessRelease` object (ADR-023), whose `commit` is what counts here - this package doesn't own `results/**` (units-of-work.md: U19), so it
 * never writes this file; it only reads whatever is (or isn't yet) there.
 *
 * Code review round 1, item 3: a *missing* file silently defaults to `["*"]` (U19
 * hasn't populated it yet, and that's expected). A file that *exists* but is malformed
 * JSON or the wrong shape throws instead of silently falling back to the same
 * all-permissive default - silently treating a corrupted or tampered allowlist as
 * "allow everything" would turn a parsing bug (or an attacker-controlled PR that breaks
 * the file) into a silent disabling of the entire harness-identity check.
 */
export function loadHarnessAllowlist(dir: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, HARNESS_ALLOWLIST_FILENAME), "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return DEFAULT_HARNESS_ALLOWLIST;
    throw new Error(
      `failed to read ${HARNESS_ALLOWLIST_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${HARNESS_ALLOWLIST_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("allow" in parsed) ||
    !Array.isArray((parsed as { allow: unknown }).allow) ||
    !(parsed as { allow: unknown[] }).allow.every(
      (v) => typeof v === "string" || isHarnessRelease(v),
    )
  ) {
    throw new Error(
      `${HARNESS_ALLOWLIST_FILENAME} must be shaped like {"allow": (string | {"commit", "version", "image"})[]}`,
    );
  }
  return (parsed as { allow: Array<string | HarnessRelease> }).allow.map((v) =>
    typeof v === "string" ? v : v.commit,
  );
}

/**
 * One released harness in `results/_harness.json`'s object form: the release commit, its
 * `vX.Y.Z` tag and the `sha256:` digest of the ranked image built from it. The ranked
 * workflows resolve the image from this form (`scripts/ranked/resolve-image.mjs`); the
 * leaderboard only needs the commit.
 */
export interface HarnessRelease {
  commit: string;
  version: string;
  image: string;
}

const RELEASE_COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_VERSION = /^v\d+\.\d+\.\d+$/;
const RELEASE_IMAGE = /^sha256:[0-9a-f]{64}$/;

/** Same entry rules as `scripts/ranked/resolve-image.mjs`. */
function isHarnessRelease(value: unknown): value is HarnessRelease {
  if (typeof value !== "object" || value === null) return false;
  const { commit, version, image } = value as Record<string, unknown>;
  return (
    typeof commit === "string" &&
    RELEASE_COMMIT.test(commit) &&
    typeof version === "string" &&
    RELEASE_VERSION.test(version) &&
    typeof image === "string" &&
    RELEASE_IMAGE.test(image)
  );
}

const VERIFIED_FILENAME = "_verified.json";

function isVerifiedEntry(value: unknown): value is VerifiedEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { tier?: unknown }).tier === 1 || (value as { tier?: unknown }).tier === 2) &&
    typeof (value as { signer?: unknown }).signer === "string" &&
    typeof (value as { subject_sha256?: unknown }).subject_sha256 === "string"
  );
}

/**
 * `results/_verified.json`'s `{"<id>": {tier, signer, run_url?}}` map (ADR-011
 * provenance tiers, U19) - written ahead of time by the separate `--verify-attestations`
 * step (`provenance.ts`'s `verifyEntries`), never by `pnpm leaderboard`'s own offline
 * default path. A *missing* file defaults to `{}` (no entry is verified - every
 * guardrail-track result is Tier 3/self-reported until proven otherwise, ADR-011's own
 * default). A file that *exists* but is malformed throws, for the same reason
 * `loadHarnessAllowlist` does: silently treating a corrupted/tampered verification map
 * as "nothing is verified" is safe, but silently treating it as "{} means verify
 * nothing is wrong" either way - either way a throw surfaces the problem instead of
 * either silently under- or over-trusting a broken file.
 */
export function loadVerifiedMap(dir: string): VerifiedMap {
  let raw: string;
  try {
    raw = readFileSync(join(dir, VERIFIED_FILENAME), "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return {};
    throw new Error(
      `failed to read ${VERIFIED_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${VERIFIED_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${VERIFIED_FILENAME} must be shaped like {"<id>": {tier, signer, subject_sha256}}`,
    );
  }
  const out: VerifiedMap = {};
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isVerifiedEntry(entry)) {
      throw new Error(
        `${VERIFIED_FILENAME}: entry "${id}" must be shaped like {tier, signer, subject_sha256}`,
      );
    }
    out[id] = entry;
  }
  return out;
}

const SEASONS_FILENAME = "_seasons.json";

/**
 * Security review MEDIUM-11: one committed season record - the *public* commitment
 * published at season start (docs/seasons.md), never the real seed. `corpus_hash` is
 * the held-out corpus's own hash (not the public `corpus/` dir's), so a Tier 1 report's
 * `corpus_hash`/`seed_commitment` can be checked against a fixed, independently
 * published record instead of trusting whatever the report itself claims.
 */
export interface SeasonRecord {
  seed_commitment: string;
  corpus_hash: string;
  starts: string;
  ends: string;
}

/** `results/_seasons.json`: `{"<season id>": SeasonRecord}`. */
export type SeasonRecords = Record<string, SeasonRecord>;

function isSeasonRecord(value: unknown): value is SeasonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { seed_commitment?: unknown }).seed_commitment === "string" &&
    typeof (value as { corpus_hash?: unknown }).corpus_hash === "string" &&
    typeof (value as { starts?: unknown }).starts === "string" &&
    typeof (value as { ends?: unknown }).ends === "string"
  );
}

/**
 * `results/_seasons.json` (security review MEDIUM-11) - this package doesn't own
 * `results/**` (units-of-work.md: U19 does), so this only reads whatever is (or isn't
 * yet) there. A *missing* file defaults to `{}` (no season has been committed yet, so
 * every Tier 1 entry is rejected - condition #14's spirit applies here too: nothing is
 * ranked until the record it must match actually exists). A *present but malformed*
 * file throws, same reasoning as `loadHarnessAllowlist`/`loadVerifiedMap`.
 */
export function loadSeasonRecords(dir: string): SeasonRecords {
  let raw: string;
  try {
    raw = readFileSync(join(dir, SEASONS_FILENAME), "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return {};
    throw new Error(
      `failed to read ${SEASONS_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${SEASONS_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${SEASONS_FILENAME} must be shaped like {"<season id>": SeasonRecord}`);
  }
  const out: SeasonRecords = {};
  for (const [id, record] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isSeasonRecord(record)) {
      throw new Error(
        `${SEASONS_FILENAME}: entry "${id}" must be shaped like {seed_commitment, corpus_hash, starts, ends}`,
      );
    }
    out[id] = record;
  }
  return out;
}
