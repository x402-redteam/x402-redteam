## What and why

<!-- What this changes and the problem it solves. -->

Design / ADR / issue: <!-- link, or "none" for small fixes -->

## Tests run

<!-- e.g. pnpm lint, pnpm typecheck, pnpm test; pnpm test:e2e if runtime paths changed -->

## Checklist

- [ ] The PR title is a Conventional Commit subject (`type(scope): subject`); it becomes the squash commit.
- [ ] Every commit is signed off (`git commit -s`, DCO).
- [ ] No held-out corpus content: no held-out scenario ids, hosts, prompts or mechanisms.
- [ ] If `results/` changed, `LEADERBOARD.md` is regenerated with `pnpm leaderboard`.
