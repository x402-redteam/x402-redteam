// Run inside the wrapper by canary.mjs. Prints one JSON object: probe name -> "ok" or an
// error code. Targets are only public names and IP literals, and the harness port.
import dns from "node:dns/promises";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const PORT = process.env.CANARY_HARNESS_PORT;
const code = (e) => e?.cause?.code ?? e?.code ?? String(e?.message ?? e);

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 });
    s.once("connect", () => (s.destroy(), resolve("ok")));
    s.once("timeout", () => (s.destroy(), resolve("TIMEOUT")));
    s.once("error", (e) => resolve(code(e)));
  });
}

/** Listen on a unix socket at `path`; "ok" when the OS allows it. */
function listen(path) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(code(e)));
    s.listen(path, () => {
      s.close();
      resolve("ok");
    });
  });
}

const attempt = async (fn) => {
  try {
    await fn();
    return "ok";
  } catch (e) {
    return code(e);
  }
};
const get = (url) =>
  attempt(() => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()));

const out = {
  "public:fetch": await get("http://example.com/"),
  "public:fetch-ip": await get("http://93.184.216.34/"),
  "public:dns": await attempt(() => dns.lookup("example.com")),
  "public:tcp-name": await tcp("example.com", 80),
  "public:tcp-ip": await tcp("93.184.216.34", 80),
  "harness:fetch-ip": await get(`http://127.0.0.1:${PORT}/`),
  "harness:fetch-localhost-name": await get(`http://provider.test.localhost:${PORT}/`),
  // A unix socket outside the run's temp dir is refused; one inside it works (tsx needs this).
  "unix:outside-run-dir": await listen(process.env.CANARY_OUTSIDE_SOCK),
  "unix:run-dir": await (async () => {
    const dir = join(process.env.TMPDIR, "probe");
    mkdirSync(dir, { recursive: true });
    return listen(join(dir, "p.sock"));
  })(),
  "harness:tcp": await tcp("127.0.0.1", Number(PORT)),
};
console.log(JSON.stringify(out));
