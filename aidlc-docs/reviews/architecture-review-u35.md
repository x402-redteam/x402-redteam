# Architecture review — U35 functional design rev 1 (shared third-party sandbox, M7)

Reviewer: senior architect (read-only). Inputs: `construction/U35-shared-sandbox/functional-design.md`,
`examples/third-party/{agentkit,clawrouter,cloudflare}/src/{sandbox,guard,agent,child-client,ports}.ts`,
each adapter's `package.json` / `pnpm-workspace.yaml`, `agentkit/bracket-2.0.0/*`,
`agentkit/scripts/run-llm.sh`, `packages/schema/package.json`, root `pnpm-workspace.yaml`,
`biome.json`, `vitest.config.*`, `.github/workflows/ci.yml`.

## Verdict: READY WITH CONDITIONS (rev 2 for M1–M5, then build). 0 Blocker, 5 Major, 10 Minor.

Option A is the right choice, and `link:` to a zero-dependency package does not weaken the
adapters' isolation. The divergence table matches the code. But five points need fixing in rev 2
before build. Two are moves that silently change behaviour: tsx resolution, and real vs fresh
HOME for the denied paths. C9 as written cannot pass. The M7 exec deny can be bypassed. AC4 lets
the key-file change stand in for the process-introspection control, which it cannot replace.
No blockers.

## 1. `link:` soundness (focus 1)
- Lockfile, frozen install and release age: OK. A `link:` dependency is written into each
  adapter's own `pnpm-lock.yaml` as a path. It never goes to the registry, so
  `minimumReleaseAge: 4320` and exact pins don't apply to it. `--frozen-lockfile` stays
  deterministic. The adapters stay outside the root workspace (`packages: []` in each adapter's
  `pnpm-workspace.yaml`). This is not like schema: schema needs an `overrides` entry because its
  own dependencies are `workspace:`/registry ones (`agentkit/pnpm-workspace.yaml`, override of
  `@x402-redteam/schema`). A zero-dep package needs no such entry, and nothing joins the adapter's tree.
- Lifecycle scripts: pnpm does not run a linked dir's install scripts the way it does for
  `file:` dirs. Even so, `packages/sandbox/package.json` must keep both `dependencies` and the
  install/prepare scripts empty (see m3).
- TS across the link: Node resolves the symlink to its realpath by default (no
  `--preserve-symlinks`), so the file loads from `packages/sandbox/src/*.ts`. That path is outside
  `node_modules`, so tsx transpiles it. This works, but it creates **M1** (bare specifiers inside
  the moved code now resolve from `packages/sandbox`, not from the adapter).
- CI, biome, coverage: `biome.json:10` excludes only `!!examples/third-party`, so the new package
  gets linted. `vitest.config` `projects: ["packages/*", …]` and coverage
  `include: ["packages/*/src/**"]` pick it up as well. But the per-package thresholds
  (`vitest.config` ~L30-36) have no entry for it, and `spawn.ts`/`guard.ts` barely run on Linux
  CI (m2).
- Isolation rationale: kept. Third-party trees still never reach the root lockfile, and root
  dependencies never reach an adapter's tree. The child can read `packages/sandbox/src` (the
  profile has `allow default` for reads) but not write it.

## 2. Divergences D1–D16 (focus 2)
The table checks out against the code. D1 (`agentkit/src/sandbox.ts:61`), D8/D9
(`agentkit/src/guard.ts:41,48` allows `::1`; `clawrouter/src/guard.ts:60,71` does not), D11
(`agentkit/src/guard.ts:236` origin-only; `clawrouter/src/guard.ts:27,271` origin+path) and D12
(only AgentKit filters; all three exit 70: `agentkit/src/guard.ts:275-280`,
`clawrouter/src/guard.ts:303-307`, `cloudflare/src/guard.ts:297-301`). D13/D14
(`clawrouter/src/agent.ts:201-206`, `ports.ts` `parseProxyPort` refuses 8402).
None of the "keep" choices loosens a guard. D4 and D3 tighten. D9 removes AgentKit's `::1`
allowance, D11's origin-only stub stays AgentKit-only, and D12 is unchanged behaviour moved into
config. Things to keep working:
- Proxy port (clawrouter): the parent picks P (`pickFreePort`) before spawn, passes it as
  `X402_CLAWROUTER_PORT`, and listens on it. That maps onto `extraEnv` + `ports.listen` +
  `refused:[8402]`. The design should say that `allowedPorts` drops a picked P equal to a refused
  port with an error (today `parseProxyPort` returns undefined), and not silently.
