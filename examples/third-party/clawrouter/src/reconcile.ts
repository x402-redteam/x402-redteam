/**
 * Reconciliation of the pre-sign log with the header capture (U28 §5, M4, C4).
 *
 * The harness writes `runs/<run_id>.json` only after the agent has exited, so the parent
 * cannot see the captured payments while it runs. This script runs afterwards, over an out
 * dir: `node --import tsx src/reconcile.ts <out>`. For each run it matches the intents in
 * `notes/<run_id>.json` to the run's header-captured payments, in order, on
 * (route, payTo, network) only; the pre-sign estimate is recorded but not compared. It writes `intents`, `captured` and `unmatched` into the run's notes:
 *
 * - an intent the spend check refused (`allowed: false`) is counted as `denied` and is not
 *   matched; it never makes a run unmeasured;
 * - an intent with no captured payment makes the run UNMEASURED, so it is left out of pass
 *   totals;
 * - a payment captured with no intent is listed for review by hand and does not make the
 *   run unmeasured.
 *
 * Exit status: 0 when no run is unmeasured, 2 when at least one is.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunNotes } from "./notes.js";
import type { Intent } from "./protocol.js";

export interface CapturedPayment {
  payment_id: string;
  capture?: string;
  network: string;
  to: string;
  route_key: string;
}

export interface Reconciliation {
  intents: number;
  /** Intents the spend check refused. They are not matched and never make a run unmeasured. */
  denied: number;
  captured: number;
  /** Intents with no captured payment, in order. */
  intents_without_capture: Intent[];
  /** Payments captured with no intent, in order (review by hand). */
  captured_without_intent: string[];
  unmeasured: boolean;
}

function samePayee(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function matches(intent: Intent, payment: CapturedPayment): boolean {
  return (
    payment.route_key.endsWith(intent.route) &&
    samePayee(intent.pay_to, payment.to) &&
    intent.network === payment.network
  );
}

/** Greedy in-order matching: each intent takes the earliest unused matching payment. */
export function reconcile(allIntents: Intent[], payments: CapturedPayment[]): Reconciliation {
  const intents = allIntents.filter((i) => i.allowed !== false);
  const header = payments.filter((p) => p.capture === undefined || p.capture === "header");
  const used = new Set<number>();
  const without: Intent[] = [];
  for (const intent of intents) {
    const at = header.findIndex((p, i) => !used.has(i) && matches(intent, p));
    if (at < 0) without.push(intent);
    else used.add(at);
  }
  const extra = header.filter((_, i) => !used.has(i)).map((p) => p.payment_id);
  return {
    intents: intents.length,
    denied: allIntents.length - intents.length,
    captured: header.length,
    intents_without_capture: without,
    captured_without_intent: extra,
    unmeasured: without.length > 0,
  };
}

export function reconcileOutDir(outDir: string): Map<string, Reconciliation> {
  const result = new Map<string, Reconciliation>();
  for (const file of readdirSync(join(outDir, "notes")).filter((f) => /^[^.]+\.json$/.test(f))) {
    const notesPath = join(outDir, "notes", file);
    const notes = JSON.parse(readFileSync(notesPath, "utf8")) as RunNotes & {
      reconciliation?: Reconciliation;
    };
    const run = JSON.parse(readFileSync(join(outDir, "runs", file), "utf8")) as {
      payments?: CapturedPayment[];
    };
    const rec = reconcile(notes.intents, run.payments ?? []);
    notes.reconciliation = rec;
    writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`);
    result.set(notes.run_id, rec);
  }
  return result;
}

function notesEgress(outDir: string, runId: string): number {
  const notes = JSON.parse(readFileSync(join(outDir, "notes", `${runId}.json`), "utf8")) as RunNotes;
  return notes.egress.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: reconcile.ts <out dir>");
    process.exit(1);
  }
  let unmeasured = 0;
  for (const [runId, rec] of reconcileOutDir(outDir)) {
    const flag = rec.unmeasured
      ? "UNMEASURED"
      : rec.captured_without_intent.length > 0 || notesEgress(outDir, runId) > 0
        ? "REVIEW"
        : "ok";
    if (rec.unmeasured) unmeasured++;
    console.log(
      `${runId}: ${flag} intents=${rec.intents} denied=${rec.denied} captured=${rec.captured} ` +
        `unmatched_intents=${rec.intents_without_capture.length} ` +
        `unmatched_payments=${rec.captured_without_intent.length}`,
    );
  }
  process.exit(unmeasured > 0 ? 2 : 0);
}
