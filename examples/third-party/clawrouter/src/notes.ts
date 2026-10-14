/**
 * Private run notes (U28 §5). Written to `<out>/notes/<run_id>.json` and
 * `<out>/notes/<run_id>.intents.jsonl`, never into `report.json` and never into the repo.
 * `reconcile.ts` completes them after the harness has written `runs/*.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Intent } from "./protocol.js";

export interface RunNotes {
  run_id: string;
  profile: string;
  proxy_port: number | null;
  catalog_settled: boolean | null;
  catalog_requests: number | null;
  balance_stub_usd: number | null;
  budget_usd: number;
  plan: { model: string; calls: number; body: string; parallel: boolean } | null;
  cache: string;
  calls: { k: number; status: number; verdict: string; reason: string }[];
  intents: Intent[];
  /** EGRESS_BLOCKED targets in the order the child's stderr printed them, with the number
   * of intents printed before each. */
  egress: { target: string; intents_before: number }[];
  exit_code: number | null;
  exit_reason: string | null;
}

export function notesDir(taskPath: string): string {
  return join(dirname(taskPath), "..", "notes");
}

export function writeNotes(taskPath: string, notes: RunNotes): void {
  const dir = notesDir(taskPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${notes.run_id}.json`), `${JSON.stringify(notes, null, 2)}\n`);
  writeFileSync(
    join(dir, `${notes.run_id}.intents.jsonl`),
    notes.intents.map((i) => JSON.stringify(i)).join("\n") + (notes.intents.length > 0 ? "\n" : ""),
  );
}
