# U35 — Shared third-party sandbox (functional design, rev 2)

Follow-up 3 of `aidlc-docs/reviews/consulting-architecture-review.md` (H7, M7). Rev 2 folds in
`aidlc-docs/reviews/architecture-review-u35.md` (ready with conditions; M1–M5, m1–m10, C1–C7;
mapping in §12). Offline only: the build may run the adapters' canary and smoke; no third-party
red-team item is re-run and no third-party result is written.

## 1. Problem

The sandbox (`sandbox.ts`, OS layer) and the egress guard (`guard.ts`, preloaded layer) are the
ADR-029 boundary for running third-party code. Each adapter carries its own copy, each copy says
"copied, not imported", and they have drifted: AgentKit, the oldest, lacks port pinning, `::1`
refusal and a fresh `HOME`. Two more adapters (mcpc, pay) are planned. Separately (M7), a
same-uid child can probably read other processes' environments and can write the run's out dir
and the LLM spend file.

## 2. Findings re-verified (2026-11-03, this checkout)

Line counts (`wc -l`): `sandbox.ts` 189 / 215 / 204 and `guard.ts` 280 / 307 / 301
(agentkit / clawrouter / cloudflare). Paths below are under `examples/third-party/`.

1. **No port pinning in AgentKit.** `agentkit/src/sandbox.ts:61` allows `localhost:*`;
   clawrouter `sandbox.ts:73` and cloudflare `sandbox.ts:70` emit one rule per allowed port. The
   AgentKit guard checks hosts only (`isAllowedHost`, `guard.ts:95,118`), never ports.
2. **No fresh HOME in AgentKit.** clawrouter `agent.ts:203-206` and cloudflare `agent.ts:127-130`
   `mkdtemp` a HOME and pass it; AgentKit passes `childEnv(process.env)` (`child-client.ts:23,54`),
   so the child gets the real `HOME`.
3. **Out dir and temp dirs writable.** All three `profileForTask` put `tmpdir()`, `/private/tmp`
   and the out dir in `writable` (agentkit `sandbox.ts:91`). The child itself writes nothing there
   (all `writeFileSync` calls are parent-side: `provenance.ts`, `notes.ts`, `reconcile.ts`).
4. **Spend file inside the writable set.** `agentkit/scripts/run-llm.sh:30` creates it with
   `mktemp -t`, i.e. under `$TMPDIR` = `tmpdir()`, which the child may write (cap bypass).
5. **Parent env readable (M7): confirmed plausible on macOS.** On this machine (macOS 26.6.2),
   `/bin/ps` is setuid root and `ps -E -ww -o command= -p $PPID` printed the environment of
   another same-uid process (counted `HOME=` matches only; no values read). Nothing in any
   profile denies `process-exec` of `/bin/ps` or `process-info*` (`(allow default)`). The key is
   in the exec environment of the user's shell, the harness and the adapter parent, all same-uid;
   `KERN_PROCARGS2` returns the exec-time strings, so `delete process.env.X` does not hide them.
   Linux `unshare -rn` keeps the host pid namespace, so `/proc/<pid>/environ` is likely readable.
   Not yet verified *inside* `sandbox-exec`; §5 is that check.

## 3. Divergences (`diff -u` of the three `sandbox.ts` and `guard.ts`, plus what they rely on)

| # | Where | agentkit | clawrouter | cloudflare | Shared version keeps |
|---|---|---|---|---|---|
| D1 | profile network | `localhost:*` | harness port + P | harness port | per-port rules from `ports` |
| D2 | profile bind/inbound | none | `localhost:P` | none | option `listenPort` |
| D3 | denied home paths | base 10 | + `.openclaw`, `.blockrun` | + `.wrangler` | union for all, plus `extraDeniedHomePaths` |
| D4 | secret-file regex | `.env*` | `.env*` | `.env*`, `.dev.vars*` | cloudflare's (broader) |
| D5 | `profileForTask` | no task read | reads `base_url` | reads `base_url` | reads `base_url` |
| D6 | `nodeArgv` | `depsHook()` bracket import | none | none | option `preImports` |
| D7 | refusal/rejection label | "AgentKit" | "ClawRouter" | "Cloudflare" | option `label` |
| D8 | guard port check | none | `isAllowedTarget` | `isAllowedTarget` | `isAllowedTarget` |
| D9 | `LOOPBACK_IPS` | 127.0.0.1, ::1 | 127.0.0.1 | 127.0.0.1 | 127.0.0.1 only |
| D10 | tls/udp checks | host only | host + port, port in log | same as clawrouter | clawrouter's |
| D11 | local 204 stub | analytics *origin* | update-check origin+path | none | option `stubs` (exact origin+path; origin-only allowed per stub, AgentKit only) |
| D12 | `unhandledRejection` | ignores analytics | none | none | option `ignoreRejection` predicate |
| D13 | `ports.ts` | absent | refuses 8402, `PORT_ENV` | harness only | `allowedPorts(baseUrl, {extra, refused})` |
| D14 | fresh HOME | none | `agent.ts:203` | `agent.ts:127` | done by shared spawn (§4) |
| D15 | child env names | PATH, HOME, TASK, BASE_URL, CHAIN | PATH, HOME, TASK, P | PATH, HOME, TASK | base PATH, HOME, TMPDIR, TASK + `extraEnv` |
| D16 | `TaskFile` | v1-4, no `parallel` | + `parallel` | + `mcp_servers` | union type; `taskUrls` identical in all three |

