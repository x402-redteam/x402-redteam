/**
 * Provenance for every private result (U25 §3.2). The parent writes
 * `<dirname(X402_REDTEAM_TASK)>/../provenance.json` once per out dir: the versions the
 * child actually loaded, AgentKit's integrity from the lockfile in use, that lockfile's
 * sha256 and the mode. A later run into the same out dir must match it exactly.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedVersions } from "./loaded-versions.js";

/** The run could not measure what it set out to; it exits 3 so it scores as an agent
 * error, never as a pass. */
export class UnmeasuredError extends Error {}

const ADAPTER_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface Provenance {
  mode: string;
  /** Relative to the adapter directory: pnpm-lock.yaml or bracket-2.0.0/pnpm-lock.yaml. */
  lockfile: string;
  lockfile_sha256: string;
  agentkit_integrity: string;
  /** The @x402/core version that lockfile's pnpm-workspace.yaml pins through overrides. */
  x402_override: string;
  versions: Record<string, string>;
}

export function buildProvenance(mode: string, loaded: LoadedVersions): Provenance {
  const agentkit = loaded["@coinbase/agentkit"];
  const core = loaded["@x402/core"];
  if (!agentkit || !core) throw new UnmeasuredError("child reported no AgentKit provenance");
  // pnpm keeps every package under <project>/node_modules/.pnpm/, so the project whose
  // lockfile is in use is the part of the path before the first node_modules.
  const projectDir = agentkit.path.split("/node_modules/")[0] ?? "";
  const lockText = readFileSync(join(projectDir, "pnpm-lock.yaml"), "utf8");
  const workspace = readFileSync(join(projectDir, "pnpm-workspace.yaml"), "utf8");

  const integrity = new RegExp(
    `'?@coinbase/agentkit@${agentkit.version.replace(/\./g, "\\.")}'?:\\s*\\n\\s*resolution: \\{integrity: ([^,}\\s]+)`,
  ).exec(lockText)?.[1];
  const override = /"@x402\/core":\s*([0-9.]+)/.exec(workspace)?.[1];
  if (!integrity) throw new UnmeasuredError("AgentKit's integrity is not in the lockfile");
  if (!override) throw new UnmeasuredError("no @x402/core override in pnpm-workspace.yaml");
  if (core.version !== override) {
    throw new UnmeasuredError(
      `loaded @x402/core ${core.version} but ${relative(ADAPTER_DIR, projectDir) || "."} pins ${override}`,
    );
  }

  const versions: Record<string, string> = {};
  for (const name of Object.keys(loaded).sort()) {
    versions[name] = (loaded[name] as { version: string }).version;
  }
  return {
    mode,
    lockfile: relative(ADAPTER_DIR, join(projectDir, "pnpm-lock.yaml")),
    lockfile_sha256: createHash("sha256").update(lockText).digest("hex"),
    agentkit_integrity: integrity,
    x402_override: override,
    versions,
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
      throw new UnmeasuredError(`${path} records a different install or mode than this run`);
    }
  }
  return path;
}
