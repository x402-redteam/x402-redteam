import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTask, writeTaskFile } from "../src/task.js";

const FIXTURE_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const SEED = "x402-redteam-v1";
const BASE_URL = "http://127.0.0.1:43021";

describe("buildTask", () => {
  const [scenario] = loadCorpus(FIXTURE_CORPUS);

  it("builds an evm task with a hex wallet", () => {
    if (!scenario) throw new Error("fixture corpus is empty");
    const task = buildTask({
      scenario,
      chain: "evm",
      baseUrl: BASE_URL,
      seed: SEED,
      run_id: "abc123",
    });

    expect(task.version).toBe(3);
    expect(task.run_id).toBe("abc123");
    expect(task.chain).toBe("evm");
    expect(task.network).toBe("eip155:84532");
    expect(task.base_url).toBe(BASE_URL);
    expect(task.facilitator_url).toBe(`${BASE_URL}/facilitator`);
    expect(task.solana_rpc_url).toBe(`${BASE_URL}/solana-rpc`);
    expect(task.ledger_url).toBe(`${BASE_URL}/__harness/ledger`);
    expect(task.notice).toMatch(/TEST KEYS ONLY/);
    expect(task.wallet_balance_usd).toBe(100);
    expect(task.evm_rpc_url).toBe(`${BASE_URL}/evm-rpc`);
    expect(task.wallet).toHaveProperty("address");
    expect(task.wallet).toHaveProperty("private_key");
    expect((task.wallet as { private_key: string }).private_key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(task.prompt).not.toContain("{{");
    expect(task.allowed_hosts).toEqual(scenario.task.allowed_hosts ?? []);
    expect(task.budget_usd).toBe(scenario.task.budget_usd ?? 0);
    // v3 (ADR-012): default host_mode "path" - allowed_hosts and hosts[] both keep
    // today's exact /_host/ shape.
    expect(task.host_mode).toBe("path");
    expect(task.hosts).toEqual({ "provider.test": `${BASE_URL}/_host/provider.test` });
    // Code review item 2: {{base_url}} in path mode is the bare harness origin, not
    // provider.test's /_host/ URL (path mode must stay byte-identical).
    expect(task.prompt).toContain(`Fetch ${BASE_URL}/archive`);
  });

  it("builds an svm task with a base58 wallet", () => {
    if (!scenario) throw new Error("fixture corpus is empty");
    const task = buildTask({
      scenario,
      chain: "svm",
      baseUrl: BASE_URL,
      seed: SEED,
      run_id: "def456",
    });

    expect(task.chain).toBe("svm");
    expect(task.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(task.wallet).toHaveProperty("secret_key_base58");
    expect(task.wallet).not.toHaveProperty("private_key");
    const secret = (task.wallet as { secret_key_base58: string }).secret_key_base58;
    expect(secret).not.toMatch(/^0x/);
    expect(task.prompt).not.toContain("{{");
  });

  it("is deterministic for the same inputs", () => {
    if (!scenario) throw new Error("fixture corpus is empty");
    const a = buildTask({ scenario, chain: "evm", baseUrl: BASE_URL, seed: SEED, run_id: "same" });
    const b = buildTask({ scenario, chain: "evm", baseUrl: BASE_URL, seed: SEED, run_id: "same" });
    expect(a).toEqual(b);
  });

  // v3 (ADR-012): host_mode "localhost" renders allowed_hosts/hosts under *.localhost,
  // unlike "path"'s identity rendering.
  it("renders allowed_hosts and hosts under *.localhost in localhost mode", () => {
    if (!scenario) throw new Error("fixture corpus is empty");
    const task = buildTask({
      scenario,
      chain: "evm",
      baseUrl: BASE_URL,
      seed: SEED,
      run_id: "localhost-mode",
      hostMode: "localhost",
    });

    expect(task.host_mode).toBe("localhost");
    expect(task.allowed_hosts).toEqual(["provider.test.localhost"]);
    expect(task.hosts).toEqual({ "provider.test": "http://provider.test.localhost:43021" });
    expect(task.prompt).not.toContain("{{");
    // Code review item 1/2: {{base_url}} means the provider host's own .localhost URL
    // in localhost mode, so the agent's literal prompt text carries it end to end.
    expect(task.prompt).toContain("Fetch http://provider.test.localhost:43021/archive");
  });
});

describe("writeTaskFile", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-task-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes tasks/<run_id>.json and returns its absolute path", () => {
    const [scenario] = loadCorpus(FIXTURE_CORPUS);
    if (!scenario) throw new Error("fixture corpus is empty");
    const task = buildTask({
      scenario,
      chain: "evm",
      baseUrl: BASE_URL,
      seed: SEED,
      run_id: "written",
    });

    const path = writeTaskFile(outDir, task);
    expect(path).toBe(join(outDir, "tasks", "written.json"));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual(task);
  });
});
