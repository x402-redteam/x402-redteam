import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORPUS_NOTE,
  hasSection,
  parseCommit,
  prependSection,
  renderSection,
} from "../release/changelog.mjs";
import { extractSection } from "../release/notes.mjs";
import { REPO_ROOT } from "../release/version.mjs";

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

describe("parseCommit", () => {
  it.each([
    [{ sha: sha(1), subject: "feat(cli): add --repeat" }, "feat", "cli", false, "add --repeat"],
    [
      { sha: sha(2), subject: "fix: handle empty corpus" },
      "fix",
      null,
      false,
      "handle empty corpus",
    ],
    [{ sha: sha(3), subject: "feat(schema)!: report@4" }, "feat", "schema", true, "report@4"],
    [
      { sha: sha(4), subject: "corpus: add a lookalike scenario" },
      "corpus",
      null,
      false,
      "add a lookalike scenario",
    ],
    [{ sha: sha(5), subject: "chore: bump deps" }, "chore", null, false, "bump deps"],
    [
      {
        sha: sha(6),
        subject: "fix(scorer): rescale",
        body: "Details.\n\nBREAKING CHANGE: scores move",
      },
      "fix",
      "scorer",
      true,
      "rescale",
    ],
  ])("%j", (commit, type, scope, breaking, text) => {
    expect(parseCommit(commit)).toEqual({ type, scope, breaking, text, sha: commit.sha });
  });

  it("returns null for a subject outside the format", () => {
    expect(parseCommit({ sha: sha(7), subject: "Merge branch 'x'" })).toBeNull();
  });
});

describe("renderSection", () => {
  const commits = [
    { sha: sha(1), subject: "feat(cli): add --repeat" },
    { sha: sha(2), subject: "fix: handle empty corpus" },
    { sha: sha(3), subject: "feat(schema)!: report@4" },
    { sha: sha(4), subject: "corpus: add a lookalike scenario" },
    { sha: sha(5), subject: "chore: bump deps" },
    { sha: sha(6), subject: "fix(scorer): rescale", body: "BREAKING CHANGE: scores move" },
    { sha: sha(8), subject: "docs: typo" },
    { sha: sha(9), subject: "ci!: drop node 22" },
  ];

  it("groups commits under Keep a Changelog headings and skips chore, ci, docs and test", () => {
    expect(renderSection(commits, "0.2.0", "2026-11-01")).toBe(
      [
        "## [0.2.0] - 2026-11-01",
        "",
        "### Breaking changes",
        "",
        "- **schema:** report@4 (3333333)",
        "- **scorer:** rescale (6666666)",
        "- drop node 22 (9999999)",
        "",
        "### Added",
        "",
        "- **cli:** add --repeat (1111111)",
        "",
        "### Fixed",
        "",
        "- handle empty corpus (2222222)",
        "",
        "### Corpus",
        "",
        "- add a lookalike scenario (4444444)",
        `- ${CORPUS_NOTE}`,
        "",
      ].join("\n"),
    );
  });

  it("writes no empty Corpus heading when every corpus commit is breaking", () => {
    const out = renderSection(
      [{ sha: sha(4), subject: "corpus!: rename a category" }],
      "0.3.0",
      "2026-11-03",
    );
    expect(out).not.toContain("### Corpus");
    expect(out).toBe(
      `## [0.3.0] - 2026-11-03\n\n### Breaking changes\n\n- rename a category (4444444)\n- ${CORPUS_NOTE}\n`,
    );
  });

  it("says so when no commit is user-facing", () => {
    expect(renderSection([{ sha: sha(5), subject: "chore: x" }], "0.1.1", "2026-11-02")).toBe(
      "## [0.1.1] - 2026-11-02\n\nNo user-facing changes.\n",
    );
  });
});

describe("prependSection and extractSection", () => {
  const header = "# Changelog\n\nIntro.\n\n## [Unreleased]\n";
  const section = renderSection(
    [
      { sha: sha(1), subject: "feat: one" },
      { sha: sha(2), subject: "fix: two" },
    ],
    "0.2.0",
    "2026-11-01",
  );

  it("inserts the section below Unreleased and above older releases", () => {
    const withOld = `${header}\n## [0.1.0] - 2026-10-01\n\n- first\n`;
    const out = prependSection(withOld, section);
    expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [0.2.0]"));
    expect(out.indexOf("## [0.2.0]")).toBeLessThan(out.indexOf("## [0.1.0]"));
    expect(hasSection(out, "0.2.0")).toBe(true);
    expect(extractSection(out, "0.1.0")).toBe("- first");
  });

  it("round-trips the body of a generated section", () => {
    const out = prependSection(header, section);
    const body = section.split("\n").slice(1).join("\n").trim();
    expect(extractSection(out, "0.2.0")).toBe(body);
    expect(extractSection(out, "9.9.9")).toBeNull();
  });
});

describe("CHANGELOG.md", () => {
  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");

  it("has an Unreleased heading and a 0.1.0 section", () => {
    expect(changelog).toMatch(/^## \[Unreleased\]$/m);
    expect(hasSection(changelog, "0.1.0")).toBe(true);
  });

  it("the 0.1.0 notes state the Node 24 runner requirement", () => {
    expect(extractSection(changelog, "0.1.0")).toMatch(/Node 24/);
  });
});
