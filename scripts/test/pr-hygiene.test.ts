import { describe, expect, it } from "vitest";
import { checkSignoff, checkTitle, TYPES } from "../pr-hygiene.mjs";

describe("checkTitle", () => {
  it.each([
    "feat(cli): x",
    "fix!: y",
    "corpus: add a drain-via-redirect scenario",
    "season(s1)!: rotate the HMAC list",
    "ci(workflows/pr-hygiene): run on edited",
  ])("accepts %j", (title) => {
    expect(checkTitle(title).ok).toBe(true);
  });

  it.each([
    "Update stuff",
    "feat:",
    "feat: ",
    "feat:   ",
    "feature: x",
    "Feat: x",
    "feat(): x",
    "feat(cli) x",
    "",
  ])("rejects %j", (title) => {
    const r = checkTitle(title);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Conventional Commit/);
  });

  it("allows exactly the ADR-017 types", () => {
    expect(TYPES).toEqual([
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
    ]);
  });
});

function commit(
  login: string,
  email: string,
  message: string,
  parents = 1,
  verified = true,
): Parameters<typeof checkSignoff>[0][number] {
  return {
    sha: "0123456789abcdef",
    author: { login },
    parents: Array.from({ length: parents }, () => ({})),
    commit: { message, author: { email }, verification: { verified } },
  };
}

describe("checkSignoff", () => {
  it("passes a commit whose Signed-off-by matches the author email", () => {
    const c = commit(
      "alice",
      "Alice@Example.org",
      "fix: x\n\nSigned-off-by: Alice <alice@example.org>",
    );
    expect(checkSignoff([c])).toEqual([]);
  });

  it("fails a commit with no Signed-off-by", () => {
    const problems = checkSignoff([commit("alice", "alice@example.org", "fix: x")]);
    expect(problems).toEqual([{ sha: "0123456", reason: expect.stringMatching(/missing/) }]);
  });

  it("fails a commit whose Signed-off-by email differs from the author email", () => {
    const c = commit(
      "alice",
      "alice@example.org",
      "fix: x\n\nSigned-off-by: Bob <bob@example.org>",
    );
    expect(checkSignoff([c])).toEqual([
      { sha: "0123456", reason: expect.stringMatching(/does not match/) },
    ]);
  });

  it("ignores a Signed-off-by that is not on its own line", () => {
    const c = commit(
      "alice",
      "alice@example.org",
      "fix: see Signed-off-by: A <alice@example.org> x",
    );
    expect(checkSignoff([c])).toHaveLength(1);
  });

  it("exempts maintainers, case-insensitively", () => {
    const c = commit("Maint", "maint@example.org", "fix: x");
    expect(checkSignoff([c], { maintainers: ["maint"] })).toEqual([]);
    expect(checkSignoff([c], { maintainers: ["someone-else"] })).toHaveLength(1);
  });

  it("does not exempt an unverified commit that claims a maintainer's email", () => {
    // The login is resolved from the author email, so an unsigned commit using the
    // maintainer's email shows the maintainer's login.
    const spoofed = commit("maint", "maint@example.org", "fix: x", 1, false);
    expect(checkSignoff([spoofed], { maintainers: ["maint"] })).toEqual([
      { sha: "0123456", reason: expect.stringMatching(/missing/) },
    ]);
  });

  it("does not exempt an unverified bot commit", () => {
    expect(
      checkSignoff([commit("dependabot[bot]", "x@users.noreply.github.com", "chore: x", 1, false)]),
    ).toHaveLength(1);
  });

  it("exempts an unsigned local merge commit", () => {
    expect(
      checkSignoff([commit("alice", "alice@example.org", "Merge branch 'main'", 2, false)]),
    ).toEqual([]);
  });

  it("exempts Dependabot and merge commits", () => {
    expect(
      checkSignoff([commit("dependabot[bot]", "x@users.noreply.github.com", "chore: x")]),
    ).toEqual([]);
    expect(checkSignoff([commit("alice", "alice@example.org", "Merge branch 'main'", 2)])).toEqual(
      [],
    );
  });

  it("checks commits with no linked GitHub account", () => {
    const c = {
      sha: "abcdef0123",
      author: null,
      commit: { message: "x", author: { email: "a@b" } },
    };
    expect(checkSignoff([c])).toHaveLength(1);
  });
});
