/**
 * OS sandbox launcher for third-party children (ADR-029 layer 1, U35). One implementation for
 * every adapter.
 *
 * - macOS: `sandbox-exec` with the profile from profile.ts.
 * - Linux: a fresh network namespace (`unshare -rn`) with loopback brought up. The process
 *   namespace flags are NOT used and the Linux M7 rows are unverified (m9).
 *
 * `spawnSandboxed` always gives the child a fresh HOME (`mkdtemp x402rt-<label>-home-`) with
 * `TMPDIR=<home>/tmp`; that is the only place it can write, and nothing there can be executed.
 * It refuses to start the child when no OS sandbox works, when the one-shot M7 / module
 * preflight fails, or when `deniedRoot` is not the parent's real home.
 */
import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./env.js";
import { PREFLIGHT_PROBES, type ProbeVerdict } from "./m7.js";
import { allowedPorts } from "./ports.js";
import { macosProfile, outDirOf, realOrSelf } from "./profile.js";
import { residualCovers } from "./residual.js";
import { readTaskFrom } from "./task.js";
import { TEST_ONLY, type TestOnly } from "./testing.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type SandboxKind = "sandbox-exec" | "unshare" | "none";

export interface PortConfig {
  /** Ports assigned to the child besides the harness's. */
  extra?: number[];
  /** Ports the child may never reach. */
  refused?: number[];
  /** The one port the child may bind and accept on. */
  listen?: number;
}

export interface SpawnOptions {
  /** Names the adapter in refusals and in the child's HOME. */
  label: string;
  /** Absolute path of the TypeScript entry point to run. */
  script: string;
  /** The adapter's own tsx loader: `import.meta.resolve("tsx")` in the adapter (M1). */
  loader: string;
  /** Absolute path of the adapter's guard entry (a file that calls installGuard). */
  guardEntry: string;
  /** The harness's task.json for this run; absent only for the profile probe. */
  taskPath?: string;
  /** The environment the child's is filtered from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Names copied from `env` besides the base names. */
  extraEnv?: string[];
  ports?: PortConfig;
  /** Extra `--import` specifiers before the loader (AgentKit's bracket resolve hook). */
  preImports?: string[];
  /** Arguments after the script. Not secret: visible to `ps`. */
  scriptArgs?: string[];
  /** Further private folders under the real home, per adapter. */
  extraDeniedHomePaths?: string[];
  /** Default true. Only the canary turns a layer off, to prove the other alone. */
  sandbox?: boolean;
  guard?: boolean;
  /** Default: stdout and stderr to our stderr, fd 3 a pipe for the JSON-lines channel. */
  stdio?: StdioOptions;
  /** Test-only switches behind a non-index symbol key (see testing.ts). */
  [TEST_ONLY]?: TestOnly;
}

export interface Spawned {
  proc: ChildProcess;
  /** The child's fresh HOME (a real path). */
  home: string;
  /** Removes the HOME. Safe to call twice. */
  dispose(): void;
}

let cachedKind: SandboxKind | undefined;

/** Which OS sandbox works on this machine, probed once by actually running it. */
export function detectSandbox(): SandboxKind {
  if (cachedKind !== undefined) return cachedKind;
  cachedKind = "none";
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    const probeHome = realOrSelf(tmpdir());
    const profile = macosProfile({
      deniedRoot: realOrSelf(homedir()),
      childHome: join(probeHome, "x402rt-detect"),
      ports: [],
      writable: [],
      readable: [],
    });
    const probe = spawnSync(SANDBOX_EXEC, ["-p", profile, "/usr/bin/true"], { stdio: "ignore" });
    if (probe.status === 0) cachedKind = "sandbox-exec";
  } else if (process.platform === "linux") {
    const probe = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
    if (probe.status === 0) cachedKind = "unshare";
  }
  return cachedKind;
}

/** Wraps `argv` so it runs inside the OS sandbox. */
export function sandboxArgv(kind: SandboxKind, argv: string[], profile: string): string[] {
  switch (kind) {
    case "sandbox-exec":
      return [SANDBOX_EXEC, "-p", profile, ...argv];
    case "unshare":
      return [
        "unshare",
        "-rn",
        "sh",
        "-c",
        '(ip link set lo up || ifconfig lo up) >/dev/null 2>&1; exec "$@"',
        "sh",
        ...argv,
      ];
    case "none":
      throw new Error("no OS sandbox available");
  }
}

/** The node argv for `script`: the deps hook, the adapter's tsx, then the guard, preloaded
 * before anything else. */
