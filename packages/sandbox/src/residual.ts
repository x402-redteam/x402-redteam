/**
 * Owner-recorded M7 residuals (U35, ADR-029). A residual is a line the owner adds to
 * aidlc-docs/inception/adr/decisions.md:
 *
 *   M7-residual: probes=P5 owner=<name> date=YYYY-MM-DD secrets=NAME1,NAME2
 *
 * `probes` lists the preflight problems accepted (probe ids that leak or could not run, or
 * `LINUX` for a platform whose controls are unverified); `secrets` lists the NAMES (never
 * values) of every same-uid environment secret the owner accepts as exposed. The environment
 * value `X402_M7_RESIDUAL=probes=P5` is honoured only when its probe set exactly equals a
 * recorded entry's set. Nothing here ever writes an entry.
 */

export interface Residual {
  probes: string[];
  owner: string;
  date: string;
  secrets: string[];
}

const LINE =
  /^M7-residual: probes=([A-Z0-9,]+) owner=(\S+) date=(\d{4}-\d{2}-\d{2})(?: secrets=(\S+))?\s*$/gm;

const sorted = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/** Only the ADR-029 section counts, and fenced code blocks and HTML comments in it do not. */
function adr029Body(text: string): string {
  const start = text.search(/^## ADR-029\b/m);
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next);
  return section.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/<!--[\s\S]*?-->/g, "");
}

export function parseResiduals(text: string): Residual[] {
  return [...adr029Body(text).matchAll(LINE)].map((m) => ({
    probes: sorted((m[1] ?? "").split(",").filter(Boolean)),
    owner: m[2] ?? "",
    date: m[3] ?? "",
    secrets: (m[4] ?? "").split(",").filter(Boolean),
  }));
}

/** The set named by `X402_M7_RESIDUAL` (`probes=P5,P2`), or undefined when malformed. */
export function parseEnvResidual(value: string | undefined): string[] | undefined {
  const m = /^probes=([A-Z0-9,]+)$/.exec(value ?? "");
  return m ? sorted((m[1] ?? "").split(",").filter(Boolean)) : undefined;
}

/** The recorded entry whose probe set exactly equals the environment's, if any. */
export function matchResidual(
  value: string | undefined,
  decisionsText: string,
): Residual | undefined {
  const wanted = parseEnvResidual(value);
  if (!wanted || wanted.length === 0) return undefined;
  return parseResiduals(decisionsText).find(
    (r) => r.probes.length === wanted.length && r.probes.every((p, i) => p === wanted[i]),
  );
}

/** True when a recorded, exactly matching residual covers every problem. */
export function residualCovers(
  problems: readonly string[],
  value: string | undefined,
  decisionsText: string,
): Residual | undefined {
  const entry = matchResidual(value, decisionsText);
  return entry && problems.every((p) => entry.probes.includes(p)) ? entry : undefined;
}
