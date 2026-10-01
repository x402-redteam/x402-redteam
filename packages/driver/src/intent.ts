/**
 * Scenario-agnostic transfer-intent extractor, per functional-design.md §2
 * (`src/intent.ts`): finds a dollar/USDC amount and a chain address in the *same
 * sentence* of a page body or 402 text. Deliberately NOT keyed on any corpus phrasing
 * ("pay ... to", "send ... to", ...) - the driver must reach every `reach_class: prose`
 * scenario regardless of its cover story, and must never be tuned to the corpus
 * (functional-design.md §5 "Do not").
 */

export interface TransferIntent {
  to: string;
  amount_usd: number;
  /** "evm" when `to` is a 0x-prefixed 40-hex address, "svm" when it's base58 32-44
   * chars (Solana's alphabet, which excludes 0/O/I/l). */
  chain: "evm" | "svm";
}

const EVM_ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
// U18b item 4: `\b` word boundaries at both ends, so a candidate is never a substring
// carved out of a longer alphanumeric run (e.g. a 50-char token, where the bounded
// quantifier would otherwise happily match 44 characters out of its middle). A
// hex-looking string (a hash, a tx id, ...) that happens to use only base58-alphabet
// hex digits (1-9a-f; '0' is outside the base58 alphabet, but a run that avoids it can
// still fully match) is filtered out separately below, by `isAllHex` - it's vanishingly
// unlikely a real Solana address is composed entirely of hex characters.
const SVM_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const ALL_HEX_RE = /^[0-9a-fA-F]+$/;

/** True iff `s` consists entirely of hex digits (0-9a-fA-F) - see `SVM_ADDRESS_RE`'s
 * comment: a hash or id quoted in prose can coincidentally satisfy the base58 pattern,
 * and must not be mistaken for a transfer destination. */
function isAllHex(s: string): boolean {
  return ALL_HEX_RE.test(s);
}

// "$12.34" / "$12" (a bare dollar amount) or "12.34 USDC" / "12 USDC" (case-insensitive;
// USDC is the harness's own asset on both chains, not a corpus-specific phrase).
const DOLLAR_AMOUNT_RE = /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/;
const USDC_AMOUNT_RE = /\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*USDC\b/i;

/**
 * Splits `text` into sentence-ish chunks on `.`/`!`/`?` *only when followed by
 * whitespace or the end of the string* (code review finding 9) - so a decimal point
 * ("$3.00", followed by another digit) and a dotted hostname ("billing.test", followed
 * by a letter) are never mistaken for a sentence boundary, without needing any
 * corpus-specific or amount-specific special-casing. A bare newline is not a boundary
 * either (manually line-wrapped markdown prose stays one sentence).
 */
function sentences(text: string): string[] {
  return text.split(/[.!?]+(?=\s|$)/);
}

function parseAmount(sentence: string): number | undefined {
  const dollar = DOLLAR_AMOUNT_RE.exec(sentence);
  if (dollar?.[1]) {
    const value = Number(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(value)) return value;
  }
  const usdc = USDC_AMOUNT_RE.exec(sentence);
  if (usdc?.[1]) {
    const value = Number(usdc[1].replace(/,/g, ""));
    // USDC is pegged 1:1 to USD on both chains (chains.ts KNOWN_ASSETS), so the token
    // amount and the USD amount coincide.
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Every address found in `sentence` (code review finding 9: "pair the amount with
 * EVERY address in the sentence", not just the first one - a sentence can legitimately
 * name more than one acceptable recipient). An SVM-shaped match that overlaps an
 * already-found EVM address's character range is dropped: an EVM address's hex digits
 * (which exclude '0x' itself, but not every digit after it) can otherwise coincidentally
 * satisfy the base58 pattern as a spurious second "address" inside the same string.
 */
function allAddresses(sentence: string): { to: string; chain: "evm" | "svm" }[] {
  const evmMatches = [...sentence.matchAll(EVM_ADDRESS_RE)];
  const evmRanges = evmMatches.map((m): readonly [number, number] => {
    const start = m.index ?? 0;
    return [start, start + m[0].length];
  });
  const overlapsEvm = (start: number, end: number): boolean =>
    evmRanges.some(([s, e]) => start < e && end > s);

  const results: { to: string; chain: "evm" | "svm" }[] = evmMatches.map((m) => ({
    to: m[0],
    chain: "evm" as const,
  }));
  for (const m of sentence.matchAll(SVM_ADDRESS_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlapsEvm(start, end)) continue;
    if (isAllHex(m[0])) continue;
    results.push({ to: m[0], chain: "svm" });
  }
  return results;
}

/**
 * Extracts every distinct transfer intent from `text`: one per (sentence, address) pair
 * where the sentence also contains an amount, de-duplicated by (to, amount_usd) so the
 * same instruction repeated verbatim doesn't produce two intents.
 */
export function extractTransferIntents(text: string): TransferIntent[] {
  const intents: TransferIntent[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    const amount_usd = parseAmount(sentence);
    if (amount_usd === undefined) continue;
    for (const address of allAddresses(sentence)) {
      const key = `${address.to}\u0000${amount_usd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      intents.push({ to: address.to, amount_usd, chain: address.chain });
    }
  }
  return intents;
}
