/**
 * The macOS sandbox-exec profile (ADR-029 layer 1, U35). Pure: it builds text from its
 * inputs and touches no process. The profile allows everything except:
 *  - network: outbound only to localhost on the listed ports (and bind/inbound on one
 *    listen port); DNS is denied as a side effect, which is why the guard resolves task
 *    hosts itself;
 *  - reads of private folders under `deniedRoot` (the parent's real home, never the child's
 *    fresh HOME, M2) and of .env / .dev.vars files;
 *  - writes anywhere but /dev and the listed writable paths (the child's own HOME only);
 *  - reading other processes' environments (M7): the `kern.procargs2` sysctl `ps -E` uses,
 *    and other processes' `proc_info`;
 *  - executing anything under the child's HOME, so the one writable area cannot hold programs.
 * Later rules win, so the out dir is re-allowed for reading after the private folders.
 */
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Secrets and private material under the user's home that no child may read (union of the
 * three adapters' former lists, U35 D3). */
export const DENIED_HOME_PATHS: readonly string[] = [
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
  // Adapter-specific private folders.
  ".openclaw",
  ".blockrun",
  ".wrangler",
];

export interface ProfileOptions {
  /** The parent's real home (`os.homedir()`); the private folders are joined onto this. */
  deniedRoot: string;
  /** The child's fresh HOME (real path). Exec is denied under it. Never used for denial. */
  childHome: string;
  /** The loopback ports the child may reach (ports.ts allowedPorts). */
  ports: number[];
  /** The one port the child may also bind and accept on, if any. */
  listenPort?: number;
  /** Real paths the child may write to: its own HOME only. */
  writable: string[];
  /** Real paths the child may read even inside a denied directory (the run's out dir). */
  readable: string[];
  /** Further private folders under `deniedRoot`, per adapter. */
  extraDeniedHomePaths?: string[];
}

export function sbString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function subpaths(paths: readonly string[]): string {
  return paths.map((p) => `(subpath ${sbString(p)})`).join(" ");
}

/** The sandbox-exec profile text. */
export function macosProfile(opts: ProfileOptions): string {
  const folders = [...DENIED_HOME_PATHS, ...(opts.extraDeniedHomePaths ?? [])];
  const denied = subpaths(folders.map((p) => join(opts.deniedRoot, p)));
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...opts.ports.map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
    ...(opts.listenPort !== undefined
      ? [
          `(allow network-bind (local ip "localhost:${opts.listenPort}"))`,
          `(allow network-inbound (local ip "localhost:${opts.listenPort}"))`,
        ]
      : []),
    `(deny file-read* ${denied})`,
  ];
  if (opts.readable.length > 0) lines.push(`(allow file-read* ${subpaths(opts.readable)})`);
  // After the out-dir allow, so a secret file is denied there too.
  lines.push('(deny file-read* (regex #"/\\.(env(\\.[^/]*)?|dev\\.vars(\\.[^/]*)?)$"))');
  lines.push(
    `(deny file-write* (require-not (require-any ${subpaths(["/dev", ...opts.writable])})))`,
  );
  // M7: other processes' environments. `ps -E` reads them through kern.procargs2, and a
  // same-uid read needs no setuid, so the sysctl is the primary control.
  lines.push('(deny sysctl-read (sysctl-name "kern.procargs2") (sysctl-name "kern.procargs"))');
  lines.push("(deny process-info* (target others))");
  // The only writable area cannot hold programs (a copied setuid binary loses nothing it needs).
  lines.push(`(deny process-exec* (subpath ${sbString(opts.childHome)}))`);
  return lines.join("\n");
}

export function realOrSelf(path: string): string {
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
