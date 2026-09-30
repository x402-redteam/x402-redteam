import { CorpusError, loadCorpus } from "@x402-redteam/schema";

/**
 * `loadCorpus` + print errors, per functional-design.md §1. Returns the
 * process exit code (0 on success, 2 on any corpus error) rather than
 * calling `process.exit` itself, so it stays testable.
 */
export function validate(corpusDir: string): number {
  try {
    const scenarios = loadCorpus(corpusDir);
    console.log(`OK: ${scenarios.length} scenario(s) loaded from ${corpusDir}`);
    return 0;
  } catch (err) {
    if (err instanceof CorpusError) {
      const path = err.path
        ? `${err.file}: ${err.path}: ${err.message}`
        : `${err.file}: ${err.message}`;
      console.error(path);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 2;
  }
}