- depsHook: covered by `preImports`. But the bracket install has its own manifest and lockfile
  (`bracket-2.0.0/package.json:17-18` uses `file:../../../../packages/...`), and
  `resolve-hooks.mjs:13-14` sends bare specifiers from the adapter's src/test to the bracket's
  `node_modules`. The bracket therefore needs its own `link:../../../../packages/sandbox`, and
  §9 lists only "resolve hook" (m1).
- 204 stubs and the rejection filter: OK as options. The stub check must come before the
  allowed-target check and must only ever return a local response (unit test).
- D15: the AgentKit parent checks the child's env names (`agent.ts:251`, `llm-mode.ts:72`).
  Adding `TMPDIR` means updating that check's expected set (m5).
- D9: AgentKit's harness connections must use `127.0.0.1` or `localhost` (both are covered by
  `localhost:P`). AgentKit's smoke is the evidence, so list it under AC3.

## 3. Canary C1–C9 (focus 3)
C1 and "fails, never skips" are fail-closed. Only C9 is wrong as written (M3). C4 can pass even
if the real-home bug is present (M2). C7's probe set misses the copy-and-exec bypass (M4). The
canary is a manual `pnpm … canary`, so nothing requires it to have passed before a real run
(m6).

## 4. M7 (focus 4)
- Rules: `process-info*` with `(target others)` is real SBPL, but it covers the `proc_info`
  calls (pidinfo, listpids and so on). `ps -E` reads the environment through the
  `kern.procargs2` sysctl. That makes `(deny sysctl-read (sysctl-name "kern.procargs2"))`
  (plus `kern.procargs`) the rule most likely to work, and it should be primary, not "if the
  probe still leaks". It also denies the child its own procargs, which is harmless for node, but
  smoke must confirm. Same-uid procargs reads don't need root, so the setuid bit on `/bin/ps` is
  not the issue. Copy `/bin/ps` into `<home>/tmp` and run it: you lose the setuid bit, but the
  same-uid read still works and the literal-path exec deny no longer matches (M4). All of this
  can be tested through C7 once the probe set is extended.
- Key file: this removes the key from every exec environment from `run-llm.sh` downward, but only
  if the key is not also exported in the user's shell. `run-llm.sh:18` currently *requires*
  `ANTHROPIC_API_KEY` in the environment. The key stays readable in two other ways: the parent's
  memory (on macOS, `task_for_pid` on a same-uid process needs a debugger entitlement, so this is
  likely denied; on Linux, ptrace and `/proc/<pid>/mem` under Yama scope 1 are not verified), and
  the file itself (`x402-redteam-private` is in `DENIED_HOME_PATHS`, `agentkit/src/sandbox.ts:28`,
  so that part is OK). The key file also does nothing for other same-uid secrets, such as tokens
  in the user's shell or other tools' environments, which the `-U <uid>` probe would reveal (M5).
- Writable set = fresh HOME only: feasible. The child writes nothing into the out dir (§2.3).
  tsx's cache follows `TMPDIR` (`os.tmpdir()`), and the out dir is already readable under
  `allow default`. The rules must use realpaths (`/private/var/folders/...`); `realOrSelf`
  already does that. Residual: native code that writes to the Darwin user cache dir (`confstr`)
  ignores `TMPDIR`. Add it to §10, with smoke as the detector.

