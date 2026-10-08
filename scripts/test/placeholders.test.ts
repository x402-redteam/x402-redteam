/**
 * Inventory of the owner placeholders still in the repository, replaced once the GitHub
 * organization, handle and contacts are decided. The expected map is explicit: adding or
 * removing a placeholder anywhere means updating it here, so the full list stays visible.
 * aidlc-docs/ (design records) and this file are excluded.
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
];

const EXPECTED: Record<string, string[]> = {
  ".github/CODEOWNERS": ["ORG_PLACEHOLDER", "OWNER_HANDLE"],
  ".github/ISSUE_TEMPLATE/bug.yml": ["ORG_PLACEHOLDER"],
  ".github/ISSUE_TEMPLATE/config.yml": ["ORG_PLACEHOLDER"],
  ".github/ISSUE_TEMPLATE/leaderboard.yml": ["ORG_PLACEHOLDER"],
  ".github/ISSUE_TEMPLATE/scenario.yml": ["ORG_PLACEHOLDER"],
  ".github/workflows/pr-hygiene.yml": ["OWNER_HANDLE"],
  ".github/workflows/rank.yml": ["ORG_PLACEHOLDER"],
  ".github/workflows/ranked-run.yml": ["ORG_PLACEHOLDER"],
  "CODE_OF_CONDUCT.md": ["OWNER_CONTACT"],
  "CONTRIBUTING.md": ["ORG_PLACEHOLDER"],
  "GOVERNANCE.md": ["OWNER_HANDLE", "OWNER_SUCCESSION_PLAN"],
  "README.md": ["ORG_PLACEHOLDER", "BEST_PRACTICES_PROJECT_ID"],
  "SECURITY.md": ["ORG_PLACEHOLDER", "OWNER_CONTACT"],
  "SUPPORT.md": ["OWNER_CONTACT"],
  "docs/seasons.md": ["ORG_PLACEHOLDER"],
  "packages/cli/test/ranked-workflows.test.ts": ["ORG_PLACEHOLDER"],
  "packages/leaderboard/src/provenance.ts": ["ORG_PLACEHOLDER"],
};

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
  it("appear exactly in the expected files", () => {
    expect(placeholderMap()).toEqual(EXPECTED);
  });
});
