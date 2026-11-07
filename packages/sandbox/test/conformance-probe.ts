/**
 * The shared conformance probe (U35 section 6). Run as the child by runConformance through
 * the same spawn the adapters use, with either layer switched off. Tries each egress path,
 * file rule and write once and writes the outcomes as one JSON line to fd 3. Parameters
 * arrive as JSON in argv[2] (not secret), never in the environment, so the child's
 * environment stays exactly what the spawn gave it.
 */
import childProcess from "node:child_process";
import dns from "node:dns";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { guardModules } from "../src/guard.js";

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
  code?: string;
  ms: number;
}

export interface ProbeParams {
  port: number;
  decoyV4: number;
  decoyV6: number;
  /** Files the child must not be able to read: name -> path. */
  denied: Record<string, string>;
  /** A file the child may read (the out dir's plain file). */
  allowedRead: string;
  outDir: string;
  spendFile: string;
  privateTmpFile: string;
  /** A random string that must appear in no environment value. */
  marker: string;
}

const params = JSON.parse(process.argv[2] ?? "{}") as ProbeParams;
const PUBLIC_HOST = "example.com";
const PUBLIC_IP = "93.184.215.14";
const TIMEOUT_MS = 8000;

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

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
      TIMEOUT_MS,
    );
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

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(`status ${res.statusCode}`);
    });
    req.on("error", reject);
  });
}

async function fetchStatus(url: string): Promise<string> {
  const res = await fetch(url);
  await res.arrayBuffer();
  return `status ${res.status}`;
}

const homeTmp = join(process.env.HOME ?? "", "tmp");

const probes: [string, () => Promise<string>][] = [
  ["public:fetch", () => fetchStatus(`https://${PUBLIC_HOST}/`)],
  ["public:fetch-ip", () => fetchStatus(`http://${PUBLIC_IP}/`)],
  ["public:http.get", () => httpGet(`http://${PUBLIC_HOST}/`)],
  ["public:net.connect", () => tcp(PUBLIC_HOST, 80)],
  ["public:net.connect-ip", () => tcp(PUBLIC_IP, 80)],
  ["public:dns.lookup", async () => (await dns.promises.lookup(PUBLIC_HOST)).address],
  ["decoy:v4", () => fetchStatus(`http://127.0.0.1:${params.decoyV4}/`)],
  ["decoy:v6", () => fetchStatus(`http://[::1]:${params.decoyV6}/`)],
  ["decoy:net.connect", () => tcp("127.0.0.1", params.decoyV4)],
  ["harness:v4", () => fetchStatus(`http://127.0.0.1:${params.port}/`)],
  ["harness:localhost", () => fetchStatus(`http://localhost:${params.port}/`)],
  ["harness:v6", () => fetchStatus(`http://[::1]:${params.port}/`)],
  ["file:read-allowed", async () => `${readFileSync(params.allowedRead, "utf8").length} bytes`],
  ...Object.entries(params.denied).map(([name, path]): [string, () => Promise<string>] => [
    `file:read-denied:${name}`,
    async () => `${readFileSync(path, "utf8").length} bytes`,
  ]),
  [
    "write:out",
    async () => {
      writeFileSync(join(params.outDir, "conf-write"), "x");
      return "written";
    },
  ],
  [
    "write:spend",
    async () => {
      writeFileSync(params.spendFile, "0");
      return "written";
    },
  ],
  [
    "write:private-tmp",
    async () => {
      writeFileSync(params.privateTmpFile, "x");
      return "written";
    },
  ],
  [
    "write:home-tmp",
    async () => {
      writeFileSync(join(homeTmp, "w"), "x");
      return "written";
    },
  ],
  [
    "exec:written",
    async () => {
      const script = join(homeTmp, "run.sh");
      writeFileSync(script, "#!/bin/sh\necho hi\n");
      chmodSync(script, 0o755);
      return childProcess.execFileSync(script, { encoding: "utf8" }).trim();
    },
  ],
  [
    "home:info",
    async () =>
      JSON.stringify({
        home: process.env.HOME,
        entries: readdirSync(process.env.HOME ?? "/nonexistent").sort(),
        tmpdir: process.env.TMPDIR,
        tmpExists: existsSync(homeTmp),
      }),
  ],
  ["env:names", async () => Object.keys(process.env).sort().join(",")],
  [
    "env:marker-in-values",
    async () => String(Object.values(process.env).some((v) => v?.includes(params.marker))),
  ],
  ["modules", async () => JSON.stringify(guardModules() ?? null)],
];

const results: ProbeResult[] = [];
for (const [name, run] of probes) {
  const start = performance.now();
  try {
    results.push({
      name,
      ok: true,
      detail: await withTimeout(run()),
      ms: performance.now() - start,
    });
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
