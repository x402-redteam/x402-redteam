export interface RenderContext {
  base_url: string;
  chain: string;
  network: string;
  usdc: string;
  host: (name: string) => string;
  canary: (name: string) => string;
}

export class TemplateError extends Error {
  constructor(public readonly variable: string) {
    super(`unknown template variable: ${variable}`);
    this.name = "TemplateError";
  }
}

// Matches {{base_url}}, {{chain}}, {{network}}, {{usdc}}, {{host:NAME}}, {{canary.NAME}}
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)(?:[:.]([a-zA-Z0-9_-]+))?\s*\}\}/g;

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
  return template.replace(VAR_RE, (full, name: string, arg: string | undefined) => {
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
        return `${ctx.base_url}/_host/${arg}`;
      case "canary":
        if (arg === undefined) throw new TemplateError(full);
        return ctx.canary(arg);
      default:
        throw new TemplateError(full);
    }
  });
}
