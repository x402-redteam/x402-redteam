#!/usr/bin/env node
/**
 * Network-deny launcher for first-party clients during fuzz runs (U29-00, ADR-029 3b).
 *
 *   x402-redteam run --agent "node examples/fuzz-sandbox/run.mjs <cmd> [args...]"
 *
 * Runs <cmd> under an OS network-deny layer that lets it connect only to the harness's own
 * loopback port, taken from `base_url` in the task file named by X402_REDTEAM_TASK. It
 * does not change what <cmd> does; a normal run simply does not use this wrapper.
 * Copied in approach from examples/third-party/clawrouter/src/sandbox.ts (not imported).
 *
 * - macOS: `sandbox-exec` with `(deny network*)` plus an allow for localhost:<port>.
 *   DNS is denied too (the resolver is a network socket), so `dns-shim.mjs` (Node) and
 *   `pyshim/sitecustomize.py` (Python) resolve `*.localhost` to 127.0.0.1 in-process.
 *   Every other name still fails to resolve, and an IP literal fails at connect().
 * - Linux: unsupported for now (detectSandbox returns "none"); see README.md.
 *
 * It refuses to start (exit 2) when no sandbox works, the harness port is unknown, or the
 * task uses host_mode "proxy".
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The port of a task's base_url, or undefined when the URL is unusable. */
export function harnessPort(baseUrl) {
  if (typeof baseUrl !== "string") return undefined;
  try {
    const url = new URL(baseUrl);
    // An explicit empty port ("http://host:") is refused, not read as the scheme default.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:(?=$|[/?#])/i.test(baseUrl)) return undefined;
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function sbString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A fresh private temp dir for one run, as a real path (the sandbox matches real paths). */
export function makeRunDir() {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fz-")));
}

/**
 * The macOS profile: everything allowed except network, then loopback to `port` only.
 * Unix sockets stay denied except under the run's own temp dir `runDir` (the `tsx` CLI
 * listens on one there). Mach service lookups are denied too: that closes the system
 * resolver (mDNSResponder) and other IPC daemons; Node, tsx and Python run without them
 * (verified by the canary).
 */
export function macosProfile(port, runDir) {
  const sockets = [
    `(allow network-bind network-inbound (local unix-socket (subpath ${sbString(runDir)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${sbString(runDir)})))`,
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny mach-lookup)",
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    ...sockets,
  ].join("\n");
}

/**
 * Which OS sandbox works here, probed by running it: "sandbox-exec" or "none". Linux is
 * "none" on purpose: `unshare -rn` gives a fresh network namespace whose loopback is not the
 * host's, so the harness port would be unreachable. It returns later, after a Linux canary
 * passes with a way to reach the harness port.
 */
export function detectSandbox() {
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    const p = spawnSync(SANDBOX_EXEC, ["-p", macosProfile(1, "/var/empty"), "/usr/bin/true"], {
      stdio: "ignore",
    });
    return p.status === 0 ? "sandbox-exec" : "none";
  }
  return "none";
}

/** `argv` wrapped to run inside the sandbox `kind`, with unix sockets confined to `runDir`. */
export function sandboxArgv(kind, port, argv, runDir) {
  if (kind === "sandbox-exec") return [SANDBOX_EXEC, "-p", macosProfile(port, runDir), ...argv];
  throw new Error("no OS sandbox available");
}

/** The child's environment: the shims that resolve `*.localhost` without the OS resolver. */
export function shimEnv(env, runDir) {
  const nodeOpt = `--import ${pathToFileURL(join(HERE, "dns-shim.mjs")).href}`;
  return {
    ...env,
    ...(runDir ? { TMPDIR: runDir, TMP: runDir, TEMP: runDir } : {}),
    // The shim dir is read-only to us; do not leave bytecode (with local paths) in it.
    PYTHONDONTWRITEBYTECODE: "1",
    NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${nodeOpt}` : nodeOpt,
    PYTHONPATH: env.PYTHONPATH
      ? `${join(HERE, "pyshim")}${delimiter}${env.PYTHONPATH}`
      : join(HERE, "pyshim"),
  };
}

function refuse(message) {
  console.error(`fuzz-sandbox: refusing to start: ${message}`);
  return 2;
}

function main(argv, env) {
  if (argv.length === 0) return refuse("usage: run.mjs <cmd> [args...]");
  const kind = detectSandbox();
  if (kind === "none") {
    return refuse("no OS sandbox works here (macOS sandbox-exec only; Linux is unsupported)");
  }
  const taskPath = env.X402_REDTEAM_TASK;
  if (!taskPath) return refuse("X402_REDTEAM_TASK is not set, so the harness port is unknown");
  let task;
  try {
    task = JSON.parse(readFileSync(taskPath, "utf8"));
  } catch {
    return refuse(`cannot read ${taskPath}`);
  }
  // Proxy host mode sends requests through HTTP_PROXY to names that no in-process shim can
  // map to the harness, and base_url is then not the port the client dials.
  if (task.host_mode === "proxy") {
    return refuse('host_mode "proxy" is not supported; use "localhost" or "path"');
  }
  const port = harnessPort(task.base_url);
  if (port === undefined) return refuse(`no usable base_url in ${taskPath}`);

  const runDir = makeRunDir();
  const cleanup = () => rmSync(runDir, { recursive: true, force: true });
  const [cmd, ...args] = sandboxArgv(kind, port, argv, runDir);
  const child = spawn(cmd, args, { env: shimEnv(env, runDir), stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("error", (err) => {
    cleanup();
    console.error(`fuzz-sandbox: ${err.message}`);
    process.exit(2);
  });
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(code ?? (signal ? 128 : 1));
  });
  return undefined;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = main(process.argv.slice(2), process.env);
  if (code !== undefined) process.exit(code);
}