## Findings
| id | sev | evidence | required change |
|---|---|---|---|
| M1 | Major | The child's loader is `import.meta.resolve("tsx")`, resolved from the file it lives in (`agentkit/src/sandbox.ts:149`). Once moved to `packages/sandbox/src/spawn.ts` (zero deps), it resolves upward to the root's `node_modules/tsx` (root `package.json:31`). The child would then load a loader from the root lockfile, not the adapter's pinned tree. It would also break in a checkout where only the adapter is installed. The §4 API has no loader parameter. | Add a required `loader: string` to `spawnSandboxed` and pass `import.meta.resolve("tsx")` from the adapter. The rule: `packages/sandbox/src` imports only `node:` built-ins and relative files, with a unit test that greps for bare imports. C9 also asserts the loader's realpath is under the adapter's (or bracket's) `node_modules`. |
| M2 | Major | The denied paths are joined onto `opts.home` (`agentkit/src/sandbox.ts:56`), which is `homedir()` today (`:90`). The shared spawn now creates a fresh HOME and has its own `home`. The §4 signature `macosProfile({ home, … })` doesn't say which home it means, so a refactor that passes the fresh HOME would quietly make `~/.ssh` and `~/x402-redteam-private` readable. C4 runs only "in a stand-in home", so it would not catch that. | Rename the parameter to `deniedRoot` (always `os.homedir()` of the parent, never the child's HOME). Add a C4 case that probes the parent's real `os.homedir()/x402-redteam-private` with a throwaway file (or the stand-in passed as `deniedRoot` in both the profile and the spawn). Add a unit test that the profile text for a spawn contains the real-home paths. |
| M3 | Major | C9 says "the preloaded guard's realpath is `packages/sandbox/src/guard.ts`". Per §4, the preloaded file is the adapter's own 5-line `src/guard.ts` entry, so C9 always fails or gets rewritten loosely. It also checks only the child: the parent's profile and spawn code could still come from a stale or other copy, and bracket mode is not covered. | Have `installGuard` record `realpath(fileURLToPath(import.meta.url))` and report it on the existing fd-3 channel. C9 asserts that path equals the realpath of `<repo>/packages/sandbox/src/guard.ts`, and the same for the parent's `spawn.ts`/`profile.ts` module URLs and (per M1) the loader. Run C9 in AgentKit's bracket mode too. Add a test that no `sandbox.ts`/`ports.ts` and no `macosProfile`/`isAllowedTarget` definition remains under `examples/third-party/*/src` (AC1). |
| M4 | Major | The exec deny matches only `(literal "/bin/ps")` (§5.1). The child can write `<home>/tmp` and run what it puts there (`allow default`), so `cp /bin/ps "$HOME/tmp/p"` gets around it. Same-uid `kern.procargs2` reads don't need setuid. The C7 probe set does not include this. | Make `sysctl-read` deny of `kern.procargs2`/`kern.procargs` the primary rule, with `process-info*` `(target others)` as a second layer. Add `(deny process-exec* (subpath <home>))` so the writable area can't hold executables. Add C7 probes: a copied `ps`, `ps` run from `<home>/tmp`, and `/usr/bin/perl` or other stock interpreters calling sysctl if available. Record each probe's result as `denied` / `empty` / `leaked`. |
| M5 | Major | AC4 accepts "mitigation 2 as the control". The key file protects only the Anthropic key. Other same-uid processes' secrets stay readable whenever C7 leaks. `run-llm.sh:18-19` requires `ANTHROPIC_API_KEY` in the environment, so with the key file it would also have to be unset. | AC4 is met only when C7 shows no leak (mitigation 1). If any probe leaks, third-party runs stay blocked until the owner records an explicit ADR-029 residual naming *all* same-uid environment secrets, not just the key. In the key-file mode, `run-llm.sh` refuses to start if `ANTHROPIC_API_KEY` is also set, checks that the file is mode 0600 and a regular file, and the parent never copies the key into `process.env`. Add a C6 or C7 case: parent started with `X402_ANTHROPIC_KEY_FILE` → the probe finds no key in any visible environment. |

| m1 | Minor | `bracket-2.0.0/package.json:17-18` and its own lockfile; `resolve-hooks.mjs:13-14`. §9 lists only the hook. | Add `link:../../../../packages/sandbox` to the bracket manifest and lockfile, and run C1–C9 in bracket mode. |
| m2 | Minor | `vitest.config` thresholds (~L30-36) have no `packages/sandbox` entry. `spawn.ts`/`guard.ts` (side-effect install) are barely exercised on Linux CI. | Add a per-package threshold, measured on the pure modules (profile, ports, target, childEnv, stubs). Exclude only the side-effect guard installer and the spawn wrapper, and say why. Optional: `ci.yml` already has a `macos-latest` job (L250). A stand-in-child conformance run there (no third-party deps) would bring the OS layer into CI. |
| m3 | Minor | The isolation claim ("zero deps") isn't enforced. | Add a root unit test: `packages/sandbox/package.json` has no `dependencies`, `peerDependencies` or `optionalDependencies`, and no `preinstall`/`install`/`postinstall`/`prepare` script. Only `devDependencies` (vitest, types) are allowed, and the adapters never install those through `link:`. |
| m4 | Minor | `run-llm.sh:30,42`: `mktemp -t` / `rm -f`. | Use `mktemp -d` (0700), clean up with `trap 'rm -rf "$d"' EXIT`, and check that the spend dir is not under the child's HOME. |
| m5 | Minor | AgentKit checks the child's env names (`agent.ts:251`, `llm-mode.ts:72`). D15 adds `TMPDIR`. | Update the expected name sets in all three adapters. C6 asserts against `childEnv`'s own base list, not a copy. |
| m6 | Minor | The canary runs manually (`package.json` `canary`). `spawnSandboxed` checks only `detectSandbox` at runtime (`sandbox.ts:171-178`). | `run-llm.sh` and the smokes first run C1, C7 and C9 (fast subset), or `spawnSandboxed` runs a cached one-shot M7 self-probe and refuses to start on `leaked`. That makes the M7 control fail-closed after a macOS update. |
| m7 | Minor | AC3 "determinism per profile unchanged" is not measurable. AC2 doesn't name AgentKit's smoke. | Name the baseline per adapter (count and command), and add AgentKit smoke plus bracket-mode canary to AC3. Add "adapter `pnpm typecheck` green" (the adapter tsconfig compiles the linked `.ts`). |
| m8 | Minor | §8 records "C7 per-probe results". Raw `ps -E` output contains other processes' environments. | Record only probe id, verdict and counts. Never the output, and never other processes' command lines (ADR-028 hygiene). |
| m9 | Minor | The Linux `unshare --pid --fork --mount-proc` mitigation is unexercised (§10). Ubuntu 24.04 restricts unprivileged userns through AppArmor. | Mark the Linux M7 rows "unverified" in ADR-029. Don't claim them as controls. |
| m10 | Minor | §5.2 "No same-uid process then holds the key in its exec environment" ignores the user's interactive shell if it exports the key. | Reword it as conditional on M5's refusal, and document in the adapter README not to export the key. |

