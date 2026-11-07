/**
 * Canary probe (U33 §3.1, C7, ADR-029 §4). Launched by canary.test.ts through the same
 * launcher as the Cloudflare child (sandbox.ts), with either layer switched off. Tries
 * every egress path and the sandbox's file rules once, and writes the outcomes as one
 * JSON line to fd 3.
 *
 * Public targets: example.com, by name and by IP literal, and the facilitator URL the
 * package names as its default. Task host: X402_CANARY_TASK_HOST on X402_CANARY_PORT (the
 * harness port). Decoy listeners, started by the test on random loopback ports, are probed
 * by X402_CANARY_DECOY_* variables.
 */
import childProcess from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import dns from "node:dns";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
  /** The error code (errno name, or curl's exit status), when the probe failed. */
  code?: string;
  ms: number;
}

const PUBLIC_HOST = "example.com";
/** The facilitator the package's server half names by default. */
const FACILITATOR_URL = "https://x402.org/facilitator";
/** An address example.com has served from, to probe connect() without DNS. */
const PUBLIC_IP = "93.184.215.14";
const TIMEOUT_MS = 8000;

const port = Number(process.env.X402_CANARY_PORT);
const decoyV4 = Number(process.env.X402_CANARY_DECOY_V4);
const decoyV6 = Number(process.env.X402_CANARY_DECOY_V6);
// The child's own HOME is fresh; the real home arrives as a canary setting.
const homeDir = process.env.X402_CANARY_REALHOME ?? homedir();
const taskHost = process.env.X402_CANARY_TASK_HOST ?? "provider.test.localhost";
const dotenvPath = process.env.X402_CANARY_DOTENV ?? "";
const devVarsPath = process.env.X402_CANARY_DEVVARS ?? "";
const outDir = process.env.X402_CANARY_OUT_DIR ?? "";

