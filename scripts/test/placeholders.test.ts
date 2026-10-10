/**
 * The repository carries no unresolved owner placeholders. aidlc-docs/ (design records)
 * and this file are excluded.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELF = "scripts/test/placeholders.test.ts";
const TOKENS = [
  "ORG_PLACEHOLDER",
  "OWNER_HANDLE",
  "OWNER_CONTACT",
  "OWNER_SUCCESSION_PLAN",
  "BEST_PRACTICES_PROJECT_ID",
  "<owner>",
];

const EXPECTED: Record<string, string[]> = {};

function placeholderMap(): Record<string, string[]> {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT })
    .toString("utf8")
    .split("\0")
    .filter((f) => f && f !== SELF && !f.startsWith("aidlc-docs/"));
  const found: Record<string, string[]> = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(`${REPO_ROOT}${file}`, "utf8");
    } catch {
      continue; // listed but deleted in the working tree
    }
    const present = TOKENS.filter((t) => text.includes(t));
    if (present.length > 0) found[file] = present;
  }
  return found;
}

describe("owner placeholders", () => {
  it("are all resolved", () => {
    expect(placeholderMap()).toEqual(EXPECTED);
  });
});
