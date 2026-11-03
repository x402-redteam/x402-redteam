/**
 * The conformance canary (U35 section 6): C1-C9 plus the M7 probes, run from each adapter's
 * own canary test with its config and its real loader and guard entry. Offline; macOS needs a
 * working sandbox-exec and a machine without one FAILS, never skips. Verdicts only: no probe
 * output, other process's environment or secret is ever printed or stored (m8).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BASE_ENV_NAMES } from "../src/env.js";
import type { GuardModules } from "../src/guard.js";
import type { ProbeVerdict } from "../src/m7.js";
import { DENIED_HOME_PATHS } from "../src/profile.js";
import {
  detectSandbox,
  type PortConfig,
  parentModules,
  RESIDUAL_ENV,
  spawnSandboxed,
} from "../src/spawn.js";
import { TEST_ONLY } from "../src/testing.js";
import type { ProbeParams, ProbeResult } from "./conformance-probe.js";

const PROBE = fileURLToPath(new URL("./conformance-probe.ts", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("../src/m7-launcher.ts", import.meta.url));
const SANDBOX_SRC = realpathSync(fileURLToPath(new URL("../src/", import.meta.url)));

export interface ConformanceAdapter {
  label: string;
  /** Absolute path of the adapter directory (the bracket install lives inside AgentKit's). */
  adapterRoot: string;
  /** Absolute path of the adapter's guard entry. */
  guardEntry: string;
  /** The adapter's own tsx: `import.meta.resolve("tsx")` from the adapter. */
  loader: string;
  preImports?: string[];
  /** Adapter-specific extras (for example a proxy port), evaluated once with a free port. */
  extra?: (freePort: number) => {
    env?: Record<string, string>;
    extraEnv?: string[];
    ports?: PortConfig;
  };
}

type Layers = { sandbox: boolean; guard: boolean };

const PUBLIC = [
  "public:fetch",
  "public:fetch-ip",
  "public:http.get",
  "public:net.connect",
  "public:net.connect-ip",
  "public:dns.lookup",
];
const DECOYS = ["decoy:v4", "decoy:v6", "decoy:net.connect"];
const FAST_MS = 1500;
const rand = (): string => randomBytes(16).toString("hex");