export function nodeArgv(opts: {
  script: string;
  loader: string;
  guardEntry: string;
  guard: boolean;
  preImports?: string[];
  scriptArgs?: string[];
}): string[] {
  return [
    process.execPath,
    ...(opts.preImports ?? []).flatMap((i) => ["--import", i]),
    "--import",
    opts.loader,
    ...(opts.guard ? ["--import", opts.guardEntry] : []),
    opts.script,
    ...(opts.scriptArgs ?? []),
  ];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Real paths of the modules the parent runs the boundary from (C9). */
export function parentModules(): { spawn: string; profile: string; guard: string; dir: string } {
  const real = (url: string): string => realOrSelf(fileURLToPath(url));
  return {
    spawn: real(import.meta.url),
    profile: real(new URL("./profile.ts", import.meta.url).href),
    guard: real(new URL("./guard.ts", import.meta.url).href),
    dir: realOrSelf(HERE),
  };
}

function loaderPath(loader: string): string {
  return realOrSelf(loader.startsWith("file:") ? fileURLToPath(loader) : loader);
}

/** The loader must come from the adapter's own pinned tree (M1), not the sandbox package. */
export function checkLoader(loader: string, guardEntry: string): string | undefined {
  const real = loaderPath(loader);
  const adapterRoot = dirname(dirname(realOrSelf(guardEntry)));
  if (!real.includes(`${sep}node_modules${sep}`))
    return `the loader ${real} is not under a node_modules`;
  if (!(real === adapterRoot || real.startsWith(adapterRoot + sep))) {
    return "the loader does not resolve inside the adapter's own tree";
  }
  return undefined;
}

type PreflightResult =
  | { ok: true; verdicts: ProbeVerdict[]; residual?: string[] }
  | { ok: false; reason: string };

let preflightVerdict: PreflightResult | undefined;

/** The environment variable that names an owner-recorded residual: `probes=P5`. It is honoured
 * only when its probe set exactly equals an `M7-residual:` entry the owner recorded in
 * decisions.md (residual.ts); a value with no such entry overrides nothing. */
export const RESIDUAL_ENV = "X402_M7_RESIDUAL";

const DECISIONS = join(HERE, "..", "..", "..", "aidlc-docs", "inception", "adr", "decisions.md");

function decisionsText(): string {
  try {
    return readFileSync(DECISIONS, "utf8");
  } catch {
    return "";
  }
}

/** The verdicts of the cached preflight, for provenance (probe ids and verdicts only). */
export function preflightReport(): ProbeVerdict[] | undefined {
  return preflightVerdict?.ok ? preflightVerdict.verdicts : undefined;
}

/**
 * One-shot, cached per parent process (m6): the loader and module checks (M1, C9) and the
 * M7 self-probe (P1, P4 with a fresh marker). Fails closed, so a macOS update that reopens
 * the environment read stops every third-party run.
 */
export function preflight(opts: { label: string; loader: string; guardEntry: string }): void {
  if (preflightVerdict === undefined) {
    preflightVerdict = runPreflight(opts);
    if (preflightVerdict.ok) {
      for (const v of preflightVerdict.verdicts) {
        if (v.notRun) {
          process.stderr.write(
            `sandbox preflight: ${v.id} not run on this machine (recorded as not run)\n`,
          );
        }
      }
      if (preflightVerdict.residual) {
        process.stderr.write(
          `sandbox preflight: running under an owner-recorded ADR-029 residual for ${preflightVerdict.residual.join(",")}\n`,
        );
      }
    }
  }
  if (!preflightVerdict.ok) {
    throw new Error(
      `refusing to start the ${opts.label} child: ${preflightVerdict.reason} (see ADR-029)`,
    );
  }
}

/** For tests: forget the cached preflight verdict. */
export function resetPreflightForTests(): void {
  preflightVerdict = undefined;
}

function runPreflight(opts: {
  label: string;
  loader: string;
  guardEntry: string;
}): PreflightResult {
  const loaderProblem = checkLoader(opts.loader, opts.guardEntry);
  if (loaderProblem) return { ok: false as const, reason: loaderProblem };
  const mods = parentModules();
  if (
    dirname(mods.profile) !== mods.dir ||
    dirname(mods.guard) !== mods.dir ||
    dirname(mods.spawn) !== mods.dir
  ) {
    return { ok: false as const, reason: "the sandbox modules do not come from one directory" };
  }
  if (process.platform !== "darwin") {
    // Linux (`unshare -rn`, /proc/<pid>/environ) is unverified and not claimed as a control.
    const entry = residualCovers(["LINUX"], process.env[RESIDUAL_ENV], decisionsText());
    if (entry) return { ok: true as const, verdicts: [], residual: ["LINUX"] };
    return {
      ok: false as const,
      reason: `the M7 controls are unverified on ${process.platform} (LINUX); third-party runs stay blocked unless the owner records an ADR-029 residual`,
    };
  }
  const launcher = join(HERE, "m7-launcher.ts");
  const marker = randomBytes(16).toString("hex");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      opts.loader,
      launcher,
      JSON.stringify({ label: opts.label, loader: opts.loader, probes: PREFLIGHT_PROBES }),
    ],
    {
      // The marker is in the launcher's exec environment on purpose; nothing else is.
      env: { PATH: process.env.PATH ?? "", X402_M7_SECRET: marker },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    return { ok: false as const, reason: "the M7 preflight could not run" };
  }
  let verdicts: ProbeVerdict[];
  try {
    verdicts = JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]") as ProbeVerdict[];
  } catch {
    return { ok: false as const, reason: "the M7 preflight returned no verdicts" };
  }
  if (verdicts.length === 0)
    return { ok: false as const, reason: "the M7 preflight returned no verdicts" };
  const leaked = verdicts.filter((v) => v.verdict === "leaked").map((v) => v.id);
  // A preflight probe that is missing from the reply, or reported "not run", is a problem too.
  const notRun = PREFLIGHT_PROBES.filter((id) => {
    const v = verdicts.find((x) => x.id === id);
    return v === undefined || v.notRun === true;
  }).map(String);
  const problems = [...leaked, ...notRun.filter((id) => !leaked.includes(id))];
  if (problems.length === 0) return { ok: true as const, verdicts };
  const entry = residualCovers(problems, process.env[RESIDUAL_ENV], decisionsText());
  if (entry) return { ok: true as const, verdicts, residual: problems };
  const parts = [
    ...(leaked.length > 0 ? [`leaked: ${leaked.join(",")}`] : []),
    ...(notRun.length > 0 ? [`not run: ${notRun.join(",")}`] : []),
  ];
  return {
    ok: false as const,
    reason: `the M7 preflight cannot show that other processes' environments are hidden (${parts.join("; ")}); third-party runs stay blocked unless the owner records an ADR-029 residual`,
  };
}