Everything else in the two files (DNS resolver patching, `net.connect`, `fetch`, `WebSocket`,
`detectSandbox`, `unshare` argv, `sbString`/`subpaths`, `outDirOf`) is identical apart from
comments.

## 4. Options and recommendation

**A. Shared package `packages/sandbox` (`@x402-redteam/sandbox`), zero dependencies, TypeScript
source exported like `@x402-redteam/schema` (`exports: ./src/index.ts`), consumed by each adapter
as `"@x402-redteam/sandbox": "link:../../../packages/sandbox"`.**
- For: one copy of the boundary; it sits in the workspace, so biome, typecheck and CI unit tests
  cover it (today none of the boundary is in CI). Adapters already consume `file:` schema/capture,
  so the pattern is known. Zero dependencies means nothing enters any adapter's tree;
  `minimumReleaseAge`, exact pins and lifecycle-scripts-off are unaffected (local links are not
  registry packages). Each adapter keeps its own lockfile and stays outside the workspace.
- Against: an edit to the shared code changes every adapter at once (that is the point, but it
  means every adapter's canary must run after one); `file:` would inject a stale copy until
  reinstall, hence `link:`; AgentKit's bracket install (`bracket-2.0.0/`, own manifest and
  lockfile) needs its own `link:../../../../packages/sandbox` entry (m1).
- Rules that keep A sound (M1, m3): `packages/sandbox/src` imports only `node:` built-ins and
  relative files, because a bare specifier there would resolve from the root `node_modules`, not
  the adapter's pinned tree. `package.json` has no `dependencies`, `peerDependencies` or
  `optionalDependencies` and no `preinstall`/`install`/`postinstall`/`prepare` script; only
  `devDependencies` (vitest, types), which `link:` never installs into an adapter. A root unit
  test enforces both (it scans `src/**` for non-`node:`, non-relative imports).

**B. Canonical copy plus vendored byte-identical copies and a root sync test.**
- For: no install semantics change; adapters remain fully self-contained.
- Against: copies stay, so adapter-specific differences must still move to config (same work as
  A); the copies are not linted or typechecked in CI; a sync test catches drift only after it is
  written, and invites "update the canonical, forget to re-copy".

**Recommendation: A**, with a canary assertion (C9) that the shared guard, spawn and profile
modules and the loader both processes actually loaded are the expected realpaths, so no adapter
can run a stale or local copy (M3).

### Shared API (seams from §3)

```ts
// profile.ts — pure
macosProfile({ deniedRoot, childHome, ports, listenPort?, writable, readable,
  extraDeniedHomePaths? }): string   // deniedRoot = parent's os.homedir(), never childHome (M2)
allowedPorts(baseUrl, { extra?: number[]; refused?: number[] }): number[]  // throws if an extra is refused
// spawn.ts
spawnSandboxed({ label, script, loader /* required: adapter's import.meta.resolve("tsx") (M1) */,
  guardEntry, taskPath, extraEnv?, ports?: {extra?, refused?, listen?}, preImports?,
  deniedRoot? /* tests only; default os.homedir() */, sandbox?, guard?, stdio? })
  : { proc: ChildProcess; home: string; dispose(): void }
childEnv(from, extraNames): Record<string,string>     // base names + extras, nothing else
// guard.ts — called from a 5-line adapter entry preloaded with --import
installGuard({ label, portEnv?, refusedPorts?, stubs?: {url, match:"origin"|"path"}[],
  ignoreRejection?: (r: unknown) => boolean }): void
// task.ts
readTaskFrom, taskUrls, taskHostnames, TaskFile (union of D16)
```
`spawnSandboxed` always creates the fresh HOME (`mkdtemp x402rt-<label>-home-`), sets `TMPDIR`
to `<home>/tmp`, and `dispose()` removes it. Adapter `src/guard.ts` becomes the config entry;
`src/sandbox.ts` and `src/ports.ts` are deleted; `child-client.ts` calls the shared spawn.
`installGuard` records `realpath(fileURLToPath(import.meta.url))` of the shared guard and of the
loader, and answers a `__modules` call on the existing fd-3 channel (C9). Stubs are checked before
the allowed-target check and only ever return a local `204` (unit test). ClawRouter maps onto
`extraEnv: [X402_CLAWROUTER_PORT]`, `ports.listen: P`, `refused: [8402]`; a picked P equal to a
refused port is an error, not a silent drop. The AgentKit parent's `checkChildEnv`
(`agent.ts:251`, `llm-mode.ts:72`) and every adapter's expected name set use `childEnv`'s exported
base list, which now includes `TMPDIR` (m5).

