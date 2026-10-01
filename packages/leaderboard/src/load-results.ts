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

/** Every top-level `results/*.json` file except `_meta.json` itself, sorted by id. */
export function loadResultsDir(dir: string): RawResultEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => extname(f) === ".json" && f !== META_FILENAME)
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
