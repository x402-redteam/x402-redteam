import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CELL_PATTERNS,
  cellValue,
  chainLabel,
  corpusText,
  labelTransport,
  legSummary,
  legSummaryCell,
  recipientCell,
  UNPRINTABLE,
} from "../src/format.js";
import type { Report } from "../src/types.js";
import { makePayment } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(here, "..", "..", "..", "results");

function committedReports(): Report[] {
  const dirs = [RESULTS_DIR, join(RESULTS_DIR, "mcp")];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Report),
  );
}

const HOSTILE = [
  "a|b",
  "a\\|b",
  "a`b",
  "[x](https://e)",
  "https://e.example/x",
  "a\nb",
  "a\u0007b",
  "a‮b",
];

describe("cellValue (design §8.6)", () => {
  it("prints an allowlisted value inside a code span", () => {
    expect(cellValue("0xabc", CELL_PATTERNS.to)).toBe("`0xabc`");
    expect(cellValue("eip155:*", CELL_PATTERNS.network)).toBe("`eip155:*`");
    expect(cellValue("exact", CELL_PATTERNS.scheme)).toBe("`exact`");
    expect(cellValue("header+rpc", CELL_PATTERNS.capture)).toBe("`header+rpc`");
  });

  it("prints - for an empty value", () => {
    expect(cellValue("", CELL_PATTERNS.network)).toBe("-");
  });

  it.each(HOSTILE)("refuses %j on every field pattern", (value) => {
    for (const pattern of Object.values(CELL_PATTERNS)) {
      expect(cellValue(value, pattern)).toBe(UNPRINTABLE);
    }
  });

  it("refuses a trailing newline, an over-long value and a non-string", () => {
    expect(cellValue("0xabc\n", CELL_PATTERNS.to)).toBe(UNPRINTABLE);
    expect(cellValue("a".repeat(65), CELL_PATTERNS.to)).toBe(UNPRINTABLE);
    expect(cellValue(12, CELL_PATTERNS.to)).toBe(UNPRINTABLE);
    expect(cellValue({ a: 1 }, CELL_PATTERNS.to)).toBe(UNPRINTABLE);
  });

  it("tests the raw value before a display label is applied", () => {
    const label = (s: string) => labelTransport(s, "mcp");
    expect(cellValue("header", CELL_PATTERNS.instruction_source, label)).toBe("`header (mcp)`");
    expect(cellValue("header (mcp)", CELL_PATTERNS.instruction_source, label)).toBe(UNPRINTABLE);
  });

  it("accepts every value in the committed results", () => {
    const reports = committedReports();
    expect(reports.length).toBeGreaterThan(0);
    let seen = 0;
    for (const report of reports) {
      for (const run of report.runs) {
        for (const p of run.payments) {
          seen += 1;
          for (const [value, pattern] of [
            [p.to, CELL_PATTERNS.to],
            [p.network, CELL_PATTERNS.network],
            [p.scheme, CELL_PATTERNS.scheme],
            [p.instruction_source, CELL_PATTERNS.instruction_source],
            [p.capture, CELL_PATTERNS.capture],
          ] as const) {
            expect(cellValue(value, pattern)).not.toBe(UNPRINTABLE);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("chainLabel", () => {
  it.each(["evm", "svm"])("prints %s", (chain) => {
    expect(chainLabel(chain)).toBe(chain);
  });

  it.each(["", "tron", "EVM", "evm\n", "a|b", "constructor", null, undefined, 1, ["evm"]])(
    "refuses %j",
    (chain) => {
      expect(chainLabel(chain)).toBe(UNPRINTABLE);
    },
  );
});

describe("corpusText (design §8.6)", () => {
  it("collapses newlines and keeps the corpus's own Markdown", () => {
    expect(corpusText("One `code`\n  two\r\nthree\n")).toBe("One `code` two three");
  });
});

describe("labelTransport", () => {
  it("relabels only the header layer of an MCP leg", () => {
    expect(labelTransport("header+rpc", "mcp")).toBe("header (mcp)+rpc");
    expect(labelTransport("header", undefined)).toBe("header");
  });
});

describe("legSummary, plain and cell forms (design §8.6)", () => {
  const hostile = "x](https://e)|`";

  it("the plain form stays text for SARIF, hostile value included", () => {
    const p = makePayment({ to: hostile, amount_usd: 1 });
    expect(legSummary(p)).toBe(`paid $1.00 to ${hostile} (header)`);
  });

  it("the cell form refuses a hostile to, on each leg kind", () => {
    expect(legSummaryCell(makePayment({ to: hostile }))).toBe(
      `paid to ${UNPRINTABLE} (\`header\`)`,
    );
    expect(legSummaryCell(makePayment({ to: hostile, scheme: "approve" }))).toBe(
      `signed \`approve\` to ${UNPRINTABLE} (\`header\`)`,
    );
  });

  it("the cell form drops the dollar part and names each leg kind", () => {
    const to = "0xabc";
    expect(legSummaryCell(makePayment({ to, amount_usd: 5 }))).toBe("paid to `0xabc` (`header`)");
    expect(legSummaryCell(makePayment({ to, scheme: "delegate", amount_usd: 100 }))).toBe(
      "signed `delegate` to `0xabc` (`header`)",
    );
    expect(legSummaryCell(makePayment({ to: "", scheme: "message" }))).toBe(
      "signed `message` (no payment)",
    );
  });

  it("recipientCell names the scheme of a leg that paid nobody", () => {
    expect(recipientCell(makePayment({ to: "0xabc" }))).toBe("`0xabc`");
    expect(recipientCell(makePayment({ to: "0xabc", scheme: "approve" }))).toBe(
      "`approve`: `0xabc`",
    );
    expect(recipientCell(makePayment({ to: "", scheme: "message" }))).toBe("`message`: -");
    expect(recipientCell(makePayment({ to: "a|b" }))).toBe(UNPRINTABLE);
  });
});
