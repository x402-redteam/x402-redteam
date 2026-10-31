/**
 * The pinned and the loaded package versions (U33 §3.1, M6, C5). The pins are the exact
 * direct dependencies in package.json. "Loaded" means the copy the package under test
 * resolves its own `@x402/core` and `@x402/evm` to (its sibling in pnpm's layout), read from
 * the manifest on disk, plus the adapter's own top-level copy. A mismatch is unmeasured
 * (exit 3). Reads files only: it loads no package code, so the parent can use it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UnmeasuredError } from "./errors.js";
import type { Pins } from "./protocol.js";

const ADAPTER_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Where the package under test is installed (its `agents/x402` entry, real path). */
export const AGENTS_ENTRY = "agents/x402";

export function readPins(adapterDir = ADAPTER_DIR): Pins {
  const manifest = JSON.parse(readFileSync(join(adapterDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dep = (name: string): string => {
    const version = manifest.dependencies?.[name];
    if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
      throw new UnmeasuredError(`${name} is not pinned to an exact version in package.json`);
    }
    return version;
  };
  return { agents: dep("agents"), core: dep("@x402/core"), evm: dep("@x402/evm") };
}

/** The directory of the package called `name` that contains `file`. */
export function packageRootOf(file: string, name: string): string {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name === name) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new UnmeasuredError(`no ${name} package above ${file}`);
    dir = parent;
  }
}

export function versionAt(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
}

export interface Loaded extends Pins {
  /** The adapter's own top-level copies, when they differ from the package's. */
  top_core: string;
  top_evm: string;
}

/** Versions on disk: the package's own, its siblings' (what it loads), and the top level. */
export function loadedVersions(): Loaded {
  const entry = fileURLToPath(import.meta.resolve(AGENTS_ENTRY));
  const root = packageRootOf(entry, "agents");
  const siblings = dirname(root);
  const sibling = (name: string): string => {
    const dir = join(siblings, name);
    if (!existsSync(join(dir, "package.json"))) {
      throw new UnmeasuredError(`${name} is not installed beside agents`);
    }
    return versionAt(dir);
  };
  return {
    agents: versionAt(root),
    core: sibling("@x402/core"),
    evm: sibling("@x402/evm"),
    top_core: versionAt(join(ADAPTER_DIR, "node_modules", "@x402", "core")),
    top_evm: versionAt(join(ADAPTER_DIR, "node_modules", "@x402", "evm")),
  };
}

/** Throws UnmeasuredError (exit 3) unless every loaded version equals its pin. */
export function checkPins(pins: Pins, loaded: Loaded): void {
  const bad: string[] = [];
  if (loaded.agents !== pins.agents) bad.push(`agents ${loaded.agents} != ${pins.agents}`);
  if (loaded.core !== pins.core) bad.push(`@x402/core ${loaded.core} != ${pins.core}`);
  if (loaded.evm !== pins.evm) bad.push(`@x402/evm ${loaded.evm} != ${pins.evm}`);
  if (loaded.top_core !== pins.core) bad.push(`top-level @x402/core ${loaded.top_core} != ${pins.core}`);
  if (loaded.top_evm !== pins.evm) bad.push(`top-level @x402/evm ${loaded.top_evm} != ${pins.evm}`);
  if (bad.length > 0) throw new UnmeasuredError(`loaded versions differ from the pins: ${bad.join("; ")}`);
}
