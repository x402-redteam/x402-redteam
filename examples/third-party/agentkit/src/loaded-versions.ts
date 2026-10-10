/**
 * Provenance (U25 §3.2): the versions of the packages the child actually loaded,
 * resolved from AgentKit's own location the way AgentKit's own require() resolves them.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LoadedPackage {
  version: string;
  /** Real path of the package root. */
  path: string;
}

export type LoadedVersions = Record<string, LoadedPackage>;

function packageRoot(entry: string, name: string): string {
  let dir = dirname(realpathSync(entry));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (json.name === name) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`no package.json for ${name} above ${entry}`);
}

function loaded(req: NodeJS.Require, name: string): LoadedPackage {
  let entry: string | undefined;
  for (const candidate of [`${name}/package.json`, name, `${name}/client`]) {
    try {
      entry = req.resolve(candidate);
      break;
    } catch {
      // Try the next entry point; exports maps differ between packages.
    }
  }
  if (!entry) throw new Error(`cannot resolve ${name}`);
  const root = packageRoot(entry, name);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  return { version, path: root };
}

/** `agentkitEntry` is the file `@coinbase/agentkit` resolves to from the child. */
export function loadedVersions(agentkitEntry: string): LoadedVersions {
  const agentkit = loaded(createRequire(agentkitEntry), "@coinbase/agentkit");
  const fromAgentkit = createRequire(join(agentkit.path, "package.json"));
  const fetch = loaded(fromAgentkit, "@x402/fetch");
  const fromFetch = createRequire(join(fetch.path, "package.json"));
  return {
    "@coinbase/agentkit": agentkit,
    "@x402/core": loaded(fromFetch, "@x402/core"),
    "@x402/fetch": fetch,
    "@x402/evm": loaded(fromAgentkit, "@x402/evm"),
    viem: loaded(fromAgentkit, "viem"),
  };
}

export function agentkitEntry(): string {
  return fileURLToPath(import.meta.resolve("@coinbase/agentkit"));
}