class ProbeError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ProbeError("timeout", "TIMEOUT")), TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function codeOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  if (code !== undefined && code !== null) return String(code);
  return err.cause === undefined ? undefined : codeOf(err.cause);
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (cause: ${errText(err.cause)})` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}

function tcp(host: string, p: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p, host);
    s.on("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.on("error", reject);
  });
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      res.resume();
      resolve(`status ${res.statusCode}`);
    });
    req.on("error", reject);
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(`status ${res.statusCode}`);
    });
    req.on("error", reject);
  });
}

/** WebSocket's error event carries no cause, so the probe watches every client socket
 * (Node's net.client.socket channel) to learn why the handshake's connection failed. */
let socketErrors: unknown[] = [];
diagnostics.subscribe("net.client.socket", (message) => {
  (message as { socket: net.Socket }).socket.on("error", (err) => socketErrors.push(err));
});

function websocket(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socketErrors = [];
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      ws.close();
      resolve("open");
    });
    ws.addEventListener("error", (ev) => {
      // The socket's own error can land just after the WebSocket's error event.
      setTimeout(() => {
        const inner = socketErrors[0] ?? (ev as { error?: unknown }).error;
        reject(new ProbeError(`websocket error: ${errText(inner)}`, codeOf(inner)));
      }, 100);
    });
  });
}

async function listenOnly(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.close();
  return "listening";
}

/** The guard's own allowlist, when the guard is preloaded. */
async function guardPorts(): Promise<number[] | null> {
  if (!process.env.X402_CANARY_GUARD) return null;
  const mod = (await import("../src/guard.js")) as { guardAllowedPorts: () => number[] };
  return mod.guardAllowedPorts();
}

function curl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile("/usr/bin/curl", ["-sS", "-m", "5", "-o", "/dev/null", url], (err) =>
      err ? reject(err) : resolve("curl exit 0"),
    );
  });
}

async function fetchStatus(url: string): Promise<string> {
  const res = await fetch(url);
  await res.arrayBuffer();
  return `status ${res.status}`;
}

const homeWriteProbe = join(homeDir, ".x402rt-canary-write-probe");

const probes: [string, () => Promise<string>][] = [
  ["env-has-anthropic-key", async () => String("ANTHROPIC_API_KEY" in process.env)],
  ["public:fetch", () => fetchStatus(`https://${PUBLIC_HOST}/`)],
  ["public:fetch-ip", () => fetchStatus(`http://${PUBLIC_IP}/`)],
  ["public:http.get", () => httpGet(`http://${PUBLIC_HOST}/`)],
  ["public:http.get-ip", () => httpGet(`http://${PUBLIC_IP}/`)],
  ["public:websocket", () => websocket(`wss://${PUBLIC_HOST}/`)],
  ["public:websocket-ip", () => websocket(`ws://${PUBLIC_IP}/`)],
  ["public:net.connect", () => tcp(PUBLIC_HOST, 80)],
  ["public:net.connect-ip", () => tcp(PUBLIC_IP, 80)],
  ["public:curl", () => curl(`https://${PUBLIC_HOST}/`)],
  ["public:curl-ip", () => curl(`http://${PUBLIC_IP}/`)],
  ["public:dns.lookup", async () => (await dns.promises.lookup(PUBLIC_HOST)).address],
  // The default facilitator the package names (C7): refused like any public endpoint.
  ["default-endpoint:facilitator", () => fetchStatus(FACILITATOR_URL)],
  ["default-endpoint:facilitator-supported", () => fetchStatus(`${FACILITATOR_URL}/supported`)],
  ["default-endpoint:facilitator-https.get", () => httpsGet(FACILITATOR_URL)],
  ["default-endpoint:facilitator-net.connect", () => tcp("x402.org", 443)],
  ["loopback:fetch-ip", () => fetchStatus(`http://127.0.0.1:${port}/`)],
  ["loopback:fetch-localhost", () => fetchStatus(`http://localhost:${port}/`)],
  // The child binds no port of its own: a listener of any kind is refused.
  ["listen:any-port", () => listenOnly()],
  // Decoys: listeners the test owns. Every one must be refused before a connection lands.
  ["harness-port:v6", () => fetchStatus(`http://[::1]:${port}/`)],
  ["decoy:random-v4", () => fetchStatus(`http://127.0.0.1:${decoyV4}/`)],
  ["decoy:random-v6", () => fetchStatus(`http://[::1]:${decoyV6}/`)],
  ["decoy:random-localhost-name", () => fetchStatus(`http://decoy.localhost:${decoyV4}/`)],
  ["decoy:random-net.connect", () => tcp("127.0.0.1", decoyV4)],
  ["decoy:random-http.get", () => httpGet(`http://127.0.0.1:${decoyV4}/`)],
  ["task:dns.lookup", async () => (await dns.promises.lookup(taskHost)).address],
  ["task:fetch", () => fetchStatus(`http://${taskHost}:${port}/`)],
  ["task:http.get", () => httpGet(`http://${taskHost}:${port}/`)],
  ["file:read-ssh", async () => `${readdirSync(join(homeDir, ".ssh")).length} entries`],
  ["file:read-dotenv", async () => `${readFileSync(dotenvPath, "utf8").length} bytes`],
  ["file:read-wrangler", async () => `${readdirSync(join(homeDir, ".wrangler")).length} entries`],
  ["file:read-dev-vars", async () => `${readFileSync(devVarsPath, "utf8").length} bytes`],
  ["env:names", async () => Object.keys(process.env).sort().join(",")],
  ["guard:ports", async () => JSON.stringify(await guardPorts())],
  [
    "file:write-home",
    async () => {
      writeFileSync(homeWriteProbe, "x");
      rmSync(homeWriteProbe, { force: true });
      return "written";
    },
  ],
  [
    "file:write-out",
    async () => {
      writeFileSync(join(outDir, "write-probe"), "x");
      return "written";
    },
  ],
];

async function main(): Promise<void> {
  const results: ProbeResult[] = [];
  for (const [name, run] of probes) {
    const start = performance.now();
    try {
      const detail = await withTimeout(run());
      results.push({ name, ok: true, detail, ms: performance.now() - start });
    } catch (err) {
      results.push({
        name,
        ok: false,
        detail: errText(err),
        code: codeOf(err),
        ms: performance.now() - start,
      });
    }
  }
  const channel = new net.Socket({ fd: 3, readable: false, writable: true });
  channel.end(`${JSON.stringify(results)}\n`, () => process.exit(0));
}

void main();
