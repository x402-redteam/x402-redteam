/**
 * The batch gate (U33 §3.3 rule 1, M7). A batch starts with the smoke paid control
 * (`role=control` in its plan line). Every other run in the out dir first checks that an
 * earlier control of the same batch (same batch id) exited 0, and that none exited otherwise, and that the harness captured at least one
 * payment in it (`runs/<run_id>.json`, written as soon as that run ends). If not, the run
 * is unmeasured: exit 3.
 *
 * The harness runs scenarios in id order, so a control's id must sort before every other
 * scenario's in the batch; a run that comes first has no evidence and exits 3.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UnmeasuredError } from "./errors.js";
import type { Plan } from "./plan.js";
import { outDirOfTask, type RunNotes } from "./notes.js";

interface RunFileLike {
  payments?: { valid?: boolean; capture?: string }[];
}

/** A batch id from the task: the wallet address is derived from the run's seed, so every
 * run of one invocation shares it and a rerun with another seed does not. */
export function batchIdOf(task: { wallet: { address: string } }): string {
  return createHash("sha256").update(task.wallet.address.toLowerCase()).digest("hex").slice(0, 16);
}

export function checkGate(taskPath: string, runId: string, plan: Plan, batchId: string): void {
  if (plan.role === "control") return;
  const out = outDirOfTask(taskPath);
  const notesDir = join(out, "notes");
  const files = existsSync(notesDir)
    ? readdirSync(notesDir).filter((f) => /^[^.]+\.json$/.test(f))
    : [];
  let opened = false;
  for (const file of files) {
    const notes = JSON.parse(readFileSync(join(notesDir, file), "utf8")) as RunNotes;
    // Only controls of this invocation count; notes left by an earlier batch are ignored.
    if (notes.run_id === runId || notes.plan?.role !== "control" || notes.batch_id !== batchId) continue;
    if (notes.exit_code !== 0) {
      throw new UnmeasuredError("batch gate: a smoke control of this batch did not exit 0");
    }
    const runFile = join(out, "runs", file);
    if (!existsSync(runFile)) continue;
    const run = JSON.parse(readFileSync(runFile, "utf8")) as RunFileLike;
    if ((run.payments ?? []).some((p) => p.valid !== false)) opened = true;
  }
  if (opened) return;
  throw new UnmeasuredError(
    "batch gate: no earlier smoke paid control of this batch produced a captured payment",
  );
}
