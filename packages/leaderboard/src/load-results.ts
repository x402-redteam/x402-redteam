/**
 * Loads committed `results/*.json` report files and `results/_meta.json`, per
 * functional-design.md §2. `readdirSync` (no `recursive` option) only ever lists a
 * directory's direct children, so `results/internal/` - a subdirectory, not a
 * `.json` file - is never returned here: the leaderboard structurally never reads
 * `results/internal/` (U13 functional-design.md §2/§6, user decision at G5), without
 * needing an explicit exclusion rule that could later be loosened by accident.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

/** One committed `results/<id>.json`, parsed but not yet validated. */
export interface RawResultEntry {
  /** The filename stem, e.g. `results/naive-baseline.json` -> `"naive-baseline"`. */
  id: string;
  data: unknown;
}

export type EntryKind = "reference" | "submitted";

/** `results/_meta.json`: `{ "<id>": { "kind": "reference" } }` (functional-design.md §2). */
export type ResultsMeta = Record<string, { kind: EntryKind }>;

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
    .map((file) => ({
      id: file.slice(0, -".json".length),
      data: JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown,
    }));
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
 * identity") - this package doesn't own `results/**` (units-of-work.md: U19), so it
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
    !(parsed as { allow: unknown[] }).allow.every((v) => typeof v === "string")
  ) {
    throw new Error(`${HARNESS_ALLOWLIST_FILENAME} must be shaped like {"allow": string[]}`);
  }
  return (parsed as { allow: string[] }).allow;
}