## 5. M7 — parent-env probe and mitigations

**Probe (in the conformance canary).** A launcher helper is exec'd with
`X402_CANARY_ENV_SECRET=<32 random hex>` in its *exec* environment (so `KERN_PROCARGS2` holds it),
and it spawns the probe child through the shared spawn. The child tries, and reports each as
`denied` / `empty` / `leaked`: P1 `/bin/ps -E -ww -o command= -p <ppid>`; P2 the same with
`-U <uid>` (every same-uid process); P3 `ps eww`; P4 `/bin/ps` copied to `<home>/tmp/p` and run
from there (setuid lost, same-uid `kern.procargs2` still works without it; M4); P5 a stock
interpreter calling sysctl if present (`/usr/bin/perl` `syscall`, or `/usr/bin/python3` ctypes
`sysctl` for `kern.procargs2`); P6 key-file mode: parent started with `X402_ANTHROPIC_KEY_FILE`
pointing at a throwaway 0600 file holding a random marker, which must appear in no visible
environment (M5); Linux: `/proc/<ppid>/environ` and every `/proc/*/environ`. Pass only if no
marker appears in any output. Markers are random, never a key. The probe compares inside the
child and returns only verdicts; raw output is never written or logged (m8).

**Mitigations.**
1. **The control (C4/M4).** Primary: `(deny sysctl-read (sysctl-name "kern.procargs2")
   (sysctl-name "kern.procargs"))` — `ps -E` reads environments through that sysctl, and a
   same-uid read needs no setuid. Second layer: `(deny process-info* (target others))` (covers
   the `proc_info` calls). Third: `(deny process-exec* (subpath <childHome>))` so the only
   writable area cannot hold executables (closes P4). The `/bin/ps` literal deny is dropped: it
   is bypassed by P4 and adds nothing once the sysctl is denied. The sysctl deny also hides the
   child's own procargs; canary and smoke must confirm node and the adapters don't need it.
   Linux: `unshare -rn --pid --fork --mount-proc`, marked **unverified** in ADR-029 and not
   claimed as a control (Ubuntu 24.04 AppArmor restricts unprivileged userns; m9).
2. **Key file (defence in depth, not a substitute for 1; Q2).** `run-llm.sh` takes
   `X402_ANTHROPIC_KEY_FILE` and passes only the path via `--pass-env`. It refuses to start if
   `ANTHROPIC_API_KEY` is also set, or if the file is not a regular file of mode 0600 (it may live
   under `~/x402-redteam-private/`, already denied to the child). The parent reads it into memory
   and never copies it into `process.env`. The key is then absent from every exec environment
   from `run-llm.sh` down, provided the user's shell does not export it; the adapter READMEs say
   not to (m10). Parent memory: `task_for_pid` on macOS needs a debugger entitlement (likely
   denied, recorded as residual); Linux ptrace/`/proc/<pid>/mem` unverified. The
   `ANTHROPIC_API_KEY` env path stays for the built-in `examples/agents` LLM agent (no third-party
   child).
3. **Fail-closed at run time (m6).** `spawnSandboxed` runs a one-shot M7 self-probe (P1, P4 with
   a fresh marker) and the C9 module check once per parent process, caches the verdict, and
   refuses to start on `leaked` or a module mismatch. `run-llm.sh` and every adapter smoke
   therefore cannot run after a macOS update reopens the read.
4. Different uid: not feasible without admin user creation on macOS; out of scope.
5. **Writable set = the child's own HOME only** (`<childHome>`, `<childHome>/tmp`, `/dev`, as
   realpaths, e.g. `/private/var/folders/...`). The out dir moves to `readable` only; `tmpdir()`
   and `/private/tmp` leave `writable`. `run-llm.sh` creates the spend file in a fresh
   `mktemp -d` dir (0700), removes it with `trap 'rm -rf "$d"' EXIT`, and checks the dir is not
   under any child HOME (m4).

