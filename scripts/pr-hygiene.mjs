#!/usr/bin/env node
// Pull-request hygiene check (ADR-017 §3, §4), run by .github/workflows/pr-hygiene.yml.
//
// 1. The PR title is a Conventional Commit subject. It becomes the squash-merge commit
//    subject, so it is the only commit message on main that has to follow the format.
// 2. Every commit authored by a non-maintainer carries a DCO `Signed-off-by:` trailer
//    whose email matches the commit author's email.
//
// The pure functions are exported for unit tests. The CLI reads the title from $PR_TITLE
// (or the event JSON at $GITHUB_EVENT_PATH) and the PR's commits from the GitHub REST API
// using $GITHUB_TOKEN, or from a JSON file given with --commits for local runs.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TYPES = [
  "feat",
  "fix",
  "docs",
  "chore",
  "ci",
  "build",
  "refactor",
  "test",
  "perf",
  "revert",
  "corpus",
  "season",
];

// type, optional (scope), optional "!", ": ", then a non-blank subject.
const TITLE_RE = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`);

// Bot accounts whose commits are machine-generated and cannot carry a matching sign-off.
// Like maintainers, they are exempt only when GitHub reports the commit signature verified:
// the author login is derived from the commit email, which anyone can set.
const EXEMPT_BOTS = ["dependabot[bot]", "github-actions[bot]"];

/** @param {string} title */
export function checkTitle(title) {
  const t = String(title ?? "");
  if (TITLE_RE.test(t)) return { ok: true };
  return {
    ok: false,
    reason:
      `PR title must be a Conventional Commit subject, "type(scope)!: subject", ` +
      `with type one of: ${TYPES.join(", ")}.`,
  };
}

/** Emails from every `Signed-off-by: Name <email>` trailer, lowercased. */
export function signoffEmails(message) {
  const emails = [];
  for (const m of String(message ?? "").matchAll(/^Signed-off-by:[^<\n]*<([^>\n]+)>\s*$/gim)) {
    emails.push(m[1].trim().toLowerCase());
  }
  return emails;
}

/**
 * Checks the DCO sign-off on each commit, in the shape returned by
 * GET /repos/{owner}/{repo}/pulls/{n}/commits.
 *
 * @param {Array<{sha: string, author?: {login?: string} | null, parents?: unknown[],
 *   commit: {message: string, author?: {email?: string} | null,
 *   verification?: {verified?: boolean} | null}}>} commits
 * @param {{maintainers?: string[]}} [options]
 * @returns {Array<{sha: string, reason: string}>} one entry per failing commit
 */
export function checkSignoff(commits, options = {}) {
  const exempt = new Set(
    [...(options.maintainers ?? []), ...EXEMPT_BOTS].map((l) => l.toLowerCase()),
  );
  const problems = [];
  for (const c of commits) {
    const verified = c.commit?.verification?.verified === true;
    const login = c.author?.login?.toLowerCase();
    if (verified && login && exempt.has(login)) continue;
    // Merge commits (merging main into a branch, locally or via "Update branch") are exempt
    // whether or not they are signed.
    if (Array.isArray(c.parents) && c.parents.length > 1) continue;
    const sha = String(c.sha).slice(0, 7);
    const email = c.commit?.author?.email?.trim().toLowerCase();
    const emails = signoffEmails(c.commit?.message);
    if (emails.length === 0) {
      problems.push({ sha, reason: "missing Signed-off-by (use `git commit -s`)" });
    } else if (!email || !emails.includes(email)) {
      problems.push({ sha, reason: "Signed-off-by email does not match the commit author email" });
    }
  }
  return problems;
}

async function fetchCommits(repo, number, token) {
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status} listing PR commits`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function main(argv, env) {
  const commitsArg = argv.indexOf("--commits");
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : undefined;
  const title = env.PR_TITLE ?? event?.pull_request?.title ?? "";
  const maintainers = (env.MAINTAINERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let failed = false;
  const t = checkTitle(title);
  if (t.ok) {
    console.log("title: ok");
  } else {
    console.log(`title: FAIL - ${t.reason}`);
    failed = true;
  }

  const commits =
    commitsArg >= 0
      ? JSON.parse(readFileSync(argv[commitsArg + 1], "utf8"))
      : await fetchCommits(
          env.GITHUB_REPOSITORY,
          env.PR_NUMBER ?? event?.pull_request?.number,
          env.GITHUB_TOKEN,
        );
  const problems = checkSignoff(commits, { maintainers });
  if (problems.length === 0) {
    console.log(`sign-off: ok (${commits.length} commits)`);
  } else {
    for (const p of problems) console.log(`sign-off: FAIL ${p.sha} - ${p.reason}`);
    failed = true;
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`pr-hygiene: ${err.message}`);
      process.exit(2);
    },
  );
}
