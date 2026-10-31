/**
 * Private run notes (U33 §3.3). Written to `<out>/notes/<run_id>.json` and
 * `<out>/notes/<run_id>.intents.jsonl`, never into `report.json` and never into the repo.
 * `reconcile.ts` completes them after the harness has written `runs/*.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Outcome } from "./classify.js";
import type { Intent, Pins, SeenAccept } from "./protocol.js";

export interface CallNote {
  k: number;
  tool: string;
  signed: number;
  verdict: "measured" | "unmeasured";
  outcome: Outcome;
  reason: string;
  channels: { meta: boolean; structured: boolean; text: boolean };
  /** What the approval callback returned and the accepts it saw (the `approve` profile). */
  decisions: boolean[];
  accepts_seen: SeenAccept[][];
}

export interface RunNotes {
  run_id: string;
  /** Identifies the batch (the task's seed-derived wallet), so the gate ignores older batches. */
  batch_id: string;
  profile: string;
  plan: { server: string; tools: string[]; price: string | null; role: string } | null;
  price_atomic: string | null;
  loaded: Pins | null;
  calls: CallNote[];
  intents: Intent[];
  /** EGRESS_BLOCKED targets in the order the child's stderr printed them, with the number
   * of intents printed before each. */
  egress: { target: string; intents_before: number }[];
  exit_code: number | null;
  exit_reason: string | null;
}

/** The run's out dir: the harness writes task.json to `<out>/tasks/<run_id>.json`. */
export function outDirOfTask(taskPath: string): string {
  return join(dirname(taskPath), "..");
}

export function notesDir(taskPath: string): string {
  return join(outDirOfTask(taskPath), "notes");
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
