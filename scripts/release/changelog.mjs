// Changelog generator (ADR-021 §4): Conventional Commits in, one Keep a Changelog
// section out. Pure functions only; scripts/release/prepare.mjs does the git and file work.

/** Commit types that appear in the changelog, in section order, with their headings. */
export const SECTIONS = [
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["corpus", "Corpus"],
  ["season", "Season"],
  ["perf", "Performance"],
  ["security", "Security"],
];

export const BREAKING_HEADING = "Breaking changes";

/** Appended to the Corpus section: corpus changes alter corpus_hash (ADR-021 §2). */
export const CORPUS_NOTE =
  "Corpus changes alter `corpus_hash`: results produced against an earlier corpus are shown as stale on the leaderboard.";

const SUBJECT_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<text>.+)$/;

/**
 * @typedef {{ sha: string, subject: string, body?: string }} Commit
 * @typedef {{ type: string, scope: string | null, breaking: boolean, text: string, sha: string }} Entry
 */

/**
 * Parses a Conventional Commit; null when the subject does not follow the format.
 * @param {Commit} commit
 * @returns {Entry | null}
 */
export function parseCommit(commit) {
  const match = SUBJECT_RE.exec(commit.subject.trim());
  if (!match?.groups) return null;
  const { type = "", scope, bang, text = "" } = match.groups;
  const breaking = bang === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body ?? "");
  return { type, scope: scope ?? null, breaking, text: text.trim(), sha: commit.sha };
}

/** @param {Entry} entry */
function line(entry) {
  const scope = entry.scope ? `**${entry.scope}:** ` : "";
  return `- ${scope}${entry.text} (${entry.sha.slice(0, 7)})`;
}

/**
 * Renders one changelog section. Breaking commits of any type go under "Breaking
 * changes"; feat, fix, corpus, season, perf and security commits go under their own
 * headings; every other type (chore, ci, docs, test, ...) is left out. Any corpus change
 * adds the stale-results note: under "Corpus", or under "Breaking changes" when every
 * corpus commit is breaking (no empty "Corpus" heading is written).
 * @param {Commit[]} commits
 * @param {string} version  MAJOR.MINOR.PATCH, no "v"
 * @param {string} date     YYYY-MM-DD
 */
export function renderSection(commits, version, date) {
  const entries = commits.map(parseCommit).filter((e) => e !== null);
  const blocks = [];
  const breaking = entries.filter((e) => e.breaking);
  const corpusItems = entries.filter((e) => e.type === "corpus" && !e.breaking);
  const breakingCorpusOnly = corpusItems.length === 0 && breaking.some((e) => e.type === "corpus");
  if (breaking.length > 0) {
    const lines = breaking.map(line);
    if (breakingCorpusOnly) lines.push(`- ${CORPUS_NOTE}`);
    blocks.push(`### ${BREAKING_HEADING}\n\n${lines.join("\n")}`);
  }
  for (const [type, heading] of SECTIONS) {
    const items = entries.filter((e) => e.type === type && !e.breaking);
    if (items.length === 0) continue;
    const lines = items.map(line);
    if (type === "corpus") lines.push(`- ${CORPUS_NOTE}`);
    blocks.push(`### ${heading}\n\n${lines.join("\n")}`);
  }
  if (blocks.length === 0) blocks.push("No user-facing changes.");
  return `## [${version}] - ${date}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * True when the changelog already has a section for `version`.
 * @param {string} changelog
 * @param {string} version
 */
export function hasSection(changelog, version) {
  return changelog.split("\n").some((l) => l.startsWith(`## [${version}]`));
}

/**
 * Inserts `section` above the newest released section (below "## [Unreleased]" and
 * anything under it), or at the end when there is none yet.
 * @param {string} changelog
 * @param {string} section
 */
export function prependSection(changelog, section) {
  const lines = changelog.split("\n");
  const index = lines.findIndex((l) => /^## \[(?!Unreleased\])/.test(l));
  if (index === -1) {
    return `${changelog.replace(/\n*$/, "")}\n\n${section.replace(/\n*$/, "")}\n`;
  }
  const before = lines.slice(0, index).join("\n").replace(/\n*$/, "");
  const after = lines.slice(index).join("\n");
  return `${before}\n\n${section.replace(/\n*$/, "")}\n\n${after}`;
}
