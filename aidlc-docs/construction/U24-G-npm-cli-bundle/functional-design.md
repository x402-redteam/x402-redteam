# U24-G — Single bundled npm package `x402-redteam` (CONDITIONAL: only if the owner chooses ADR-022 option B) · Functional Design

Author: senior-architect · Implementer: one Sonnet developer · Bolt 7 **Phase 3** (post-launch). It's sized now so the decision can be made with the cost known.
Contract: ADR-022 §3–4. Size: about 1.5 days.

## 1. Goal
`npx x402-redteam@0.x run --agent "…"` works on Node ≥ 22.14 without a clone and without `tsx`. The package is published by trusted publishing with automatic provenance from `release.yml`. CI smoke-tests the **built** artefact.

## 2. Files
```
packages/cli/package.json      name "x402-redteam" (unscoped), private false, files ["dist","corpus","LICENSE","README.md"],
                               bin → dist/x402-redteam.mjs, exports → dist, engines >=22.14, repository field (provenance needs it)
packages/cli/build.mjs         esbuild: bundle cli + driver + adversary + capture + scorer + schema (workspace deps inlined);
                               externals = @x402/*, viem, hono, commander, yaml, zod (kept as exact-pinned runtime deps);
                               platform node, format esm, target node22; copies corpus/ in
packages/cli/src/guardrail-track.ts   driver location: resolve the bundled driver entry relative to import.meta.url in dist,
                               source path in dev (single helper, tested)
packages/cli/bin/x402-redteam.mjs     dev bin unchanged (tsx); dist bin is generated
.github/workflows/ci.yml       (orchestrator applies) `fast` job adds: build bundle → `node dist/x402-redteam.mjs validate` →
                               `npm pack --dry-run` file-list check
.github/workflows/release.yml  (orchestrator applies) npm job: environment release, id-token: write, setup-node v7 with
                               registry-url, npm ≥ 11.5.1 (`npm i -g npm@<pinned>` inside the job only), `npm publish --access public`
                               from packages/cli (no token; trusted publisher configured by the owner)
packages/cli/test/bundle.test.ts      build to a temp dir (< 30 s) and run `validate` + `--help`
```

## 3. Acceptance (developer; each < 3 min)
- The bundle builds in under 30 s. `node dist/x402-redteam.mjs validate` → exit 0 with 52 scenarios.
- One scenario run with the built CLI against the guarded agent (`--scenario <one public id>`) completes in under 1 min with exit 0.
- `npm pack --dry-run` lists no `src/`, `test/` or `.ts` files.

## 4. Orchestrator / owner
- Owner: create the npm account or org, configure the trusted publisher (repo, `release.yml`, environment `release`), and after the first publish set "require 2FA and disallow tokens".
- Unverified: whether the trusted publisher can be set up before the first publish. If it can't, the owner does one manual `npm publish --provenance` with 2FA from a clean checkout of the release tag, then switches.
- Verify the provenance on npmjs.com and record it in audit.md.

## 5. Do not
- Publish any other workspace package. Use a long-lived npm token in Actions.
