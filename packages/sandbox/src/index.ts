/**
 * @x402-redteam/sandbox: the shared ADR-029 boundary for running third-party code (U35).
 * Zero runtime dependencies; imports only `node:` built-ins and relative files, so it never
 * resolves a bare specifier from the wrong tree (M1).
 *
 * `installGuard` (the preloaded layer) lives in `./guard`, imported by the adapter's own
 * guard entry, so a parent that only spawns never loads it.
 */
export { BASE_ENV_NAMES, childEnv } from "./env.js";
export { KEY_FILE_ENV, KeyFileError, readKeyFile, resolveAnthropicKey } from "./keyfile.js";
export type { Marker, ProbeVerdict, Verdict } from "./m7.js";
export { allowedPorts, harnessPort, parsePort, portOfUrl } from "./ports.js";
export {
  DENIED_HOME_PATHS,
  macosProfile,
  outDirOf,
  type ProfileOptions,
} from "./profile.js";
export {
  checkLoader,
  detectSandbox,
  nodeArgv,
  type PortConfig,
  parentModules,
  preflight,
  preflightReport,
  RESIDUAL_ENV,
  type SandboxKind,
  type Spawned,
  type SpawnOptions,
  sandboxArgv,
  spawnSandboxed,
} from "./spawn.js";
export { makeTargetPolicy, type Stub, stubMatches } from "./target.js";
export { readTask, readTaskFrom, type TaskFile, taskHostnames, taskUrls } from "./task.js";
