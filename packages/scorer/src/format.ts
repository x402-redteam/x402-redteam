import { legKind, type Payment, RESULT_ID_PATTERN } from "@x402-redteam/schema";
import { formatUsd } from "./round.js";

/** Printed in place of a value that does not match its field's allowlist (design §8.6). */
export const UNPRINTABLE = "(unprintable, see report.json)";

/**
 * Field allowlists for agent-controlled and edited-file values (design §8.6). None admits a pipe,
 * backtick, backslash, URL, control or bidi character. `instruction_source` and `capture` are
 * tested before `labelTransport` adds "(mcp)".
 */
export const CELL_PATTERNS = {
  to: /^[A-Za-z0-9]{1,64}$/,
  network: /^[A-Za-z0-9:*_-]{1,64}$/,
  scheme: /^[A-Za-z0-9_-]{1,32}$/,
  agent_id: RESULT_ID_PATTERN,
  guardrail_id: RESULT_ID_PATTERN,
  guardrail_repo_ref: /^[A-Za-z0-9._/-]{1,128}@[0-9a-f]{7,40}$/,
  harness_version: /^[0-9A-Za-z.+-]{1,32}$/,
  driver: /^[a-z0-9@._-]{1,32}$/,
  season: /^[A-Za-z0-9._-]{1,64}$/,
  instruction_source: /^[a-z+]{1,32}$/,
  capture: /^[a-z+]{1,32}$/,
} as const;

/**
 * Prints an agent-controlled value inside a code span if it matches `pattern`, else
 * `UNPRINTABLE`. Empty prints "-". `display` relabels a value that has already passed the
 * allowlist; it must add only fixed text.
 */
export function cellValue(
  value: unknown,
  pattern: RegExp,
  display: (value: string) => string = (v) => v,
): string {
  if (value === "" || value === null || value === undefined) return "-";
  if (typeof value !== "string" || !pattern.test(value)) return UNPRINTABLE;
  return `\`${display(value)}\``;
}

/** Printed chain names, in rendering order. Anything else in a report file is not a chain. */
export const KNOWN_CHAINS: readonly string[] = ["evm", "svm"];

/** A chain for fixed text: `evm` or `svm` as it is, otherwise `UNPRINTABLE`. */
export function chainLabel(chain: unknown): string {
  return typeof chain === "string" && KNOWN_CHAINS.includes(chain) ? chain : UNPRINTABLE;
}

/** Corpus-bound text is ours: it keeps its Markdown and has no length cap (design §8.6). */
export function corpusText(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** M4: an MCP leg's "header" layer reads `header (mcp)`; HTTP legs print as before. */
export function labelTransport(label: string, transport: "mcp" | undefined): string {
  if (transport !== "mcp") return label;
  return label
    .split("+")
    .map((l) => (l === "header" ? "header (mcp)" : l))
    .join("+");
}

type LegFields = Pick<Payment, "scheme" | "to" | "amount_usd" | "instruction_source" | "transport">;

/**
 * How a result names its leg, as plain text for SARIF `message.text`, which is not Markdown: a
 * payment "paid $X to Y"; an approval or delegation, or a signature that moves nothing by
 * itself, by its scheme, since it paid nobody.
 */
export function legSummary(payment: LegFields): string {
  const source = labelTransport(payment.instruction_source, payment.transport);
  switch (legKind(payment.scheme)) {
    case "grant":
      return `signed ${payment.scheme} to ${payment.to} valued at ${formatUsd(payment.amount_usd)} (${source})`;
    case "message":
      return `signed ${payment.scheme} (no payment)`;
    default:
      return `paid ${formatUsd(payment.amount_usd)} to ${payment.to} (${source})`;
  }
}

/** `legSummary` minus its dollar part, with every value through `cellValue` (design §8.3.1). */
export function legSummaryCell(payment: Omit<LegFields, "amount_usd">): string {
  const scheme = cellValue(payment.scheme, CELL_PATTERNS.scheme);
  const to = cellValue(payment.to, CELL_PATTERNS.to);
  const source = cellValue(payment.instruction_source, CELL_PATTERNS.instruction_source, (s) =>
    labelTransport(s, payment.transport),
  );
  switch (legKind(payment.scheme)) {
    case "grant":
      return `signed ${scheme} to ${to} (${source})`;
    case "message":
      return `signed ${scheme} (no payment)`;
    default:
      return `paid to ${to} (${source})`;
  }
}

/** The `to` cell of a `report.md` table. A leg that paid nobody names its scheme. */
export function recipientCell(payment: Pick<Payment, "scheme" | "to">): string {
  const to = cellValue(payment.to, CELL_PATTERNS.to);
  if (legKind(payment.scheme) === "payment") return to;
  return `${cellValue(payment.scheme, CELL_PATTERNS.scheme)}: ${to}`;
}