export function runConformance(adapter: ConformanceAdapter): void {
  describe(`${adapter.label} sandbox conformance (U35 C1-C9)`, { timeout: 240_000 }, () => {
    let server: Server;
    let dir: string;
    let taskPath: string;
    let port: number;
    let freePort: number;
    let decoyServers: Server[] = [];
    let decoyConnections = 0;
    let decoyV4 = 0;
    let decoyV6 = 0;
    const marker = rand();
    const realHome = realpathSync(homedir());
    const created: string[] = [];
    let createdPrivateParent: string | undefined;
    let privateDir: string;
    let privateFile: string;
    let fakeRoot: string;
    let spendStandIn: string;
    let privateTmpFile: string;
    const extras = () => adapter.extra?.(freePort) ?? {};

    async function listen(host: string): Promise<Server> {
      const s = createServer((_req, res) => res.end("decoy"));
      s.on("connection", () => {
        decoyConnections += 1;
      });
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(0, host, resolve);
      });
      return s;
    }

    before(async () => {
      server = createServer((_req, res) => res.end("canary-ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      freePort = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const v4 = await listen("127.0.0.1");
      const v6 = await listen("::1");
      decoyServers = [v4, v6];
      decoyV4 = (v4.address() as AddressInfo).port;
      decoyV6 = (v6.address() as AddressInfo).port;

      dir = realpathSync(mkdtempSync(join(tmpdir(), `x402rt-conf-${adapter.label}-`)));
      mkdirSync(join(dir, "tasks"));
      taskPath = join(dir, "tasks", "conf.json");
      writeFileSync(
        taskPath,
        JSON.stringify({ version: 4, run_id: "conf", base_url: `http://127.0.0.1:${port}` }),
      );
      writeFileSync(join(dir, "plain.txt"), "fine");
      writeFileSync(join(dir, ".env"), "CANARY=1\n");
      writeFileSync(join(dir, ".dev.vars"), "CANARY=1\n");

      // C4(a): a stand-in root holding every denied folder.
      // Outside the out dir, which the profile re-allows for reading after the denials.
      fakeRoot = realpathSync(
        mkdtempSync(join(realpathSync(tmpdir()), `x402rt-conf-root-${adapter.label}-`)),
      );
      created.push(fakeRoot);
      for (const p of DENIED_HOME_PATHS) {
        mkdirSync(join(fakeRoot, p), { recursive: true });
        writeFileSync(join(fakeRoot, p, "secret"), "secret");
      }
      writeFileSync(join(fakeRoot, "plain.txt"), "fine");

      // C4(b): one throwaway file in a new, uniquely named subdir of the real private folder,
      // removed in `after`. Nothing else in that folder is listed or read (D3).
      const privateRoot = join(realHome, "x402-redteam-private");
      if (!existsSync(privateRoot)) {
        mkdirSync(privateRoot, { mode: 0o700 });
        createdPrivateParent = privateRoot;
      }
      privateDir = join(privateRoot, `conf-${rand()}`);
      mkdirSync(privateDir);
      privateFile = join(privateDir, "f");
      writeFileSync(privateFile, "x");

      spendStandIn = join(realpathSync(tmpdir()), `x402-conf-spend-${rand()}`);
      writeFileSync(spendStandIn, "0");
      created.push(spendStandIn);
      privateTmpFile = `/private/tmp/x402-conf-${rand()}`;
    });

    after(() => {
      server.close();
      for (const s of decoyServers) s.close();
      rmSync(dir, { recursive: true, force: true });
      for (const f of created) rmSync(f, { recursive: true, force: true });
      rmSync(privateTmpFile, { force: true });
      try {
        rmSync(privateDir, { recursive: true, force: true });
        if (createdPrivateParent) rmdirSync(createdPrivateParent);
      } catch {
        // Left in place if something else was put there meanwhile.
      }
    });

    function params(over: Partial<ProbeParams> = {}): ProbeParams {
      return {
        port,
        decoyV4,
        decoyV6,
        denied: {
          dotenv: join(dir, ".env"),
          devvars: join(dir, ".dev.vars"),
          realPrivate: privateFile,
        },
        allowedRead: join(dir, "plain.txt"),
        outDir: dir,
        spendFile: spendStandIn,
        privateTmpFile,
        marker,
        ...over,
      };
    }

    async function runProbe(
      layers: Layers,
      over: Partial<ProbeParams> = {},
      testOnly?: { deniedRoot: string },
    ): Promise<{
      results: Map<string, ProbeResult>;
      stderr: string;
      home: string;
      dispose(): void;
    }> {
      const x = extras();
      const spawned = spawnSandboxed({
        label: adapter.label,
        script: PROBE,
        scriptArgs: [JSON.stringify(params(over))],
        loader: adapter.loader,
        guardEntry: adapter.guardEntry,
        taskPath,
        env: {
          ...process.env,
          ...x.env,
          ANTHROPIC_API_KEY: `sk-conformance-${marker}`,
          HTTPS_PROXY: "http://127.0.0.1:1",
          NODE_OPTIONS: "--require evil",
        },
        ...(x.extraEnv ? { extraEnv: x.extraEnv } : {}),
        ...(x.ports ? { ports: x.ports } : {}),
        ...(adapter.preImports ? { preImports: adapter.preImports } : {}),
        sandbox: layers.sandbox,
        guard: layers.guard,
        // The layers are what is under test; the runtime preflight has its own case below.
        [TEST_ONLY]: { skipPreflight: true, ...(testOnly ?? {}) },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      let out = "";
      let stderr = "";
      (spawned.proc.stdio[3] as NodeJS.ReadableStream).on("data", (d) => {
        out += d;
      });
      spawned.proc.stdout?.on("data", (d) => {
        stderr += d;
      });
      spawned.proc.stderr?.on("data", (d) => {
        stderr += d;
      });
      const code = await new Promise<number | null>((resolve) => spawned.proc.on("close", resolve));
      assert.equal(code, 0, `probe exited ${code}`);
      const list = JSON.parse(out) as ProbeResult[];
      return {
        results: new Map(list.map((r) => [r.name, r])),
        stderr,
        home: spawned.home,
        dispose: spawned.dispose,
      };
    }

    const get = (results: Map<string, ProbeResult>, name: string): ProbeResult => {
      const r = results.get(name);
      assert.ok(r, `missing probe ${name}`);
      return r;
    };

    it("C1: a working OS sandbox exists on this machine (fails, never skips)", () => {
      assert.notEqual(detectSandbox(), "none");
    });

    it("C2/C3: OS layer alone, guard alone, and both refuse public egress and decoys; the harness port connects", async () => {
      const before = decoyConnections;
      const os = await runProbe({ sandbox: true, guard: false });
      for (const name of [...PUBLIC, ...DECOYS]) {
        const r = get(os.results, name);
        assert.equal(r.ok, false, `${name} got through the OS layer`);
        assert.doesNotMatch(r.detail, /EGRESS_BLOCKED/, `${name} was refused by the guard`);
        assert.ok(r.ms < FAST_MS, `${name} took ${r.ms} ms`);
      }
      assert.equal(get(os.results, "harness:v4").detail, "status 200");
      os.dispose();

      const guard = await runProbe({ sandbox: false, guard: true });
      for (const name of [...PUBLIC, ...DECOYS, "harness:v6"]) {
        const r = get(guard.results, name);
        assert.equal(r.ok, false, `${name} got through the guard`);
        assert.match(r.detail, /EGRESS_BLOCKED/, name);
      }
      assert.equal(get(guard.results, "harness:v4").detail, "status 200");
      assert.equal(get(guard.results, "harness:localhost").detail, "status 200");
      guard.dispose();

      const both = await runProbe({ sandbox: true, guard: true });
      for (const name of [...PUBLIC, ...DECOYS, "harness:v6"]) {
        assert.equal(get(both.results, name).ok, false, name);
      }
      assert.equal(get(both.results, "harness:v4").detail, "status 200");
      both.dispose();
      assert.equal(decoyConnections, before, "a decoy accepted a connection");
    });

    it("C4(a): the union of denied folders is unreadable under a stand-in deniedRoot while HOME is fresh", async () => {
      const denied: Record<string, string> = { plainControl: join(fakeRoot, "plain.txt") };
      for (const p of DENIED_HOME_PATHS) denied[p] = join(fakeRoot, p, "secret");
      const run = await runProbe(
        { sandbox: true, guard: false },
        { denied },
        { deniedRoot: fakeRoot },
      );
      for (const p of DENIED_HOME_PATHS) {
        const r = get(run.results, `file:read-denied:${p}`);
        assert.equal(r.ok, false, `${p} was readable`);
        assert.equal(r.code, "EPERM", p);
      }
      // The fresh HOME is not the denied root, so denial did not come from the HOME.
      assert.equal(
        get(run.results, "file:read-denied:plainControl").ok,
        true,
        "stand-in root is not denied as a whole",
      );
      run.dispose();
    });

    it("C4(b): the parent's real private folder and .env / .dev.vars (even in the out dir) are unreadable", async () => {
      const run = await runProbe({ sandbox: true, guard: false });
      for (const name of ["dotenv", "devvars", "realPrivate"]) {
        const r = get(run.results, `file:read-denied:${name}`);
        assert.equal(r.ok, false, `${name} was readable`);
        assert.equal(r.code, "EPERM", name);
      }
      assert.equal(get(run.results, "file:read-allowed").detail, "4 bytes");
      run.dispose();
    });

    it("C5: the child's HOME is fresh, holds only its tmp, is not the real home, and is removed on dispose", async () => {
      const run = await runProbe({ sandbox: true, guard: false });
      const info = JSON.parse(get(run.results, "home:info").detail) as {
        home: string;
        entries: string[];
        tmpdir: string;
      };
      assert.notEqual(info.home, realHome);
      assert.equal(info.home, run.home);
      assert.equal(info.tmpdir, join(run.home, "tmp"));
      assert.ok(
        info.entries.every((e) => ["tmp", "run.sh", "w"].includes(e)),
        "unexpected entries in HOME",
      );
      run.dispose();
      assert.equal(existsSync(run.home), false, "HOME survived dispose()");
    });

    it("C6: the child's environment is exactly the exported base names plus the adapter's, with no key and no marker", async () => {
      const x = extras();
      const run = await runProbe({ sandbox: true, guard: true });
      const names = get(run.results, "env:names")
        .detail.split(",")
        .filter((n) => n !== "__CF_USER_TEXT_ENCODING");
      assert.deepEqual(names, [...new Set([...BASE_ENV_NAMES, ...(x.extraEnv ?? [])])].sort());
      assert.ok(names.every((n) => !n.startsWith("ANTHROPIC_")));
      assert.equal(get(run.results, "env:marker-in-values").detail, "false");
      run.dispose();
    });

    // C7: the M7 probes, from a launcher that holds the markers in its exec environment.
    let verdicts: ProbeVerdict[] = [];
    let control: ProbeVerdict[] = [];
    const keyFile = (): string => join(dir, "anthropic-key");
    function launch(sandbox: boolean): ProbeVerdict[] {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          adapter.loader,
          LAUNCHER,
          JSON.stringify({
            label: adapter.label,
            loader: adapter.loader,
            guardEntry: adapter.guardEntry,
            sandbox,
            probes: ["P1", "P2", "P3", "P4", "P5", "P6"],
          }),
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            X402_M7_SECRET: rand(),
            X402_ANTHROPIC_KEY_FILE: keyFile(),
          },
          encoding: "utf8",
          timeout: 180_000,
        },
      );
      assert.equal(result.status, 0, "the M7 launcher failed");
      return JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]") as ProbeVerdict[];
    }

    describe("C7: other processes' environments", () => {
      before(() => {
        writeFileSync(keyFile(), `sk-conformance-${rand()}\n`, { mode: 0o600 });
        chmodSync(keyFile(), 0o600);
        verdicts = launch(true);
        control = launch(false);
      });

      it("positive control: with the OS layer off the probes do see the marker", () => {
        assert.ok(
          control.some((v) => v.verdict === "leaked"),
          "no probe found the marker even unsandboxed, so the probes prove nothing",
        );
      });

      for (const id of ["P1", "P2", "P3", "P4", "P5", "P6"]) {
        it(`${id} finds no marker in any visible environment (denied or empty)`, () => {
          const v = verdicts.find((x) => x.id === id);
          assert.ok(v, `no verdict for ${id}`);
          console.error(`C7 ${adapter.label} ${id}: ${v.verdict}${v.notRun ? " (not run)" : ""}`);
          assert.notEqual(v.verdict, "leaked", `${id} leaked`);
        });
      }

      it("the runtime preflight fails closed exactly when a preflight probe leaks", () => {
        const preflightLeak = verdicts.some(
          (v) => ["P1", "P4", "P5"].includes(v.id) && v.verdict === "leaked",
        );
        // The residual override must not be set while this case runs.
        const saved = process.env[RESIDUAL_ENV];
        delete process.env[RESIDUAL_ENV];
        try {
          let refused: string | undefined;
          try {
            const s = spawnSandboxed({
              label: adapter.label,
              script: PROBE,
              loader: adapter.loader,
              guardEntry: adapter.guardEntry,
              taskPath,
              ...(adapter.preImports ? { preImports: adapter.preImports } : {}),
              stdio: ["ignore", "ignore", "ignore", "pipe"],
            });
            s.proc.kill("SIGKILL");
            s.dispose();
          } catch (err) {
            refused = err instanceof Error ? err.message : String(err);
          }
          assert.equal(
            refused !== undefined,
            preflightLeak,
            refused ?? "the spawn was not refused",
          );
        } finally {
          if (saved !== undefined) process.env[RESIDUAL_ENV] = saved;
        }
      });
    });

    it("key-file mode: the key is in no process's environment, only in the reader's memory (M5)", async () => {
      const keyValue = `sk-conformance-${rand()}`;
      const file = join(dir, "anthropic-key-2");
      writeFileSync(file, `${keyValue}\n`, { mode: 0o600 });
      const reader = fileURLToPath(new URL("./key-reader.ts", import.meta.url));
      const proc = spawn(process.execPath, ["--import", adapter.loader, reader], {
        env: { PATH: process.env.PATH ?? "", X402_ANTHROPIC_KEY_FILE: file },
        stdio: ["ignore", "pipe", "inherit"],
      });
      await new Promise<void>((resolve) => proc.stdout?.once("data", () => resolve()));
      try {
        const ps = spawnSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(proc.pid)], {
          encoding: "utf8",
        });
        // The positive control: ps does show the path variable, so it could show a key.
        assert.match(ps.stdout, /X402_ANTHROPIC_KEY_FILE=/);
        assert.equal(
          ps.stdout.includes(keyValue),
          false,
          "the key is visible in the reader's environment",
        );
        const all = spawnSync(
          "/bin/ps",
          ["-E", "-ww", "-o", "command=", "-U", String(process.getuid?.() ?? 0)],
          {
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
          },
        );
        assert.equal(
          all.stdout.includes(keyValue),
          false,
          "the key is visible in a same-uid environment",
        );
      } finally {
        proc.kill("SIGKILL");
      }
    });

    it("C8: the child cannot write the out dir, the spend stand-in or /private/tmp, can write its own tmp, and cannot exec what it wrote", async () => {
      // Earlier runs with the OS layer off may have written it.
      rmSync(join(dir, "conf-write"), { force: true });
      const run = await runProbe({ sandbox: true, guard: false });
      for (const name of ["write:out", "write:spend", "write:private-tmp"]) {
        const r = get(run.results, name);
        assert.equal(r.ok, false, `${name} succeeded`);
        assert.equal(r.code, "EPERM", name);
      }
      assert.equal(get(run.results, "write:home-tmp").detail, "written");
      const exec = get(run.results, "exec:written");
      assert.equal(exec.ok, false, "a written file was executed");
      assert.equal(existsSync(join(dir, "conf-write")), false);
      run.dispose();
    });

    it("C9: the modules both sides ran come from packages/sandbox and the adapter's own tsx", async () => {
      const mods = parentModules();
      for (const p of [mods.spawn, mods.profile, mods.guard]) {
        assert.ok(p.startsWith(`${SANDBOX_SRC}/`), `${p} is not under packages/sandbox/src`);
      }
      const run = await runProbe({ sandbox: true, guard: true });
      const reply = JSON.parse(get(run.results, "modules").detail) as GuardModules | null;
      assert.ok(reply, "the guard reported no modules");
      assert.equal(reply.guard, join(SANDBOX_SRC, "guard.ts"));
      assert.ok(
        reply.imports.includes(realpathSync(adapter.guardEntry)),
        "the adapter's guard entry was not preloaded",
      );
      const loader = reply.imports.find((p) => p.includes("/node_modules/") && /tsx/.test(p));
      assert.ok(loader, "no tsx loader among the imports");
      assert.ok(
        loader.startsWith(`${realpathSync(adapter.adapterRoot)}/`),
        "the loader is not from the adapter's tree",
      );
      run.dispose();
    });
  });
}
