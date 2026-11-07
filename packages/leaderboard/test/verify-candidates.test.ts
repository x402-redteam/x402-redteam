import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawResultEntry } from "../src/load-results.js";
import { buildVerifyCandidates } from "../src/verify-candidates.js";

/**
 * U36-b (M4): `--verify-attestations` builds its candidates from the schema string. A site
 * left on report@3 would silently drop every report@4 entry (no candidate, no attestation,
 * Tier 3). One test per schema proves each reaches the builder.
 */
const COMMIT = "a".repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(id: string, schema: string): RawResultEntry {
  writeFileSync(join(dir, `${id}.attestation.jsonl`), "{}");
  return { id, data: { schema, config: { harness_commit: COMMIT } }, sha256: "f".repeat(64) };
}

describe("buildVerifyCandidates (U36-b)", () => {
  it("a report@4-redacted entry with a bundle is a Tier 1 candidate", () => {
    const c = buildVerifyCandidates([entry("t1", "x402-redteam/report@4-redacted")], dir, {}, []);
    expect(c.map((x) => [x.id, x.tier])).toEqual([["t1", 1]]);
  });

  it("a report@4 entry on a Tier 2-eligible release is a Tier 2 candidate", () => {
    const c = buildVerifyCandidates(
      [entry("t2", "x402-redteam/report@4")],
      dir,
      { t2: { kind: "submission", owner: "me" } } as never,
      [COMMIT],
    );
    expect(c.map((x) => [x.id, x.tier])).toEqual([["t2", 2]]);
  });

  it("a report@3 or report@3-redacted entry is superseded and never a candidate", () => {
    const c = buildVerifyCandidates(
      [entry("o1", "x402-redteam/report@3"), entry("o2", "x402-redteam/report@3-redacted")],
      dir,
      {},
      [COMMIT],
    );
    expect(c).toEqual([]);
  });
});
