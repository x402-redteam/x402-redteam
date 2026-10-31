/**
 * OS sandbox launcher for the Cloudflare Agents SDK child (U25 §3.1 layer 1, U33 §3.1,
 * ADR-029). Copied from the ClawRouter adapter, not imported, and changed in two ways: the
 * network rule names one port (the harness's, nothing else; the child binds none), and the
 * payer's own private folder is denied instead of ClawRouter's.
 *
 * - macOS: `sandbox-exec` with a profile that allows everything except network, and
 *   allows outbound network only to localhost on the allowed ports. DNS is denied as a side effect (the
 *   resolver's mDNSResponder socket is network), which is why the guard resolves task
 *   hosts itself. The profile also denies reads of secrets under the home directory and
 *   of .env files, and allows writes only to the temp dir and the run's out dir.
 * - Linux: a fresh network namespace (`unshare -rn`) with loopback brought up.
 *
 * `spawnSandboxed` refuses to start the child when neither works.
 */
import { type ChildProcess, spawn, spawnSync, type StdioOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedPorts } from "./ports.js";
import { readTaskFrom } from "./task.js";

/** Secrets and private material under the user's home that the child may never read. */
export const DENIED_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".gnupg",
  ".npmrc",
  ".netrc",
  "x402-redteam-heldout",
  "x402-redteam-private",
  "x402-redteam-prepublish",
  "Library/Keychains",
  // The platform tooling's own login and key files live here when it runs as a user tool.
  ".wrangler",
];

export interface ProfileOptions {
  home: string;
  /** The loopback ports the child may reach (ports.ts allowedPorts). */
  ports: number[];
  /** Real paths the child may write to (temp dir, the run's out dir). */
  writable: string[];
  /** Real paths the child may read even inside a denied directory (the run's out dir). */
  readable: string[];
}

function sbString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function subpaths(paths: string[]): string {
  return paths.map((p) => `(subpath ${sbString(p)})`).join(" ");
}

/**
 * The macOS sandbox-exec profile. Verified on macOS 26 (Darwin 25): loopback connects
 * succeed, a public IP fails at connect() with EPERM, a public name fails to resolve,
 * reads under the denied paths and of any .env file fail with EPERM, and writes outside
 * the writable paths fail with EPERM. Later rules win, so the out dir is re-allowed.
 */
export function macosProfile(opts: ProfileOptions): string {
  const denied = subpaths(DENIED_HOME_PATHS.map((p) => join(opts.home, p)));
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...opts.ports.map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
    `(deny file-read* ${denied})`,
  ];
  if (opts.readable.length > 0) lines.push(`(allow file-read* ${subpaths(opts.readable)})`);
  // After the out-dir allow, so a .env file is denied there too.
  lines.push('(deny file-read* (regex #"/\\.(env(\\.[^/]*)?|dev\\.vars(\\.[^/]*)?)$"))');
  lines.push(
    `(deny file-write* (require-not (require-any ${subpaths(["/dev", ...opts.writable])})))`,
  );
  return lines.join("\n");
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The run's out dir: the harness writes task.json to `<out>/tasks/<run>.json`. */
export function outDirOf(taskPath: string): string {
  return realOrSelf(dirname(dirname(resolve(taskPath))));
}

/** The profile for a child of this task: temp dirs and the run's out dir writable, and
 * network only to the harness port (from the task's base_url). */
export function profileForTask(taskPath: string | undefined): string {
  const outDir = taskPath ? outDirOf(taskPath) : undefined;
  let baseUrl: string | undefined;
  if (taskPath) {
    try {
      baseUrl = readTaskFrom(taskPath).base_url;
    } catch {
      baseUrl = undefined;
    }
  }
  return macosProfile({
    home: homedir(),
    ports: allowedPorts(baseUrl),
    writable: [realOrSelf(tmpdir()), "/private/tmp", ...(outDir ? [outDir] : [])],
    readable: outDir ? [outDir] : [],
  });
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type SandboxKind = "sandbox-exec" | "unshare" | "none";

let cachedKind: SandboxKind | undefined;

/** Which OS sandbox works on this machine, probed once by actually running it. */
export function detectSandbox(): SandboxKind {
  if (cachedKind !== undefined) return cachedKind;
  cachedKind = "none";
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    const probe = spawnSync(SANDBOX_EXEC, ["-p", profileForTask(undefined), "/usr/bin/true"], {
      stdio: "ignore",
    });
    if (probe.status === 0) cachedKind = "sandbox-exec";
  } else if (process.platform === "linux") {
    const probe = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
    if (probe.status === 0) cachedKind = "unshare";
  }
  return cachedKind;
}

/** Wraps `argv` so it runs inside the OS sandbox. */
export function sandboxArgv(
  kind: SandboxKind,
  argv: string[],
  taskPath?: string,
): string[] {
  switch (kind) {
    case "sandbox-exec":
      return [SANDBOX_EXEC, "-p", profileForTask(taskPath), ...argv];
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

export interface SpawnSandboxedOptions {
  /** Absolute path of the TypeScript entry point to run. */
  script: string;
  env: Record<string, string>;
  /** Default true. Only the canary test turns a layer off, to prove the other alone. */
  sandbox?: boolean;
  guard?: boolean;
  /** Default: stdout and stderr to our stderr, fd 3 a pipe for the JSON-lines channel. */
  stdio?: StdioOptions;
}

const TSX_LOADER = import.meta.resolve("tsx");
const GUARD = fileURLToPath(new URL("./guard.ts", import.meta.url));

/** The node argv for `script`: our tsx, then the guard, preloaded before anything else. */
export function nodeArgv(script: string, guard: boolean): string[] {
  return [
    process.execPath,
    "--import",
    TSX_LOADER,
    ...(guard ? ["--import", GUARD] : []),
    script,
  ];
}

export function spawnSandboxed(opts: SpawnSandboxedOptions): ChildProcess {
  const useSandbox = opts.sandbox ?? true;
  let argv = nodeArgv(opts.script, opts.guard ?? true);
  if (useSandbox) {
    const kind = detectSandbox();
    if (kind === "none") {
      throw new Error(
        "refusing to start the Cloudflare child: no OS sandbox works here " +
          "(need macOS sandbox-exec or Linux unshare -rn), see ADR-029",
      );
    }
    argv = sandboxArgv(kind, argv, opts.env.X402_REDTEAM_TASK);
  }
  const [cmd, ...args] = argv as [string, ...string[]];
  return spawn(cmd, args, {
    env: opts.env,
    stdio: opts.stdio ?? ["ignore", 2, 2, "pipe"],
  });
}