## Privacy (ADR-028)
OK. Everything that mentions a third-party package (the analytics origin, the update-check URL,
`.openclaw`/`.blockrun`/`.wrangler`) is already in public adapter source as a harness control.
None of it is a result. §8's "counts and package names only" is right. Add m8.

## Scope
In scope. The key file and the spend-file move are what M7 asks for. The Linux `--pid` flags are
the only part that adds something unverified (m9). Don't add a sandbox for mcpc/pay here.

## Conditions for build
- C1: Add a `loader` parameter, and allow only `node:` built-ins and relative imports in `packages/sandbox/src`, with a test (M1).
- C2: Use `deniedRoot` = the parent's `os.homedir()`, with C4 extended to the real-home path (M2).
- C3: Make C9 a reported module realpath for guard, spawn/profile and loader, run in bracket mode too, plus the AC1 no-copy test (M3).
- C4: Make the `kern.procargs*` sysctl deny primary, deny exec under `<home>`, and add the copied-`ps` and interpreter probes to C7 (M4).
- C5: AC4 is met by C7 alone. A leak blocks third-party runs unless an ADR-029 residual names every same-uid secret. `run-llm.sh` refuses when the key is also in the environment (M5, m10).
- C6: The bracket `link:` and lockfile; the coverage threshold; the zero-deps/no-scripts test; the `mktemp -d` + trap; the TMPDIR name sets (m1–m5).
- C7: A runtime M7/C9 preflight before LLM runs and smokes (m6). Measurable AC3 with AgentKit smoke and adapter typecheck (m7). Audit records verdicts only (m8). Linux marked unverified (m9).

## Delta check (rev 2)

**Verdict: SIGNED OFF FOR BUILD.** Every finding and condition is resolved in rev 2:
M1–M5, m1–m10 and C1–C7 all map correctly in §12. I checked each one against §4 (API and
rules), §5 (probes P1–P6, mitigations 1–5), §6 (C4 a/b, C8 exec, C9 `__modules`, the CI tests),
§7 (AC3–AC5), §9 and §10. Rev 2 introduced no regressions. Four small new points become build
conditions. None of them needs a rev 3.

| id | sev | evidence (rev 2) | condition |
|---|---|---|---|
| D1 | Minor | `spawnSandboxed({ deniedRoot? /* tests only */ })` (§4 API). Nothing enforces "tests only", so a production caller could point the denied paths elsewhere, the same failure as M2. | The §5.3 preflight refuses when `deniedRoot !== os.homedir()` unless the conformance harness sets an explicit test-only flag (unit test). Alternatively, take the parameter out of the public API. |
| D2 | Minor | P5 runs `/usr/bin/python3`. On a Mac without Command Line Tools that is a stub that opens the install dialog and can block an offline canary. | Run P5 only if `xcode-select -p` succeeds. Give every probe a timeout. A probe that is absent counts as `empty` and is recorded as "not run". |
| D3 | Minor | C4(b) writes a throwaway file into the real `~/x402-redteam-private/`. | Create the file only in a new, uniquely named subdir. Remove it in `finally`. Never list or read anything else in that dir, and record only the verdict. |
| D4 | Minor | §5.1 rule 3 (`deny process-exec*` under `<childHome>`) can break a package that downloads a binary into a HOME cache and runs it. §10 covers write breakage only. | Add this to §10. Smoke and canary detect it. Any fix goes through the owner, never by loosening rule 3 per adapter. |
