import { displayAddress } from "./canary.js";

export interface RenderContext {
  base_url: string;
  chain: string;
  network: string;
  usdc: string;
  host: (name: string) => string;
  canary: (name: string) => string;
  /** v4 (U26-2, M4): the poisoned lookalike of canary NAME (`poisonAddress`). */
  poison: (name: string) => string;
}

export class TemplateError extends Error {
  constructor(public readonly variable: string) {
    super(`unknown template variable: ${variable}`);
    this.name = "TemplateError";
  }
}

// Matches {{base_url}}, {{chain}}, {{network}}, {{usdc}}, {{host:NAME}}, {{canary.NAME}},
// and (v4) {{poison:NAME}}, {{poison_short:NAME}}, {{short:NAME}}, {{lower:NAME}}
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)(?:[:.]([a-zA-Z0-9_.-]+))?\s*\}\}/g;

/** Returns the list of variable expressions referenced by a template string. */
export function collectVars(template: string): string[] {
  const vars: string[] = [];
  for (const match of template.matchAll(VAR_RE)) {
    vars.push(match[0]);
  }
  return vars;
}

/** Pure template renderer. Throws TemplateError on any unresolved variable. */
export function render(template: string, ctx: RenderContext): string {
  const out = template.replace(VAR_RE, (full, name: string, arg: string | undefined) => {
    switch (name) {
      case "base_url":
        return ctx.base_url;
      case "chain":
        return ctx.chain;
      case "network":
        return ctx.network;
      case "usdc":
        return ctx.usdc;
      case "host":
        if (arg === undefined) throw new TemplateError(full);
        // v3 (ADR-012, code review HIGH-1): this used to hard-code the path-mode
        // `/_host/` URL here, bypassing `ctx.host` entirely - every RenderContext's own
        // `host()` builder (adversary/render.ts, cli/task.ts, schema/load.ts's dummy
        // context, scorer/resolve.ts's dummy context) was therefore dead code. Every one
        // of those builders already produces the identical `${base_url}/_host/${name}`
        // string in path mode (U15's Bolt 6 Phase A default), so fixing this to actually
        // call `ctx.host(arg)` is behaviour-preserving in path mode and is what makes
        // `host_mode: "localhost"`/`"proxy"` rendering work at all.
        return ctx.host(arg);
      case "canary":
        if (arg === undefined) throw new TemplateError(full);
        return ctx.canary(arg);
      // v4 (U26-2, M4): the full poisoned address belongs in a challenge's pay_to or in
      // prose an agent may act on; pages that only show an address use the short forms,
      // which never contain the full address (lint rule 3).
      case "poison":
        if (arg === undefined) throw new TemplateError(full);
        return ctx.poison(arg);
      case "poison_short":
        if (arg === undefined) throw new TemplateError(full);
        return displayAddress(ctx.poison(arg));
      case "short":
        if (arg === undefined) throw new TemplateError(full);
        return displayAddress(ctx.canary(arg));
      // v4 (U26-3, review Q4): canary NAME in lower case, for the EVM control whose payTo
      // differs from the address the task names only in letter case. EVM only (lint):
      // base58 is case-sensitive, so lower-casing an SVM address names another account.
      case "lower":
        if (arg === undefined) throw new TemplateError(full);
        return ctx.canary(arg).toLowerCase();
      default:
        throw new TemplateError(full);
    }
  });
  // Anything still shaped like {{...}} didn't match VAR_RE (e.g. a bad character); fail loudly.
  const leftover = out.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new TemplateError(leftover[0]);
  return out;
}

/**
 * v2 (challenge_injection, application-design.md §3 "v2"): deep-renders every string
 * leaf of an arbitrary JSON-like value with `render()`, leaving object keys and
 * non-string leaves (numbers, booleans, null) untouched. Shared by `load.ts` (lint-time
 * validation, with a dummy context) and the runtime `body_json` renderer (with the real
 * context), per code review L6, so the two never drift.
 */
export function renderJsonStrings(value: unknown, ctx: RenderContext): unknown {
  if (typeof value === "string") {
    return render(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderJsonStrings(v, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderJsonStrings(v, ctx);
    }
    return out;
  }
  return value;
}
