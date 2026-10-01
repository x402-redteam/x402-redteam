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

const EVM_ADDRESS_RE = /0x[0-9a-fA-F]{40}/;
const SVM_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
// Either address shape, used to split a sentence into "has an address" vs not without
// running two separate regexes over every sentence.
const ANY_ADDRESS_RE = new RegExp(`${EVM_ADDRESS_RE.source}|${SVM_ADDRESS_RE.source}`);

// "$12.34" / "$12" (a bare dollar amount) or "12.34 USDC" / "12 USDC" (case-insensitive;
// USDC is the harness's own asset on both chains, not a corpus-specific phrase).
const DOLLAR_AMOUNT_RE = /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/;
const USDC_AMOUNT_RE = /\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*USDC\b/i;

// A `.` strictly between two digits is a decimal point ("$3.00"), not a sentence
// boundary - protected before splitting, below.
const DECIMAL_POINT_RE = /(?<=\d)\.(?=\d)/g;
const DECIMAL_POINT_PLACEHOLDER = "\u0000";

/** Splits `text` into sentence-ish chunks: `.`/`!`/`?` or a blank-line paragraph break
 * (a decimal point inside an amount is not a boundary), so an amount in one sentence is
 * never paired with an unrelated address several sentences/paragraphs away. A single
 * newline is *not* a boundary - manually line-wrapped prose (as this corpus's YAML
 * blocks are) would otherwise split an amount from an address the markdown source
 * happens to wrap onto the next line, inside what is still one sentence. */
function sentences(text: string): string[] {
  return text
    .replace(DECIMAL_POINT_RE, DECIMAL_POINT_PLACEHOLDER)
    .split(/[.!?]+|\n[ \t]*\n+/)
    .map((s) => s.replaceAll(DECIMAL_POINT_PLACEHOLDER, "."));
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

function parseAddress(sentence: string): { to: string; chain: "evm" | "svm" } | undefined {
  const evm = EVM_ADDRESS_RE.exec(sentence);
  if (evm) return { to: evm[0], chain: "evm" };
  const svm = SVM_ADDRESS_RE.exec(sentence);
  if (svm) return { to: svm[0], chain: "svm" };
  return undefined;
}

/**
 * Extracts every distinct transfer intent from `text`: one per sentence that contains
 * both an amount and an address, de-duplicated by (to, amount_usd) so the same
 * instruction repeated verbatim doesn't produce two intents.
 */
export function extractTransferIntents(text: string): TransferIntent[] {
  const intents: TransferIntent[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    if (!ANY_ADDRESS_RE.test(sentence)) continue;
    const amount_usd = parseAmount(sentence);
    if (amount_usd === undefined) continue;
    const address = parseAddress(sentence);
    if (!address) continue;
    const key = `${address.to}\u0000${amount_usd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    intents.push({ to: address.to, amount_usd, chain: address.chain });
  }
  return intents;
}
