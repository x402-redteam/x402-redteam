/**
 * Provenance for every private result (U28 §2). The parent writes
 * `<dirname(X402_REDTEAM_TASK)>/../provenance.json` once per out dir, and a later run into
 * the same out dir must match it exactly. It holds only what is the same for every run
 * with one profile: the package version and integrity, the sha256 of its `dist/index.js`
 * (it is not patched), the viem version read from the bundle, the installed sibling
 * `@x402/*` and viem versions, the profile and every
 * option passed to `startProxy`. What differs per run (proxy port, catalog settling, the
 * balance stub, the request plan) goes in the run's notes (`notes.ts`).
 *
 * The parent reads these facts from files. It imports nothing from ClawRouter.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "./protocol.js";

/** The run could not measure what it set out to; it exits 3 so it scores as an agent
 * error, never as a pass. */
export class UnmeasuredError extends Error {}

/** The run was misconfigured; it exits 1. */
export class ConfigError extends Error {}

const ADAPTER_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface Provenance {
  package: string;
  version: string;
  /** From the lockfile in use. */
  integrity: string;
  /** sha256 of dist/index.js as installed: the build is unmodified. */
  dist_index_sha256: string;
  lockfile: string;
  lockfile_sha256: string;
  /** Versions read from constants inside dist/index.js itself (viem only; the @x402/*
   * packages carry no version constant in the bundle). */
  bundled_versions: Record<string, string>;
  /** Versions of the packages installed beside the bundle. They are not necessarily what
   * the bundle inlines. */
  installed_sibling_versions: Record<string, string>;
  profile: Profile;
  /** Every option passed to `startProxy`, with values taken from the task written as names. */
  start_proxy_options: Record<string, unknown>;
  cache: string;
}

/** The options the child passes (child.ts proxyOptions), described without per-run values. */
export function describeOptions(profile: Profile): Record<string, unknown> {
  const common = {
    wallet: "task.wallet.private_key",
    apiBase: "task.base_url",
    paymentChain: "base",
    port: "P (X402_CLAWROUTER_PORT, chosen by the parent per run)",
    allowExistingProxy: false,
    skipBalanceCheck: true,
    _balanceMonitorOverride: "stub reporting task.wallet_balance_usd as USDC",
    spendControl: "ObservingSpendControl on InMemorySpendControlStorage",
  };
  if (profile === "defaults") return { ...common, limits: "none (package defaults)" };
  return {
    ...common,
    limits: {
      session: "task.budget_usd",
      perRequest: "task.budget_usd",
      payee_policy: "none",
      network_policy: "none",
      asset_policy: "none",
    },
    maxCostPerRunUsd: "task.budget_usd",
    maxCostPerRunMode: "strict",
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

function readVersion(dir: string): string | undefined {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
}

export function buildProvenance(profile: Profile): Provenance {
  const entry = fileURLToPath(import.meta.resolve("@blockrun/clawrouter"));
  // dist/index.js -> package root (the real path, inside pnpm's store layout).
  const root = dirname(dirname(entry));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  if (manifest.name !== "@blockrun/clawrouter") {
    throw new UnmeasuredError(`unexpected package at ${root}: ${manifest.name}`);
  }
  const projectDir = root.split("/node_modules/")[0] ?? "";
  const lockText = readFileSync(join(projectDir, "pnpm-lock.yaml"), "utf8");
  const integrity = new RegExp(
    `'?@blockrun/clawrouter@${escapeRegExp(manifest.version)}'?:\\s*\\n\\s*resolution: \\{integrity: ([^,}\\s]+)`,
  ).exec(lockText)?.[1];
  if (!integrity) throw new UnmeasuredError("the package's integrity is not in the lockfile");

  // Siblings in pnpm's per-package node_modules: <store>/node_modules/@scope/name.
  const siblings = dirname(dirname(root));
  const sibling: Record<string, string> = {};
  for (const name of ["@x402/core", "@x402/evm", "@x402/fetch", "@x402/svm", "viem"]) {
    const version = readVersion(join(siblings, name));
    if (version) sibling[name] = version;
  }
  const distText = readFileSync(entry, "utf8");
  const viem = /node_modules\/viem\/_esm\/errors\/version\.js"\(\) \{\s*"use strict";\s*version2 = "([^"]+)"/.exec(
    distText,
  )?.[1];
  if (!viem) throw new UnmeasuredError("no viem version constant in dist/index.js");
  const bundled: Record<string, string> = { viem };
  return {
    package: manifest.name,
    version: manifest.version,
    integrity,
    dist_index_sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    lockfile: relative(ADAPTER_DIR, join(projectDir, "pnpm-lock.yaml")),
    lockfile_sha256: createHash("sha256").update(lockText).digest("hex"),
    bundled_versions: bundled,
    installed_sibling_versions: sibling,
    profile,
    start_proxy_options: describeOptions(profile),
    cache: "package default",
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
