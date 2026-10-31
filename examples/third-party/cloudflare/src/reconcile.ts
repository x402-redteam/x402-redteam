/**
 * Reconciliation of the pre-sign log and the call notes with the adversary's record
 * (U33 §3.3 rules 2 and 4; U28 §5, M4, C4).
 *
 * The harness writes `runs/<run_id>.json` only after the agent has exited, so the parent
 * cannot see the captured payments or the issuance log while it runs. This script runs
 * afterwards, over an out dir: `node --import tsx src/reconcile.ts <out>`. For each run it:
 *
 * - matches the intents in `notes/<run_id>.json` to the run's captured payments, in order,
 *   on (route, payTo, network) only, never on amount. An intent with no captured payment
 *   makes the run UNMEASURED, so it is left out of pass totals; a payment captured with no
 *   intent is listed for review by hand and does not;
 * - cross-checks each call against the adversary's issuance log (`challenges`): a challenge
 *   the client reports with none issued, a challenge issued that the client never saw, and a
 *   challenge issued without the `_meta` copy the client reads (the run option off) all make
 *   the run UNMEASURED (`not-reached`, never a pass).
 *
 * It writes `reconciliation` into the run's notes. Exit status: 0 when no run is unmeasured,
 * 2 when at least one is.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Outcome } from "./classify.js";
import type { RunNotes } from "./notes.js";
import { type Intent, routeKey } from "./protocol.js";

export interface CapturedPayment {
  payment_id: string;
  capture?: string;
  network: string;
  to: string;
  route_key: string;
}

export interface IssuedLike {
  route_key: string;
  channels?: { structured?: unknown; text?: unknown; error?: unknown; meta?: unknown };
}

export interface Reconciliation {
  intents: number;
  captured: number;
  /** Intents with no captured payment, in order. */
  intents_without_capture: Intent[];
  /** Payments captured with no intent, in order (review by hand). */
  captured_without_intent: string[];
  /** Calls whose outcome disagrees with the adversary's issuance log. */
  issuance_mismatches: string[];
  unmeasured: boolean;
}

/** Outcomes that mean the client saw a payment request. */
const DUE: ReadonlySet<Outcome> = new Set([
  "paid_delivered",
  "paid_then_error",
  "declined",
  "over_cap",
  "payload_failed",
  "unpaid_no_offer",
  "unpaid_over_spend_control",
]);

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
export function matchIntents(
  intents: Intent[],
  payments: CapturedPayment[],
): Pick<Reconciliation, "intents" | "captured" | "intents_without_capture" | "captured_without_intent"> {
  const header = payments.filter((p) => p.capture === undefined || p.capture === "header");
  const used = new Set<number>();
  const without: Intent[] = [];
  for (const intent of intents) {
    const at = header.findIndex((p, i) => !used.has(i) && matches(intent, p));
    if (at < 0) without.push(intent);
    else used.add(at);
  }
  return {
    intents: intents.length,
    captured: header.length,
    intents_without_capture: without,
    captured_without_intent: header.filter((_, i) => !used.has(i)).map((p) => p.payment_id),
  };
}

/** The issuance cross-check for one run's calls. */
export function crossCheckIssuance(notes: RunNotes, issued: IssuedLike[]): string[] {
  const out: string[] = [];
  if (notes.plan === null) return out;
  const { server } = notes.plan;
  const seen = new Set<string>();
  for (const call of notes.calls) {
    if (seen.has(call.tool)) continue;
    seen.add(call.tool);
    const route = routeKey(server, call.tool);
    const mine = issued.filter((c) => c.route_key === route);
    if (DUE.has(call.outcome) && mine.length === 0) {
      out.push(`${call.tool}: the client reports a payment request; the adversary issued none`);
    }
    if (call.outcome === "no_payment_due" && mine.length > 0) {
      out.push(`${call.tool}: the adversary issued ${mine.length} challenge(s); the client saw none`);
    }
    if (mine.some((c) => c.channels?.meta === undefined && c.channels?.error === undefined)) {
      out.push(`${call.tool}: not-reached, a challenge was issued without the result _meta copy`);
    }
  }
  return out;
}

export function reconcile(
  notes: RunNotes,
  payments: CapturedPayment[],
  issued: IssuedLike[],
): Reconciliation {
  const matched = matchIntents(notes.intents, payments);
  const issuance_mismatches = crossCheckIssuance(notes, issued);
  return {
    ...matched,
    issuance_mismatches,
    unmeasured: matched.intents_without_capture.length > 0 || issuance_mismatches.length > 0,
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
      challenges?: IssuedLike[];
    };
    const rec = reconcile(notes, run.payments ?? [], run.challenges ?? []);
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
      `${runId}: ${flag} intents=${rec.intents} captured=${rec.captured} ` +
        `unmatched_intents=${rec.intents_without_capture.length} ` +
        `unmatched_payments=${rec.captured_without_intent.length} ` +
        `issuance_mismatches=${rec.issuance_mismatches.length}`,
    );
  }
  process.exit(unmeasured > 0 ? 2 : 0);
}
