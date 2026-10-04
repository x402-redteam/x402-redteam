/**
 * ADR-011 seasons (provenance/seasons; owner U19). A season's real secret seed is read
 * from an env var named by `--season-seed-env` and used *operationally* (wallet
 * derivation, canaries, template rendering - exactly like any other `--seed`), but it
 * must never be logged, written to `task.json`, or appear anywhere in `report.json`:
 * only its sha256 `seed_commitment` and the season's public `id` are recorded
 * (`run.ts` records `config.season`/`config.seed_commitment` from this module's return
 * value, and separately swaps the *reported* seed string for `"season:<id>"` before it
 * reaches `config.seed`/`report.seed` - see run.ts).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LoadSeasonOptions {
  seasonSeedEnv?: string;
  /** The corpus directory passed to `--corpus` - `season.json` lives alongside the
   * scenario YAML (the held-out corpus bundle carries its own, per ADR-011 "Seasons"). */
  corpusDir: string;
}

export interface SeasonInfo {
  /** The season id from `corpus/season.json`, or `null` when no season is active. */
  season: string | null;
  /** `sha256(seed)` hex, or `null` when no season is active. Publishable (ADR-011). */
  seed_commitment: string | null;
  /** The real secret seed, for operational use only (wallet/canary derivation,
   * rendering) - `undefined` when no season is active, in which case the caller keeps
   * using its own `--seed`. Never logged or written by this module. */
  seed: string | undefined;
}

interface SeasonFile {
  id: string;
  starts: string;
  ends: string;
}

const SEASON_FILENAME = "season.json";
const MIN_SEED_BITS = 256;

/**
 * Security review #13: the season seed's entropy, in bits - accepts hex (2 chars/byte)
 * or standard/URL-safe base64 (with or without padding) and measures the *decoded*
 * byte length, so a 64-hex-char or ~43-base64-char seed both read as 256 bits; any
 * other string is measured as its own raw UTF-8 byte length (a strict lower bound on
 * its entropy, since a human-typed passphrase of N bytes has at most, and usually far
 * less than, 8*N bits of real entropy - good enough to catch an obviously-too-short
 * value without claiming to measure entropy precisely).
 */
function seedBitLength(seed: string): number | undefined {
  // Every hex digit is also a valid base64 character, so a hex-charset string is
  // disambiguated as hex *first* - an odd-length run of hex digits is far more likely a
  // truncated/corrupted hex seed than intentional base64, and is rejected outright
  // rather than silently reinterpreted as (coincidentally valid) base64.
  if (/^[0-9a-fA-F]+$/.test(seed)) {
    return seed.length % 2 === 0 && seed.length > 0 ? (seed.length / 2) * 8 : undefined;
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(seed) && seed.length >= 4) {
    const encoding = /[+/]/.test(seed) ? "base64" : "base64url";
    const decoded = Buffer.from(seed, encoding);
    if (decoded.length > 0) return decoded.length * 8;
  }
  return undefined;
}

function isSeasonFile(value: unknown): value is SeasonFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { starts?: unknown }).starts === "string" &&
    typeof (value as { ends?: unknown }).ends === "string"
  );
}

function readSeasonFile(corpusDir: string): SeasonFile {
  const path = resolve(corpusDir, SEASON_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `--season-seed-env given but no ${SEASON_FILENAME} found under --corpus (expected {id, starts, ends})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isSeasonFile(parsed)) {
    throw new Error(`${path} must be shaped like {"id": string, "starts": string, "ends": string}`);
  }
  return parsed;
}

/**
 * Resolves season provenance for this run, per ADR-011 and functional-design.md §2/§3.
 * No season is active (`{season: null, seed_commitment: null, seed: undefined}`) when
 * `seasonSeedEnv` isn't given - the common case for every public-corpus run. When it is
 * given, this throws loudly (never falls back to "no season") if `corpus/season.json`
 * is missing/malformed or the named env var isn't set, since silently running an
 * un-seeded "season" would misreport provenance.
 */
export function loadSeason(opts: LoadSeasonOptions): SeasonInfo {
  if (opts.seasonSeedEnv === undefined) {
    return { season: null, seed_commitment: null, seed: undefined };
  }
  const seasonFile = readSeasonFile(opts.corpusDir);
  const seed = process.env[opts.seasonSeedEnv];
  if (!seed) {
    throw new Error(
      `--season-seed-env "${opts.seasonSeedEnv}" is not set (or is empty) in the environment`,
    );
  }
  // Security review #13: refuse a seed that isn't valid hex/base64, or decodes to less
  // than 256 bits - never echoes the seed itself in the error.
  const bits = seedBitLength(seed);
  if (bits === undefined || bits < MIN_SEED_BITS) {
    throw new Error(
      `--season-seed-env "${opts.seasonSeedEnv}" must hold a hex- or base64-encoded ` +
        `seed of at least ${MIN_SEED_BITS} bits (32 bytes: 64 hex chars, or ~43 base64 ` +
        `chars)${bits === undefined ? "" : ` - got ~${bits} bits`}`,
    );
  }
  const seed_commitment = createHash("sha256").update(seed).digest("hex");
  return { season: seasonFile.id, seed_commitment, seed };
}
