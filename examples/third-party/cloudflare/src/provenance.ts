/**
 * Provenance for every private result (U33 §3.1, M6). The parent writes
 * `<dirname(X402_REDTEAM_TASK)>/../provenance.json` once per out dir, and a later run into
 * the same out dir must match it exactly. It holds only what is the same for every run with
 * one profile: the pinned and the loaded versions, the lockfile integrity of the packages
 * that matter, the sha256 of the package's x402 entry files (it is not patched), and the
 * profile's settings. What differs per run (plan, calls) goes in the run's notes.
 *
 * The parent reads these facts from files. It loads no package code.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { UnmeasuredError } from "./errors.js";
import { describeProfile } from "./profiles.js";
import type { Pins, Profile } from "./protocol.js";
import { AGENTS_ENTRY, checkPins, loadedVersions, packageRootOf, versionAt } from "./versions.js";

const ADAPTER_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Packages whose lockfile integrity is recorded. */
const RECORDED = ["agents", "@x402/core", "@x402/evm", "@modelcontextprotocol/sdk", "viem"] as const;

export interface Provenance {
  package: string;
  version: string;
  pins: Pins;
  /** Versions read from disk: the package's own copies and the adapter's top level. */
  loaded: Record<string, string>;
  /** Lockfile integrity per recorded package. */
  integrity: Record<string, string>;
  /** sha256 of the package's x402 entry file and the module it imports. */
  dist_sha256: Record<string, string>;
  lockfile: string;
  lockfile_sha256: string;
  profile: Profile;
  profile_settings: Record<string, unknown>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The lockfile integrity of `name@version` (the first matching `packages:` entry). */
export function lockIntegrity(lockText: string, name: string, version: string): string | undefined {
  return new RegExp(
    `'?${escapeRegExp(name)}@${escapeRegExp(version)}'?:\\s*\\n\\s*resolution: \\{integrity: ([^,}\\s]+)`,
  ).exec(lockText)?.[1];
}

export function buildProvenance(
  profile: Profile,
  pins: Pins,
  opts: { adapterDir?: string } = {},
): Provenance {
  const adapterDir = opts.adapterDir ?? ADAPTER_DIR;
  const loaded = loadedVersions();
  checkPins(pins, loaded);

  const entry = fileURLToPath(import.meta.resolve(AGENTS_ENTRY));
  const root = packageRootOf(entry, "agents");
  const lockPath = join(adapterDir, "pnpm-lock.yaml");
  const lockText = readFileSync(lockPath, "utf8");

  const versions: Record<string, string> = {
    agents: loaded.agents,
    "@x402/core": loaded.core,
    "@x402/evm": loaded.evm,
    "@modelcontextprotocol/sdk": versionAt(join(adapterDir, "node_modules", "@modelcontextprotocol", "sdk")),
    viem: versionAt(join(adapterDir, "node_modules", "viem")),
  };
  const integrity: Record<string, string> = {};
  for (const name of RECORDED) {
    const found = lockIntegrity(lockText, name, versions[name] as string);
    if (!found) throw new UnmeasuredError(`${name}@${versions[name]} integrity is not in the lockfile`);
    integrity[name] = found;
  }

  // The entry file and the module it imports for the client wrapper.
  const entryText = readFileSync(entry, "utf8");
  const invoker = /from "\.\.\/\.\.\/(invoker-[A-Za-z0-9_-]+\.js)"/.exec(entryText)?.[1];
  const distRoot = join(root, "dist");
  const dist: Record<string, string> = { "dist/mcp/client/x402.js": sha256(entry) };
  if (invoker && existsSync(join(distRoot, invoker))) {
    dist[`dist/${invoker}`] = sha256(join(distRoot, invoker));
  } else {
    throw new UnmeasuredError("the package's invoker module was not found");
  }

  return {
    package: "agents",
    version: loaded.agents,
    pins,
    loaded: { ...versions, "top-level @x402/core": loaded.top_core, "top-level @x402/evm": loaded.top_evm },
    integrity,
    dist_sha256: dist,
    lockfile: relative(adapterDir, lockPath),
    lockfile_sha256: createHash("sha256").update(lockText).digest("hex"),
    profile,
    profile_settings: describeProfile(profile),
  };
}

/** Writes provenance.json next to the task's out dir, or checks it matches. */
export function recordProvenance(taskPath: string, provenance: Provenance): string {
  const path = join(dirname(taskPath), "..", "provenance.json");
  const text = `${JSON.stringify(provenance, null, 2)}\n`;
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
    if (readFileSync(path, "utf8") !== text) {
      throw new UnmeasuredError(`${path} records a different install or profile than this run`);
    }
  }
  return path;
}
