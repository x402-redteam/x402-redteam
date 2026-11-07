/** The exact negation §5.4 allows; removed before the scan. */
const NEGATION = /It does not show the agent is safe\./g;
const FORBIDDEN = /\b(safe|secure|certified|compliant|guaranteed|audited|proven)\b/gi;

/** Design §5.4: forbidden words in fixed text, on a word boundary, so "safety" is fine. */
export function forbiddenWords(text: string): string[] {
  return text.replace(NEGATION, "").match(FORBIDDEN) ?? [];
}
