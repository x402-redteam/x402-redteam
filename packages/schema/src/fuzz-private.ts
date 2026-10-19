/**
 * The private marker for fuzz output (U29-00, ADR-028 #7). U29-2 and U29-3 stamp every
 * file they write (cases.json, diff.json, triage.md, generated YAML, JSONL) with it, so
 * scripts/fuzz-guard.mjs can refuse such a file in a commit wherever `--out` pointed, unless
 * it sits under packages/fuzz/catalogue-public/. The guard script keeps its own copy of
 * the constant; a test keeps the two equal.
 */
export const FUZZ_PRIVATE_MARKER = "x402_redteam_fuzz_private";

/** A JSON object with the marker key first. */
export function stampJson<T extends Record<string, unknown>>(
  value: T,
): { [FUZZ_PRIVATE_MARKER]: true } & T {
  return { [FUZZ_PRIVATE_MARKER]: true, ...value } as { [FUZZ_PRIVATE_MARKER]: true } & T;
}

/** JSON Lines: the marker on every row, so a partial copy of the file is still caught. */
export function stampJsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(stampJson(r))).join("\n") + (rows.length ? "\n" : "");
}

/** YAML or Markdown text with the marker as a first-line comment. */
export function stampText(format: "yaml" | "md", text: string): string {
  const line = format === "yaml" ? `# ${FUZZ_PRIVATE_MARKER}` : `<!-- ${FUZZ_PRIVATE_MARKER} -->`;
  return `${line}\n${text}`;
}
