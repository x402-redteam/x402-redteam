import { describe, expect, it } from "vitest";
import { shufflePass } from "../src/pass-order.js";

const legs = Array.from({ length: 40 }, (_, i) => `leg-${i}`);

describe("shufflePass (U36-c, AC-c7)", () => {
  it("is a permutation of its input", () => {
    for (const k of [1, 2, 3]) {
      expect([...shufflePass(legs, "seed", k)].sort()).toEqual([...legs].sort());
    }
  });

  it("is identical across two calls with the same seed and attempt", () => {
    expect(shufflePass(legs, "seed", 2)).toEqual(shufflePass(legs, "seed", 2));
  });

  it("differs between attempts and between seeds", () => {
    expect(shufflePass(legs, "seed", 1)).not.toEqual(shufflePass(legs, "seed", 2));
    expect(shufflePass(legs, "seed", 1)).not.toEqual(shufflePass(legs, "other", 1));
    expect(shufflePass(legs, "seed", 1)).not.toEqual(legs);
  });

  it("does not mutate its input and handles empty and single inputs", () => {
    const copy = [...legs];
    shufflePass(legs, "seed", 1);
    expect(legs).toEqual(copy);
    expect(shufflePass([], "seed", 1)).toEqual([]);
    expect(shufflePass(["only"], "seed", 1)).toEqual(["only"]);
  });
});

describe("runSuite pass order (U36-c, AC-c7)", () => {
  it("runs each attempt as its own full pass, in an order that is identical across two runs", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { runSuite } = await import("../src/run.js");
    const corpus = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "x402-pass-order-"));
    try {
      const orderOf = async (name: string): Promise<string[]> => {
        const orderFile = join(dir, `${name}.txt`);
        const script =
          "require('fs').appendFileSync(process.env.ORDER_FILE," +
          "JSON.parse(require('fs').readFileSync(process.env.X402_REDTEAM_TASK,'utf8')).run_id+'\\n')";
        const { report } = await runSuite({
          agentCmd: `"${process.execPath}" -e "${script}"`,
          env: { ORDER_FILE: orderFile },
          corpus,
          chains: ["evm", "svm"],
          repeat: 2,
          timeoutMs: 30_000,
          startupTimeoutMs: 30_000,
          seed: "x402-redteam-v1",
          outDir: join(dir, name),
          failOn: "low",
          harnessCommit: "test-harness-commit",
          agentId: "order-agent",
          guardrailId: "none",
          skipControls: true,
        });
        const ids = readFileSync(orderFile, "utf8").trim().split("\n");
        const attemptOf = new Map(report.runs.map((r) => [r.run_id, r.attempt]));
        // Six legs per pass: attempt 1 fills the first half, attempt 2 the second.
        expect(ids).toHaveLength(12);
        expect(ids.slice(0, 6).map((id) => attemptOf.get(id))).toEqual(Array(6).fill(1));
        expect(ids.slice(6).map((id) => attemptOf.get(id))).toEqual(Array(6).fill(2));
        // Review M4: pass 2 visits the legs in a different order than pass 1 (a removed
        // shuffle would make these equal).
        const legOf = new Map(report.runs.map((r) => [r.run_id, `${r.scenario_id}:${r.chain}`]));
        const pass1 = ids.slice(0, 6).map((id) => legOf.get(id));
        const pass2 = ids.slice(6).map((id) => legOf.get(id));
        expect([...pass1].sort()).toEqual([...pass2].sort());
        expect(pass2).not.toEqual(pass1);
        return ids;
      };
      const a = await orderOf("a");
      const b = await orderOf("b");
      expect(b).toEqual(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
