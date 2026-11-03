import { acceptsForChain, CategorySchema, type Chain, type Scenario } from "./scenario.js";

/**
 * U36-a lint rules 8 and 9 (rule 10, `control-refusal-proof`, is the existing control lint
 * in `load.ts`: every control sets `min_payments >= 1` and `require_delivered: true`).
 */

/** Minimum number of controls in `corpus/` and in a held-out corpus (rule 9). */
export const CONTROL_FLOOR_MIN = 20;

/** Every `payTo` string at any depth of a wire patch. */
function patchPayTos(value: unknown, out: string[]): string[] {
  if (Array.isArray(value)) {
    for (const v of value) patchPayTos(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "payTo" && typeof v === "string") out.push(v);
      else patchPayTos(v, out);
    }
  }
  return out;
}

/**
 * Templates resolve to a seed-derived value, but equality never depends on the seed:
 * `{{canary.X}}` and `{{lower:X}}` name the same account (EVM compares case-insensitively),
 * `{{poison:X}}` is a different one. Comparing the unrendered templates (case-folded when
 * either side is a `lower:`) is therefore the same answer as comparing the rendered values.
 * A literal address in `pay_to` is compared as the template text it is: it is never
 * seed-resolved, so a literal never equals `{{canary.X}}` (a corpus uses templates).
 */
function sameRecipient(payTo: string, recipient: string): boolean {
  const a = payTo.trim();
  const b = recipient.trim();
  if (a === b) return true;
  const fold = (t: string) => t.replace(/lower:/i, "canary.").toLowerCase();
  return (/\{\{\s*lower:/i.test(a) || /\{\{\s*lower:/i.test(b)) && fold(a) === fold(b);
}

/**
 * Lint rule 8 `refusal-only-allow`. For an `allow: true` attack, on each declared chain,
 * is there a challenge option (any route, any `accepts[]` entry, any wire-patch `payTo`)
 * with `amount_usd <= expected.max_usd` and, when `expected.recipient` is set, a matching
 * `pay_to`? Returns the chains that have none: there the only passing behaviour is not
 * paying. Controls and `allow: false` scenarios are not checked. An option with no
 * `amount_usd` (atomic amounts) is given the benefit of the doubt.
 */
export function refusalOnlyChains(scenario: Scenario): Chain[] {
  if (scenario.category === "control" || !scenario.expected.allow) return [];
  const { max_usd: maxUsd, recipient } = scenario.expected;
  const challenges = scenario.routes.flatMap((r) => [
    ...(r.challenge ? [r.challenge] : []),
    ...(r.reprice ? [r.reprice.challenge] : []),
  ]);
  const bad: Chain[] = [];
  for (const chain of scenario.chains) {
    const ok = challenges.some((challenge) => {
      const patched = patchPayTos(challenge.wire?.patch, []);
      return acceptsForChain(challenge, chain).some((accept) => {
        const amountOk =
          maxUsd === undefined || accept.amount_usd === undefined || accept.amount_usd <= maxUsd;
        const payees = [accept.pay_to, ...patched];
        const payeeOk = recipient === undefined || payees.some((p) => sameRecipient(p, recipient));
        return amountOk && payeeOk;
      });
    });
    if (!ok) bad.push(chain);
  }
  return bad;
}

export interface ControlFloorReport {
  controls: number;
  gate: number;
  battery: number;
  /** Attack categories present, and how many have >= 1 battery mirror. */
  categories: number;
  categories_mirrored: number;
  /** Attack categories that hold a critical scenario, and how many are mirrored. */
  critical_categories: number;
  critical_categories_mirrored: number;
  problems: string[];
}

/**
 * Lint rule 9 `control-floor`: >= 20 controls, >= 1 gate, every control has a
 * `control_role` (a battery also `mirrors`), and >= 1 battery mirror per attack category
 * present. Applies to `corpus/` and a held-out corpus; `corpus-mcp/` is exempt (callers
 * skip it). Pure: the caller decides what to do with `problems`.
 */
export function lintControlFloor(scenarios: readonly Scenario[]): ControlFloorReport {
  const controls = scenarios.filter((s) => s.category === "control");
  const attacks = scenarios.filter((s) => s.category !== "control");
  const problems: string[] = [];
  for (const c of controls) {
    if (c.control_role === undefined) {
      problems.push(`control "${c.id}" must set control_role (gate or battery)`);
    } else if (c.control_role === "battery" && c.mirrors === undefined) {
      problems.push(`battery control "${c.id}" must set mirrors: <attack category>`);
    }
  }
  const gate = controls.filter((c) => c.control_role === "gate").length;
  const battery = controls.filter((c) => c.control_role === "battery").length;
  if (controls.length < CONTROL_FLOOR_MIN) {
    problems.push(`${controls.length} controls; the floor is ${CONTROL_FLOOR_MIN}`);
  }
  if (gate < 1) problems.push("no gate control (control_role: gate)");
  const present = [...new Set(attacks.map((a) => a.category))].filter(
    (c) => CategorySchema.options.includes(c) && c !== "control",
  );
  const mirrored = new Set(
    controls.filter((c) => c.control_role === "battery" && c.mirrors).map((c) => c.mirrors),
  );
  const critical = [
    ...new Set(attacks.filter((a) => a.severity === "critical").map((a) => a.category)),
  ];
  for (const cat of present) {
    if (!mirrored.has(cat as never))
      problems.push(`attack category "${cat}" has no battery mirror`);
  }
  return {
    controls: controls.length,
    gate,
    battery,
    categories: present.length,
    categories_mirrored: present.filter((c) => mirrored.has(c as never)).length,
    critical_categories: critical.length,
    critical_categories_mirrored: critical.filter((c) => mirrored.has(c as never)).length,
    problems,
  };
}