/** The test-only switches of `opts`; a look-alike key made with `Symbol.for` is ignored. */
export function testOnlyOf(opts: SpawnOptions): TestOnly | undefined {
  return opts[TEST_ONLY];
}

export function spawnSandboxed(opts: SpawnOptions): Spawned {
  const useSandbox = opts.sandbox ?? true;
  const realHome = realOrSelf(homedir());
  const testOnly = testOnlyOf(opts);
  const deniedRoot = testOnly?.deniedRoot ?? realHome;
  let kind: SandboxKind = "none";
  if (useSandbox) {
    kind = detectSandbox();
    if (kind === "none") {
      throw new Error(
        `refusing to start the ${opts.label} child: no OS sandbox works here ` +
          "(need macOS sandbox-exec or Linux unshare -rn), see ADR-029",
      );
    }
    if (!testOnly?.skipPreflight) preflight(opts);
  }

  const home = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `x402rt-${opts.label}-home-`)),
  );
  const childTmp = join(home, "tmp");
  mkdirSync(childTmp, { recursive: true, mode: 0o700 });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rmSync(home, { recursive: true, force: true });
  };

  try {
    const source = opts.env ?? process.env;
    const env = childEnv(
      {
        ...source,
        HOME: home,
        TMPDIR: childTmp,
        ...(opts.taskPath ? { X402_REDTEAM_TASK: opts.taskPath } : {}),
      },
      opts.extraEnv,
    );
    let argv = nodeArgv({
      script: opts.script,
      loader: opts.loader,
      guardEntry: opts.guardEntry,
      guard: opts.guard ?? true,
      ...(opts.preImports ? { preImports: opts.preImports } : {}),
      ...(opts.scriptArgs ? { scriptArgs: opts.scriptArgs } : {}),
    });
    if (useSandbox) {
      let baseUrl: string | undefined;
      if (opts.taskPath) {
        try {
          baseUrl = readTaskFrom(opts.taskPath).base_url;
        } catch {
          baseUrl = undefined;
        }
      }
      const outDir = opts.taskPath ? outDirOf(opts.taskPath) : undefined;
      const profile = macosProfile({
        deniedRoot,
        childHome: home,
        ports: allowedPorts(baseUrl, {
          extra: [
            ...(opts.ports?.extra ?? []),
            ...(opts.ports?.listen !== undefined ? [opts.ports.listen] : []),
          ],
          refused: opts.ports?.refused ?? [],
        }),
        ...(opts.ports?.listen !== undefined ? { listenPort: opts.ports.listen } : {}),
        writable: [home],
        readable: outDir ? [outDir] : [],
        ...(opts.extraDeniedHomePaths ? { extraDeniedHomePaths: opts.extraDeniedHomePaths } : {}),
      });
      argv = sandboxArgv(kind, argv, profile);
    }
    const [cmd, ...args] = argv as [string, ...string[]];
    const proc = spawn(cmd, args, { env, stdio: opts.stdio ?? ["ignore", 2, 2, "pipe"] });
    return { proc, home, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