## 6. Conformance canary (`packages/sandbox/test/conformance.ts`)

Exports `runConformance(adapter)` (node:test). Each adapter's `test/canary.test.ts` calls it with
its config and its real child entry; adapter-specific cases (8402 listener, proxy-mode refusal,
provider list) stay in the adapter. Runs offline on macOS via `pnpm -C examples/third-party/<a> canary`
(`--test-concurrency=1`); a machine with no working sandbox **fails**, never skips.

| | Asserts |
|---|---|
| C1 | `detectSandbox()` is not `none` |
| C2 | OS layer alone, guard alone, and both: public IP, public name, DNS and a decoy loopback port refused; harness port (and P if any) connects |
| C3 | `[::1]` refused by the guard |
| C4 | union denied paths unreadable under `deniedRoot` while the child's HOME is the fresh one: (a) a stand-in passed as `deniedRoot` to both profile and spawn; (b) a throwaway file in the parent's real `os.homedir()/x402-redteam-private/`, removed after (M2); `.env*`/`.dev.vars*` unreadable even in the out dir |
| C5 | child `HOME` is fresh, empty, not `os.homedir()`, removed after `dispose()` |
| C6 | child env names equal `childEnv`'s exported base list + extras (not a copy); no `ANTHROPIC_*`, no marker |
| C7 | M7 probes P1–P6 (§5) — every verdict `denied` or `empty`, none `leaked` |
| C8 | child cannot write the out dir, a stand-in spend file in parent `$TMPDIR`, or `/private/tmp`; can write `<home>/tmp`; cannot exec a file it wrote there |
| C9 | the child's `__modules` reply: shared guard realpath = realpath of `<repo>/packages/sandbox/src/guard.ts`, loader realpath under the adapter's (or bracket's) `node_modules`; the parent's `spawn.ts`/`profile.ts` `import.meta.url` realpaths are under `<repo>/packages/sandbox/src` (M1, M3) |

C1–C9 also run in AgentKit's bracket mode (m1). A root unit test asserts no `sandbox.ts` or
`ports.ts`, and no `macosProfile`/`isAllowedTarget`/`installGuard` definition, remains under
`examples/third-party/*/src` (AC1, M3).

CI (Linux, no adapters): vitest unit tests in `packages/sandbox` for the pure parts — profile text
per input (including that a spawn's profile names the real-home denied paths, M2), `allowedPorts`,
`isAllowedTarget`, `childEnv`, stub ordering and matching, the import and zero-deps tests (M1, m3).
A per-package coverage threshold in `vitest.config` is measured on the pure modules; the
side-effect guard installer and the spawn wrapper are excluded because they only run inside a
real sandboxed child (m2). Optional: a stand-in-child conformance run (no third-party deps) on the
existing `macos-latest` CI job would bring the OS layer into CI; left to the build if cheap.

## 7. Acceptance criteria

1. `examples/third-party/*/src/{sandbox,ports}.ts` are gone; each adapter `guard.ts` is config only.
2. AgentKit gets port pinning, `::1` refusal and a fresh HOME through the shared code (D1, D8, D9, D14).
3. All three adapters pass C1–C9 (AgentKit in default and bracket mode), and each adapter's
   `pnpm typecheck` is green (it compiles the linked `.ts`). Existing tests still pass at their
   baselines plus the new cases: cloudflare `pnpm canary` 93/93 and `pnpm smoke` (5 runs per
   profile byte-identical); clawrouter `pnpm canary` 67/67 and `pnpm smoke` (3 runs per profile
   byte-identical, last recorded in `audit.md`); agentkit `pnpm canary` (count recorded before migration) and the scripted,
   offline exit-code cases. AgentKit has no smoke script today; its canary's real-child case is
   the D9 evidence (harness reached on `127.0.0.1`/`localhost` only) (m7).
4. **C7 shows no leak with mitigation 1. That alone meets AC4.** If any probe leaks, third-party
   runs stay blocked (the §5.3 preflight refuses) until the owner records an ADR-029 residual
   naming *every* same-uid environment secret exposed, not only the Anthropic key (M5).
5. Key-file mode: `run-llm.sh` refuses when `ANTHROPIC_API_KEY` is also set or the file is not a
   0600 regular file; P6 finds no marker (M5). The spend file lives outside every child-writable
   path (C8 stand-in, m4).
6. Root checks green: install, lint, typecheck, unit with coverage, test:e2e (CLAUDE.md).

## 8. Test plan

Test-first in `packages/sandbox` (unit), then conformance per adapter, migrating AgentKit last
because it changes behaviour. Offline smoke per adapter after migration. Record in `audit.md`:
C7 probe id and verdict per adapter (never probe output or other processes' command lines, m8),
the final profile rules, any third-party package that broke under the narrowed writable set
(counts and package names only, no results, ADR-028).

## 9. Files touched

`packages/sandbox/` (new: package.json, tsconfig, src/{index,profile,spawn,guard,task}.ts,
test/{unit tests, conformance.ts}); root `pnpm-lock.yaml`; per adapter: `package.json`,
`pnpm-lock.yaml`, `src/{guard,child-client,agent}.ts`, delete `src/{sandbox,ports}.ts`,
`test/canary.test.ts`, README; `agentkit/bracket-2.0.0/{package.json,pnpm-lock.yaml}` (own
`link:`) and resolve hook; `agentkit/{src/llm-mode.ts,scripts/run-llm.sh}`; `vitest.config`
(threshold); root unit tests (zero-deps/imports, no-copy); `aidlc-docs/inception/adr/decisions.md`
(ADR-029 amendment, Linux rows unverified); CHANGELOG.

## 10. Risks

- Narrowing writable paths may break a third-party package that writes to `$TMPDIR` or a cache
  dir; `TMPDIR=<home>/tmp` absorbs most; failures surface in canary/smoke, not in results.
- Native code that writes to the Darwin user cache dir (`confstr`) ignores `TMPDIR`; smoke is the
  detector.
- `(target others)` / `sysctl-read` semantics in SBPL are undocumented; only C7 is evidence, and
  the §5.3 preflight re-checks it on every parent start.
- Denying `kern.procargs*` also hides the child's own procargs; smoke confirms nothing needs it.
- Linux path (`unshare`) is unexercised today, and a fresh netns cannot reach the host loopback
  harness; noted, not fixed here.
- One shared change now reaches every adapter; mitigated by running all canaries per change.

## 11. Owner decisions

1. **A (`link:` package) or B (vendored + sync test)?** Recommend A.
2. **After AC4 passes on a clean C7, also adopt the key-file mode (§5.2) for third-party LLM runs,
   with `run-llm.sh` refusing an exported `ANTHROPIC_API_KEY`?** Recommend yes, as defence in
   depth: the SBPL rules are undocumented and the preflight only detects a regression. It is not
   a substitute: if C7 leaks, runs stay blocked whatever this answer (AC4).
3. **Deny the union of private folders for every adapter (D3)?** Recommend yes.
4. **Narrow the child's writable set to its fresh HOME only, with exec denied there, accepting
   canary/smoke-detected breakage as a fix-forward item?** Recommend yes.

## 12. Rev 2 changes (architecture-review-u35.md)

| Finding | Fixed in |
|---|---|
| M1 / C1 — tsx loader resolved from the shared package | §4 rules + API (`loader` required), §6 C9 loader realpath, §6 CI import test |
| M2 / C2 — denied paths joined onto the wrong HOME | §4 API (`deniedRoot` vs `childHome`), §6 C4 (a)/(b), §6 CI profile test |
| M3 / C3 — C9 could not pass; parent and bracket uncovered | §4 (`__modules` report), §6 C9 rewritten, bracket mode, no-copy test (AC1) |
| M4 / C4 — `/bin/ps` literal deny bypassed by a copy | §5 probes P4–P5, §5.1 sysctl deny primary, `process-info*` second, exec deny under `<childHome>`; §6 C8 |
| M5 / C5 — key file accepted as the control | §5.2 (refusals, no `process.env` copy), §5 P6, §7 AC4–AC5, §11 Q2 |
| m1 / C6 — bracket `link:` and lockfile | §4 option A, §6, §9 |
| m2 / C6 — coverage threshold | §6 CI |
| m3 / C6 — zero-deps not enforced | §4 rules, §6 CI |
| m4 / C6 — spend file `mktemp -t` | §5.5 |
| m5 / C6 — `TMPDIR` in env name checks | §4, §6 C6 |
| m6 / C7 — canary manual only | §5.3 runtime preflight |
| m7 / C7 — AC3 not measurable | §7 AC3 |
| m8 / C7 — raw probe output | §5 probe, §8 |
| m9 / C7 — Linux unverified | §5.1, §9 (ADR-029) |
| m10 — shell may export the key | §5.2, AC5 |
